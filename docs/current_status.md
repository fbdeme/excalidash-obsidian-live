# excalidash-obsidian-live — 현재 상태

> 최종 업데이트: 2026-09-23 (**양방향 동작** — push·pull·라이브러리 공유. 열린 뷰 주입까지. ▶ 다음 = socket.io 실시간)

## ▶ 다음 세션

**양방향이 닫혔다.** 사용자 실측: ExcaliDash 에서 그린 것이 Obsidian 에 들어오고, Obsidian 에서 그린 것이 ExcaliDash 로 나간다. 도면을 **열어둔 채로도** 반영된다.

1. **실시간(C)** — 남은 건 socket.io `element-update` 를 받아 `pullIntoOpenView` 를 부르는 것뿐이다. 프로토콜은 probe 로 증명했고(아래), 뷰 주입 경로도 뚫렸다.
2. 텍스트 요소 **id 재발급** 확인 — 뷰 주입 뒤 id 가 바뀌는 것으로 보인다(Issue #8 남은 관찰). id 기준 병합의 전제라 실시간 전에 확인할 것.
3. 모바일(아이패드)에서 socket.io 가 되는가 — 아직 미확인.
4. 프로젝트별 도면 목록 노트 자동 생성(매핑 5·6번).

## 지금 되는 것 (2026-09-23 실측)

| | 상태 |
|---|---|
| Obsidian → ExcaliDash | ✅ 저장할 때 자동(2.5 초 디바운스) · 삭제는 tombstone 으로 전파 |
| ExcaliDash → Obsidian | ✅ `Pull all drawings` · **도면이 열려 있으면 뷰에 직접 주입** |
| 스텐실 라이브러리 | ✅ 양방향(249 항목). ⚠️ `/api/library` 는 API 키 범위 밖이라 **비밀번호 필요** |
| 충돌 | ✅ 요소 단위 version 승 · 공통 조상 불필요 → 다자 편집 가능 |
| 정본 | ExcaliDash. vault 파일은 클라이언트 사본 |

## Probe 결과 (2026-09-23) — 둘 다 통과

`scripts/probe-socket.mjs` · `scripts/probe-roundtrip.mjs`, 우리 인스턴스(`127.0.0.1:6768`) 실측.

| 질문 | 답 |
|---|---|
| 비브라우저 클라이언트가 방에 들어갈 수 있나 | **된다 — 로그인 JWT 로만.** 익명도 API 키도 `denied` |
| 어디에 실어야 하나 | `handshake.auth.token` · `Cookie: excalidash-access-token=…` **둘 다 됨** |
| element-update 가 오가나 | **오간다.** B 가 `elements=["b"] elementOrder=["a","b"]` 수신 |
| socket 이 저장도 하나 | **안 한다.** 서버 씬은 그대로 — `socket.to(roomId).emit(...)` **중계만** |

### 설계에 직결되는 것 넷

1. **인증이 둘로 갈린다** — REST 는 API 키, socket 은 JWT. 핸드셰이크가 `jwt.verify` 라 API 키는 JWT 가 아니라서 익명으로 떨어진다. upstream 의 `generateApiKeyFromLogin` 이 이미 `POST /api/auth/login` 을 하니 그 경로를 재사용한다.
2. **`element-update` 에 `drawingId` 가 없으면 서버가 조용히 버린다**(`backend/src/server/socket.ts:288`). 에러도 안 준다. 첫 왕복 시도가 이것 때문에 실패했다 — 계약을 추측하지 말고 핸들러를 읽을 것.
3. **2 채널 설계가 실측으로 맞다** — socket 은 영속화하지 않으므로 저장은 REST(영구 tombstone·409 가드)로 가야 한다. 여기서 CLAUDE.md §충돌 규칙이 그대로 필요해진다.
4. **access 토큰 TTL 15 분**(Issue #5). 상시 연결은 갱신이 필요하다.

## 선행자산 조사 (2026-09-22, 판정 = FORK)

새로 만들기 전에 찾는다. 커뮤니티 플러그인 **전수 7,901 개**(`obsidianmd/obsidian-releases` 의 `community-plugins.json`)를 받아 훑고, GitHub·웹을 각도별로 검색했다.

| 후보 | 실측 | 판정 |
|---|---|---|
| **`siredvin/excalidash-obsidian-sync`** | MIT(LICENSE 파일 있음) · 커뮤니티 스토어 등재 · v0.2.0(2026-07-31) · 별 0 · main.ts 1,739 줄. ExcaliDash REST 클라이언트·API 키/로그인 인증·frontmatter 계약·씬 파싱(압축 JSON)·컬렉션 해석·회귀 스크립트·BRAT 릴리스 워크플로. **양방향도 있다**(frontmatter opt-in). 다만 **실시간 아님**(수동 명령), websocket 없음, 양방향 충돌 해소가 약하다고 README 가 자인 | **FORK** ← 이 repo |
| `onefckcps/obsidian-excalidraw-share` | 별 0 · 포크 0 · 릴리스 없음 · 생성 2026-02-21 · 커밋 9/18~19 로 매우 활발. Rust/Axum 백엔드 + WebSocket 협업 + Obsidian 플러그인. 커밋 제목이 정확히 우리 난제("robust join state machine + offline conflict resolution", "session theft guard", "auto-rejoin live collab"). **README 엔 MIT 라 쓰여 있으나 LICENSE 파일이 없다** | **REFERENCE** — 설계만 읽는다. 코드 복사 금지. 자체 서버를 들고 오므로 ExcaliDash 를 대체하지 보완하지 않는다 |
| `zsviczian/obsidian-excalidraw-plugin` | 7,631⭐ · v2.27.3(2026-09-06). `ExcalidrawAutomate` API 로 열린 뷰 조작 가능. excalidraw.com 협업 방 생성은 되지만 **참가**는 안 된다(excalidraw 討論 #4969) | **의존** — 우리 플러그인의 짝 |
| `rmoff/obsidian-canvas-export` | `.canvas` → Excalidraw/Mermaid/D2/PDF **역방향** | SKIP |
| Peerdraft · Relay(system3) · screengarden 등 | Obsidian 실시간 협업은 여럿 있으나 전부 **문서·폴더** 대상. Excalidraw 씬도 ExcaliDash 도 모른다 | SKIP |

**결론**: ExcaliDash ↔ Obsidian 을 잇는 건 upstream 하나뿐이고, 실시간은 아무도 안 했다. 배관의 60~70% 를 물려받고 실시간·충돌 해소만 얹으면 된다.

## 설계

```
아이패드/Mac/Gram  Obsidian + Excalidraw 플러그인
        │  ExcalidrawAutomate (열린 뷰 즉시 갱신)
        ▼
   이 플러그인  ──socket.io(알림·전파)──▶  ExcaliDash 방
        │                                    ▲
        └──REST(저장, 영구 tombstone)────────┘
```

**두 채널로 나눈다.** 저장은 검증된 REST 경로(영구 tombstone·409 가드·업로드 후 검증), socket 은 변경 감지와 열린 탭 전파에만 쓴다. Excalidraw 의 reconcile 을 파이썬/TS 로 다시 구현하지 않는다 — 버그 하나가 씬을 망가뜨린다.

충돌 규칙 원문은 `CLAUDE.md` §충돌 규칙. 정본은 `~/.claude/skills/excalidraw/scripts/excalidash_upload.py` docstring.

### 폴백

probe 가 실패하면 실시간을 버리고 **파일 감시(push) + 주기 폴링(pull, ~5분)** 으로 내려간다. 이 경우에도 tombstone 규칙은 그대로 필요하고, "올린 뒤 탭 새로고침" 불편이 남는다.

## 왜 이 프로젝트인가

2026-09-22 에 Obsidian 이 Gram·Mac·아이패드·아이폰에 모두 깔리고 vault 가 동기화됐다([[project_obsidian_livesync]]). 그래서 보드를 전 기기에서 보는 문제는 이미 풀렸고, ExcaliDash 에 남는 고유 가치는 **브라우저만으로 보기**와 **남에게 공유(scoped sharing)** 다. 이 둘을 살리려면 두 시스템이 같은 그림을 들고 있어야 하고, 편집 지점이 둘이면 실시간이 아니고서는 계속 어긋난다.

## 2026-09-22 한 것

| 항목 | 상태 |
|---|---|
| 선행자산 조사 | ✅ 위 표. 커뮤니티 플러그인 전수 + GitHub + 웹 |
| repo | ✅ upstream clone → 리모트 `upstream` · 브랜치 `feat/realtime-collab` |
| 규율 | ✅ `CLAUDE.md`(내력·충돌 규칙·실측 사실·작업 규칙) · docs-pattern 4 종 |
| 커밋 | ❌ 이날은 안 함 |

## 2026-09-23 한 것

| 항목 | 상태 |
|---|---|
| probe ① 방 참가 | ✅ `scripts/probe-socket.mjs` — 익명·API 키는 denied, 로그인 JWT 는 joined |
| probe ② 왕복 | ✅ `scripts/probe-roundtrip.mjs` — 임시 드로잉에 소켓 둘, 전파 확인 후 드로잉 삭제 |
| 공개 | ✅ public repo (MIT, upstream 파생 명시) |
