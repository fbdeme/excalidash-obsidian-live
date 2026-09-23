// verify-text-elements-section — pull 이 씬을 쓸 때 `## Text Elements` 도 같이 맞추는가.
//
//   node scripts/verify-text-elements-section.mjs
//
// 2026-09-23, 오늘 사고의 진짜 원인. Excalidraw 플러그인은 도면의 글자를 `## Text Elements` 에
// `<텍스트> ^<요소 id>` 로 풀어 적고 **파일을 읽을 때 거기서 텍스트를 가져온다**. 그래서 압축 씬
// 블록만 바꾸고 이 구간을 옛것 그대로 두면 둘이 어긋나, 엉뚱한 요소에 목록이 통째로 들어간다.
//
// 옛 방식(구간을 안 건드림)이 실제로 어긋나는지도 같이 확인한다 — 그래야 통과가 의미를 가진다.

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
    extract("rewriteTextElementsSection", "function rewriteTextElementsSection("),
].join("\n\n");

const js = esbuild.transformSync(
    `${SHIM}\n${ts}\nglobalThis.__r = rewriteTextElementsSection;`,
    { loader: "ts", format: "cjs" },
).code;
new Function("exports", "module", js)({}, { exports: {} });
const rewrite = globalThis.__r;

const RAW = [
    "---",
    "excalidraw-plugin: parsed",
    "---",
    "",
    "# Excalidraw Data",
    "",
    "## Text Elements",
    "옛 라벨 ^stale-1",
    "",
    "또 다른 옛 라벨 ^stale-2",
    "",
    "## Drawing",
    "```compressed-json",
    "AAAA",
    "```",
    "%%",
].join("\n");

const scene = {
    elements: [
        { id: "t1", type: "text", text: "새 라벨" },
        { id: "gone", type: "text", text: "지워진 것", isDeleted: true },
        { id: "box", type: "rectangle" },
        { id: "t2", type: "text", text: "두 번째" },
    ],
    appState: {},
    files: {},
};

const refsOf = (md) => {
    const m = /## Text Elements\n([\s\S]*?)\n## /.exec(md);
    if (!m) return null;
    return m[1].split("\n").filter((l) => l.trim()).map((l) => /\^(\S+)\s*$/.exec(l)?.[1] ?? l);
};
const fail = [];
const out = rewrite(RAW, scene);

// ① 씬의 살아 있는 텍스트 요소와 정확히 일치해야 한다
{
    const refs = refsOf(out);
    if (refs === null) fail.push("Text Elements 구간이 사라졌다");
    else if (refs.join(",") !== "t1,t2") fail.push(`구간이 씬과 다르다: ${refs}`);
    if (out.includes("stale-1") || out.includes("stale-2")) fail.push("옛 항목이 남았다");
    if (out.includes("^gone")) fail.push("지워진 요소가 목록에 남았다");
    if (out.includes("^box")) fail.push("텍스트가 아닌 요소가 목록에 들어갔다");
    if (!out.includes("새 라벨 ^t1")) fail.push("텍스트 내용이 안 들어갔다");
}

// ② 나머지 부분은 건드리면 안 된다
for (const keep of ["excalidraw-plugin: parsed", "# Excalidraw Data", "```compressed-json", "AAAA", "%%"]) {
    if (!out.includes(keep)) fail.push(`문서의 다른 부분이 사라졌다: ${keep}`);
}

// ③ 옛 방식(구간 미수정)은 실제로 어긋난다 — 이 검사가 뭘 막는지 증명
{
    const refs = refsOf(RAW);
    if (refs.join(",") === "t1,t2") fail.push("대조군이 이미 일치한다 — 검사 설계가 깨졌다");
}

// ④ 구간이 없는 문서에서는 아무것도 하지 않는다
{
    const plain = "no sections here";
    if (rewrite(plain, scene) !== plain) fail.push("구간이 없는데 문서를 고쳤다");
}

// ⑤ 텍스트 요소가 하나도 없어도 안 터진다
{
    try {
        const empty = rewrite(RAW, { elements: [{ id: "box", type: "rectangle" }], appState: {}, files: {} });
        if (/\^(stale|t1|t2)/.test(empty)) fail.push("빈 씬인데 옛 항목이 남았다");
    } catch (e) {
        fail.push(`빈 씬에서 터졌다: ${e}`);
    }
}

if (fail.length > 0) {
    for (const f of fail) console.error("FAIL:", f);
    process.exit(1);
}
console.log("text-elements section smoke test passed (씬과 일치·옛 항목 제거·나머지 보존, 옛 방식 불일치 확인)");
