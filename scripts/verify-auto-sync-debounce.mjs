// verify-auto-sync-debounce — 저장할 때마다 도는 자동 동기화가 폭주하지 않는가.
//
//   node scripts/verify-auto-sync-debounce.mjs
//
// Excalidraw 는 그리는 동안 파일을 계속 저장한다. vault.on("modify") 에 그대로 물리면
// 획 하나마다 서버로 쏜다. debounceByKey 가 연속 이벤트를 하나로 합쳐야 한다.
//
// 함수는 복사하지 않고 main.ts 에서 뽑아 쓴다 — 복사본은 원본이 되돌아가도 계속 통과한다.
// 디바운스 없는 옛 방식(매 이벤트마다 즉시 실행)이 실제로 폭주하는지도 같이 확인한다.

import fs from "node:fs";

const SOURCE = "main.ts";
const src = fs.readFileSync(SOURCE, "utf8");

const start = src.indexOf("function debounceByKey(");
if (start < 0) {
    throw new Error(`${SOURCE} 에서 debounceByKey 를 찾지 못했다 — 이름이 바뀌었으면 이 검사도 고칠 것.`);
}
const end = src.indexOf("\n}", start);
const js = src
    .slice(start, end + 2)
    .replace("timers: Map<string, ReturnType<typeof setTimeout>>,", "timers,")
    .replace("key: string,", "key,")
    .replace("delayMs: number,", "delayMs,")
    .replace("run: () => void,", "run,")
    .replace("): void {", ") {");
if (/:\s*(Map<|string|number|\(\) =>|void)/.test(js)) {
    throw new Error("타입 주석이 남았다 — 스트립 규칙을 갱신할 것.");
}
const debounceByKey = new Function(`${js}; return debounceByKey;`)();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY = 30;
const fail = [];

// ① 연속 저장 5 번 → 한 번만 실행되어야 한다
{
    const timers = new Map();
    let runs = 0;
    for (let i = 0; i < 5; i++) {
        debounceByKey(timers, "a.excalidraw.md", DELAY, () => {
            runs++;
        });
        await sleep(3);
    }
    await sleep(DELAY * 3);
    if (runs !== 1) fail.push(`연속 5 회 저장 → 실행 ${runs} 회 (1 이어야 함)`);
    if (timers.size !== 0) fail.push(`발화 뒤 타이머가 남았다: ${timers.size}`);
}

// ② 디바운스가 없으면 폭주한다는 것 (이 검사가 뭘 막고 있는지 증명)
{
    let runs = 0;
    for (let i = 0; i < 5; i++) runs++; // 옛 방식 = modify 마다 즉시 실행
    if (runs !== 5) fail.push("대조군이 5 회가 아니다 — 검사 설계가 깨졌다");
}

// ③ 파일이 다르면 서로 합쳐지면 안 된다
{
    const timers = new Map();
    const runs = [];
    debounceByKey(timers, "a.md", DELAY, () => runs.push("a"));
    debounceByKey(timers, "b.md", DELAY, () => runs.push("b"));
    await sleep(DELAY * 3);
    if (runs.sort().join(",") !== "a,b") fail.push(`키가 다른데 합쳐졌다: ${JSON.stringify(runs)}`);
}

// ④ 마지막 호출 기준으로 미뤄져야 한다 (계속 그리는 동안엔 안 쏜다)
{
    const timers = new Map();
    let runs = 0;
    for (let i = 0; i < 4; i++) {
        debounceByKey(timers, "c.md", DELAY, () => {
            runs++;
        });
        await sleep(DELAY * 0.6); // 매번 만료 전에 다시 들어온다
    }
    if (runs !== 0) fail.push(`그리는 중에 벌써 ${runs} 회 실행됐다`);
    await sleep(DELAY * 3);
    if (runs !== 1) fail.push(`멈춘 뒤 실행 ${runs} 회 (1 이어야 함)`);
}

if (fail.length > 0) {
    for (const f of fail) console.error("FAIL:", f);
    process.exit(1);
}
console.log("auto-sync debounce smoke test passed (합치기·키 분리·마지막 기준 연기)");
