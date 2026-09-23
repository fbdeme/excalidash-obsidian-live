// verify-tombstones — 지운 요소가 실제로 서버에서도 지워지는가.
//
//   node scripts/verify-tombstones.mjs
//
// 2026-09-23 실측: Obsidian 에서 지운 도형이 ExcaliDash 에 그대로 남았다(structure 23 개, architecture 2 개).
// ExcaliDash 는 요소 단위로 병합한다 — 같은 id 는 version 큰 쪽이 이기고, **빠진 id 는 건드리지 않는다.**
// Excalidraw 플러그인은 지운 요소를 씬에서 아예 빼므로 로컬에 tombstone 이 없다. 그래서 보낼 때 만들어야 한다.
//
// 함수는 복사하지 않고 main.ts 에서 뽑아 쓴다. 옛 방식(씬을 그대로 전송)이 실제로 유령을 남기는지도 확인한다.

import fs from "node:fs";
import esbuild from "esbuild";

const SOURCE = "main.ts";
const src = fs.readFileSync(SOURCE, "utf8");

function extract(name, header) {
    const start = src.indexOf(header);
    if (start < 0) {
        throw new Error(`${SOURCE} 에서 ${name} 을 찾지 못했다 — 모양이 바뀌었으면 이 검사도 고칠 것.`);
    }
    const end = src.indexOf("\n}", start);
    return src.slice(start, end + 2);
}

// 타입 주석은 정규식으로 벗기지 않는다 — 금방 깨진다. 이미 의존성에 있는 esbuild 로 트랜스파일한다.
const SHIM = "interface ExcalidrawScene { elements: unknown[]; appState: Record<string, unknown>; files: Record<string, unknown>; }";
const ts = [
    extract("isRecord", "function isRecord(value: unknown): value is Record<string, unknown> {"),
    extract("elementId", "function elementId(element: unknown): string | null {"),
    extract("isLiveElement", "function isLiveElement(element: unknown): boolean {"),
    extract("withTombstones", "function withTombstones("),
].join("\n\n");
const full = `${SHIM}\n${ts}`;

const js = esbuild.transformSync(
    `${full}\nglobalThis.__withTombstones = withTombstones;`,
    { loader: "ts", format: "cjs" },
).code;

new Function("exports", "module", js)({}, { exports: {} });
const withTombstones = globalThis.__withTombstones;

const el = (id, version, isDeleted = false) => ({
    id,
    type: "rectangle",
    version,
    versionNonce: version,
    isDeleted,
});
const liveIds = (list) => list.filter((e) => !e.isDeleted).map((e) => e.id).sort();
const byId = (list, id) => list.find((e) => e.id === id);
const fail = [];

// ① 로컬에서 지운 요소가 tombstone 으로 나가야 한다
{
    const remote = [el("a", 5), el("b", 5), el("c", 5)];
    const scene = { elements: [el("a", 6), el("c", 6)], appState: {}, files: {} };
    const out = withTombstones(scene, remote).elements;

    const b = byId(out, "b");
    if (b === undefined) fail.push("지운 요소 b 가 전송 목록에 아예 없다 — 서버가 계속 들고 있게 된다");
    else {
        if (b.isDeleted !== true) fail.push("b 가 isDeleted 로 표시되지 않았다");
        if (!(b.version > 5)) fail.push(`b 의 version 이 안 올라갔다(${b.version}) — 병합에서 서버 사본이 이긴다`);
    }
    if (liveIds(out).join(",") !== "a,c") fail.push(`살아있는 집합이 어긋났다: ${liveIds(out)}`);
}

// ② 옛 방식이면 유령이 남는다 (이 검사가 뭘 막는지 증명)
{
    const remote = [el("a", 5), el("b", 5)];
    const scene = { elements: [el("a", 6)], appState: {}, files: {} };
    const legacyOut = scene.elements; // upstream: 씬을 그대로 PUT
    const remoteAfter = new Map(remote.map((e) => [e.id, e]));
    for (const e of legacyOut) remoteAfter.set(e.id, e); // 서버의 요소 단위 병합
    const ghosts = [...remoteAfter.values()].filter((e) => !e.isDeleted && e.id === "b");
    if (ghosts.length !== 1) fail.push("대조군이 유령을 안 남겼다 — 검사 설계가 깨졌다");
}

// ③ 이미 죽은 요소도 계속 실어야 한다 (영구 tombstone)
{
    const remote = [el("a", 5), el("dead", 9, true)];
    const scene = { elements: [el("a", 6)], appState: {}, files: {} };
    const out = withTombstones(scene, remote).elements;
    const dead = byId(out, "dead");
    if (dead === undefined) {
        fail.push("이미 죽은 id 가 빠졌다 — 열려 있던 편집기가 다음 저장에서 되살린다");
    } else if (!(dead.version > 9)) {
        fail.push(`죽은 id 의 version 이 안 올라갔다(${dead.version})`);
    }
}

// ④ 지운 게 없으면 원본 그대로여야 한다
{
    const remote = [el("a", 5)];
    const scene = { elements: [el("a", 6)], appState: {}, files: {} };
    const out = withTombstones(scene, remote).elements;
    if (out.length !== 1) fail.push(`변경이 없는데 요소가 늘었다: ${out.length}`);
}

// ⑤ 원격이 비었거나 이상해도 견뎌야 한다
for (const [label, remote] of [["빈 배열", []], ["id 없는 요소", [{ type: "x" }]]]) {
    try {
        const out = withTombstones({ elements: [el("a", 1)], appState: {}, files: {} }, remote).elements;
        if (liveIds(out).join(",") !== "a") fail.push(`${label}: 살아있는 집합이 어긋났다`);
    } catch (e) {
        fail.push(`${label} 에서 터졌다: ${e}`);
    }
}

if (fail.length > 0) {
    for (const f of fail) console.error("FAIL:", f);
    process.exit(1);
}
console.log("tombstone smoke test passed (삭제 전파·영구 tombstone·무변경 보존, 옛 방식 유령 확인)");
