// probe-roundtrip — 방에 들어간 뒤 element-update 가 실제로 오가는가.
//
//   node scripts/probe-roundtrip.mjs --base http://127.0.0.1:6768 --env <인스턴스>/.env
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
const API = { Authorization: `Bearer ${kv.EXCALIDASH_API_KEY}` };

const rect = (id, x, ver) => ({
    id, type: "rectangle", x, y: 0, width: 100, height: 60, angle: 0,
    strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
    strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100,
    groupIds: [], frameId: null, roundness: null, seed: 1,
    version: ver, versionNonce: ver, isDeleted: false,
    boundElements: null, updated: 1, link: null, locked: false,
});

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

function connect(token, label) {
    return new Promise((res, rej) => {
        const s = io(BASE, { path: "/socket.io", transports: ["websocket"], auth: { token }, reconnection: false, timeout: 8000 });
        s.on("connect", () => res(s));
        s.on("connect_error", (e) => rej(new Error(`${label} 핸드셰이크 실패: ${e.message}`)));
    });
}
const join = (s, drawingId, name) =>
    new Promise((res) => s.emit("join-room", { drawingId, user: { id: name, name } }, (ack) => res(ack)));

const token = await loginForJwt();
if (!token) { console.error("로그인 실패"); process.exit(2); }

// 임시 드로잉 (끝나면 삭제)
const created = await fetch(`${BASE}/api/drawings`, {
    method: "POST", headers: { ...API, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `_probe-${Date.now()}`, elements: [rect("a", 0, 1)], appState: {}, files: {} }),
}).then((r) => r.json());
const drawingId = created.id ?? created.drawing?.id;
console.log(`임시 드로잉 ${drawingId}`);

let verdict = "no-receive";
try {
    const [A, B] = [await connect(token, "A"), await connect(token, "B")];
    await join(A, drawingId, "sender");
    await join(B, drawingId, "receiver");

    const received = new Promise((res) => {
        B.on("element-update", (p) => res(p));
        setTimeout(() => res(null), 10000);
    });

    // 백엔드(socket.ts:288)는 data.drawingId 를 읽고, 없으면 조용히 버린다. 저장은 하지 않고 방에 중계만 한다.
    const payload = { drawingId, elements: [rect("b", 200, 99)], files: {}, elementOrder: ["a", "b"] };
    A.on("error", (p) => console.log(`A 가 error 수신: ${p?.message ?? JSON.stringify(p)}`));
    A.emit("element-update", payload);

    const got = await received;
    if (got) {
        const ids = (got.elements ?? []).map((e) => e.id);
        console.log(`B 수신: elements=${JSON.stringify(ids)} elementOrder=${JSON.stringify(got.elementOrder ?? null)}`);
        verdict = ids.includes("b") ? "ok" : "partial";
    } else {
        console.log("B 가 10초 안에 아무것도 못 받음");
    }

    // 서버에 반영됐는지(= socket 이 저장까지 하는지) 확인
    const after = await fetch(`${BASE}/api/drawings/${drawingId}`, { headers: API }).then((r) => r.json());
    const live = (after.elements ?? []).filter((e) => !e.isDeleted).map((e) => e.id).sort();
    console.log(`서버 씬 live ids = ${JSON.stringify(live)}  ← socket 전파가 저장까지 하는지 판정`);

    A.close(); B.close();
} finally {
    await fetch(`${BASE}/api/drawings/${drawingId}`, { method: "DELETE", headers: API });
    console.log("임시 드로잉 삭제");
}

console.log(`\n판정: ${verdict === "ok" ? "element-update 가 방 안에서 전파된다 → 실시간 양방향 가능" : verdict === "partial" ? "받긴 받는데 내용이 다르다 — 페이로드 계약 확인 필요" : "전파 안 됨 → 설계 재검토"}`);
process.exit(verdict === "ok" ? 0 : 1);
