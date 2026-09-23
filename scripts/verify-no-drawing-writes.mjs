// verify-no-drawing-writes — 자동 동기화 경로가 도면 파일을 건드리지 않는가.
//
//   node scripts/verify-no-drawing-writes.mjs
//
// 2026-09-23 실측 사고: 동기화가 끝난 뒤 frontmatter 를 되쓰자, Excalidraw 플러그인이 같은 파일을
// 자기 형식(`## Text Elements` + 압축 씬)으로 저장하던 중이라 서로 밟았다. 증상 = 빈 텍스트 박스를
// 만들고 저장하면 Text Elements 구간이 통째로 그 요소 안으로 빨려 들어감. 플러그인을 끄면 재현 안 됨.
//
// 그래서 기록을 파일 밖(플러그인 설정)으로 옮겼다. 이 검사는 **그게 되돌아가지 않도록** 지킨다.
// 사용자가 직접 부른 명령(폴더 일괄 설정, 설정 모달)은 Excalidraw 의 저장과 겹치지 않으므로 예외다.

import fs from "node:fs";

const SOURCE = "main.ts";
const src = fs.readFileSync(SOURCE, "utf8");
const lines = src.split("\n");

// 파일을 쓰는 Obsidian API
const WRITE_API = /\b(processFrontMatter|vault\.(modify|process|append|create|delete)|adapter\.write)\b/;

/** 메서드 하나의 본문을 들여쓰기로 잘라낸다. */
function methodBody(name) {
    const startIdx = lines.findIndex((l) => new RegExp(`^\\s{4}(async )?${name}\\(`).test(l));
    if (startIdx < 0) {
        throw new Error(`${SOURCE} 에서 ${name} 을 찾지 못했다 — 이름이 바뀌었으면 이 검사도 고칠 것.`);
    }
    const out = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
        if (/^\s{4}\}/.test(lines[i])) break;
        out.push([i + 1, lines[i]]);
    }
    return out;
}

const fail = [];

// ① 동기화 경로는 도면 파일을 쓰면 안 된다
for (const name of ["syncFile", "recordSync", "autoSyncFile", "queueAutoSync", "resolveDrawingState"]) {
    for (const [lineNo, text] of methodBody(name)) {
        if (WRITE_API.test(text)) {
            fail.push(`${name} 안에서 파일을 쓴다 — ${SOURCE}:${lineNo}  ${text.trim().slice(0, 70)}`);
        }
    }
}

// ② 기록은 설정에 남아야 한다 (파일이 아니라)
const record = methodBody("recordSync").map(([, t]) => t).join("\n");
if (!/this\.settings\.syncState\[/.test(record)) {
    fail.push("recordSync 가 settings.syncState 에 쓰지 않는다 — 기록이 어디로 갔나?");
}
if (!/saveSettings\(\)/.test(record)) {
    fail.push("recordSync 가 saveSettings() 를 부르지 않는다 — 재시작하면 기록이 날아간다");
}

// ③ 남아 있는 쓰기는 **사용자가 직접 부른 것**뿐이어야 한다
const ALLOWED = new Set(["writeRemoteSceneToLocal", "applyDrawingSettingsToFolder", "save"]);
const enclosing = (idx) => {
    for (let i = idx; i >= 0; i--) {
        const m = /^\s{4}(?:async )?([a-zA-Z]+)\(/.exec(lines[i]);
        if (m) return m[1];
    }
    return "(최상위)";
};
for (let i = 0; i < lines.length; i++) {
    if (!WRITE_API.test(lines[i])) continue;
    const owner = enclosing(i);
    if (!ALLOWED.has(owner)) {
        fail.push(`예상 못 한 쓰기: ${owner} (${SOURCE}:${i + 1}) — 사용자가 직접 부르는 자리가 맞나?`);
    }
}

// ④ 검사가 발화하는지 — 사고 당시의 호출을 넣어보면 ①에 걸려야 한다
{
    const injected = ["    async recordSync(", "        await this.app.fileManager.processFrontMatter(file, () => {});", "    }"].join("\n");
    if (!WRITE_API.test(injected)) {
        fail.push("대조군이 쓰기로 인식되지 않는다 — 정규식이 깨졌다");
    }
}

if (fail.length > 0) {
    for (const f of fail) console.error("FAIL:", f);
    process.exit(1);
}
console.log("no-drawing-writes smoke test passed (동기화 경로 쓰기 0 · 기록은 설정에 · 예외는 사용자 명령뿐)");
