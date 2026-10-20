# 스플래툰 3 일정 봇 운영 분석

확인 기준: 2026-10-20, upstream/main `07ba375`. 실제 Nintendo 계정 로그인 및 SNS 게시 검증은 수행하지 않았다.

## 결론

일정과 연어런 로테이션 알림이 목적이라면 Splatoon3.ink의 공개 JSON을 캐시해서 기존 스케줄 store와 게시 생성기에 공급하는 구성이 가장 간단하다. nxapi와 Nintendo 계정이 필요 없다. 자체 수집이 필요하면 이 저장소의 Nintendo → nxapi → SplatNet3 파이프라인을 사용할 수 있으나, 베타 패키지 설치 외에 nxapi 인증 클라이언트 등록도 필요하다.

## 코드 구조

- `app/index.mjs`: dotenv 로딩 후 CLI 명령 실행.
- `app/splatnet/NsoClient.mjs`: Nintendo session token → Coral 세션 → SplatNet 웹서비스 토큰. nxapi는 여기에서 사용한다.
- `app/splatnet/SplatNet3Client.mjs`: 웹서비스 토큰 → bullet token → persisted GraphQL query. 쿼리 해시는 `queryHashes.json`에 있다.
- `app/data/updaters/StageScheduleUpdater.mjs`: 대전과 연어런 일정을 모두 `dist/data/schedules.json`에 저장한다. `coop.json`은 연어런 로테이션이 아니라 월간 보상 기어 데이터다.
- `app/data/LocalizationProcessor.mjs`: 게임 내 명칭을 `dist/data/locale/*.json`에 저장한다.
- `src/stores/schedules.mjs`: 일반/카오폴리스/X/이벤트/연어런/빅 런/팀 콘테스트 데이터를 정규화한다.
- `app/social/generators/SchedulesStatus.mjs`, `SalmonRunStatus.mjs`: 일정 변경 게시. Upcoming 생성기는 특수 로테이션 예고를 처리한다.
- `app/social/StatusGeneratorManager.mjs`: 이미지 생성, 클라이언트별 게시, 성공 후 중복 방지 캐시 저장.
- `app/cron.mjs`: 데이터 갱신 후 게시. 인증 캐시 예열과 일일 프로세스 종료도 수행하므로 재시작 관리자가 필요하다.
- `storage/cache/`: 인증 정보와 게시 이력. 컨테이너 교체 시 영속화해야 한다.

## nxapi 버전 문제

### 확인된 사실

머지 전 package.json과 lockfile은 모두 `1.6.1-next.242`였으며, 머지 후에는 upstream과 동일한 `1.6.1-next.257`이다. npm registry는 `latest=1.6.1`, `next=1.6.1-next.257`를 반환했다. `npm ci` 설치 후 실제 package.json은 `1.6.1-next.257+sha.47c9d35`였다.

정확한 버전 문자열로 고정하면 npm이 조용히 정식 버전으로 대체하지 않는다. `nxapi` 또는 `nxapi@latest`를 설치하면 정식 버전이 선택되고, `^1.6.1-next.242` 같은 범위는 정식 `1.6.1`도 허용한다. 정식 릴리스는 같은 버전 번호의 prerelease보다 우선한다.

`.257` 배포 tarball의 `resources/common/remote-config.json` 기본값은 `https://nxapi-znca-api.fancy.org.uk/api/znca`이며 imink 설정은 null이다. 실행 시 실제 설정은 remote config로 갱신될 수 있다. 따라서 패키지 버전과 인증 provider는 별도로 확인해야 한다. **베타인데 `1.6.1`로 보이는 현상도 재현했다.** `import { version } from 'nxapi'`의 값은 실제 베타 설치 상태에서도 `1.6.1`이다. `dist/util/product.js`가 `/^(\d+\.\d+\.\d+)-next\b/i`로 베타 접미사를 제거하기 때문이다. 따라서 이 출력만으로 정식 패키지가 설치됐다고 판단하면 안 된다. 실제 package.json과 resolved 경로를 확인해야 한다.

기존 코드에는 `ClientAssertionProviderInterface`를 런타임 named import하는 문제가 있었다. 이 이름은 `.d.ts`의 interface이고 JavaScript export가 아니므로 ESM import 단계에서 실패할 수 있다. 머지 후 코드는 이 import를 제거했다. 기존 `NXAPI_AUTH_CLIENT_PUBLIC` 방식도 최신 shared-secret 인증과 함께 유지했다.

### 실행 환경에서 진단

반드시 봇이 실행되는 컨테이너 또는 작업 디렉터리에서 확인한다.

```sh
node --version
npm ls nxapi
node -p "require('./node_modules/nxapi/package.json').version"
node --input-type=module -e "console.log(import.meta.resolve('nxapi'))"
npm view nxapi dist-tags --json
```

- `npx nxapi`나 전역 `nxapi` CLI는 앱의 로컬 dependency와 다른 버전을 사용할 수 있다. 앱은 `npm run splatnet:quick`으로 실행한다.
- `NXAPI_ZNCA_API=imink`가 남아 있으면 최신 버전에서도 imink가 강제된다. `ZNCA_API_URL`보다 우선한다. provider 선택 코드는 `node_modules/nxapi/dist/api/f.js`에 있다.
- `ZNCA_API_URL`, `NXAPI_CONFIG_URL`, `NXAPI_ENABLE_REMOTE_CONFIG`, `NXAPI_REMOTE_CONFIG_FALLBACK`도 점검한다. remote config를 끄거나 과거 설정으로 fallback시키는 우회는 피한다.
- nxapi remote config는 프로세스 수명 동안 유지될 수 있다. 패키지/설정 변경 후 프로세스를 재시작한다. upstream cron에도 일일 재시작이 추가됐다.
- `docker-compose.override.yml.prod.example`은 `ghcr.io/misenhower/splatoon3.ink:main`을 실행한다. 이 파일을 그대로 쓰면 포크의 package.json 변경은 적용되지 않는다. 직접 빌드하거나 포크 이미지 `ghcr.io/lastorder-dc/new-radio-ko-kr:main`을 지정하고 실제 digest와 컨테이너 내부 버전을 확인한다. GitHub Actions 실행/패키지 접근 권한에 따라 이미지 게시 여부는 별도 확인이 필요하다.
- 이미지 안에서 변경했더라도 bind mount가 `/app` 또는 `/app/node_modules`를 덮으면 호스트의 오래된 dependency가 실행될 수 있다.

버전 재현에는 현재 저장소에서 `npm ci`를 사용한다. 베타 버전을 변경할 때에는 `npm install --save-exact nxapi@1.6.1-next.257`로 package.json과 lockfile을 함께 변경한다.

## 공개 JSON으로 운영하는 방법

공식 데이터 안내: https://github.com/misenhower/splatoon3.ink/wiki/Data-Access

필수 입력은 다음 두 개다.

- https://splatoon3.ink/data/schedules.json
- https://splatoon3.ink/data/locale/ko-KR.json

일반 대전은 `data.regularSchedules.nodes`, 카오폴리스는 `data.bankaraSchedules.nodes`, X는 `data.xSchedules.nodes`, 연어런은 `data.coopGroupingSchedule.regularSchedules.nodes`, 빅 런은 같은 그룹의 `bigRunSchedules.nodes`를 사용한다. 기존 store를 재사용하면 직접 정규화할 필요가 없다. 명칭은 `id` 또는 `__splatoon3ink_id`로 한국어 locale JSON을 조회한다.

운영 순서는 다음과 같다.

1. Node 24에서 `npm ci`, `npm run build`를 실행한다.
2. 데이터 fetch 작업을 따로 만들어 시간당 한 번 캐시한다. 연락처가 포함된 User-Agent를 설정하고, 응답 성공/JSON 구조 검증 후 임시 파일을 rename하여 반영한다. 실패 시 마지막 정상 데이터를 보존한다.
3. 로컬 시간은 `Asia/Seoul`, 현재 로테 판정은 `startTime <= now < endTime`으로 처리한다. 변경 시점 알림은 미리 받은 미래 일정으로 실행하면 매번 원격 요청할 필요가 없다.
4. 대상 채널/모드/시작 시각을 키로 게시 이력을 저장한다. 재시작 후 중복 게시와 종료된 일정의 뒤늦은 게시를 방지한다.
5. 기존 `StatusGenerator._loadData()`를 그대로 쓰려면 schedules 외에 `gear.json`, `coop.json`, `festivals.json`도 필요하다. 일정 전용으로 좁히려면 생성기를 SchedulesStatus/SalmonRunStatus로 제한하고 데이터 로더도 필요한 파일만 읽도록 변경한다.
6. 공개 데이터 운영에서는 기존 `npm start`/`npm run cron`을 그대로 실행하면 안 된다. Nintendo 직접 수집과 인증 예열이 포함되어 있다. JSON 수집 → 게시 작업으로 별도의 진입점/스케줄러를 구성한다.

기존 `testcron.sh`는 공개 JSON 다운로드의 흔적이지만 디렉터리 생성, 응답 검증, 원자적 갱신, 실패 처리가 없으므로 운영용으로는 보강이 필요하다. `VITE_DATA_FROM`은 프런트엔드의 데이터 출처 설정일 뿐, 백엔드 수집을 공개 JSON 방식으로 바꾸지는 않는다.

데이터 제공자는 출처 표기와 무료 제공을 요구하고, 시간당 한 번 이하 요청/캐시 및 User-Agent 설정을 안내한다. 구체적인 최신 조건은 위 원문을 따른다.

## Nintendo에서 직접 수집하는 방법

머지 전과 upstream의 `.env.example`에 있던 `NINTENDO_TOKEN`만 채우면 동작하지 않는다. 이번 머지에서는 예제를 실제 코드와 맞게 지역별 변수로 수정했다. `regionTokens()`는 `NINTENDO_TOKEN_AP`, `_US`, `_EU`, `_JP`를 읽는다. 한국 계정으로 시작할 때에는 AP 토큰을 설정한다. 이 값은 Nintendo 계정 로그인으로 얻는 session token이며 웹서비스 토큰이나 bullet token이 아니다.

```dotenv
NINTENDO_TOKEN_AP=<Nintendo session token>
USER_AGENT=new-radio-ko-kr/1.0 (연락 가능한 프로젝트 URL 또는 이메일)
NXAPI_AUTH_CLIENT_PUBLIC=<등록한 public client ID>
SCREENSHOT_PROVIDER=browserless
BROWSERLESS_ENDPOINT=ws://browserless:3000
SCREENSHOT_HOST=app
```

nxapi-auth 등록: https://nxapi-auth.fancy.org.uk/oauth/clients

공식 nxapi 문서: https://github.com/samuelthomas2774/nxapi#nxapi-auth-authentication

public client 대신 upstream 방식의 `NXAPI_CLIENT_ID`와 `NXAPI_SHARED_SECRET`으로 서명한 assertion을 사용할 수도 있다. 등록한 클라이언트 유형/인증 방식과 일치하는 설정을 사용한다. scope는 `ca:gf ca:er ca:dr`다. 라이브러리 사용자는 CLI 기본 인증에 의존해서는 안 된다.

```sh
npm ci
npm run build
npm run splatnet:quick
```

수집 결과 파일의 갱신 시각과 내용을 검증한 다음 이미지 미리보기, SNS 연동 순서로 진행한다. updater가 오류를 로그에 남기고 계속 진행할 수 있으므로 exit code만으로 수집 성공을 판단해서는 안 된다.

포크는 AP만 festival updater를 실행하던 설정을 보존했다. 전체 지역 페스티벌 데이터가 필요하면 `app/data/index.mjs`의 주석을 해제하고 해당 지역 토큰을 마련한다. 일반 일정 수집을 위해 네 지역 토큰이 모두 필요한 것은 아니다.

S3/R2는 선택 사항이다. 로컬 파일 기반 운용도 가능하다. Docker에서는 직접 빌드한 앱과 Browserless를 같은 네트워크에 두고 `/app/storage`, `/app/dist/data`, `/app/dist/assets/splatnet`을 영속화한다. 생성된 이미지도 보관하려면 `/app/dist/status-screenshots`를 영속화한다. 데이터 파일만 남겨 이미지 원본/가공 파일을 잃으면 캐시에 기록된 이미지가 깨질 수 있다.

## 한국어 봇 지원

프런트엔드 기본 locale, 기본 수집 언어, 기존 한국어 번역 수정을 보존하고, SNS 문구·대체 텍스트의 `ko-KR` 지원을 추가했다. 기본 운영 locale은 한국어이며 `SOCIAL_LOCALE=en-US`로 영어를 선택할 수 있다. 캡처 URL의 locale이 우선하므로 브라우저 언어만 바꾸는 것으로는 충분하지 않다.

- `app/social/i18n/ko-KR.json`에 한국어 문구와 이미지 대체 텍스트를 등록했다.
- 게임 명칭은 공개 `locale/ko-KR.json`에서 ID로 조회한다. 누락된 번역은 영어로 게시하지 않고 오류로 처리한다.
- 날짜·스크린샷은 `ko-KR`/`Asia/Seoul`을 사용한다. 캡처 locale을 `ko-KR`로 전달하며 한국 시간만 표시한다.
- 기본 manager와 각 client의 locale도 동일하게 설정한다.
- `defaultStatusGenerators()`를 일정/연어런 중심으로 제한한다. 현재 기본값은 기어/페스티벌/이벤트 예고도 포함한다.
- Mastodon, Bluesky, Threads, Buffer 경유 Twitter 등의 클라이언트가 있다. 직접 TwitterClient는 기본 구성에서 비활성화되어 있다. Discord/Telegram 등은 새 Client 구현이 필요하다.
- 전체 문구, 이미지 대체 텍스트, 미스터리 무기, 빅 런, 팀 콘테스트, 일정 없음, 데이터 지연 시나리오를 미리보기로 확인한다.

실제 게시하지 않는 파일 출력 미리보기는 영어/일본어/한국어를 지원한다. `npm run social:preview -- ko-KR`로 한국어 미리보기를 생성한다. 공개 JSON을 사용한 마스토돈 테스트에서 본문·이미지·대체 텍스트의 한국어 출력과 서버의 게시 언어 `ko`를 확인했다. Nintendo 인증과 운영 배포는 별도다.

## 이번 머지 검증

Node 24.22.0에서 `npm ci`, `npm run lint`, `npm run build`, `npm test`가 성공했다. 테스트는 350개 통과, 1개 skip이다. nxapi 실제 설치 버전과 런타임 version 표기의 차이를 재현했고, NsoClient 모듈 import도 성공했다. build에는 500 kB 초과 chunk 경고가 있다. Nintendo 로그인은 별도 검증이 필요하다. 후속 한국어 마스토돈 테스트는 공개 JSON만 사용했으며 일정·연어런 각 1건 게시를 확인했다.
