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
