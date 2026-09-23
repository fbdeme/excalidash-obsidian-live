// probe-watch — 방에 듣기만 하는 소켓을 넣고 오가는 element-update 를 요약해 찍는다(보내지 않는다).
//
//   node scripts/probe-watch.mjs --base http://127.0.0.1:6768 --env <인스턴스>/.env --drawing <id>
//
// probe-socket 이 "들어갈 수 있다" 를 증명했다면, 이건 "주고받을 수 있다" 를 증명한다.
// 소켓 두 개(A=보내는 쪽, B=받는 쪽)를 같은 방에 넣고 A 가 element-update 를 쏜다.
// 실제 보드를 건드리지 않도록 **임시 드로잉을 만들고 끝나면 지운다.**

import fs from "node:fs";
import { io } from "socket.io-client";

const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : d;
};
const BASE = arg("base", "http://127.0.0.1:6768");
const ENV = arg("env");
if (!ENV) { console.error("--env 필요"); process.exit(2); }

const kv = Object.fromEntries(
    fs.readFileSync(ENV, "utf8").split("\n")
        .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
        .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);


async function loginForJwt() {
    const csrfRes = await fetch(`${BASE}/api/csrf-token`);
    const csrf = await csrfRes.json();
    const cookie = (csrfRes.headers.getSetCookie?.() ?? []).join("; ");
    const res = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [csrf.header]: csrf.token, ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify({ identifier: kv.EXCALIDASH_LOGIN || kv.EXCALIDASH_USER, password: kv.EXCALIDASH_PASSWORD }),
    });
    const jar = Object.fromEntries((res.headers.getSetCookie?.() ?? []).map((c) => {
        const [p] = c.split(";"); const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1)];
    }));
    return jar["excalidash-access-token"];
}

const DRAWING = arg("drawing");
if (!DRAWING) { console.error("--drawing 필요"); process.exit(2); }
const token = await loginForJwt();
const s = io(BASE, { path: "/socket.io", transports: ["websocket"], auth: { token } });
s.on("connect", () => {
    s.emit("join-room", { drawingId: DRAWING, user: { id: "watch", name: "watch" } });
    console.log(new Date().toISOString(), "joined", DRAWING);
});
s.on("presence-update", (users) => console.log(new Date().toISOString(), "presence", users.map((u) => u.name).join(",")));
s.on("element-update", (p) => {
    const els = p.elements ?? [];
    const brief = els.slice(0, 6).map((e) => `${e.type}:${e.id}@v${e.version}${e.isDeleted ? "(del)" : ""}${e.text ? `"${String(e.text).slice(0, 20)}"` : ""}`);
    console.log(new Date().toISOString(), `update n=${els.length}`, brief.join(" "), p.files ? "files" : "", p.elementOrder ? "order" : "");
});
s.on("error", (e) => console.log("error", e));
