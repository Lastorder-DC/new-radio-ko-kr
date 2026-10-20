# 공개 JSON 기반 자동 게시 봇

이 실행 경로는 Nintendo/nxapi 수집, S3/R2 동기화, 다른 SNS 게시, 프로필 변경을 실행하지 않는다. 한국어 대전 스케줄·연어런·일반 기어 변경만 마스토돈에 게시한다. 기본 공개범위는 `unlisted`다.

## 실행

Docker Engine과 Docker Compose v2가 필요하다. `.env.example`을 참고해 `.env`의 다음 값을 설정한다.

```dotenv
MASTODON_URL=https://your-mastodon-server.example
MASTODON_ACCESS_TOKEN=<운영 계정 토큰>
MASTODON_VISIBILITY=unlisted
BROWSERLESS_TOKEN=<openssl rand -hex 32로 생성한 값>
PUBLIC_DATA_USER_AGENT=new-radio-ko-kr/1.0 (연락 가능한 프로젝트 URL)
```

토큰 계정에는 본인 계정 확인·본인 게시 조회와 기어 이미지 업로드·게시 권한이 필요하다. API 경로는 Mastodon 호환 서버를 기준으로 한다. `.env`는 Git과 Docker 빌드 컨텍스트에서 제외된다. 앱 이미지는 포크의 현재 코드를 로컬에서 빌드한다.

```sh
docker compose -f compose.bot.yml build bot
docker compose -f compose.bot.yml up -d browserless
# 첫 운영 시작 전, 공개 JSON과 이미지를 검증하되 게시하지 않는다.
docker compose -f compose.bot.yml run --rm --use-aliases bot npm run bot:preview
# 실제 자동 게시 시작. 첫 실행은 현재 항목 세 건을 게시한다.
docker compose -f compose.bot.yml up -d
```

Browserless는 내부 네트워크에서만 접근하고, 호스트 포트를 열지 않는다. 렌더링할 앱의 임시 HTTP 서버도 Docker 네트워크에서 접근한다. `VITE_DATA_FROM`을 빌드 단계에서 비워 스크린샷이 외부 JSON을 반복해서 요청하지 않도록 했다. 원본 게임 이미지는 공개 JSON의 이미지 URL을 사용한다.

최초 다운로드한 browser image의 RepoDigest를 `BROWSERLESS_IMAGE`에 넣으면 같은 버전을 재현할 수 있다. 자동 이미지 업데이트는 사용하지 않는다.

## 운영 명령

```sh
# 상태·로그 확인
docker compose -f compose.bot.yml ps
docker compose -f compose.bot.yml logs --tail=100 bot

# 코드 업데이트 후 다시 빌드하고 적용
docker compose -f compose.bot.yml up -d --build

# 자동 게시 중지 (게시 이력과 공개 JSON은 보존)
docker compose -f compose.bot.yml stop bot

# 중지 상태에서 한 번만 실행: 실제 게시함
docker compose -f compose.bot.yml run --rm --use-aliases bot npm run bot:once

# 중지 상태에서 미리보기: 실제 게시하지 않음
docker compose -f compose.bot.yml run --rm --use-aliases bot npm run bot:preview
```

운영 프로세스가 실행 중이면 별도의 once/preview/fetch 실행은 flock 잠금으로 거절된다. `node app/bot/index.mjs`를 직접 호출하면 잠금을 우회하므로 npm 스크립트를 사용한다. 여러 호스트에서 같은 계정을 동시에 운영하는 구성은 지원하지 않는다.

## 실행 주기와 변경 감지

- 시작할 때 공개 JSON을 받아 캐시한다. 이후 마지막 다운로드 시도로부터 최소 1시간 간격으로 요청한다. 특정 분에 맞추기 위해 1시간 이내 재요청하지 않는다.
- `schedules.json`, `gear.json`, `coop.json`, `festivals.json`, `locale/ko-KR.json`을 검증하고 새 스냅샷으로 교체한다. ETag/Last-Modified가 있으면 조건부 요청을 사용한다.
- 다운로드가 일부 실패하면 마지막 정상 스냅샷을 보존한다. 실패한 시도도 기록하므로 재시작으로 요청 제한을 우회하지 않는다. 다시 받을 수 있는 시점까지 캐시로 동작한다.
- 매분 로컬 캐시를 확인한다. 미래 일정이 포함되어 있으므로 다음 로테이션을 캐시에서 선택할 수 있다. 매 tick마다 생성기를 새로 만들어 이전 시간/Pinia 데이터를 재사용하지 않는다.
- 대전·연어런은 현재 일정의 시작 시각, 기어는 최신 기어의 판매 종료 시각을 비교한다. 성공한 이벤트만 게시 이력에 기록한다.
- 최초 실행은 현재 항목을 한 번씩 게시한다. 멈춘 동안 지나간 모든 로테이션을 소급 게시하지 않고, 현재 항목만 게시한다.
- 90분보다 오래된 캐시로 새 기어 게시를 만들지 않는다. 일정은 6시간까지 캐시 사용을 허용하지만 현재 활성 일정만 선택한다. 실제 데이터 공급 중단은 로그와 health.json에서 확인한다.
- 기어는 원본 JSON에 새 상품이 나타난 뒤 다음 수집 시점에 게시한다. 원본 계정보다 지연될 수 있다.

## 전송 대기열과 중복 방지

`storage/public-bot/accounts/<서버와 계정 ID 해시>/`에 계정별 게시 이력을 저장한다. 토큰을 갱신해도 같은 계정이면 이력을 이어 쓰고, 다른 계정으로 변경하면 별도 이력을 사용한다.

게시 본문·공개범위·이미지·첨부 ID·안정적인 Idempotency-Key를 전송 전에 저장한다. 서버 응답이 유실되면 본인 타임라인에서 같은 첨부 ID를 찾고, 이미 게시됐으면 새 게시를 만들지 않고 이력만 복구한다. 확인 API가 실패하면 재전송을 보류한다. Mastodon의 Idempotency-Key 보존 시간이 제한되어 있어 로컬 이력과 이 확인 절차를 함께 사용한다. 서버별 호환성이나 서버 측 데이터 손실까지 포함한 절대적인 exactly-once 보장은 아니다.

HTTP 오류는 지수 백오프(최대 15분)와 Retry-After를 적용한다. 오래된 로테이션의 미확정 전송도 먼저 확인한 다음 폐기하며, 지난 일정으로 새 게시를 만들지 않는다. 손상된 게시 이력 파일은 자동으로 초기화하지 않고 오류로 중지한다.

운영 전에 토큰 계정을 확인하며, `MASTODON_VISIBILITY=unlisted`를 명시적으로 전송한다. 이미 대기열에 들어간 게시의 공개범위는 재시작이나 환경변수 변경에도 유지된다. 공개범위를 바꿀 때에는 기존 대기열도 확인해야 한다.

## 상태와 백업

호스트의 `./storage`를 컨테이너의 `/app/storage`에 마운트한다. 재배포·재부팅 후에도 이 디렉터리를 보존한다. 백업 대상은 `.env`와 `storage/public-bot/`다. 인증 토큰이 포함된 `.env` 백업은 별도로 보호한다.

- `source.json`: 마지막 다운로드 시도·성공 시각과 현재 스냅샷.
- `snapshots/`: 현재 및 이전 공개 JSON 스냅샷.
- `accounts/`: 게시 이력과 미전송 이미지/본문.
- `health.json`: 최근 tick 완료 시각, 데이터 시각, 항목별 결과/오류. 토큰은 기록하지 않는다.

healthcheck는 마지막 tick이 5분 이내에 완료됐는지 확인한다. API 장애는 프로세스를 계속 재시작하는 대신 항목별 오류와 재시도 상태로 남긴다. Docker의 restart 정책은 프로세스 종료 및 호스트 재부팅 후 복구를 담당한다. 로그는 파일당 10 MB, 최대 3개로 순환한다.

`npm run bot:preview`의 출력은 `temp/public-bot-preview/`에 저장된다. Docker one-off 컨테이너 종료 후 파일이 필요하면 `--rm`을 빼고 컨테이너에서 복사한다. 미리보기는 실제 전송 이력을 변경하지 않는다.

데이터 제공자의 출처 표기·무료 이용·조회 주기 정책을 준수한다: https://github.com/misenhower/splatoon3.ink/wiki/Data-Access

## 배포 검증 (2026-10-20)

실제 Docker Compose에서 공개 JSON 수집과 세 종류의 한국어 미리보기를 확인한 뒤 운영 계정에 각 1건을 게시했다. 서버 응답과 본인 타임라인에서 세 게시 모두 `visibility=unlisted`, `language=ko`, 이미지 1개와 대체 텍스트를 확인했다. 컨테이너 재시작 후 세 항목 모두 `unchanged`로 처리됐고, 공개 JSON도 다시 다운로드하지 않았다.
