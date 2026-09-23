// probe-socket — ExcaliDash 실시간 방에 비브라우저 클라이언트가 들어갈 수 있는가.
//
//   node scripts/probe-socket.mjs --base http://127.0.0.1:6768 --env <인스턴스>/.env [--drawing <id>]
//
// 배경(backend/src/server/socket.ts 실측): 핸드셰이크는 `handshake.auth.token` 또는 쿠키
// `excalidash-access-token` 을 **JWT 로 검증**한다(jwt.verify). API 키는 받지 않는다.
// authEnabled 면 익명 소켓도 통과시키고 **join-room 에서 접근을 검사**한다
// (실패 시 `error` 이벤트 "You do not have access to this drawing", 성공 시 ack 콜백).
//
// 그래서 세 가지를 가른다: ①익명 ②API 키를 token 자리에 ③로그인 JWT.
// 비밀값은 길이만 찍는다. 절대 출력하지 않는다.

import fs from "node:fs";
import { io } from "socket.io-client";

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("base", "http://127.0.0.1:6768");
const ENV = arg("env");
if (!ENV) {
    console.error("--env <.env 경로> 가 필요하다");
    process.exit(2);
}
const kv = Object.fromEntries(
    fs
        .readFileSync(ENV, "utf8")
        .split("\n")
        .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
        .map((l) => {
            const i = l.indexOf("=");
            return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
        }),
);

const mask = (v) => (v ? `<${v.length}자>` : "(없음)");

async function pickDrawing(apiKey) {
    const explicit = arg("drawing");
    if (explicit) return explicit;
    const r = await fetch(`${BASE}/api/drawings?limit=1`, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) throw new Error(`GET /api/drawings → ${r.status}`);
    const body = await r.json();
    const rows = Array.isArray(body) ? body : body.drawings;
    if (!rows?.length) throw new Error("드로잉이 없다");
    return rows[0].id;
}

// 로그인해서 access-token 쿠키(JWT)를 얻는다. 브라우저가 아니므로 set-cookie 를 직접 읽는다.
async function loginForJwt() {
    const csrfRes = await fetch(`${BASE}/api/csrf-token`);
    const csrf = await csrfRes.json();
    const setCookies = [];
    const cookieHeader = (csrfRes.headers.getSetCookie?.() ?? []).join("; ");
    const res = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            [csrf.header]: csrf.token,
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: JSON.stringify({
            identifier: kv.EXCALIDASH_LOGIN || kv.EXCALIDASH_USER,
            password: kv.EXCALIDASH_PASSWORD,
        }),
    });
    setCookies.push(...(res.headers.getSetCookie?.() ?? []));
    const jar = Object.fromEntries(
        setCookies.map((c) => {
            const [pair] = c.split(";");
            const i = pair.indexOf("=");
            return [pair.slice(0, i).trim(), pair.slice(i + 1)];
        }),
    );
    return { status: res.status, token: jar["excalidash-access-token"], jar };
}

// 한 가지 경우를 시험한다. 결과는 joined / denied / handshake-failed / timeout 중 하나.
function attempt(label, { token, cookie }, drawingId) {
    return new Promise((resolve) => {
        const socket = io(BASE, {
            path: "/socket.io",
            transports: ["websocket"],
            auth: token ? { token } : {},
            extraHeaders: cookie ? { Cookie: cookie } : {},
            reconnection: false,
            timeout: 8000,
        });
        const done = (result, detail) => {
            clearTimeout(timer);
            socket.close();
            resolve({ label, result, detail });
        };
        const timer = setTimeout(() => done("timeout", "15s 안에 아무 응답 없음"), 15000);

        socket.on("connect_error", (e) => done("handshake-failed", e.message));
        socket.on("error", (p) => done("denied", p?.message ?? JSON.stringify(p)));
        socket.on("connect", () => {
            socket.emit("join-room", { drawingId, user: { id: "probe", name: "probe" } }, (ack) =>
                done("joined", `ack user=${JSON.stringify(ack?.user ?? ack)}`),
            );
        });
    });
}

const apiKey = kv.EXCALIDASH_API_KEY;
console.log(`base=${BASE}`);
console.log(`API 키 ${mask(apiKey)} · 로그인 ID ${kv.EXCALIDASH_LOGIN || kv.EXCALIDASH_USER ? "있음" : "없음"} · 비밀번호 ${mask(kv.EXCALIDASH_PASSWORD)}`);

const drawingId = await pickDrawing(apiKey);
console.log(`대상 drawingId=${drawingId}\n`);

const results = [];
results.push(await attempt("① 익명 (토큰 없음)", {}, drawingId));
results.push(await attempt("② API 키를 auth.token 자리에", { token: apiKey }, drawingId));

const login = await loginForJwt();
console.log(`로그인 HTTP ${login.status} · access-token 쿠키 ${mask(login.token)}\n`);
if (login.token) {
    results.push(await attempt("③ 로그인 JWT (auth.token)", { token: login.token }, drawingId));
    results.push(
        await attempt(
            "④ 로그인 JWT (쿠키 헤더)",
            { cookie: `excalidash-access-token=${login.token}` },
            drawingId,
        ),
    );
} else {
    results.push({ label: "③④ 로그인 JWT", result: "skipped", detail: "쿠키를 못 얻음" });
}

console.log("=== 결과 ===");
for (const r of results) console.log(`${r.label.padEnd(30)} ${r.result.padEnd(18)} ${r.detail ?? ""}`);

const ok = results.some((r) => r.result === "joined");
console.log(`\n판정: ${ok ? "비브라우저 클라이언트가 방에 들어갈 수 있다 → 실시간 설계 진행" : "못 들어간다 → 폴백(파일 감시 + 주기 폴링) 검토"}`);
process.exit(ok ? 0 : 1);
