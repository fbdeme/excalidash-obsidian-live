// fix-short-ids — 서버 도면의 "8 자가 아닌 텍스트 id" 를 플러그인과 같은 8 자 id 로 바꾸고,
//                 Text Elements 구간이 빨려 들어간 텍스트는 원래 글자로 되돌린다. 열린 탭에는 소켓으로 바로 알린다.
//
//   node scripts/fix-short-ids.mjs --base http://127.0.0.1:6768 --env <인스턴스>/.env --drawing <id> [--apply]
//
// 왜: Obsidian Excalidraw 플러그인은 `## Text Elements` 를 정확히 8 자 id 로만 끊어 읽는다. 그보다
// 짧은 id(`desc:t0`, `th`)의 줄은 다음 8 자 id 텍스트에 통째로 붙는다. 플러그인은 이제 들어오는 id 를
// 매핑하지만, **이미 로컬에 짧은 id 로 들어간 요소**는 매핑 대상이 아니다(한 벌 더 생기므로). 그래서
// 서버 쪽 id 를 한 번 정리한다. 새 id 는 main.ts 의 shortElementId 그대로 — 플러그인이 같은 id 를 계산한다.
//
// 규칙은 CLAUDE.md §충돌 규칙: 옛 id 는 tombstone(version+1)으로 함께 보내고, 올린 뒤 다시 읽어 검증한다.
// 기본은 dry-run. --apply 가 있어야 쓴다.

import fs from "node:fs";
import esbuild from "esbuild";
import { io } from "socket.io-client";

const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : d;
};
const BASE = arg("base", "http://127.0.0.1:6768");
const ENV = arg("env");
const DRAWING = arg("drawing");
const APPLY = process.argv.includes("--apply");
if (!ENV || !DRAWING) { console.error("--env 와 --drawing 필요"); process.exit(2); }

// main.ts 에서 함수를 뽑는다 — 플러그인과 같은 id 를 내야 한다.
const src = fs.readFileSync(new URL("../main.ts", import.meta.url), "utf8");
const extract = (h) => { const s = src.indexOf(h); if (s < 0) throw new Error(`main.ts 에 ${h} 없음`); return src.slice(s, src.indexOf("\n}", s) + 2); };
const js = esbuild.transformSync(
    [
        "function isRecord(value: unknown): value is Record<string, unknown> {",
        "function shortElementId(",
        "function remapElementIds(",
    ].map(extract).join("\n") + "\nglobalThis.__f = { shortElementId, remapElementIds };",
    { loader: "ts", format: "cjs" },
).code;
new Function(js)();
const { shortElementId, remapElementIds } = globalThis.__f;

const kv = Object.fromEntries(
    fs.readFileSync(ENV, "utf8").split("\n")
        .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
        .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const API = { Authorization: `Bearer ${kv.EXCALIDASH_API_KEY}` };
const get = () => fetch(`${BASE}/api/drawings/${DRAWING}`, { headers: API }).then((r) => r.json());

// 구간이 빨려 들어간 텍스트: "… ^id" 줄이 두 개 이상 들어 있다.
const isSwallowed = (e) => e.type === "text" && (String(e.text ?? "").match(/\s\^\S+\n/g) ?? []).length >= 2;
const needsId = (e) => (e.type === "text" || e.link) && e.id.length !== 8;

const drawing = await get();
const live = drawing.elements.filter((e) => !e.isDeleted);
const swallowed = live.filter(isSwallowed);
const rename = new Map(live.filter(needsId).map((e) => [e.id, shortElementId(e.id)]));
// 빨려 들어간 글자는 피해자 것이 아니다. 원래 글자는 마지막 "… ^id" 줄 뒤에 남아 있다.
const restored = (e) => String(e.text).replace(/^[\s\S]*\s\^\S+\n+/, "");

const taken = new Set(drawing.elements.map((e) => e.id));
for (const [from, to] of rename) if (taken.has(to)) throw new Error(`id 충돌: ${from} → ${to} 가 이미 있다`);

const remapped = remapElementIds(drawing.elements, rename);
const out = [];
drawing.elements.forEach((before, i) => {
    let after = remapped[i];
    if (swallowed.includes(before)) after = { ...after, text: restored(before), originalText: restored(before), rawText: restored(before) };
    if (after.id !== before.id) {
        out.push({ ...after, version: before.version + 1 }); // 새 id 로 살아나고
        out.push({ ...before, isDeleted: true, version: before.version + 1, versionNonce: before.versionNonce + 1 }); // 옛 id 는 죽는다
    } else if (JSON.stringify(after) !== JSON.stringify(before)) {
        out.push({ ...after, version: before.version + 1, versionNonce: before.versionNonce + 1 }); // 참조만 바뀐 컨테이너·화살표
    } else {
        out.push(before);
    }
});

console.log(`${drawing.name} v${drawing.version}: 이름 바꿀 텍스트 ${rename.size} · 빨려 들어간 텍스트 ${swallowed.length}`);
for (const [from, to] of rename) console.log(`  ${from} → ${to}  "${String(live.find((e) => e.id === from).text ?? "").slice(0, 30)}"`);
for (const e of swallowed) console.log(`  되돌림 ${e.id}  ${String(e.text).length} 자 → "${restored(e)}"`);
if (!APPLY) { console.log("dry-run — 쓰려면 --apply"); process.exit(0); }
if (rename.size === 0 && swallowed.length === 0) process.exit(0);

const put = await fetch(`${BASE}/api/drawings/${DRAWING}`, {
    method: "PUT",
    headers: { ...API, "Content-Type": "application/json" },
    body: JSON.stringify({ name: drawing.name, elements: out, appState: drawing.appState, files: drawing.files, version: drawing.version, collectionId: drawing.collectionId ?? null }),
});
if (!put.ok) { console.error(`PUT 실패 ${put.status}: ${await put.text()}`); process.exit(1); }

// 검증: 다시 읽어서 짧은 텍스트 id 도, 빨려 들어간 텍스트도 없어야 한다.
const after = await get();
const bad = after.elements.filter((e) => !e.isDeleted && (needsId(e) || isSwallowed(e)));
if (bad.length > 0) { console.error(`검증 실패: 남은 것 ${bad.map((e) => e.id)}`); process.exit(1); }
console.log(`저장 v${after.version} · 검증 통과`);

// 열린 탭(웹·Obsidian)에 바로 알린다. REST PUT 은 방에 브로드캐스트되지 않는다.
const csrfRes = await fetch(`${BASE}/api/csrf-token`);
const csrf = await csrfRes.json();
const cookie = (csrfRes.headers.getSetCookie?.() ?? []).join("; ");
const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [csrf.header]: csrf.token, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ identifier: kv.EXCALIDASH_LOGIN || kv.EXCALIDASH_USER, password: kv.EXCALIDASH_PASSWORD }),
});
const token = (login.headers.getSetCookie?.() ?? []).map((c) => /^excalidash-access-token=([^;]+)/.exec(c)?.[1]).find(Boolean);
const s = io(BASE, { path: "/socket.io", transports: ["websocket"], auth: { token }, reconnection: false });
await new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
await new Promise((res) => s.emit("join-room", { drawingId: DRAWING, user: { id: "fix", name: "fix-short-ids" } }, res));
const sent = out.filter((e) => !drawing.elements.includes(e));
s.emit("element-update", { drawingId: DRAWING, elements: sent });
await new Promise((r) => setTimeout(r, 500));
s.close();
console.log(`열린 탭에 ${sent.length} 요소 전파`);
