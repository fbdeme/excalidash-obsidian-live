# TODO

## 1. 사전 확인 (코드보다 먼저)

- [x] socket.io `join-room` 을 비브라우저 클라이언트가 할 수 있는가 (2026-09-23) — **API 키로는 안 된다**
- [x] 로그인 JWT 로 핸드셰이크 (2026-09-23) — `auth.token`·`Cookie` 둘 다 됨
- [x] `element-update` 왕복 확인 (2026-09-23) — **`drawingId` 필수**, 서버는 중계만 하고 저장 안 함
- [ ] 모바일(아이패드) Obsidian 에서 socket.io 연결이 되는가 — 주 편집 기기라 필수
- [ ] upstream 플러그인이 vault 에 깔린 상태에서 `ExcalidrawAutomate` 접근이 되는가 (`ea.setView`)

## 1b. 저장 시 자동 동기화 (A)

- [x] `vault.on("modify")` → 디바운스 → opt-in 된 파일만 동기화 (2026-09-23)
- [x] 되쓰기 루프 방지 — 억제 장치 없이 구조로 막힘(씬 해시 같으면 `skipped`, frontmatter 안 씀)
- [x] 검사 `scripts/verify-auto-sync-debounce.mjs` (되돌리면 exit 1 실측)
- [ ] 실제 기기에서 그려 보며 2.5 초 디바운스가 적당한지 확인

## 2. 실시간 배관

- [ ] socket.io-client 번들 (esbuild, 크기 확인)
- [ ] access 토큰 15분 만료 갱신 (Issue #5)
- [ ] 방 참가·재참가 상태 기계 — 파일 닫았다 열기·네트워크 끊김 복구
- [ ] 원격 `element-update` → 열린 뷰면 `ea.addElementsToView()`, 아니면 파일에 기록
- [ ] 로컬 변경 → 방에 `element-update` 전파 (A 의 디바운스 재사용)
- [ ] **접속·재접속 시 한 번 대조** — socket 이벤트는 재방송되지 않으므로, 꺼져 있던/끊겼던 동안의 변경은 이걸로만 메운다. 주기 폴링 대신 이걸 쓴다(토큰 15 분 만료로 재접속이 잦아 자연히 자주 돈다)

## 3. 충돌 해소 (CLAUDE.md §충돌 규칙 그대로)

- [ ] 요소 단위 reconcile: 같은 id 는 `version` 큰 쪽
- [ ] 삭제 = tombstone(`isDeleted:true` + 더 큰 version), **영구 적재**
- [ ] PUT 에 서버 `drawing.version` 낙관적 가드 → 409 시 재읽기·재시도
- [ ] 업로드 후 검증: 살아 있는 id 집합 == 올린 id 집합
- [ ] tombstone 누적 대비 — 죽은 id 임계치 넘으면 경고(`/drawings/:id/trim` 안내)

## 4. 검사 (통과만 하는 테스트 금지 — 발화를 증명할 것)

- [ ] 되살리기 재현: 옛 방식이면 **부활해야** 하고 새 방식이면 **안 부활해야** 한다 (`excalidash_stale_tab_test.py` 의 TS 판)
- [ ] 요소 단위 병합: 양쪽이 서로 다른 요소를 고쳤을 때 둘 다 살아남는가
- [ ] 같은 요소를 양쪽이 고쳤을 때 version 큰 쪽이 이기는가
- [ ] `fileId` 가 `^[\w-]{1,200}$` 를 어겨 이미지가 조용히 버려지는 경우 검출
- [ ] upstream 회귀 스크립트 2 종이 계속 통과하는가

## 5. 배포

- [ ] `manifest.json` — id·이름·`isDesktopOnly` 결정 (upstream 과 충돌하지 않게)
- [ ] `.obsidian/plugins/` 수동 설치로 Gram·Mac·아이패드 검증
- [ ] LiveSync `usePluginSyncV2` 로 전 기기 자동 배포할지 결정
- [ ] upstream 에 돌려줄 수정 분리 (PR 가능하게)

## 6. 보류 / 판단 필요

- [ ] 실시간이 정말 필요한 범위 — 혼자 쓸 땐 폴백(파일 감시 + 5 분 폴링)으로 충분할 수 있다
- [ ] 프로젝트별 `.canvas` 생성(별건, `obsidian-livesync` 쪽 작업)
