// verify-set-cookie-parsing — extractSetCookies 가 배열 set-cookie 를 견디는가.
//
//   node scripts/verify-set-cookie-parsing.mjs
//
// 2026-09-23 실측 사고: "Generate API key from login" 이 `i.trim is not a function` 으로 죽었다.
// Obsidian 의 requestUrl 은 다중 헤더를 **배열**로 돌려줄 수 있는데 옛 구현이 헤더 값을 항상
// 문자열로 보고 value.trim() 을 불렀다. CSRF 응답 파싱 단계라 로그인은 시도조차 못 했다.
//
// 통과만 하는 검사는 확인 편향이다. 그래서 **옛 구현은 터지고 새 구현은 안 터진다** 를 둘 다 확인한다.
// 함수는 복사하지 않고 main.ts 에서 뽑아 쓴다 — 복사본은 원본이 되돌아가도 계속 통과한다.

import fs from "node:fs";

const SOURCE = "main.ts";
const src = fs.readFileSync(SOURCE, "utf8");

const start = src.indexOf("function extractSetCookies(");
if (start < 0) {
    throw new Error(`${SOURCE} 에서 extractSetCookies 를 찾지 못했다 — 이름이 바뀌었으면 이 검사도 고칠 것.`);
}
const end = src.indexOf("\n}", start);
const body = src.slice(start, end + 2);

// 타입 주석만 걷어낸다. 여기서 실패하면 함수 모양이 바뀐 것이므로 검사도 같이 갱신해야 한다.
const js = body
    .replace("headers: Record<string, unknown>", "headers")
    .replace("): string[] {", ") {")
    .replace("(item): item is string =>", "(item) =>");
if (js.includes(":") && /:\s*(Record|string\[\])/.test(js)) {
    throw new Error("타입 주석이 남았다 — 스트립 규칙을 갱신할 것.");
}
const current = new Function(`${js}; return extractSetCookies;`)();

// 사고 당시의 구현. 이게 **터져야** 검사가 살아 있는 것이다.
function legacy(headers) {
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === "set-cookie" && value.trim().length > 0) {
            return value
                .split(/,(?=\s*[^;,\s]+=)/)
                .map((item) => item.trim())
                .filter((item) => item.length > 0);
        }
    }
    return [];
}

const ARRAY_HEADERS = {
    "set-cookie": ["excalidash-csrf=abc; Path=/", "excalidash-access-token=xyz; Path=/; HttpOnly"],
};
const STRING_HEADERS = {
    "set-cookie": "excalidash-csrf=abc; Path=/, excalidash-access-token=xyz; Path=/; HttpOnly",
};

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const expected = ["excalidash-csrf=abc; Path=/", "excalidash-access-token=xyz; Path=/; HttpOnly"];
const fail = [];

// ① 옛 구현은 배열에서 터져야 한다 (검사가 실제로 발화하는지 증명)
let legacyThrew = false;
try {
    legacy(ARRAY_HEADERS);
} catch (e) {
    legacyThrew = /trim is not a function/.test(String(e));
}
if (!legacyThrew) fail.push("옛 구현이 배열 set-cookie 에서 안 터졌다 — 이 검사는 아무것도 증명하지 못한다");

// ② 새 구현은 배열을 처리해야 한다
try {
    const got = current(ARRAY_HEADERS);
    if (!eq(got, expected)) fail.push(`배열 set-cookie: ${JSON.stringify(got)}`);
} catch (e) {
    fail.push(`배열 set-cookie 에서 터졌다: ${e}`);
}

// ③ 문자열도 그대로 동작해야 한다 (회귀 방지)
try {
    const got = current(STRING_HEADERS);
    if (!eq(got, expected)) fail.push(`문자열 set-cookie: ${JSON.stringify(got)}`);
} catch (e) {
    fail.push(`문자열 set-cookie 에서 터졌다: ${e}`);
}

// ④ 없거나 이상한 값에서도 터지지 않아야 한다
for (const [label, headers] of [
    ["빈 헤더", {}],
    ["숫자 값", { "set-cookie": 42 }],
    ["빈 배열", { "set-cookie": [] }],
    ["대문자 키", { "Set-Cookie": ["a=1"] }],
]) {
    try {
        const got = current(headers);
        if (!Array.isArray(got)) fail.push(`${label}: 배열이 아닌 것을 돌려줬다`);
        if (label === "대문자 키" && !eq(got, ["a=1"])) fail.push(`대문자 키: ${JSON.stringify(got)}`);
    } catch (e) {
        fail.push(`${label} 에서 터졌다: ${e}`);
    }
}

if (fail.length > 0) {
    for (const f of fail) console.error("FAIL:", f);
    process.exit(1);
}
console.log("set-cookie parsing smoke test passed (배열·문자열·빈값, 옛 구현 발화 확인)");
