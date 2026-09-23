# CLAUDE.md — excalidash-obsidian-live

Obsidian 플러그인. **ExcaliDash 와 Obsidian Excalidraw 를 실시간으로 묶는다.**

`~/workspace_2026/obsidian-livesync`(vault 동기화)·`~/workspace_2026/excalidash-personal`(우리 ExcaliDash 인스턴스)과 짝이다. 진입점은 `docs/current_status.md` ▶.

## 이 repo 의 내력 (FORK — 지우지 말 것)

| | |
|---|---|
| upstream | `siredvin/excalidash-obsidian-sync` (MIT, Obsidian 커뮤니티 스토어 등재, v0.2.0 / 2026-07-31) |
| 리모트 | `upstream` 으로 등록돼 있다. `git fetch upstream && git rebase upstream/main` 로 따라간다 |
| 브랜치 | `feat/realtime-collab` — upstream `main` 에서 땄다 |
| 참고(코드 복사 금지) | `onefckcps/obsidian-excalidraw-share` — README 에 MIT 라 적혀 있으나 **LICENSE 파일이 없다**. 설계만 읽고 코드는 가져오지 않는다 |

upstream 이 이미 해 놓은 것: 설정 UI·frontmatter 계약·Excalidraw 씬 파싱(압축 JSON 포함)·ExcaliDash REST 클라이언트(생성/조회/갱신)·API 키 & 로그인 인증·컬렉션 해석·회귀 스크립트·BRAT 릴리스 워크플로. **다시 만들지 말 것.**

## 우리가 더하는 것 (이 브랜치의 전부)

1. **socket.io 실시간** — ExcaliDash 방에 참가해서 양방향으로 즉시 반영
2. **요소 단위 충돌 해소 + 영구 tombstone** (아래 §충돌 규칙)
3. **열린 뷰 즉시 갱신** — `ExcalidrawAutomate` 로 파일뿐 아니라 화면까지

upstream 은 수동 명령 기반이고 양방향일 때 충돌 해소가 약하다고 README 가 명시한다. 거기가 우리 자리다.

## 🔴 충돌 규칙 — 새로 설계하지 말 것

`~/.claude/skills/excalidraw/scripts/excalidash_upload.py` 의 docstring 이 정본이다. 2026-09-21 에 **두 번 사고를 내고** 얻은 규칙이고, `excalidash_stale_tab_test.py` 가 살아 있는 인스턴스에서 발화를 증명한다.

1. **요소 단위 reconcile** — 같은 `id` 는 `version` 큰 쪽이 이긴다. 공통 조상이 필요 없다(그래서 실시간에도 성립한다).
2. **삭제는 tombstone** — 새 씬에 없는 id 를 `isDeleted:true` + 더 큰 version 으로 **함께** 보낸다. 그냥 빼고 보내면 열린 편집기가 자기 사본을 되밀어 **부활한다**.
3. **tombstone 은 영구** — 전 판의 tombstone 을 다음 업로드에서 떨어뜨리면, 두 번 이상 올리는 동안 열려 있던 탭이 409 → 병합(로컬에만 있는 id 유지) → 옛 요소를 도로 올린다. 이미 죽은 id 도 매번 version 만 올려 같이 싣는다.
4. **낙관적 가드** — PUT 에 서버 `drawing.version` 을 실어 409 를 받으면 다시 읽고 재시도.
5. **올린 뒤 검증** — 다시 읽어 `살아 있는 id 집합 == 올린 id 집합`. 어긋나면 실패로 처리한다.

⚠️ Excalidraw 의 reconcile 을 **직접 구현하지 않는다.** 화면 반영은 `ExcalidrawAutomate` 에 맡기고, 서버 저장은 위 규칙대로 REST 로 한다.

⚠️ tombstone 은 요소 전체 사본이라 판이 거듭되면 씬이 커진다. 죽은 id 가 수천이면 `/drawings/:id/trim` + 열린 탭 전부 새로고침.

## ExcaliDash 쪽 사실 (실측)

| | |
|---|---|
| upstream | `ZimengXiong/ExcaliDash` (LGPL-3.0). 우리 인스턴스는 `~/workspace_2026/excalidash-personal` |
| REST | `GET/POST /api/collections` · `GET /api/drawings` · `GET /api/drawings/:id` · `POST/PUT /api/drawings[/:id]` |
| 실시간 | socket.io, path `/socket.io`. `join-room {drawingId, user}` → `element-update {elements, files, elementOrder}` · `cursor-move` · `presence-update` · `error` |
| 소스 | `frontend/src/pages/editor/useEditorCollaboration.ts` |
| 🔴 미확인 | **비브라우저 클라이언트가 `join-room` 을 할 수 있는가.** API 키는 upstream 정책상 drawings/collections 범위다. 핸드셰이크가 이걸 받는지 JWT 쿠키를 요구하는지 모른다 — **첫 작업이 이 probe 다** |
| 🔴 함정 | REST PUT 은 열린 탭에 브로드캐스트되지 않는다(reload 이벤트는 trim 만). 반대로 **우리가 방에서 `element-update` 를 쏘면 탭이 즉시 반영한다** — 그게 이 플러그인의 값어치다 |
| 🔴 함정 | 백엔드는 `fileId` 가 `^[\w-]{1,200}$` 가 아니면 **조용히 버린다**. 이미지가 통째로 사라진다 |
| 인스턴스 | `http://127.0.0.1:6768` (tailnet `:8445`). 자격증명 = `excalidash-personal/.env` (600, **출력 금지**) |

## Obsidian 쪽 사실 (실측)

- 짝 플러그인 = `zsviczian/obsidian-excalidraw-plugin` v2.27.3. 열린 뷰 조작은 `ExcalidrawAutomate`: `ea.setView()` → `ea.addElementsToView()` (`docs/API/introduction.md`).
- 설정 `compatibilityMode: true` 면 평범한 `.excalidraw` 를 직접 편집한다(기본은 `.excalidraw.md` 래퍼라 파일이 둘이 된다). `syncExcalidraw`·`autoexportExcalidraw`·`keepInSync` 도 관련.
- 배포는 `.obsidian/plugins/<id>/{main.js,manifest.json,styles.css}` 복사로 끝. 스토어 심사 불필요. LiveSync 의 `usePluginSyncV2` 를 켜면 vault 를 타고 전 기기(Gram·Mac·아이패드)로 퍼진다.
- 모바일 지원 여부는 `manifest.json` 의 `isDesktopOnly`. **모바일에서 socket.io 핸드셰이크·쿠키가 되는지 미검증** — 아이패드가 주 편집 기기라 여기가 중요하다.

## 작업 규칙

- 코드 작업은 **ponytail**(YAGNI·최단 diff). 새 추상화·설정 항목을 함부로 늘리지 않는다 — upstream 과 rebase 해야 한다.
- 비자명한 로직은 검사를 하나 남긴다. upstream 이 `scripts/verify-*.mjs` 패턴을 쓰니 **그 패턴을 따른다**(새 프레임워크 도입 금지).
- **충돌 규칙은 발화를 증명해야 한다** — `excalidash_stale_tab_test.py` 처럼 "옛 방식이면 부활, 새 방식이면 안 부활" 양쪽을 다 확인하는 테스트여야 한다. 통과만 하는 테스트는 확인 편향이다.
- `.env`·API 키·비밀번호는 **채팅·로그·커밋에 절대 넣지 않는다.**
- commit·push·PR 은 **사용자가 명시적으로 요청할 때만.**
- upstream 에 돌려줄 만한 수정(버그·API 키 등)은 별도 브랜치로 분리해 두면 PR 하기 쉽다.

## 명령

```bash
npm install
npm run dev          # esbuild watch
npm run build
node scripts/verify-compressed-json.mjs
node scripts/verify-collection-resolution.mjs
```
