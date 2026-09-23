// verify-merge — pull 이 원격을 로컬에 합칠 때, 그리고 라이브러리를 합칠 때 규칙이 맞는가.
//
//   node scripts/verify-merge.mjs
//
// 여러 사람이 같은 도면을 동시에 고치는 게 목적이라, 병합은 **승자를 고르지 않는다** —
// 같은 id 는 version 큰 쪽이 이기고, 서로 다른 요소는 둘 다 산다. 공통 조상이 필요 없어서
// 실시간에도 그대로 성립한다. 이게 깨지면 남의 편집이 조용히 사라진다.
//
// 함수는 복사하지 않고 main.ts 에서 뽑아 esbuild 로 트랜스파일한다.

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

const SHIM = "interface ExcalidrawScene { elements: unknown[]; appState: Record<string, unknown>; files: Record<string, unknown>; }";
const ts = [
    extract("isRecord", "function isRecord(value: unknown): value is Record<string, unknown> {"),
    extract("elementId", "function elementId(element: unknown): string | null {"),
    extract("mergeScenes", "function mergeScenes("),
    extract("mergeLibraryItems", "function mergeLibraryItems("),
].join("\n\n");

const js = esbuild.transformSync(
    `${SHIM}\n${ts}\nglobalThis.__m = { mergeScenes, mergeLibraryItems };`,
    { loader: "ts", format: "cjs" },
).code;
new Function("exports", "module", js)({}, { exports: {} });
const { mergeScenes, mergeLibraryItems } = globalThis.__m;

const el = (id, version, extra = {}) => ({ id, type: "rectangle", version, ...extra });
const ids = (list) => list.map((e) => e.id).sort().join(",");
const fail = [];

// ① 원격에만 있는 요소는 들어와야 한다 (= 내가 그린 게 당신에게 간다)
{
    const local = { elements: [el("a", 1)], appState: {}, files: {} };
    const { scene, changed } = mergeScenes(local, [el("a", 1), el("b", 1)]);
    if (ids(scene.elements) !== "a,b") fail.push(`원격 신규가 안 들어왔다: ${ids(scene.elements)}`);
    if (changed !== 1) fail.push(`changed 가 ${changed} (1 이어야 함)`);
}

// ② 같은 id 는 version 큰 쪽이 이긴다
{
    const local = { elements: [el("a", 9, { text: "mine" })], appState: {}, files: {} };
    const { scene } = mergeScenes(local, [el("a", 3, { text: "theirs" })]);
    if (scene.elements[0].text !== "mine") fail.push("version 작은 원격이 로컬을 덮었다");

    const local2 = { elements: [el("a", 3, { text: "mine" })], appState: {}, files: {} };
    const { scene: s2 } = mergeScenes(local2, [el("a", 9, { text: "theirs" })]);
    if (s2.elements[0].text !== "theirs") fail.push("version 큰 원격이 반영되지 않았다");
}

// ③ 로컬에만 있는 요소는 살아남아야 한다 (= 내 편집이 안 사라진다)
{
    const local = { elements: [el("a", 1), el("mine", 1)], appState: {}, files: {} };
    const { scene } = mergeScenes(local, [el("a", 2)]);
    if (!ids(scene.elements).includes("mine")) fail.push("로컬 전용 요소가 사라졌다");
}

// ④ 원격의 tombstone 은 반영되어야 한다 (= 남이 지운 게 나에게도 지워진다)
{
    const local = { elements: [el("a", 1)], appState: {}, files: {} };
    const { scene } = mergeScenes(local, [el("a", 5, { isDeleted: true })]);
    if (scene.elements[0].isDeleted !== true) fail.push("원격 tombstone 이 무시됐다");
}

// ⑤ 바뀐 게 없으면 changed 0 (= 쓸데없이 파일을 안 쓴다)
{
    const local = { elements: [el("a", 4)], appState: {}, files: {} };
    const { changed } = mergeScenes(local, [el("a", 4)]);
    if (changed !== 0) fail.push(`무변경인데 changed=${changed}`);
}

// ⑥ 대조군: "원격으로 통째 교체" 였다면 로컬 전용 요소가 죽는다 — 이 검사가 뭘 막는지 증명
{
    const local = [el("a", 1), el("mine", 1)];
    const replaced = [el("a", 2)];
    if (ids(replaced).includes("mine")) fail.push("대조군 설계가 깨졌다");
}

// ⑦ 라이브러리: id 합집합 · 같은 id 는 created 큰 쪽
{
    const merged = mergeLibraryItems(
        [{ id: "x", created: 100, name: "old" }, { id: "only-local", created: 1 }],
        [{ id: "x", created: 200, name: "new" }, { id: "only-remote", created: 1 }],
    );
    const byId = Object.fromEntries(merged.map((i) => [i.id, i]));
    if (Object.keys(byId).sort().join(",") !== "only-local,only-remote,x")
        fail.push(`라이브러리 합집합이 틀렸다: ${Object.keys(byId)}`);
    if (byId.x.name !== "new") fail.push("라이브러리에서 created 큰 쪽이 안 이겼다");
}

// ⑧ 라이브러리: id 없는 항목·빈 목록에도 안 터진다
for (const [label, a, b] of [["빈 목록", [], []], ["id 없음", [{ name: "x" }], [null, 3]]]) {
    try {
        if (!Array.isArray(mergeLibraryItems(a, b))) fail.push(`${label}: 배열이 아니다`);
    } catch (e) {
        fail.push(`${label} 에서 터졌다: ${e}`);
    }
}

if (fail.length > 0) {
    for (const f of fail) console.error("FAIL:", f);
    process.exit(1);
}
console.log("merge smoke test passed (요소 version 승·로컬 보존·tombstone 반영·라이브러리 합집합)");
