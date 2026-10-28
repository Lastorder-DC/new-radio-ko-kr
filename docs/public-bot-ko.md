# 공개 JSON 기반 자동 게시 봇

이 실행 경로는 Nintendo/nxapi 수집, S3/R2 동기화, 프로필 변경을 실행하지 않는다. 한국어 대전 스케줄·연어런·일반 기어 변경과 페스티벌 알림, 특별 연어런 예고, 팀 콘테스트 예고·시작, 이벤트 매치 시작, 오늘의 픽업을 마스토돈에 게시하며, 설정하면 Buffer를 통해 X/Twitter에도 전송한다. 마스토돈 기본 공개범위는 `unlisted`다.

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
# 실제 자동 게시 시작. 첫 실행은 현재 유효한 항목을 각각 한 번 게시한다.
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

## Buffer 경유 X/Twitter 자동 게시

Buffer personal API key에 `accountRead`, `postsRead`, `postsWrite` 권한을 부여한다. 다음 값을 `.env`에 넣고 서비스를 다시 생성한다.

```dotenv
BUFFER_API_KEY=<Buffer API key>
BUFFER_TWITTER_CHANNEL_ID=<조회한 Twitter 채널 ID>
```

```sh
docker compose -f compose.bot.yml exec -T bot npm run social:buffer:channels
docker compose -f compose.bot.yml up -d --build bot
```

공개 JSON 봇은 마스토돈에 성공적으로 게시한 동일 이벤트의 본문·이미지·대체 텍스트를 재사용한다. Buffer가 이미지 URL을 인증 없이 가져올 수 있는지 먼저 확인한다. R2 자격 증명은 필요하지 않다. 마스토돈 게시와 원본 첨부 이미지를 Buffer 전송 완료 전에 삭제하지 않는다. 기존 `npm run social`의 BufferTwitterClient는 R2 업로드 방식을 그대로 사용하므로 공개 JSON 봇에는 `npm run bot` 경로를 사용한다.

Buffer 채널은 연결·잠금·일시정지 상태를 검증하고 `shareNow`로 전송한다. 활성화 직후에는 현재 세 항목을 트위터에 한 번씩 게시한다. 마스토돈에는 기존 이력이 유지되므로 재게시하지 않는다. 마스토돈 공개범위는 `unlisted`를 유지하며, X 게시에는 마스토돈의 공개범위 옵션이 적용되지 않는다.

전송 이력은 `storage/public-bot/buffer/<채널 ID 해시>/`에 별도로 저장한다. Buffer가 반환한 게시 ID와 `scheduled`/`sending`/`sent` 상태를 기록하고, 후속 tick에서 실제 상태와 X 게시 링크를 조회한다. `scheduled`는 Buffer가 요청을 수락한 상태이며 X 게시 완료는 `sent`와 링크로 확인한다. 한쪽 API 장애가 다른 쪽 이력을 초기화하지 않는다. 다만 X의 이미지·본문 공급원은 마스토돈이므로 같은 이벤트의 마스토돈 게시가 성공해야 X 전송을 진행한다.

Buffer에는 문서화된 멱등성 키가 없으므로 생성 요청의 응답이 유실되면 채널·본문·원본 이미지 URL이 일치하는 Buffer 게시를 조회한다. 찾으면 기존 게시 ID를 복구하고, 찾지 못하면 `needs-review`로 보류한다. 불확실한 요청을 무조건 다시 보내 중복 게시하지 않는다. 이 경우 Buffer에서 실제 접수 여부를 확인한 후 해당 대기 상태를 복구해야 한다. 명확한 요청 거절은 대기 후 재시도하며, 이미 수락된 게시가 `error`/`draft` 상태가 되면 자동으로 새 게시를 만들지 않고 `delivery-error`로 알린다.

Buffer의 상태는 `health.json`의 `buffer` 항목과 봇 로그에서 확인한다. 첫 연결 시 채널 ID 조회는 읽기 전용이며, 자동 게시 활성화 후의 생성 요청만 실제 X 전송을 수행한다.

Buffer 연결 검증에서는 스케줄·연어런·기어 각 1건의 `sent` 상태와 X 게시 링크를 API로 확인했다. 서비스 재시작 후 Buffer와 마스토돈 모두 `unchanged`로 처리되어 추가 게시하지 않았다. 트위터용 별도 R2 설정이나 마스토돈 공개범위 변경은 하지 않았다.

## 페스티벌 자동 알림

한국 계정 기준 AP 지역의 페스티벌만 등록한다. 전 세계 공통 행사도 AP 데이터를 한 번만 사용하므로 NA/JP/EU/AP가 중복 게시되지 않는다.

- 최초 확인 시 예고, 시작 72시간 전, 24시간 전, 시작, 트리컬러 활성화, 종료를 각각 한 번 안내한다.
- 완성된 결과와 우승 팀이 공개되면 결과 알림을 별도로 보낸다. 부분 집계는 결과로 게시하지 않는다.
- 서비스 중단으로 지나간 모든 단계를 소급 게시하지 않고 현재 단계만 안내한다.
- 운영 반영 직후 현재 예정된 페스티벌이 있으면 예고가 한 번 게시된다. 스케줄·연어런·기어의 기존 게시 이력은 유지한다.
- 마스토돈과 Buffer 모두 페스티벌 ID와 단계로 된 이벤트 키를 영속화한다. 최근 문자열 이벤트 128개의 이력을 유지하여 일시적인 데이터 회귀나 재시작에도 같은 단계를 다시 올리지 않는다. 기존 숫자형 로테이션 이력도 계속 읽는다.

페스티벌 기간에는 일반·카오폴리스·X 매치 대신 페스티벌 오픈·챌린지를 안내한다. 트리컬러는 공개 JSON의 `currentFest.midtermTime`부터 활성화하며, 같은 로테이션 안에서 활성화되거나 스테이지가 바뀌어도 변경을 감지한다. 종료 후에는 일반 스케줄로 복귀한다. 본문과 캡처는 같은 전환 기준을 사용하고, 페스티벌 기록만 먼저 갱신된 경우 일반 매치로 잘못 안내하지 않고 페스티벌 스케줄을 기다린다.

페스티벌 정보·스케줄·한국어 명칭은 기존 시간당 공개 JSON 캐시를 사용한다. 원본 데이터와 번역 반영이 늦으면 그만큼 안내가 지연될 수 있다. 결과 캡처는 명시한 페스티벌 ID를 사용하므로 다음 행사가 예고되어도 이전 행사 결과와 섞이지 않는다.

### 게시하지 않는 재현 미리보기

```sh
docker compose -f compose.bot.yml run --name festival-preview \
  -e FESTIVAL_PREVIEW_HOST=festival-preview bot npm run bot:festival:preview
docker cp festival-preview:/app/temp/festival-preview ./temp/festival-preview
```

현재 캐시의 행사 정보를 바탕으로 가상 스케줄·중간 발표·결과를 만들어 8개 상황을 캡처한다. 이 명령은 마스토돈/Buffer 게시기를 호출하지 않으며 운영 JSON과 게시 이력을 수정하지 않는다. `report.json`과 각 상황의 `status.txt`, `image.png`가 생성된다. 중간 발표 시각과 결과 수치는 테스트용이며 실제 행사 일정·결과로 사용하지 않는다. 같은 컨테이너 이름으로 다시 실행하려면 이전 미리보기 컨테이너를 먼저 제거한다.

### 디스크가 작은 서버에서 의존성 변경 없는 업데이트

`docker/bot-update.Dockerfile`은 기존 운영 이미지의 런타임 의존성을 재사용한다. 직접 런타임 의존성과 도달 가능한 의존성의 버전·무결성 해시·해석 경로가 기존 이미지와 일치해야 빌드되며, 런타임 의존성이 변경되면 거절한다. `npm prune`이 제거한 개발용·사용하지 않는 잠금 항목 차이는 허용한다. 먼저 동일 잠금 파일로 프런트엔드를 빌드하고 테스트한다.

```sh
VITE_DATA_FROM= npm run build
docker tag new-radio-ko-kr-bot:local new-radio-ko-kr-bot:update-base
docker build -f docker/bot-update.Dockerfile \
  --build-arg BASE_IMAGE=new-radio-ko-kr-bot:update-base \
  -t new-radio-ko-kr-bot:local .
docker compose -f compose.bot.yml up -d bot
```

업데이트용 컨텍스트에서도 `.env`, `storage`, `temp`와 수집 JSON은 제외된다. 전체 의존성을 다시 설치할 공간이 있는 환경이나 의존성 변경이 있는 경우에는 기존 `compose.bot.yml`의 전체 빌드를 사용한다.

페스티벌 운영 반영 검증에서는 실제 예정 행사의 예고를 마스토돈(`unlisted`, 한국어, 이미지·대체 텍스트)과 X(`sent`)에 각각 한 번 게시했다. 재시작 후 예고 및 기존 세 항목이 모두 `unchanged`로 처리됐다. 가상 중간 발표·결과 데이터는 미리보기에서만 사용했고 운영 게시에는 사용하지 않았다.

## 추가 알림

특별 연어런(빅 런·랜덤 무기·쿠마씨 무기)과 팀 콘테스트는 공개 일정에서 발견하면 예고를 한 번 게시한다. 팀 콘테스트 시작과 이벤트 매치의 각 개최 시간대 시작도 게시한다. 오늘의 픽업은 판매 종료 시각이 바뀔 때 게시한다. 모든 항목은 한국어 이미지·ALT, Mastodon unlisted와 Buffer X 전송 및 기존 중복 방지를 적용한다. 공개 JSON 수집은 최소 1시간 간격이므로 예고는 다음 수집 시점에 감지한다. 월간 연어런 보상 기어 알림은 활성화하지 않는다.
