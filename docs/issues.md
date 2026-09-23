# 이슈

## Issue #1: 비브라우저 클라이언트가 socket.io 방에 들어갈 수 있는가
**상태: ✅ 해결됨 (2026-09-23) — 된다. 단 JWT 로만.**

### 결과 (`scripts/probe-socket.mjs`, 우리 인스턴스 실측)
| 시도 | 결과 |
|---|---|
| 익명(토큰 없음) | `denied` — "You do not have access to this drawing" |
| **API 키**를 `auth.token` 자리에 | `denied` — 핸드셰이크는 `jwt.verify` 라 API 키는 JWT 가 아니다 → 익명 취급 |
| 로그인 JWT 를 `auth.token` 에 | **`joined`** |
| 로그인 JWT 를 `Cookie: excalidash-access-token=…` 에 | **`joined`** |

### 그래서
- 플러그인은 **로그인해서 JWT 를 얻어야** 한다. upstream 의 `generateApiKeyFromLogin` 이 이미 `POST /api/auth/login` 을 하므로 그 경로를 재사용한다(CSRF 토큰 → 로그인 → `set-cookie` 에서 `excalidash-access-token`).
- REST 는 API 키, socket 은 JWT — **인증이 둘로 갈린다.** 설정 UI 가 이걸 드러내야 한다.
- ⚠️ access 토큰 기본 TTL 이 **15분**(`backend/src/auth/cookies.ts`). 장시간 세션은 갱신이 필요하다 → Issue #5.
- ⚠️ join 은 됐는데 ack 의 presence id 가 `anon:<socketId>` 로 온다. 편집 권한은 통과했으므로(아래 #1b) 표시 이름만의 문제로 보이나 확인 필요.

---

## Issue #1b: element-update 가 실제로 오가는가
**상태: ✅ 해결됨 (2026-09-23) — 오간다. 그리고 socket 은 저장하지 않는다.**

`scripts/probe-roundtrip.mjs` — 임시 드로잉에 소켓 둘을 넣고 A 가 쏘면 B 가 받는다:
```
B 수신: elements=["b"] elementOrder=["a","b"]
서버 씬 live ids = ["a"]        ← 저장은 안 된다
```

### 배운 것 (설계에 직결)
1. **`element-update` 페이로드에 `drawingId` 가 없으면 서버가 조용히 버린다**(`backend/src/server/socket.ts:288`). 첫 시도가 이것 때문에 실패했다 — 에러도 안 준다.
2. 서버는 `socket.to(roomId).emit("element-update", data)` 로 **중계만** 한다. **영속화는 REST 뿐이다.** → 우리 2 채널 설계(저장=REST, socket=알림·전파)가 실측으로 맞다.
3. 변경 이벤트마다 **편집 권한을 재검사**한다(캐시 우회). 권한이 없으면 `error` 로 "Read-only access: cannot edit this drawing".

---

## Issue #2: 모바일 Obsidian 에서 socket.io 가 되는가
**상태: 🔄 미확인**

아이패드가 주 편집 기기다. 여기서 안 되면 `isDesktopOnly` 를 재검토해야 하고, 아이패드는 파일 동기화(LiveSync)에만 의존하게 된다. Obsidian 의 `requestUrl` 은 HTTP 의 CORS 를 우회하지만 WebSocket 은 별개다.

---

## Issue #3: tombstone 누적으로 씬이 커진다
**상태: ⏸️ 보류 (임계치 넘을 때)**

tombstone 은 요소 전체 사본이라 판이 거듭되면 씬이 커진다. 죽은 id 가 수천이면 `/drawings/:id/trim` + 열린 탭 전부 새로고침이 필요하다. 지금은 경고만 띄우고, 실제로 커지면 그때 자동화한다.

---

## Issue #4: 백엔드가 규칙에 안 맞는 `fileId` 를 조용히 버린다
**상태: 🔄 알려진 함정**

ExcaliDash 백엔드는 `fileId` 가 `^[\w-]{1,200}$` 가 아니면 `delete result[fileId]` 로 **조용히** 버린다. 이미지가 통째로 사라지고 회색 자리표시자만 남는다. 올리기 전에 정규화하고, 올린 뒤 files 도 검증한다.

---

## Issue #5: access 토큰 TTL 15분
**상태: 🔄 열림**

`ACCESS_TOKEN_COOKIE_NAME = "excalidash-access-token"`, 기본 TTL 15분(refresh 는 7일). 상시 연결을 유지하려면 만료 전에 갱신하거나 재로그인해야 한다. 우리 인스턴스는 `JWT_REFRESH_EXPIRES_IN=365d` 로 늘려 뒀지만 **access 쪽은 그대로**다. 재연결 시 조용히 실패하지 않도록 만료를 다뤄야 한다.

---

## Issue #6: `set-cookie` 가 배열이면 로그인 전에 죽는다 (upstream 버그, 수정함)
**상태: ✅ 해결됨 (2026-09-23)**

### 문제
"Generate API key from login" 이 **`i.trim is not a function`** 으로 죽었다. 로그인 시도조차 못 한다 — 그 앞의 CSRF 응답 파싱 단계에서 터진다.

### 원인
`extractSetCookies(headers: Record<string, string>)` 가 헤더 값을 **항상 문자열로 가정**하고 `value.trim()` 을 부른다. Obsidian 의 `requestUrl` 은 다중 헤더(특히 `set-cookie`)를 **배열**로 돌려줄 수 있다.

### 해결
값이 배열이면 펼치고, 문자열이 아닌 항목은 버린다. 헤더 객체 자체가 없어도 견딘다.

### 검사
`scripts/verify-set-cookie-parsing.mjs` — 함수를 **복사하지 않고 `main.ts` 에서 뽑아** 돌린다(복사본은 원본이 되돌아가도 계속 통과한다). 옛 구현이 배열에서 **실제로 터지는지**까지 확인하므로 통과가 의미를 가진다. 수정을 되돌리면 exit 1 (실측).

### upstream 에 돌려줄 것
이건 실시간과 무관한 순수 버그 수정이라 **PR 대상**이다. `feat/realtime-collab` 에서 떼어 별도 브랜치로 올릴 것.

---

## Issue #7: 동기화가 도면 파일을 깨뜨렸다 (frontmatter 되쓰기)
**상태: ✅ 해결됨 (2026-09-23)**

### 증상
Obsidian 의 Excalidraw 뷰에서 **빈 텍스트 박스를 만들고 저장하면, 그 박스 안에 `## Text Elements` 구간이 통째로 들어갔다** — 블록 참조(`^th`, `^desc:t0`)까지 같이. 그냥 저장만 하면 재현되지 않았다.

실측 피해: `architecture` 의 요소 `tA6Vc5lk` 가 252 자 / 25 줄, `structure` 의 `tabicl:t` 가 "TabICL" 대신 `AI Agent ^agent:t …`. `## Text Elements` 구간에는 같은 항목이 두 벌씩 쌓였다.

### 원인 (사용자 실측으로 확정)
동기화 직후 `processFrontMatter` 로 `excalidash-id/version/last-hash/last-synced` 를 **도면 파일에 되썼다**(upstream 설계). Excalidraw 플러그인은 같은 파일을 열어둔 채 자기 형식(`## Text Elements` + 압축 씬)으로 저장하는 중이라 서로 밟는다.

**플러그인을 끄고 같은 조작을 하니 재현되지 않았다** — 이걸로 확정. 추측 두 개(서버측 편집 / 자동 동기화)를 놓고 사용자가 한 번의 토글로 갈랐다.

### 해결
동기화 기록을 **파일 밖**(플러그인 설정 `syncState`, 파일 경로 키)으로 옮겼다. frontmatter 는 이제 **읽기만** 한다 — opt-in 키(`destination`·`sync`·`collection`·선택적 `id`)는 사용자 소유다. 기록이 없으면 옛 frontmatter 값을 승계하므로 기존 파일도 그대로 동작한다. 파일 이름이 바뀌면 기록도 따라간다(안 그러면 드로잉이 하나 더 생긴다).

### 검사
`scripts/verify-no-drawing-writes.mjs` — `syncFile`·`recordSync`·`autoSyncFile` 등 동기화 경로에 파일 쓰기 API 가 **하나도 없어야** 통과. 남아 있는 쓰기는 사용자가 직접 부르는 자리(`applyDrawingSettingsToFolder`·설정 모달·양방향 pull)뿐임을 확인한다. `recordSync` 에 옛 호출을 되살리면 exit 1 (실측).

### 남은 위험
**양방향(`bidirectional`) 모드의 `writeRemoteSceneToLocal` 은 여전히 도면 파일을 쓴다.** 지금은 단방향이라 닿지 않지만, 양방향을 켜면 같은 부류의 사고가 난다. 실시간(C) 설계에서 이 경로를 어떻게 다룰지 정해야 한다 — 열린 뷰가 있으면 `ExcalidrawAutomate` 로 넣고 파일은 건드리지 않는 쪽이 맞아 보인다.

---

## Issue #8: 파일을 부분만 고치면 도면이 망가진다 (⚠️ 진짜 원인은 Issue #9 — 8 자가 아닌 id)
**상태: ✅ 해결됨 (2026-09-23)**

### 증상
Obsidian 에서 빈 텍스트 박스를 만들고 저장하면 `## Text Elements` 구간이 통째로 그 요소 안에 들어갔다. 원인을 세 번 잘못 짚었다(우리 frontmatter 쓰기 → 우리 읽기 → LiveSync). **빈 no-op 플러그인으로도 재현**됐고 **새로 만든 도면은 멀쩡**해서, 원인이 플러그인이 아니라 **파일에 이미 박힌 불일치**임이 드러났다.

### 원인
`.excalidraw.md` 는 **압축 씬**과 **`## Text Elements`**(각 텍스트 요소를 `<텍스트> ^<id>` 로 풀어 적은 목록) 두 벌을 들고 있고, 플러그인은 파일을 읽을 때 **목록 쪽에서 텍스트를 가져온다.** 그래서 한쪽만 바꾸면 둘이 어긋나고, 그 파일은 열고 저장할 때마다 유령을 스스로 재생산한다.

부분 수정을 한 주체가 그때그때 달랐을 뿐이다 — 서버에서 frontmatter 를 심은 것도, upstream 의 pull(`writeRemoteSceneToLocal` 이 씬 블록만 교체)도 같은 짓이었다.

### 해결
1. 파일을 쓸 때 `## Text Elements` 를 **씬에서 다시 생성**한다(`rewriteTextElementsSection`).
2. 도면이 **열려 있으면 파일을 아예 안 쓰고** `ExcalidrawAutomate.viewUpdateScene()` 으로 살아 있는 뷰에 넣는다. 저장은 Excalidraw 플러그인이 하므로 두 쪽이 늘 일관된다.
3. 정리 작업은 파일이 아니라 **ExcaliDash REST** 로 한다 — 도면을 열어둔 채로도 안전하다.

### 검사
`scripts/verify-text-elements-section.mjs`(재생성이 씬과 일치하는지 + 옛 방식이 어긋나는지) · `verify-no-drawing-writes.mjs`(pull 이 열린-뷰 분기를 갖는지, 뷰 주입이 파일을 안 쓰는지).

### 남은 관찰
뷰 주입 뒤 텍스트 요소의 **id 가 새로 매겨지는 것으로 보인다**(보낸 `claude-text-1` 이 `Y706lL3o`·`eM8rM5eU` 두 벌로 들어왔다). id 기준 병합이 텍스트 요소에서는 어긋날 수 있다 — 실시간(C) 전에 확인할 것.

## Issue #9: 8 자가 아닌 텍스트 id 가 `## Text Elements` 를 무너뜨린다 (Issue #8 의 진짜 원인)
**상태: ✅ 해결됨 (2026-09-23)** · 연관: Issue #8

### 증상
실시간을 붙이고 웹에서 "Hello World" 를 쓰자, 잠시 뒤 그 텍스트 박스에 `## Text Elements` 목록이 두 번 통째로 들어갔다 — Issue #8 과 똑같은 모양.

### 원인
Obsidian Excalidraw 플러그인(v2.27.3)은 구간을 `e.matchAll(/\s\^(.{8})[\n]+/g)` 로 끊고, 다음 시작을 `index + 12` 로 둔다. **정확히 8 자 id 만 경계가 된다.** excalidraw 스킬(`~/.claude/skills/excalidraw`)이 만든 `th`·`desc:t0` 같은 짧은 id 의 줄은 경계로 안 잡혀 **다음 8 자 id 의 텍스트에 붙는다.** 그리고 저장할 때 8 자 넘는 텍스트 id 는 무작위 8 자로 바꾼다(`findNewTextElementsInScene`).
Issue #8 에서 "새 도면은 멀쩡" 했던 건 새 도면의 id 가 전부 플러그인이 만든 8 자라서였다. "파일에 박힌 불일치" 는 결과였지 원인이 아니다.

### 해결 방법
- 플러그인: 서버 id 가 8 자가 아니면 들어올 때 결정론적 8 자(`shortElementId`)로 바꾸고, 나갈 때 되돌린다(`toLocalIds`/`toRemoteIds`, 참조도 함께). `verify-live.mjs` 가 플러그인 파서를 그대로 흉내 내서 대조군(짧은 id → 빨려 들어감)과 새 방식을 둘 다 확인한다.
- 이미 로컬에 짧은 id 로 들어간 도면은 매핑으로 못 고친다 → `scripts/fix-short-ids.mjs` 로 **서버 id 를 같은 8 자로 정리**(옛 id tombstone·빨려 들어간 글자는 마지막 `^id` 줄 뒤 원문으로 복구·다시 읽어 검증·소켓으로 열린 탭에 전파). architecture v27→28(14 개), structure v2→3(2 개) 적용.

### 향후 고려사항
- excalidraw 스킬이 텍스트 id 를 처음부터 8 자로 만들게 할 것(지금은 플러그인 매핑이 막는다).
- 닫혀 있던 도면은 **닫힌 채로** `Pull all` 해야 한다 — 열면 옛 구간을 먼저 읽어 다시 빨아들인다.

## Issue #10: 플러그인이 삭제를 추론해 만들어 라벨을 거듭 지웠다 (설계 결함 → 중단)
**상태: ⏸️ 보류 — 프로젝트 중단 (2026-09-23)** · 연관: Issue #9

### 문제
실시간 배포 뒤 architecture 라벨 14 개가 세 번 지워졌다(05:25·05:35·05:51 UTC). 05:35 에는 같은 id 가 두 벌씩 쌓여 push 마다 요소가 불어났다(146→294→606, 총 1,246).

### 원인
`withTombstones` 가 "서버에 있고 로컬에 없는 id = 로컬에서 지운 것" 으로 추론해 tombstone 을 만들고 version 에 `Date.now()` 를 붙였다. 로컬 사본이 늦거나(자동 저장 60 초를 기다리는 파일) 불완전하면(화면의 죽은 사본과 겹침) 그대로 대량 삭제·중복이 됐다. 도면 파일이 LiveSync 로도 동기화돼 다른 경로의 변경이 "편집" 으로 다시 올라갔다.

### 해결 방법
고치지 않고 **경로를 없앴다**: 도면은 ExcaliDash 에서만 편집(사용자 결정 B). 서버는 id 당 한 벌로 정리하고 라벨을 복구했다. 재개 원칙은 `current_status.md` ⛔.
