// verify-live — 실시간 경로의 세 규칙: id 매핑 · 본 적 있는 것만 삭제 · 바뀐 것만 전송.
//
//   node scripts/verify-live.mjs
//
// ① Excalidraw 플러그인은 저장할 때 id 가 8 자 넘는 텍스트를 무작위 8 자로 바꾼다. 매핑이 없으면
//    당겨올 때마다 한 벌씩 늘어난다(2026-09-23 `claude-text-1` 두 벌). 그 플러그인 동작을 흉내 내서
//    옛 방식이 실제로 불어나는지, 새 방식은 안 불어나는지 본다.
// ② 실시간이면 서버에 남이 방금 그린 요소가 늘 있다. "로컬에 없으면 지운 것" 이면 그걸 지운다.
// ③ 뷰를 주기적으로 읽어 보내므로, 바뀐 것만 나가야 하고 받은 걸 되돌려 보내면 안 된다.
//
// 함수는 main.ts 에서 뽑아 esbuild 로 트랜스파일한다(복사본은 원본이 바뀌어도 통과한다).

import fs from "node:fs";
import esbuild from "esbuild";

const SOURCE = "main.ts";
const src = fs.readFileSync(SOURCE, "utf8");

function extract(name, header) {
    const start = src.indexOf(header);
    if (start < 0) throw new Error(`${SOURCE} 에서 ${name} 을 찾지 못했다 — 모양이 바뀌었으면 이 검사도 고칠 것.`);
    const end = src.indexOf("\n}", start);
    return src.slice(start, end + 2);
}

const SHIM = "interface ExcalidrawScene { elements: unknown[]; appState: Record<string, unknown>; files: Record<string, unknown>; } type TFile = unknown; type ExcaliDashTarget = unknown;";
const names = {
    isRecord: "function isRecord(value: unknown): value is Record<string, unknown> {",
    elementId: "function elementId(element: unknown): string | null {",
    isLiveElement: "function isLiveElement(element: unknown): boolean {",
    liveIdsOf: "function liveIdsOf(",
    mergeScenes: "function mergeScenes(",
    withTombstones: "function withTombstones(",
    shortElementId: "function shortElementId(",
    remapElementIds: "function remapElementIds(",
    toLocalIds: "function toLocalIds(",
    toRemoteIds: "function toRemoteIds(",
    LiveRoom: "class LiveRoom {",
};
const ts = Object.entries(names).map(([n, h]) => extract(n, h)).join("\n\n");
const js = esbuild.transformSync(
    `${SHIM}\n${ts}\nglobalThis.__l = { ${Object.keys(names).join(", ")} };`,
    { loader: "ts", format: "cjs" },
).code;
new Function("exports", "module", js)({}, { exports: {} });
const L = globalThis.__l;

const fail = [];
const text = (id, v = 1, extra = {}) => ({ id, type: "text", text: id, version: v, versionNonce: v, isDeleted: false, ...extra });
const rect = (id, v = 1, extra = {}) => ({ id, type: "rectangle", version: v, versionNonce: v, isDeleted: false, ...extra });
const ids = (list) => list.map((e) => e.id);
const live = (list) => list.filter((e) => !e.isDeleted);

// Excalidraw 플러그인의 저장 흉내: 8 자 넘는 텍스트 id 를 무작위로 바꾼다(main.js findNewTextElementsInScene).
let n = 0;
const pluginSave = (els) => els.map((e) => (e.type === "text" && e.id.length > 8 ? { ...e, id: `rnd${String(n++).padStart(5, "0")}` } : e));

// ① 매핑: 서버의 긴 텍스트 id 를 세 번 당겨와도 한 벌
{
    const server = [text("claude-text-1"), rect("a-long-rectangle-id-000")];

    // 옛 방식(매핑 없음) — 대조군: 반드시 불어나야 한다
    let old = [];
    for (let i = 0; i < 3; i++) old = pluginSave(L.mergeScenes({ elements: old }, server).scene.elements);
    if (live(old).filter((e) => e.type === "text").length < 2) fail.push("대조군이 안 불어난다 — 검사 설계가 깨졌다");

    // 새 방식
    let local = [];
    for (let i = 0; i < 3; i++) {
        const localIds = new Set(ids(local));
        local = pluginSave(L.mergeScenes({ elements: local }, L.toLocalIds(server, localIds)).scene.elements);
    }
    const texts = live(local).filter((e) => e.type === "text");
    if (texts.length !== 1) fail.push(`매핑이 있어도 텍스트가 ${texts.length} 벌`);
    if (texts.some((e) => e.id.length > 8)) fail.push("로컬에 8 자 넘는 텍스트 id 가 남았다 — 플러그인이 또 바꾼다");

    // 되돌리면 서버 id 그대로
    const back = L.toRemoteIds(local, ids(server));
    if (ids(back).sort().join(",") !== ids(server).sort().join(",")) fail.push(`되돌린 id 가 서버와 다르다: ${ids(back)}`);
}

// ① 참조도 같이 바뀐다 (컨테이너 안 글자·화살표 바인딩)
{
    const box = rect("container-with-long-id", 1, { boundElements: [{ id: "bound-text-long-id", type: "text" }] });
    const label = text("bound-text-long-id", 1, { containerId: "container-with-long-id" });
    const arrow = { id: "arrow-long-id-0000", type: "arrow", version: 1, startBinding: { elementId: "bound-text-long-id" }, endBinding: null };
    const local = L.toLocalIds([box, label, arrow], new Set());
    const byType = Object.fromEntries(local.map((e) => [e.type, e]));
    if (byType.rectangle.boundElements[0].id !== byType.text.id) fail.push("boundElements 가 새 텍스트 id 를 안 가리킨다");
    if (byType.text.containerId !== byType.rectangle.id) fail.push("containerId 가 새 컨테이너 id 를 안 가리킨다");
    if (byType.arrow.startBinding.elementId !== byType.text.id) fail.push("화살표 바인딩이 새 id 를 안 가리킨다");
    const back = L.toRemoteIds(local, ["container-with-long-id", "bound-text-long-id", "arrow-long-id-0000"]);
    if (JSON.stringify(back) !== JSON.stringify([box, label, arrow])) fail.push("왕복하면 원본과 달라진다");
}

// ① 예전에 올린 긴 id(로컬에 그대로 있는 것)는 건드리지 않는다
{
    const out = L.toLocalIds([rect("already-local-long-id")], new Set(["already-local-long-id"]));
    if (out[0].id !== "already-local-long-id") fail.push("로컬에 있는 긴 id 를 바꿨다 — 한 벌 더 생긴다");
}

// ② 본 적 없는 서버 요소는 지우지 않는다
{
    const remote = [rect("seen"), rect("mine-deleted"), rect("theirs-new")];
    const scene = { elements: [rect("seen", 2)], appState: {}, files: {} };
    const known = new Set(["seen", "mine-deleted"]);

    const oldOut = L.withTombstones(scene, remote).elements; // 대조군: 옛 방식은 남의 신규까지 지운다
    if (!oldOut.some((e) => e.id === "theirs-new" && e.isDeleted)) fail.push("대조군이 남의 신규를 안 지운다 — 검사 설계가 깨졌다");

    const out = L.withTombstones(scene, remote, known).elements;
    if (out.some((e) => e.id === "theirs-new")) fail.push("본 적 없는 남의 신규 요소를 지웠다");
    if (!out.some((e) => e.id === "mine-deleted" && e.isDeleted)) fail.push("내가 지운 요소가 tombstone 으로 안 나갔다");
}

// ③ 바뀐 것만 보내고, 받은 건 되돌려 보내지 않는다
{
    const room = new L.LiveRoom(null, null, "d");
    const a = rect("a"), b = rect("b");
    if (room.takeChanges([a, b]).length !== 2) fail.push("처음엔 전부 나가야 한다");
    if (room.takeChanges([a, b]).length !== 0) fail.push("안 바뀌었는데 또 나갔다");

    const a2 = rect("a", 2);
    const out = room.takeChanges([a2, b]);
    if (ids(out).join(",") !== "a") fail.push(`바뀐 것만 나가야 한다: ${ids(out)}`);

    const fromServer = rect("c", 5);
    room.markSent([fromServer]);
    if (room.takeChanges([a2, b, fromServer]).length !== 0) fail.push("받은 요소를 되돌려 보냈다(에코)");

    // 씬에서 사라진 요소(플러그인의 id 교체) → tombstone
    const gone = room.takeChanges([a2, fromServer]);
    const t = gone.find((e) => e.id === "b");
    if (t === undefined || t.isDeleted !== true || !(t.version > 1)) fail.push("사라진 요소가 tombstone 으로 안 나갔다");
    if (room.takeChanges([a2, fromServer]).length !== 0) fail.push("tombstone 을 또 보냈다");
}

if (fail.length > 0) {
    for (const f of fail) console.error("FAIL:", f);
    process.exit(1);
}
console.log("live smoke test passed (id 매핑 왕복·참조·중복 없음, 본 것만 삭제, 바뀐 것만 전송·에코 없음 — 대조군 확인)");
