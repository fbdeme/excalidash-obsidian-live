import {
    App,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    RequestUrlParam,
    RequestUrlResponse,
    Setting,
    SettingDefinitionItem,
    TFile,
    TFolder,
    normalizePath as normalizeObsidianPath,
    requestUrl,
} from "obsidian";
import { compressToBase64, decompressFromBase64 } from "lz-string";
import { io, Socket } from "socket.io-client";

// Excalidraw 는 그리는 동안 파일을 계속 저장한다. 이 정도는 기다려야 획 하나마다 서버로 쏘지 않는다.
const AUTO_SYNC_DEBOUNCE_MS = 2500;

/**
 * 저장 시 자동 동기화.
 *
 * 2026-09-23 에 이걸 의심해 껐다가 되돌렸다. 도면이 깨지는 건 우리 탓이 아니었다 —
 * 아무것도 하지 않는 656 바이트짜리 no-op 플러그인으로도 재현됐고, **새로 만든 도면은 멀쩡했다.**
 * 원인은 파일에 이미 박힌 오염(`## Text Elements` 중복)이고, 그런 파일은 열고 저장할 때마다
 * 유령 요소를 스스로 재생산한다. 자세한 건 docs/issues.md Issue #8.
 */
const AUTO_SYNC_ON_SAVE = true;

/**
 * 열린 도면에서 바뀐 요소를 소켓으로 내보내는 주기. 파일 저장에 기대면 Excalidraw 의 자동 저장
 * (데스크톱 60 초 · 모바일 30 초)만큼 늦으므로, 웹 클라이언트처럼 뷰를 직접 읽는다.
 */
const LIVE_FLUSH_MS = 300;

const DEFAULT_API_PATH_PREFIX = "/api";
const DEFAULT_CSRF_ENDPOINT = "/csrf-token";
const DEFAULT_CSRF_HEADER = "x-csrf-token";
const DEFAULT_SYNC_DIRECTION: SyncDirection = "obsidian-to-excalidash";
const GENERATED_API_KEY_NAME = "Obsidian ExcaliDash sync";

type SyncDirection = "obsidian-to-excalidash" | "bidirectional";
type TargetAuthMode = "api-key" | "username-password";

interface ExcaliDashTarget {
    name: string;
    baseUrl: string;
    authMode: TargetAuthMode;
    apiKey: string;
    username: string;
    password: string;
    generatedApiKey: string;
}

interface TemporarySession {
    cookieHeader: string;
}

interface SyncState {
    id: string;
    version: number;
    lastHash: string;
    lastSynced: string;
    /**
     * 이 도면에서 로컬이 **본 적 있는** 서버 id. 로컬에 없는 서버 요소 중 여기 있는 것만 "지웠다" 로
     * 친다 — 없는 것은 남이 방금 그린 것이다. 실시간이면 서버 version 이 늘 바뀌어 옛 "충돌이면 멈춤"
     * 규칙으로는 영영 못 올리므로, 이걸로 삭제와 신규를 가른다.
     */
    knownIds?: string[];
}

interface ExcaliDashSyncSettings {
    targets: ExcaliDashTarget[];
    /**
     * 파일 경로 -> 마지막 동기화 기록. **도면 파일에 쓰지 않기 위해** 여기 둔다.
     *
     * upstream 은 이걸 frontmatter 에 되썼는데, Excalidraw 플러그인이 그 파일을 열어둔 채
     * 자기 형식(`## Text Elements` + 압축 씬)으로 저장하는 중이라 서로 밟는다. 실측(2026-09-23):
     * 빈 텍스트 박스를 만들고 저장하면 Text Elements 구간이 통째로 그 요소 안으로 빨려 들어갔고,
     * 플러그인을 끄면 재현되지 않았다.
     */
    syncState: Record<string, SyncState>;
}

type PersistedExcaliDashTarget = Partial<ExcaliDashTarget> & {
    apiPathPrefix?: unknown;
};

interface DrawingFrontmatter {
    destination?: string;
    collection?: string;
    direction: SyncDirection;
    id?: string;
    version?: number;
    lastHash?: string;
    lastSynced?: string;
}

interface ExcalidrawScene {
    elements: unknown[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
}

interface ExcaliDashDrawing extends ExcalidrawScene {
    id: string;
    name: string;
    version: number;
    preview?: string | null;
    collectionId?: string | null;
}

/** Excalidraw 플러그인의 뷰 중 우리가 쓰는 부분. */
interface ExcalidrawViewLike {
    excalidrawAPI: { getSceneElementsIncludingDeleted(): unknown[] };
    updateScene(scene: { elements: unknown[]; captureUpdate?: string }): void;
}

/** 열린 도면 하나의 실시간 상태. 보낸(또는 받은) 요소의 version 을 기억해 바뀐 것만 보낸다. */
class LiveRoom {
    private sent = new Map<string, Record<string, unknown>>();
    /** 방에 (다시) 들어간 뒤 REST 로 한 번 따라잡아야 한다 — 끊긴 동안 놓친 편집. */
    needsCatchUp = true;
    busy = false;

    constructor(
        readonly file: TFile,
        readonly target: ExcaliDashTarget,
        readonly drawingId: string,
    ) {}

    markSent(elements: readonly unknown[]): void {
        for (const element of elements) {
            const id = elementId(element);
            if (id !== null) this.sent.set(id, element as Record<string, unknown>);
        }
    }

    /** 지난번 이후 바뀐 요소 + 씬에서 아예 사라진 요소(플러그인의 id 교체 등)는 tombstone 으로. */
    takeChanges(elements: readonly unknown[]): unknown[] {
        const out: unknown[] = [];
        const present = new Set<string>();
        for (const element of elements) {
            const id = elementId(element);
            if (id === null) continue;
            present.add(id);
            const e = element as Record<string, unknown>;
            const prev = this.sent.get(id);
            if (prev === undefined || prev.version !== e.version || prev.versionNonce !== e.versionNonce) {
                out.push(e);
                this.sent.set(id, e);
            }
        }
        for (const [id, prev] of this.sent) {
            if (present.has(id)) continue;
            this.sent.delete(id);
            if (prev.isDeleted === true) continue;
            out.push({
                ...prev,
                isDeleted: true,
                version: Number(prev.version ?? 0) + 1,
                versionNonce: Math.floor(Math.random() * 2 ** 31),
            });
        }
        return out;
    }
}

interface ExcaliDashCollection {
    id: string;
    name?: string;
    title?: string;
}

interface SyncResult {
    path: string;
    status: "synced" | "skipped" | "conflict" | "error";
    message: string;
}

interface ConnectionTestResult {
    drawingCount?: number;
}

const DEFAULT_SETTINGS: ExcaliDashSyncSettings = {
    targets: [],
    syncState: {},
};

export default class ExcaliDashSyncPlugin extends Plugin {
    settings: ExcaliDashSyncSettings = DEFAULT_SETTINGS;
    private autoSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private autoSyncRunning = new Set<string>();
    private live = new Map<string, LiveRoom>();
    private sockets = new Map<string, Socket>();

    async onload(): Promise<void> {
        await this.loadSettings();

        // 저장할 때마다 자동으로 올린다. opt-in 된 파일만 건드리므로 별도 설정을 두지 않는다.
        // 되쓰기 루프는 구조적으로 생기지 않는다: syncFile 은 씬 해시가 그대로면 skipped 로 빠져
        // frontmatter 를 아예 쓰지 않는다.
        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                const state = this.settings.syncState[oldPath];
                if (state !== undefined) {
                    delete this.settings.syncState[oldPath];
                    this.settings.syncState[file.path] = state;
                    void this.saveSettings();
                }
            }),
        );

        if (AUTO_SYNC_ON_SAVE) {
            this.registerEvent(
                this.app.vault.on("modify", (file) => {
                    if (file instanceof TFile) {
                        this.queueAutoSync(file);
                    }
                }),
            );
        }

        this.addCommand({
            id: "perform-sync",
            name: "Sync current drawing",
            callback: () => {
                void this.performSync();
            },
        });

        this.addCommand({
            id: "pull-all-drawings",
            name: "Pull all drawings from ExcaliDash",
            callback: () => {
                void this.pullAllDrawings();
            },
        });

        this.addCommand({
            id: "pull-current-drawing",
            name: "Pull current drawing from ExcaliDash",
            callback: () => {
                void this.pullCurrentDrawing();
            },
        });

        this.addCommand({
            id: "sync-stencil-library",
            name: "Sync stencil library with ExcaliDash",
            callback: () => {
                void this.syncStencilLibrary();
            },
        });

        this.addCommand({
            id: "edit-current-drawing-settings",
            name: "Edit current drawing settings",
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                const canEdit = file !== null && isExcalidrawFile(file);
                if (checking) {
                    return canEdit;
                }

                if (file !== null && canEdit) {
                    new DrawingSettingsModal(this.app, this, file).open();
                }
                return true;
            },
        });

        this.addCommand({
            id: "apply-drawing-settings-to-folder",
            name: "Apply drawing settings to folder",
            callback: () => {
                new FolderDrawingSettingsModal(this.app, this).open();
            },
        });

        this.addSettingTab(new ExcaliDashSettingTab(this.app, this));

        // 실시간: 열린 도면마다 ExcaliDash 방에 들어간다. 저장(REST)은 그대로 두고, 소켓은 전파만 한다.
        this.app.workspace.onLayoutReady(() => this.refreshLive());
        this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshLive()));
        this.registerInterval(window.setInterval(() => void this.flushLive(), LIVE_FLUSH_MS));
    }

    /** 열린 opt-in 도면과 방 목록을 맞춘다. */
    refreshLive(): void {
        const open = new Set<string>();
        for (const leaf of this.app.workspace.getLeavesOfType("excalidraw")) {
            const path = (leaf.getViewState().state as { file?: unknown } | undefined)?.file;
            const file = typeof path === "string" ? this.app.vault.getAbstractFileByPath(path) : null;
            if (!(file instanceof TFile)) continue;
            const frontmatter = this.resolveDrawingState(
                file,
                parseDrawingFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter),
            );
            const target = this.settings.targets.find((item) => item.name === frontmatter.destination);
            // 소켓은 로그인 JWT 로만 들어간다(API 키는 거부). 비밀번호가 없으면 저장 동기화만 한다.
            if (frontmatter.id === undefined || target === undefined || target.password.length === 0) continue;
            open.add(file.path);
            if (this.live.has(file.path)) continue;
            const room = new LiveRoom(file, target, frontmatter.id);
            this.live.set(file.path, room);
            const socket = this.socketFor(target);
            if (socket.connected) this.joinLive(socket, room);
        }
        // ponytail: 서버에 leave-room 이 없다. 닫은 도면의 방 이벤트는 onLiveUpdate 에서 무시된다.
        for (const path of [...this.live.keys()]) {
            if (!open.has(path)) this.live.delete(path);
        }
    }

    socketFor(target: ExcaliDashTarget): Socket {
        const existing = this.sockets.get(target.name);
        if (existing !== undefined) return existing;
        const socket = io(new URL(target.baseUrl).origin, {
            path: "/socket.io",
            transports: ["websocket"],
            // 접속할 때마다 새로 로그인한다. access 토큰 TTL 이 15 분이라(Issue #5) 재접속엔 새 토큰이
            // 필요하고, 서버는 핸드셰이크에서만 토큰을 본다 — 붙어 있는 동안은 만료돼도 끊기지 않는다.
            auth: (cb) => {
                accessTokenFor(target).then(
                    (token) => cb({ token }),
                    () => cb({}),
                );
            },
        });
        socket.on("connect", () => {
            for (const room of this.live.values()) {
                if (room.target.name === target.name) this.joinLive(socket, room);
            }
        });
        socket.on("element-update", (data: unknown) => this.onLiveUpdate(target, data));
        socket.on("error", (error: unknown) => console.warn("ExcaliDash Live socket error", error));
        this.sockets.set(target.name, socket);
        return socket;
    }

    joinLive(socket: Socket, room: LiveRoom): void {
        room.needsCatchUp = true;
        socket.emit("join-room", {
            drawingId: room.drawingId,
            user: { id: "obsidian", name: "Obsidian" },
        });
    }

    onLiveUpdate(target: ExcaliDashTarget, data: unknown): void {
        if (!isRecord(data) || typeof data.drawingId !== "string" || !Array.isArray(data.elements)) return;
        for (const room of this.live.values()) {
            if (room.drawingId !== data.drawingId || room.target.name !== target.name) continue;
            const view = this.openExcalidrawView(room.file);
            // ponytail: 첨부 파일(이미지)은 소켓으로 안 받는다 — 저장 뒤 pull 로 들어온다.
            if (view !== null) this.applyRemoteToView(room.file, view, data.elements);
        }
    }

    /** 방마다: 들어간 직후면 REST 로 따라잡고, 아니면 바뀐 요소만 소켓으로 보낸다. */
    async flushLive(): Promise<void> {
        for (const room of this.live.values()) {
            if (room.busy) continue;
            const socket = this.sockets.get(room.target.name);
            const view = this.openExcalidrawView(room.file);
            if (socket?.connected !== true || view === null) continue;

            if (room.needsCatchUp) {
                room.busy = true;
                try {
                    const frontmatter = this.resolveDrawingState(
                        room.file,
                        parseDrawingFrontmatter(this.app.metadataCache.getFileCache(room.file)?.frontmatter),
                    );
                    const result = await this.pullIntoOpenView(room.file, room.target, frontmatter);
                    if (result.status !== "error") room.needsCatchUp = false;
                } finally {
                    room.busy = false;
                }
                continue;
            }

            const changes = room.takeChanges(view.excalidrawAPI.getSceneElementsIncludingDeleted());
            if (changes.length === 0) continue;
            // 서버 id 로 되돌려 보낸다. drawingId 가 없으면 서버가 조용히 버린다(socket.ts:288).
            socket.emit("element-update", {
                drawingId: room.drawingId,
                elements: toRemoteIds(changes, this.knownIdsOf(room.file) ?? []),
            });
        }
    }

    async loadSettings(): Promise<void> {
        const loaded =
            (await this.loadData()) as Partial<ExcaliDashSyncSettings> | null;
        this.settings = normalizeSettings(loaded);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    onunload(): void {
        for (const socket of this.sockets.values()) socket.disconnect();
        this.sockets.clear();
        this.live.clear();
        for (const timer of this.autoSyncTimers.values()) {
            clearTimeout(timer);
        }
        this.autoSyncTimers.clear();
    }

    queueAutoSync(file: TFile): void {
        if (!isExcalidrawFile(file)) {
            return;
        }
        debounceByKey(this.autoSyncTimers, file.path, AUTO_SYNC_DEBOUNCE_MS, () => {
            void this.autoSyncFile(file);
        });
    }

    /** 자동 경로. 손으로 부른 게 아니므로 조용히 지나가고, 실패했을 때만 알린다. */
    async autoSyncFile(file: TFile): Promise<void> {
        if (this.autoSyncRunning.has(file.path)) {
            return;
        }

        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = parseDrawingFrontmatter(cache?.frontmatter);
        if (frontmatter.destination === undefined) {
            return;
        }
        const target = this.settings.targets.find(
            (item) => item.name === frontmatter.destination,
        );
        if (target === undefined) {
            return;
        }

        this.autoSyncRunning.add(file.path);
        try {
            const result = await this.syncFile(file, target, frontmatter);
            if (result.status === "error" || result.status === "conflict") {
                new Notice(`ExcaliDash Live: ${file.basename} — ${result.message}`);
            }
        } finally {
            this.autoSyncRunning.delete(file.path);
        }
    }

    async performSync(): Promise<void> {
        const file = this.app.workspace.getActiveFile();
        if (file === null || !isExcalidrawFile(file)) {
            new Notice("ExcaliDash Live: open an Excalidraw drawing to sync.");
            return;
        }

        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = parseDrawingFrontmatter(cache?.frontmatter);
        if (frontmatter.destination === undefined) {
            new Notice("ExcaliDash Live: current drawing is not opted in.");
            return;
        }

        const target = this.settings.targets.find(
            (item) => item.name === frontmatter.destination,
        );
        if (target === undefined) {
            this.showSyncSummary([
                {
                    path: file.path,
                    status: "error",
                    message: `Missing ExcaliDash target '${frontmatter.destination}'.`,
                },
            ]);
            return;
        }

        this.showSyncSummary([await this.syncFile(file, target, frontmatter)]);
    }

    /** 이 파일이 지금 Excalidraw 뷰로 열려 있나. 열려 있으면 파일을 쓰면 안 된다(2026-09-23 사고). */
    isOpenInExcalidrawView(file: TFile): boolean {
        return this.app.workspace
            .getLeavesOfType("excalidraw")
            .some((leaf) => {
                const state = leaf.getViewState().state as
                    | { file?: unknown }
                    | undefined;
                return state?.file === file.path;
            });
    }

    /**
     * opt-in 된 도면을 전부 당겨온다.
     *
     * 단일 파일 pull 은 **활성 파일**을 보는데, 열린 도면에는 쓰면 안 되므로(2026-09-23 사고)
     * "열어두되 닫아라" 라는 모순이 된다. 그래서 활성 파일에 기대지 않는 이쪽이 기본이다.
     */
    async pullAllDrawings(): Promise<void> {
        const results: SyncResult[] = [];

        for (const file of this.app.vault.getMarkdownFiles()) {
            if (!isExcalidrawFile(file)) continue;
            const frontmatter = this.resolveDrawingState(
                file,
                parseDrawingFrontmatter(
                    this.app.metadataCache.getFileCache(file)?.frontmatter,
                ),
            );
            if (frontmatter.destination === undefined || frontmatter.id === undefined) continue;
            const target = this.settings.targets.find(
                (item) => item.name === frontmatter.destination,
            );
            if (target === undefined) continue;

            // 열려 있으면 파일을 쓰지 않고 살아 있는 뷰에 직접 넣는다.
            results.push(
                this.isOpenInExcalidrawView(file)
                    ? await this.pullIntoOpenView(file, target, frontmatter)
                    : await this.pullFile(file, target, frontmatter),
            );
        }

        if (results.length === 0) {
            new Notice(
                "ExcaliDash Live: no opted-in drawings with a recorded remote yet — push one first.",
                8000,
            );
            return;
        }
        this.showSyncSummary(results);
    }

    async pullCurrentDrawing(): Promise<void> {
        const file = this.app.workspace.getActiveFile();
        if (file === null || !isExcalidrawFile(file)) {
            new Notice("ExcaliDash Live: open an Excalidraw drawing to pull.");
            return;
        }
        const raw0 = this.app.metadataCache.getFileCache(file);
        const frontmatter = this.resolveDrawingState(
            file,
            parseDrawingFrontmatter(raw0?.frontmatter),
        );
        const target = this.settings.targets.find(
            (item) => item.name === frontmatter.destination,
        );
        if (frontmatter.destination === undefined || target === undefined) {
            new Notice("ExcaliDash Live: current drawing is not opted in.");
            return;
        }
        if (frontmatter.id === undefined) {
            new Notice("ExcaliDash Live: no remote drawing recorded yet — push once first.");
            return;
        }
        this.showSyncSummary([
            this.isOpenInExcalidrawView(file)
                ? await this.pullIntoOpenView(file, target, frontmatter)
                : await this.pullFile(file, target, frontmatter),
        ]);
    }

    /**
     * 열려 있는 도면에 **파일을 거치지 않고** 반영한다.
     *
     * 파일을 부분만 고치면 압축 씬과 `## Text Elements` 가 어긋나 도면이 망가진다(2026-09-23).
     * 살아 있는 뷰에 넣으면 저장은 Excalidraw 플러그인이 하므로 두 쪽이 늘 일관된다.
     */
    async pullIntoOpenView(
        file: TFile,
        target: ExcaliDashTarget,
        frontmatter: DrawingFrontmatter,
    ): Promise<SyncResult> {
        const view = this.openExcalidrawView(file);
        if (view === null) {
            return {
                path: file.path,
                status: "error",
                message: "Excalidraw view not ready — close the drawing and pull again.",
            };
        }

        try {
            const remote = await getRemoteDrawing(target, frontmatter.id as string);
            const changed = this.applyRemoteToView(file, view, remote.elements ?? []);
            await this.recordSync(
                file,
                remote.id,
                remote.version,
                frontmatter.lastHash ?? "",
                liveIdsOf(remote.elements ?? []),
            );
            if (changed === 0) {
                return { path: file.path, status: "skipped", message: "Already up to date." };
            }
            return {
                path: file.path,
                status: "synced",
                message: `Pulled ${changed} element(s) into the open drawing (version ${remote.version}).`,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { path: file.path, status: "error", message };
        }
    }

    /** 이 파일을 연 Excalidraw 뷰. 아직 API 가 붙지 않았으면 null. */
    openExcalidrawView(file: TFile): ExcalidrawViewLike | null {
        const leaf = this.app.workspace
            .getLeavesOfType("excalidraw")
            .find((item) => {
                const state = item.getViewState().state as { file?: unknown } | undefined;
                return state?.file === file.path;
            });
        const view = leaf?.view as unknown as ExcalidrawViewLike | undefined;
        return view?.excalidrawAPI?.getSceneElementsIncludingDeleted === undefined ? null : view;
    }

    /**
     * 서버 요소를 **열린 뷰에** 넣는다. 파일은 거치지 않는다 — 부분 수정하면 압축 씬과
     * `## Text Elements` 가 어긋나 도면이 망가진다(2026-09-23). 저장은 Excalidraw 플러그인이 한다.
     *
     * 지운 요소까지 포함한 씬과 합친다. 안 그러면 로컬에서 지운 요소가 옛 version 으로 되살아난다.
     */
    applyRemoteToView(file: TFile, view: ExcalidrawViewLike, remoteElements: readonly unknown[]): number {
        const current = view.excalidrawAPI.getSceneElementsIncludingDeleted();
        const currentIds = new Set(
            current.map((e) => elementId(e)).filter((id): id is string => id !== null),
        );
        const incoming = toLocalIds(remoteElements, currentIds);
        const { scene, changed } = mergeScenes(
            { elements: [...current], appState: {}, files: {} },
            incoming,
        );
        this.rememberSeen(
            file,
            remoteElements.map((e) => elementId(e)).filter((id): id is string => id !== null),
        );
        if (changed === 0) return 0;
        // 남의 편집이 내 실행 취소(undo) 기록에 섞이지 않게 한다.
        view.updateScene({ elements: scene.elements, captureUpdate: "NEVER" });
        // 받은 쪽이 이긴 요소만 "보냄" 으로 친다 — 되돌려 보내지 않되, 로컬 전용 편집은 계속 나가게.
        const won = new Set(incoming);
        this.live.get(file.path)?.markSent(scene.elements.filter((e) => won.has(e)));
        return changed;
    }

    async pullFile(
        file: TFile,
        target: ExcaliDashTarget,
        frontmatter: DrawingFrontmatter,
    ): Promise<SyncResult> {
        try {
            const raw = await this.app.vault.read(file);
            const parsed = parseExcalidrawScene(raw, file.extension === "md");
            if (parsed === null) {
                return { path: file.path, status: "error", message: "Unable to parse Excalidraw scene." };
            }
            const remote = await getRemoteDrawing(target, frontmatter.id as string);
            const localIds = new Set(
                parsed.scene.elements.map((e) => elementId(e)).filter((id): id is string => id !== null),
            );
            const { scene, changed } = mergeScenes(
                parsed.scene,
                toLocalIds(remote.elements ?? [], localIds),
            );
            const seen = liveIdsOf(remote.elements ?? []);
            if (changed === 0) {
                await this.recordSync(file, remote.id, remote.version, await sceneHash(parsed.scene), seen);
                return { path: file.path, status: "skipped", message: "Already up to date." };
            }
            await this.writeRemoteSceneToLocal(file, raw, parsed, scene);
            await this.recordSync(file, remote.id, remote.version, await sceneHash(scene), seen);
            return {
                path: file.path,
                status: "synced",
                message: `Pulled ${changed} element(s) from ExcaliDash (version ${remote.version}).`,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { path: file.path, status: "error", message };
        }
    }

    /** ExcaliDash 의 스텐실 라이브러리와 Obsidian 의 라이브러리를 합친다. 양쪽 다 갱신한다. */
    async syncStencilLibrary(): Promise<void> {
        const target = this.settings.targets[0];
        if (target === undefined) {
            new Notice("ExcaliDash Live: configure a target first.");
            return;
        }
        // /api/library 는 API 키 범위(drawings·collections) 밖이라 **로그인이 필요하다**(실측: API 키는 403).
        // 비밀번호 없이 부르면 엉뚱한 에러가 나므로 먼저 막고 무엇이 필요한지 말해 준다.
        if (target.password.trim().length === 0) {
            new Notice(
                "ExcaliDash Live: the stencil library needs your ExcaliDash password " +
                    "(the API key has no access to /api/library). Enter it in settings.",
                10000,
            );
            return;
        }

        try {
            const session = await loginWithPassword(target);
            const remote = await requestUrl({
                url: buildApiUrl(target, "/library"),
                method: "GET",
                headers: { Accept: "application/json", Cookie: session.cookieHeader },
                throw: false,
            });
            if (remote.status === 403) {
                new Notice(
                    "ExcaliDash Live: ExcaliDash refused the library request (403). " +
                        "Check that the account can reach /api/library.",
                    10000,
                );
                return;
            }
            if (remote.status >= 400) {
                new Notice(`ExcaliDash Live: library fetch failed (${remote.status}).`, 8000);
                return;
            }
            const remoteItems: unknown[] = Array.isArray(remote.json?.items) ? remote.json.items : [];

            const path = excalidrawLibraryPath(this.app);
            const localItems = await this.readStencilLibrary(path);

            const merged = mergeLibraryItems(localItems, remoteItems);
            await this.writeStencilLibrary(path, merged);

            const csrf = await getCsrfToken(target, session.cookieHeader);
            const put = await requestUrl({
                url: buildApiUrl(target, "/library"),
                method: "PUT",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Cookie: csrf.cookieHeader.length > 0 ? csrf.cookieHeader : session.cookieHeader,
                    [DEFAULT_CSRF_HEADER]: csrf.token,
                },
                body: JSON.stringify({ items: merged }),
                throw: false,
            });
            if (put.status >= 400) {
                new Notice(`ExcaliDash Live: library push failed (${put.status}).`);
                return;
            }
            new Notice(`ExcaliDash Live: stencil library synced (${merged.length} items).`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`ExcaliDash Live: library sync failed — ${message}`);
        }
    }

    /** Excalidraw 의 라이브러리 파일을 읽는다. 없거나 깨졌으면 빈 목록 — 여기서 죽으면 동기화 전체가 막힌다. */
    async readStencilLibrary(path: string): Promise<unknown[]> {
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (!(existing instanceof TFile)) {
            return [];
        }
        try {
            const parsed = JSON.parse(await this.app.vault.read(existing)) as {
                libraryItems?: unknown;
                library?: unknown;
            };
            if (Array.isArray(parsed.libraryItems)) return parsed.libraryItems;
            if (Array.isArray(parsed.library)) return parsed.library;   // 옛 형식
            return [];
        } catch {
            return [];
        }
    }

    async writeStencilLibrary(path: string, items: unknown[]): Promise<void> {
        const body = JSON.stringify(
            { type: "excalidrawlib", version: 2, source: "excalidash-live", libraryItems: items },
            null,
            2,
        );
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
            await this.app.vault.process(existing, () => body);
            return;
        }
        const folder = path.slice(0, path.lastIndexOf("/"));
        if (folder.length > 0 && this.app.vault.getAbstractFileByPath(folder) === null) {
            await this.app.vault.createFolder(folder);
        }
        await this.app.vault.create(path, body);
    }

    async syncFile(
        file: TFile,
        target: ExcaliDashTarget,
        rawFrontmatter: DrawingFrontmatter,
    ): Promise<SyncResult> {
        const frontmatter = this.resolveDrawingState(file, rawFrontmatter);
        try {
            const raw = await this.app.vault.read(file);
            const parsed = parseExcalidrawScene(raw, file.extension === "md");
            if (parsed === null) {
                return {
                    path: file.path,
                    status: "error",
                    message: "Unable to parse Excalidraw scene.",
                };
            }

            // 열려 있으면 화면이 정본이다. 파일은 Excalidraw 자동 저장(60 초)만큼 늦어서, 실시간으로 받은
            // 요소가 파일엔 아직 없다 — 그걸 "지웠다" 로 보고 tombstone 을 쏜 사고가 있었다(2026-09-23 05:25).
            const view = this.openExcalidrawView(file);
            if (view !== null) {
                parsed.scene.elements = view.excalidrawAPI.getSceneElementsIncludingDeleted();
            }

            const localHash = await sceneHash(parsed.scene);
            const localChanged = localHash !== frontmatter.lastHash;
            const collectionId = await resolveDrawingCollectionId(
                target,
                frontmatter.collection,
            );

            if (frontmatter.id === undefined) {
                const created = await createRemoteDrawing(
                    target,
                    remoteDrawingName(file),
                    parsed.scene,
                    collectionId,
                );
                await this.recordSync(
                    file,
                    created.id,
                    created.version,
                    localHash,
                    liveIdsOf(parsed.scene.elements ?? []),
                );
                return {
                    path: file.path,
                    status: "synced",
                    message: `Created remote drawing ${created.id}.`,
                };
            }

            const remote = await getRemoteDrawing(target, frontmatter.id);
            const remoteHash = await sceneHash(remote);
            const remoteElements = remote.elements ?? [];
            const remoteIds = remoteElements
                .map((element) => elementId(element))
                .filter((id): id is string => id !== null);
            const known = this.knownIdsOf(file);
            // 비교·전송은 서버 id 로 한다(짧게 바꾼 id 를 되돌린다).
            const localScene: ExcalidrawScene = {
                ...parsed.scene,
                elements: toRemoteIds(parsed.scene.elements ?? [], remoteIds),
            };
            const remoteChanged =
                frontmatter.version !== undefined &&
                remote.version !== frontmatter.version;
            // frontmatter 에 collection 이 **없으면 원격의 컬렉션을 그대로 둔다.**
            // 예전엔 없으면 null 로 보고 컬렉션에서 빼버렸는데, "지정 안 함" 은 "빼라" 가 아니다.
            const targetCollectionId =
                frontmatter.collection === undefined
                    ? (remote.collectionId ?? null)
                    : collectionId;
            const collectionChanged =
                (remote.collectionId ?? null) !== targetCollectionId;

            if (
                frontmatter.direction === "bidirectional" &&
                remoteChanged &&
                !localChanged
            ) {
                if (this.isOpenInExcalidrawView(file)) {
                    return await this.pullIntoOpenView(file, target, frontmatter);
                }
                const localIds = new Set(parsed.scene.elements.map((e) => elementId(e)).filter((id): id is string => id !== null));
                await this.writeRemoteSceneToLocal(file, raw, parsed, {
                    ...remote,
                    elements: toLocalIds(remoteElements, localIds),
                });
                await this.recordSync(
                    file,
                    remote.id,
                    remote.version,
                    remoteHash,
                    liveIdsOf(remoteElements),
                );
                return {
                    path: file.path,
                    status: "synced",
                    message: "Pulled remote changes into Obsidian.",
                };
            }

            // 본 적 있는 id 기록이 없으면(옛 기록) 무엇이 신규인지 모르므로 예전처럼 멈춘다.
            if (remoteChanged && known === undefined) {
                return {
                    path: file.path,
                    status: "conflict",
                    message: `Remote version is ${remote.version}; last synced version was ${frontmatter.version ?? "unknown"}.`,
                };
            }

            // 원격에만 살아 있는 요소(= 로컬에서 지웠는데 서버가 들고 있는 것). 로컬이 그대로여도
            // 이게 남아 있으면 스킵하면 안 된다 — 안 그러면 유령을 치울 기회가 영영 없다.
            const localLiveIds = liveIdsOf(localScene.elements);
            const remoteGhosts = [...liveIdsOf(remoteElements)].filter(
                (id) => !localLiveIds.has(id) && (known === undefined || known.has(id)),
            );

            if (!localChanged && !collectionChanged && remoteGhosts.length === 0) {
                return {
                    path: file.path,
                    status: "skipped",
                    message: "No local changes.",
                };
            }

            const outgoing = withTombstones(localScene, remoteElements, known);
            const updated = await updateRemoteDrawing(
                target,
                frontmatter.id,
                remoteDrawingName(file),
                outgoing,
                remote.version,
                targetCollectionId,
            );

            // 기록을 먼저 남긴다. 검증에서 걸리더라도 서버는 이미 올라갔으므로, 여기서 빠져나가면
            // 다음 저장이 같은 걸 또 밀어 올린다(실측: version 이 11 -> 30 까지 헛돌았다).
            await this.recordSync(
                file,
                updated.id,
                updated.version,
                localHash,
                liveIdsOf(mergeScenes({ ...remote, elements: [...remoteElements] }, outgoing.elements).scene.elements),
            );

            // 검증은 PUT 응답이 아니라 **다시 읽어서** 한다. 응답은 병합 전 상태를 담고 있어
            // 멀쩡한 결과를 유령으로 오판한다(실측). 지울 게 있었을 때만 확인한다.
            if (remoteGhosts.length > 0) {
                const after = await getRemoteDrawing(target, updated.id);
                const stillLive = liveIdsOf(after.elements ?? []);
                const leftover = [...stillLive].filter(
                    (id) => !localLiveIds.has(id) && remoteGhosts.includes(id),
                );
                if (leftover.length > 0) {
                    return {
                        path: file.path,
                        status: "error",
                        message: `Remote kept ${leftover.length} deleted element(s) (first: ${leftover[0]}).`,
                    };
                }
            }

            return {
                path: file.path,
                status: "synced",
                message: `Updated remote drawing to version ${updated.version}${
                    remoteGhosts.length > 0
                        ? ` (removed ${remoteGhosts.length} deleted element(s))`
                        : ""
                }.`,
            };
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            return {
                path: file.path,
                status: message.includes("409") ? "conflict" : "error",
                message,
            };
        }
    }

    /**
     * 동기화 기록을 남긴다. **도면 파일은 건드리지 않는다** — frontmatter 에 되쓰면 Excalidraw
     * 플러그인의 저장과 부딪혀 파일이 깨진다(설정의 syncState 주석 참조).
     */
    async recordSync(
        file: TFile,
        id: string,
        version: number,
        hash: string,
        seenIds?: Iterable<string>,
    ): Promise<void> {
        const previous = this.settings.syncState[file.path];
        const knownIds = previous?.id === id ? (previous.knownIds ?? []) : [];
        this.settings.syncState[file.path] = {
            id,
            version,
            lastHash: hash,
            lastSynced: new Date().toISOString(),
            knownIds: seenIds === undefined ? previous?.knownIds : [...new Set([...knownIds, ...seenIds])],
        };
        await this.saveSettings();
    }

    knownIdsOf(file: TFile): Set<string> | undefined {
        const ids = this.settings.syncState[file.path]?.knownIds;
        return ids === undefined ? undefined : new Set(ids);
    }

    /** 실시간으로 받은 id 도 "본 것" 이다. 저장은 다음 recordSync 에 묻어간다. */
    rememberSeen(file: TFile, ids: Iterable<string>): void {
        const state = this.settings.syncState[file.path];
        if (state === undefined) return;
        state.knownIds = [...new Set([...(state.knownIds ?? []), ...ids])];
    }

    /** frontmatter 의 opt-in 값 + 우리가 보관한 기록을 합친다. 기록이 없으면 옛 frontmatter 를 승계한다. */
    resolveDrawingState(
        file: TFile,
        frontmatter: DrawingFrontmatter,
    ): DrawingFrontmatter {
        const state = this.settings.syncState[file.path];
        if (state === undefined) {
            return frontmatter;
        }
        return {
            ...frontmatter,
            id: frontmatter.id ?? state.id,
            version: state.version,
            lastHash: state.lastHash,
            lastSynced: state.lastSynced,
        };
    }

    async writeRemoteSceneToLocal(
        file: TFile,
        raw: string,
        parsed: ParsedScene,
        remote: ExcalidrawScene,
    ): Promise<void> {
        const sceneDocument = { ...parsed.sceneDocument, ...remote };
        const replacement =
            parsed.sourceFormat === "compressed-json"
                ? compressToBase64(JSON.stringify(sceneDocument))
                : JSON.stringify(sceneDocument, null, 2);
        const withScene =
            parsed.jsonStart === 0 && parsed.jsonEnd === raw.length
                ? replacement
                : `${raw.slice(0, parsed.jsonStart)}${replacement}${raw.slice(parsed.jsonEnd)}`;

        // 씬만 바꾸고 텍스트 목록을 두면 둘이 어긋나 도면이 망가진다.
        const nextContent = rewriteTextElementsSection(withScene, sceneDocument as ExcalidrawScene);

        await this.app.vault.process(file, () => nextContent);
    }

    showSyncSummary(results: SyncResult[]): void {
        if (results.length === 0) {
            new Notice("ExcaliDash Live: no opted-in drawings found.");
            return;
        }

        const synced = results.filter(
            (item) => item.status === "synced",
        ).length;
        const skipped = results.filter(
            (item) => item.status === "skipped",
        ).length;
        const conflicts = results.filter((item) => item.status === "conflict");
        const errors = results.filter((item) => item.status === "error");

        const details = [...conflicts, ...errors]
            .map((item) => `${item.path}: ${item.message}`)
            .join("\n");
        // 0 인 항목은 말하지 않는다. "0 conflicts, 0 errors" 를 붙이면 성공이 실패처럼 읽힌다.
        const parts = [`${synced} synced`];
        if (skipped > 0) parts.push(`${skipped} unchanged`);
        if (conflicts.length > 0) parts.push(`${conflicts.length} conflicts`);
        if (errors.length > 0) parts.push(`${errors.length} failed`);
        const summary = `ExcaliDash Live: ${parts.join(", ")}.`;
        new Notice(
            details.length > 0 ? `${summary}\n${details}` : summary,
            details.length > 0 ? 12000 : 5000,
        );
    }

    async applyDrawingSettingsToFolder(
        folder: TFolder,
        settings: DrawingSettingsUpdate,
    ): Promise<void> {
        const files = collectExcalidrawFiles(folder);
        let updated = 0;
        const errors: string[] = [];

        for (const file of files) {
            try {
                await this.app.fileManager.processFrontMatter(
                    file,
                    (frontmatter) => {
                        applyDrawingSettingsFrontmatter(frontmatter, settings);
                    },
                );
                updated += 1;
            } catch (error) {
                errors.push(`${file.path}: ${sanitizeErrorMessage(error)}`);
            }
        }

        // 에러가 0 건인데도 "0 errors" 를 붙이면 성공을 실패로 읽는다(실측: 사용자가 그렇게 읽었다).
        // 0 건은 성공처럼 보이면 안 된다 — 폴더를 잘못 고른 경우가 대부분이다(실측).
        const summary =
            errors.length > 0
                ? `ExcaliDash Live: updated ${updated} drawings in ${folder.path}, ${errors.length} failed.\n${errors.join("\n")}`
                : updated === 0
                  ? `ExcaliDash Live: no Excalidraw drawings found in ${folder.path} — nothing was changed. Check the folder.`
                  : `ExcaliDash Live: updated ${updated} drawings in ${folder.path}.`;
        new Notice(summary, errors.length > 0 || updated === 0 ? 12000 : 5000);
    }
}

class ExcaliDashSettingTab extends PluginSettingTab {
    plugin: ExcaliDashSyncPlugin;

    constructor(app: App, plugin: ExcaliDashSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                type: "list",
                emptyState: "No ExcaliDash targets configured yet.",
                addItem: {
                    name: "Add target",
                    action: async () => {
                        this.plugin.settings.targets.push(createDefaultTarget());
                        await this.plugin.saveSettings();
                        this.update();
                    },
                },
                onDelete: async (index) => {
                    this.plugin.settings.targets.splice(index, 1);
                    await this.plugin.saveSettings();
                    this.update();
                },
                items: this.plugin.settings.targets.map((target, index) => ({
                    type: "page",
                    name:
                        target.name.trim().length > 0
                            ? `Target ${index + 1}: ${target.name.trim()}`
                            : `Target ${index + 1}`,
                    displayValue: target.baseUrl,
                    items: [
                        {
                            name: "Name",
                            desc: "Frontmatter destination value for this ExcaliDash instance.",
                            control: {
                                type: "text",
                                key: `targets.${index}.name`,
                                placeholder: "home",
                            },
                        },
                        {
                            name: "Base URL",
                            desc: "ExcaliDash server URL, for example https://excalidash.example.com.",
                            control: {
                                type: "text",
                                key: `targets.${index}.baseUrl`,
                                placeholder: "https://excalidash.example.com",
                            },
                        },
                        {
                            name: "Auth mode",
                            desc: "Use an existing personal API key, or generate one by logging in once.",
                            control: {
                                type: "dropdown",
                                key: `targets.${index}.authMode`,
                                options: {
                                    "api-key": "API key",
                                    "username-password":
                                        "Username and password",
                                },
                            },
                        },
                        {
                            name: "API key",
                            desc: "Personal API key used as an Authorization bearer token for sync requests.",
                            visible: () => target.authMode === "api-key",
                            render: (setting) => {
                                setting.addText((text) => {
                                    text.inputEl.type = "password";
                                    text.setPlaceholder("ExcaliDash API key")
                                        .setValue(target.apiKey)
                                        .onChange(async (value) => {
                                            target.apiKey = value.trim();
                                            await this.plugin.saveSettings();
                                        });
                                });
                            },
                        },
                        {
                            name: "Username",
                            desc: "Used only to generate or reuse a personal API key.",
                            visible: () =>
                                target.authMode === "username-password",
                            control: {
                                type: "text",
                                key: `targets.${index}.username`,
                                placeholder: "username",
                            },
                        },
                        {
                            name: "Password",
                            desc: "Used only during API key generation; normal sync uses the generated API key.",
                            visible: () =>
                                target.authMode === "username-password",
                            render: (setting) => {
                                setting.addText((text) => {
                                    text.inputEl.type = "password";
                                    text.setPlaceholder("password")
                                        .setValue(target.password)
                                        .onChange(async (value) => {
                                            target.password = value;
                                            await this.plugin.saveSettings();
                                        });
                                });
                            },
                        },
                        {
                            name: "Generated API key",
                            desc:
                                target.generatedApiKey.length > 0
                                    ? "A generated key is stored and will be used for sync."
                                    : "No generated API key is stored yet.",
                            visible: () =>
                                target.authMode === "username-password",
                        },
                        {
                            name: "Connection actions",
                            render: (setting) => {
                                setting.addButton((button) =>
                                    button
                                        .setButtonText("Test connection")
                                        .onClick(async () => {
                                            const targetIndex =
                                                this.plugin.settings.targets.indexOf(
                                                    target,
                                                );
                                            if (
                                                target.baseUrl.trim().length ===
                                                0
                                            ) {
                                                new Notice(
                                                    `ExcaliDash connection test failed for ${formatTargetName(target, targetIndex)}: base URL is required.`,
                                                );
                                                return;
                                            }

                                            try {
                                                const result =
                                                    await testExcaliDashConnection(
                                                        target,
                                                    );
                                                const suffix =
                                                    result.drawingCount ===
                                                    undefined
                                                        ? ""
                                                        : ` Found ${result.drawingCount} drawings.`;
                                                new Notice(
                                                    `ExcaliDash connection test succeeded for ${formatTargetName(target, targetIndex)}.${suffix}`,
                                                );
                                            } catch (error) {
                                                new Notice(
                                                    `ExcaliDash connection test failed for ${formatTargetName(target, targetIndex)}: ${sanitizeErrorMessage(error)}`,
                                                    10000,
                                                );
                                            }
                                        }),
                                );

                                if (
                                    target.authMode === "username-password"
                                ) {
                                    setting.addButton((button) =>
                                        button
                                            .setButtonText(
                                                "Generate API key from login",
                                            )
                                            .onClick(async () => {
                                                try {
                                                    target.generatedApiKey =
                                                        await generateApiKeyFromLogin(
                                                            target,
                                                        );
                                                    target.password = "";
                                                    await this.plugin.saveSettings();
                                                    this.update();
                                                    new Notice(
                                                        `ExcaliDash API key generated for ${formatTargetName(target, this.plugin.settings.targets.indexOf(target))}.`,
                                                    );
                                                } catch (error) {
                                                    new Notice(
                                                        `ExcaliDash API key generation failed for ${formatTargetName(target, this.plugin.settings.targets.indexOf(target))}: ${sanitizeErrorMessage(error)}`,
                                                        10000,
                                                    );
                                                }
                                            }),
                                    );
                                    setting.addButton((button) =>
                                        button
                                            .setButtonText(
                                                "Clear generated API key",
                                            )
                                            .onClick(async () => {
                                                target.generatedApiKey = "";
                                                await this.plugin.saveSettings();
                                                this.update();
                                            }),
                                    );
                                }
                            },
                        },
                    ],
                })),
            },
        ];
    }

    getControlValue(key: string): unknown {
        const [, index, field] = key.split(".");
        return this.plugin.settings.targets[Number(index)]?.[
            field as keyof ExcaliDashTarget
        ];
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        const [, index, field] = key.split(".");
        const target = this.plugin.settings.targets[Number(index)];
        if (target === undefined || !(field in target)) {
            throw new Error(`Unknown ExcaliDash setting '${key}'.`);
        }

        const normalized = String(value).trim();
        if (field === "authMode") {
            target.authMode =
                normalized === "username-password"
                    ? "username-password"
                    : "api-key";
        } else {
            target[
                field as Exclude<keyof ExcaliDashTarget, "authMode">
            ] = normalized;
        }
        await this.plugin.saveSettings();
    }
}

class DrawingSettingsModal extends Modal {
    plugin: ExcaliDashSyncPlugin;
    file: TFile;
    destination = "";
    collection = "";
    direction: SyncDirection = DEFAULT_SYNC_DIRECTION;

    constructor(app: App, plugin: ExcaliDashSyncPlugin, file: TFile) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        const frontmatter = parseDrawingFrontmatter(
            app.metadataCache.getFileCache(file)?.frontmatter,
        );
        this.destination = frontmatter.destination ?? "";
        this.collection = frontmatter.collection ?? "";
        this.direction = frontmatter.direction;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        new Setting(contentEl)
            .setName("ExcaliDash drawing settings")
            .setHeading();

        new Setting(contentEl)
            .setName("Destination")
            .setDesc(
                "Target name. Leave blank to opt this drawing out of sync.",
            )
            .addDropdown((dropdown) => {
                dropdown.addOption("", "Do not sync");
                for (const target of this.plugin.settings.targets) {
                    dropdown.addOption(target.name, target.name);
                }
                dropdown.setValue(this.destination);
                dropdown.onChange((value) => {
                    this.destination = value;
                });
            });

        new Setting(contentEl)
            .setName("Sync direction")
            .setDesc(
                "Bidirectional only pulls remote changes when the local drawing has not changed.",
            )
            .addDropdown((dropdown) =>
                dropdown
                    .addOption(
                        "obsidian-to-excalidash",
                        "Obsidian to ExcaliDash",
                    )
                    .addOption("bidirectional", "Bidirectional")
                    .setValue(this.direction)
                    .onChange((value) => {
                        this.direction =
                            value === "bidirectional"
                                ? "bidirectional"
                                : "obsidian-to-excalidash";
                    }),
            );

        new Setting(contentEl)
            .setName("Collection")
            .setDesc(
                "Optional ExcaliDash collection id, name, or title. Leave blank for no collection.",
            )
            .addText((text) =>
                text
                    .setPlaceholder("optional collection")
                    .setValue(this.collection)
                    .onChange((value) => {
                        this.collection = value.trim();
                    }),
            );

        new Setting(contentEl)
            .addButton((button) =>
                button
                    .setButtonText("Save")
                    .setCta()
                    .onClick(async () => {
                        await this.save();
                        this.close();
                    }),
            )
            .addButton((button) =>
                button.setButtonText("Cancel").onClick(() => this.close()),
            );
    }

    async save(): Promise<void> {
        await this.app.fileManager.processFrontMatter(
            this.file,
            (frontmatter) => {
                applyDrawingSettingsFrontmatter(frontmatter, {
                    destination: this.destination,
                    direction: this.direction,
                    collection: this.collection,
                });
            },
        );
    }
}

class FolderDrawingSettingsModal extends Modal {
    plugin: ExcaliDashSyncPlugin;
    folderPath = "";
    destination = "";
    collection = "";
    direction: SyncDirection = DEFAULT_SYNC_DIRECTION;

    constructor(app: App, plugin: ExcaliDashSyncPlugin) {
        super(app);
        this.plugin = plugin;
        this.folderPath = getActiveFileParentPath(app);
        this.refreshDefaultsForFolder();
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        new Setting(contentEl)
            .setName("Apply drawing settings to folder")
            .setHeading();

        const folders = collectFolders(this.app.vault.getRoot()).sort(
            (left, right) => left.path.localeCompare(right.path),
        );

        new Setting(contentEl)
            .setName("Folder")
            .setDesc(
                "Apply settings to Excalidraw files directly inside or under this folder.",
            )
            .addText((text) => {
                text.setPlaceholder("path/to/folder")
                    .setValue(this.folderPath)
                    .onChange((value) => {
                        this.folderPath = value.trim();
                    });
                text.inputEl.addEventListener("change", () => {
                    this.folderPath = text.getValue().trim();
                    this.refreshDefaultsForFolder();
                    this.onOpen();
                });
            })
            .addDropdown((dropdown) => {
                dropdown.addOption("", "Choose folder");
                for (const folder of folders) {
                    dropdown.addOption(folder.path, folder.path);
                }
                dropdown.setValue(this.folderPath);
                dropdown.onChange((value) => {
                    this.folderPath = value;
                    this.refreshDefaultsForFolder();
                    this.onOpen();
                });
            });

        new Setting(contentEl)
            .setName("Destination")
            .setDesc(
                "Target name. Leave blank to opt matching drawings out of sync.",
            )
            .addDropdown((dropdown) => {
                dropdown.addOption("", "Do not sync");
                for (const target of this.plugin.settings.targets) {
                    dropdown.addOption(target.name, target.name);
                }
                dropdown.setValue(this.destination);
                dropdown.onChange((value) => {
                    this.destination = value;
                });
            });

        new Setting(contentEl)
            .setName("Sync direction")
            .setDesc(
                "Bidirectional only pulls remote changes when the local drawing has not changed.",
            )
            .addDropdown((dropdown) =>
                dropdown
                    .addOption(
                        "obsidian-to-excalidash",
                        "Obsidian to ExcaliDash",
                    )
                    .addOption("bidirectional", "Bidirectional")
                    .setValue(this.direction)
                    .onChange((value) => {
                        this.direction =
                            value === "bidirectional"
                                ? "bidirectional"
                                : "obsidian-to-excalidash";
                    }),
            );

        new Setting(contentEl)
            .setName("Collection")
            .setDesc(
                "Optional ExcaliDash collection id, name, or title. Leave blank for no collection.",
            )
            .addText((text) =>
                text
                    .setPlaceholder("optional collection")
                    .setValue(this.collection)
                    .onChange((value) => {
                        this.collection = value.trim();
                    }),
            );

        new Setting(contentEl)
            .addButton((button) =>
                button
                    .setButtonText("Apply")
                    .setCta()
                    .onClick(async () => {
                        const folder = this.getFolder();
                        if (folder === null) {
                            new Notice(
                                "ExcaliDash Live: choose an existing folder.",
                            );
                            return;
                        }

                        await this.plugin.applyDrawingSettingsToFolder(folder, {
                            destination: this.destination,
                            direction: this.direction,
                            collection: this.collection,
                        });
                        this.close();
                    }),
            )
            .addButton((button) =>
                button.setButtonText("Cancel").onClick(() => this.close()),
            );
    }

    getFolder(): TFolder | null {
        return this.getFolderForPath(this.folderPath);
    }

    getFolderForPath(folderPath: string): TFolder | null {
        const normalized = normalizeObsidianPath(folderPath);
        const abstractFile =
            normalized.length === 0 || normalized === "/"
                ? this.app.vault.getRoot()
                : this.app.vault.getAbstractFileByPath(normalized);
        return abstractFile instanceof TFolder ? abstractFile : null;
    }

    refreshDefaultsForFolder(): void {
        const folder = this.getFolderForPath(this.folderPath);
        if (folder === null) {
            this.destination = "";
            this.collection = "";
            this.direction = DEFAULT_SYNC_DIRECTION;
            return;
        }

        const defaults = analyzeFolderDrawingSettings(this.app, folder);
        this.destination = defaults.destination;
        this.collection = defaults.collection;
        this.direction = defaults.direction;
    }
}

function getActiveFileParentPath(app: App): string {
    return app.workspace.getActiveFile()?.parent?.path ?? "";
}

interface DrawingSettingsUpdate {
    destination: string;
    direction: SyncDirection;
    collection: string;
}

function applyDrawingSettingsFrontmatter(
    frontmatter: Record<string, unknown>,
    settings: DrawingSettingsUpdate,
): void {
    if (settings.destination.length === 0) {
        delete frontmatter["excalidash-destination"];
        delete frontmatter["excalidash-sync"];
        delete frontmatter["excalidash-collection"];
        return;
    }

    frontmatter["excalidash-destination"] = settings.destination;
    frontmatter["excalidash-sync"] = settings.direction;
    if (settings.collection.length === 0) {
        delete frontmatter["excalidash-collection"];
    } else {
        frontmatter["excalidash-collection"] = settings.collection;
    }
}

function collectExcalidrawFiles(folder: TFolder): TFile[] {
    const files: TFile[] = [];

    for (const child of folder.children) {
        if (child instanceof TFile && isExcalidrawFile(child)) {
            files.push(child);
        } else if (child instanceof TFolder) {
            files.push(...collectExcalidrawFiles(child));
        }
    }

    return files;
}

function collectFolders(folder: TFolder): TFolder[] {
    const folders: TFolder[] = [folder];

    for (const child of folder.children) {
        if (child instanceof TFolder) {
            folders.push(...collectFolders(child));
        }
    }

    return folders;
}

function analyzeFolderDrawingSettings(
    app: App,
    folder: TFolder,
): DrawingSettingsUpdate {
    const destinationCounts = new Map<string, number>();
    const collectionCounts = new Map<string, number>();
    const directionCounts = new Map<SyncDirection, number>();

    for (const file of collectExcalidrawFiles(folder)) {
        const frontmatter = parseDrawingFrontmatter(
            app.metadataCache.getFileCache(file)?.frontmatter,
        );
        incrementCount(directionCounts, frontmatter.direction);

        if (frontmatter.destination !== undefined) {
            incrementCount(destinationCounts, frontmatter.destination);
        }

        if (frontmatter.collection !== undefined) {
            incrementCount(collectionCounts, frontmatter.collection);
        }
    }

    return {
        destination: mostFrequentValue(destinationCounts) ?? "",
        collection: mostFrequentValue(collectionCounts) ?? "",
        direction: mostFrequentValue(directionCounts) ?? DEFAULT_SYNC_DIRECTION,
    };
}

function incrementCount<T>(counts: Map<T, number>, value: T): void {
    counts.set(value, (counts.get(value) ?? 0) + 1);
}

function mostFrequentValue<T>(counts: Map<T, number>): T | undefined {
    let selected: T | undefined;
    let selectedCount = 0;

    for (const [value, count] of counts) {
        if (count > selectedCount) {
            selected = value;
            selectedCount = count;
        }
    }

    return selected;
}

interface ParsedScene {
    scene: ExcalidrawScene;
    sceneDocument: Record<string, unknown>;
    jsonStart: number;
    jsonEnd: number;
    sourceFormat: "json" | "compressed-json";
}

interface SceneCandidate {
    text: string;
    start: number;
    end: number;
    format: "json" | "compressed-json";
}

function parseExcalidrawScene(
    raw: string,
    markdown: boolean,
): ParsedScene | null {
    const withoutFrontmatter = markdown
        ? stripYamlFrontmatter(raw)
        : { content: raw, offset: 0 };
    const candidates = markdown
        ? findJsonCandidates(
              withoutFrontmatter.content,
              withoutFrontmatter.offset,
          )
        : [{ text: raw, start: 0, end: raw.length, format: "json" as const }];

    for (const candidate of candidates) {
        try {
            const json =
                candidate.format === "compressed-json"
                    ? decompressCompressedJson(candidate.text)
                    : candidate.text;
            const parsed = JSON.parse(json) as unknown;
            if (isSceneDocument(parsed)) {
                return {
                    scene: toScene(parsed),
                    sceneDocument: parsed,
                    jsonStart: candidate.start,
                    jsonEnd: candidate.end,
                    sourceFormat: candidate.format,
                };
            }
        } catch {
            continue;
        }
    }

    return null;
}

function stripYamlFrontmatter(raw: string): {
    content: string;
    offset: number;
} {
    if (!raw.startsWith("---\n")) {
        return { content: raw, offset: 0 };
    }

    const end = raw.indexOf("\n---", 4);
    if (end === -1) {
        return { content: raw, offset: 0 };
    }

    const after = raw.indexOf("\n", end + 4);
    const offset = after === -1 ? raw.length : after + 1;
    return { content: raw.slice(offset), offset };
}

function findJsonCandidates(content: string, offset: number): SceneCandidate[] {
    const candidates: SceneCandidate[] = [];
    const fenceRegex = /```([^\n`]*)\n([\s\S]*?)\n```/gi;
    let match: RegExpExecArray | null;

    while ((match = fenceRegex.exec(content)) !== null) {
        const fenceType = (match[1] ?? "").trim().toLowerCase();
        const format =
            fenceType === "compressed-json"
                ? "compressed-json"
                : fenceType === "" ||
                    fenceType === "json" ||
                    fenceType === "excalidraw"
                  ? "json"
                  : null;
        if (format === null) {
            continue;
        }

        const text = match[2] ?? "";
        const relativeStart = match.index + match[0].indexOf(text);
        candidates.push({
            text: text.trim(),
            start: offset + relativeStart,
            end: offset + relativeStart + text.length,
            format,
        });
    }

    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        candidates.push({
            text: content.slice(firstBrace, lastBrace + 1),
            start: offset + firstBrace,
            end: offset + lastBrace + 1,
            format: "json",
        });
    }

    return candidates;
}

function decompressCompressedJson(text: string): string {
    const decompressed = decompressFromBase64(text.replace(/\s+/g, ""));
    if (decompressed.length === 0) {
        throw new Error(
            "Unable to decompress Excalidraw compressed-json block.",
        );
    }

    return decompressed;
}

function isSceneDocument(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value)) {
        return false;
    }

    return (
        Array.isArray(value.elements) &&
        isRecord(value.appState ?? {}) &&
        isRecord(value.files ?? {})
    );
}

function toScene(value: Record<string, unknown>): ExcalidrawScene {
    return {
        elements: Array.isArray(value.elements) ? value.elements : [],
        appState: isRecord(value.appState) ? value.appState : {},
        files: isRecord(value.files) ? value.files : {},
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sceneHash(scene: ExcalidrawScene): Promise<string> {
    const normalized = JSON.stringify({
        elements: scene.elements,
        appState: scene.appState,
        files: scene.files,
    });
    const data = new TextEncoder().encode(normalized);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

async function createRemoteDrawing(
    target: ExcaliDashTarget,
    name: string,
    scene: ExcalidrawScene,
    collectionId: string | null,
): Promise<ExcaliDashDrawing> {
    return requestJson<ExcaliDashDrawing>(target, "POST", "/drawings", {
        name,
        ...scene,
        preview: null,
        collectionId,
    });
}

async function getRemoteDrawing(
    target: ExcaliDashTarget,
    id: string,
): Promise<ExcaliDashDrawing> {
    return requestJson<ExcaliDashDrawing>(
        target,
        "GET",
        `/drawings/${encodeURIComponent(id)}`,
    );
}

async function updateRemoteDrawing(
    target: ExcaliDashTarget,
    id: string,
    name: string,
    scene: ExcalidrawScene,
    version: number,
    collectionId: string | null,
): Promise<ExcaliDashDrawing> {
    return requestJson<ExcaliDashDrawing>(
        target,
        "PUT",
        `/drawings/${encodeURIComponent(id)}`,
        {
            name,
            ...scene,
            preview: null,
            version,
            collectionId,
        },
    );
}

async function resolveDrawingCollectionId(
    target: ExcaliDashTarget,
    collection: string | undefined,
): Promise<string | null> {
    if (collection === undefined) {
        return null;
    }

    const collections = await requestJson<unknown>(
        target,
        "GET",
        "/collections",
    );
    const resolved = resolveCollectionId(collection, collections);
    if (resolved === null) {
        throw new Error(
            `ExcaliDash collection '${collection}' was not found by id, name, or title.`,
        );
    }

    return resolved;
}

function resolveCollectionId(
    collection: string,
    value: unknown,
): string | null {
    if (!Array.isArray(value)) {
        throw new Error(
            "ExcaliDash collections response was not a JSON array.",
        );
    }

    const collections = value.filter(isExcaliDashCollection);
    return (
        collections.find((item) => item.id === collection)?.id ??
        collections.find(
            (item) => item.name === collection || item.title === collection,
        )?.id ??
        null
    );
}

function isExcaliDashCollection(value: unknown): value is ExcaliDashCollection {
    return isRecord(value) && typeof value.id === "string";
}

async function testExcaliDashConnection(
    target: ExcaliDashTarget,
): Promise<ConnectionTestResult> {
    const drawings = await requestJson<unknown>(
        target,
        "GET",
        "/drawings?includeData=false",
    );
    return {
        drawingCount: Array.isArray(drawings) ? drawings.length : undefined,
    };
}

async function requestJson<T>(
    target: ExcaliDashTarget,
    method: string,
    path: string,
    body?: unknown,
): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    headers.Authorization = `Bearer ${getTargetApiKey(target)}`;

    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    const params: RequestUrlParam = {
        url: buildApiUrl(target, path),
        method,
        headers,
        throw: false,
    };

    if (body !== undefined) {
        params.body = JSON.stringify(body);
    }

    const response = await requestUrl(params);
    return parseJsonResponse<T>(response, target, path, "ExcaliDash request");
}

function getTargetApiKey(target: ExcaliDashTarget): string {
    const apiKey =
        target.authMode === "username-password"
            ? target.generatedApiKey
            : target.apiKey;
    if (apiKey.trim().length === 0) {
        throw new Error(
            target.authMode === "username-password"
                ? "Generated API key is required. Use Generate API key from login before syncing."
                : "API key is required for this ExcaliDash target.",
        );
    }

    return apiKey.trim();
}

async function generateApiKeyFromLogin(
    target: ExcaliDashTarget,
): Promise<string> {
    if (target.generatedApiKey.trim().length > 0) {
        return target.generatedApiKey.trim();
    }

    if (target.baseUrl.trim().length === 0) {
        throw new Error("Base URL is required.");
    }

    if (target.username.trim().length === 0 || target.password.length === 0) {
        throw new Error(
            "Username and password are required to generate an API key.",
        );
    }

    const session = await loginWithPassword(target);
    const existingKey = await findExistingApiKey(target, session);
    if (existingKey !== null) {
        return existingKey;
    }

    const csrf = await getCsrfToken(target, session.cookieHeader);
    if (csrf.token.length === 0) {
        throw new Error(
            "CSRF token response did not include a token for API key creation.",
        );
    }

    const response = await requestUrl({
        url: buildApiUrl(target, "/auth/api-keys"),
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Cookie: session.cookieHeader,
            [DEFAULT_CSRF_HEADER]: csrf.token,
        },
        body: JSON.stringify({ name: GENERATED_API_KEY_NAME }),
        throw: false,
    });

    const json = parseJsonResponse<unknown>(
        response,
        target,
        "/auth/api-keys",
        "ExcaliDash API key creation",
    );
    const apiKey = extractApiKey(json);
    if (apiKey === null) {
        throw new Error(
            "ExcaliDash API key creation response did not include an API key.",
        );
    }

    return apiKey;
}

async function loginWithPassword(
    target: ExcaliDashTarget,
): Promise<TemporarySession> {
    const csrf = await getCsrfToken(target);
    if (csrf.token.length === 0) {
        throw new Error(
            "CSRF token response did not include a token for login.",
        );
    }

    const response = await requestUrl({
        url: buildApiUrl(target, "/auth/login"),
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(csrf.cookieHeader.length > 0
                ? { Cookie: csrf.cookieHeader }
                : {}),
            [DEFAULT_CSRF_HEADER]: csrf.token,
        },
        body: JSON.stringify({
            username: target.username,
            password: target.password,
        }),
        throw: false,
    });

    parseJsonResponse<unknown>(
        response,
        target,
        "/auth/login",
        "ExcaliDash login",
    );
    const session = mergeSessionCookies(
        { cookieHeader: csrf.cookieHeader },
        response,
    );
    if (session.cookieHeader.length === 0) {
        throw new Error("ExcaliDash login did not return a session cookie.");
    }

    return session;
}

/** 소켓 핸드셰이크용 access JWT. 로그인 쿠키에서 꺼낸다. */
async function accessTokenFor(target: ExcaliDashTarget): Promise<string> {
    const session = await loginWithPassword(target);
    const match = /(?:^|;\s*)excalidash-access-token=([^;]+)/.exec(session.cookieHeader);
    if (match === null) throw new Error("ExcaliDash login returned no access token.");
    return match[1];
}

async function findExistingApiKey(
    target: ExcaliDashTarget,
    session: TemporarySession,
): Promise<string | null> {
    const response = await requestUrl({
        url: buildApiUrl(target, "/auth/api-keys"),
        method: "GET",
        headers: {
            Accept: "application/json",
            Cookie: session.cookieHeader,
        },
        throw: false,
    });

    const json = parseJsonResponse<unknown>(
        response,
        target,
        "/auth/api-keys",
        "ExcaliDash API key lookup",
    );
    return extractNamedApiKey(json, GENERATED_API_KEY_NAME);
}

async function getCsrfToken(
    target: ExcaliDashTarget,
    cookieHeader = "",
): Promise<{ token: string; cookieHeader: string }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (cookieHeader.length > 0) {
        headers.Cookie = cookieHeader;
    }

    const response = await requestUrl({
        url: buildApiUrl(target, DEFAULT_CSRF_ENDPOINT),
        method: "GET",
        headers,
        throw: false,
    });

    const json = parseJsonResponse<Partial<{ token: string; header: string }>>(
        response,
        target,
        DEFAULT_CSRF_ENDPOINT,
        "CSRF token request",
    );
    const session = mergeSessionCookies({ cookieHeader }, response);
    return {
        token: typeof json.token === "string" ? json.token : "",
        cookieHeader: session.cookieHeader,
    };
}

function mergeSessionCookies(
    session: TemporarySession,
    response: RequestUrlResponse,
): TemporarySession {
    const cookies = extractSetCookies(response.headers);
    if (cookies.length === 0) {
        return session;
    }

    const jar = new Map<string, string>();
    for (const cookie of splitCookieHeader(session.cookieHeader)) {
        const name = cookie.split("=", 1)[0]?.trim();
        if (name !== undefined && name.length > 0) {
            jar.set(name, cookie);
        }
    }

    for (const cookie of cookies) {
        const pair = cookie.split(";", 1)[0]?.trim() ?? "";
        const name = pair.split("=", 1)[0]?.trim();
        if (name.length > 0 && pair.length > 0) {
            jar.set(name, pair);
        }
    }

    return { cookieHeader: Array.from(jar.values()).join("; ") };
}

function extractSetCookies(headers: Record<string, unknown>): string[] {
    for (const [key, value] of Object.entries(headers ?? {})) {
        if (key.toLowerCase() !== "set-cookie") {
            continue;
        }

        // Obsidian's requestUrl returns multi-value headers as an array on some
        // platforms, so set-cookie is not always a string. Calling .trim() on it
        // blows up with "x.trim is not a function" before login is even attempted.
        const items = (Array.isArray(value) ? value : [value])
            .filter((item): item is string => typeof item === "string")
            .flatMap((item) => item.split(/,(?=\s*[^;,\s]+=)/))
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
        if (items.length > 0) {
            return items;
        }
    }

    return [];
}

function splitCookieHeader(cookieHeader: string): string[] {
    return cookieHeader
        .split(";")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

function extractNamedApiKey(value: unknown, name: string): string | null {
    const keys = Array.isArray(value)
        ? value
        : isRecord(value) && Array.isArray(value.apiKeys)
          ? value.apiKeys
          : [];
    for (const key of keys) {
        if (!isRecord(key)) {
            continue;
        }

        const keyName =
            typeof key.name === "string"
                ? key.name
                : typeof key.label === "string"
                  ? key.label
                  : "";
        if (keyName === name) {
            return extractApiKey(key);
        }
    }

    return null;
}

function extractApiKey(value: unknown): string | null {
    if (!isRecord(value)) {
        return typeof value === "string" && value.length > 0 ? value : null;
    }

    for (const field of [
        "apiKey",
        "key",
        "token",
        "value",
        "secret",
    ] as const) {
        const apiKey = value[field];
        if (typeof apiKey === "string" && apiKey.length > 0) {
            return apiKey;
        }

        const nestedApiKey = extractApiKey(apiKey);
        if (nestedApiKey !== null) {
            return nestedApiKey;
        }
    }

    return null;
}

function parseJsonResponse<T>(
    response: RequestUrlResponse,
    target: ExcaliDashTarget,
    path: string,
    requestName: string,
): T {
    const displayPath = getApiDisplayPath(path);
    const contentType = getHeader(response.headers, "content-type");

    if (!isJsonContentType(contentType)) {
        const received =
            contentType.length > 0 ? contentType : "unknown content type";
        throw new Error(
            `Expected JSON from ${displayPath} but received ${received}; check the ExcaliDash base URL.`,
        );
    }

    if (response.status < 200 || response.status >= 300) {
        throw new Error(
            `${requestName} to ${displayPath} failed with HTTP ${response.status}.`,
        );
    }

    try {
        return JSON.parse(response.text) as T;
    } catch {
        throw new Error(
            `Expected JSON from ${displayPath} but received invalid JSON; check the ExcaliDash base URL.`,
        );
    }
}

function getHeader(headers: Record<string, string>, name: string): string {
    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lowerName) {
            return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        }
    }
    return "";
}

function isJsonContentType(contentType: string): boolean {
    return contentType === "application/json" || contentType.endsWith("+json");
}

function buildApiUrl(target: ExcaliDashTarget, path: string): string {
    if (
        baseUrlEndsWithPathPrefix(target.baseUrl, DEFAULT_API_PATH_PREFIX)
    ) {
        return joinUrl(target.baseUrl, path);
    }

    return joinUrl(target.baseUrl, joinPath(DEFAULT_API_PATH_PREFIX, path));
}

function getApiDisplayPath(path: string): string {
    return joinPath(DEFAULT_API_PATH_PREFIX, path);
}

function baseUrlEndsWithPathPrefix(
    baseUrl: string,
    pathPrefix: string,
): boolean {
    try {
        const parsed = new URL(baseUrl);
        const pathname = normalizePath(parsed.pathname);
        return pathname === pathPrefix || pathname.endsWith(pathPrefix);
    } catch {
        return (
            normalizePath(baseUrl) === pathPrefix ||
            normalizePath(baseUrl).endsWith(pathPrefix)
        );
    }
}

function joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function joinPath(prefix: string, path: string): string {
    return `${normalizePathPrefix(prefix)}${normalizePath(path)}`;
}

function normalizePath(path: string): string {
    const trimmed = path.trim();
    return `/${trimmed.replace(/^\/+/, "")}`;
}

function normalizePathPrefix(pathPrefix: string): string {
    const trimmed = pathPrefix.trim().replace(/^\/+|\/+$/g, "");
    return trimmed.length > 0 ? `/${trimmed}` : "";
}

function formatTargetName(target: ExcaliDashTarget, index: number): string {
    return target.name.trim().length > 0
        ? target.name.trim()
        : `Target ${index + 1}`;
}

function sanitizeErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message
        .replace(/(cookie\s*[:=]\s*)[^\n,;]+/gi, "$1[redacted]")
        .replace(/(authorization\s*[:=]\s*bearer\s+)[^\n,;]+/gi, "$1[redacted]")
        .replace(/(api[-_\s]*key\s*[:=]\s*)[^\n,;]+/gi, "$1[redacted]")
        .replace(/(password\s*[:=]\s*)[^\n,;]+/gi, "$1[redacted]")
        .replace(/(csrf[-_\s]*(?:token)?\s*[:=]\s*)[^\n,;]+/gi, "$1[redacted]")
        .replace(/(x-csrf-token\s*[:=]\s*)[^\n,;]+/gi, "$1[redacted]");
}

function parseDrawingFrontmatter(
    frontmatter: Record<string, unknown> | undefined,
): DrawingFrontmatter {
    const syncValue = frontmatter?.["excalidash-sync"];
    const direction =
        syncValue === "bidirectional" || syncValue === "bydirectional"
            ? "bidirectional"
            : DEFAULT_SYNC_DIRECTION;
    const version = frontmatter?.["excalidash-version"];

    return {
        destination: readNonEmptyString(
            frontmatter?.["excalidash-destination"],
        ),
        collection: readNonEmptyString(frontmatter?.["excalidash-collection"]),
        direction,
        id: readNonEmptyString(frontmatter?.["excalidash-id"]),
        version:
            typeof version === "number"
                ? version
                : Number.isFinite(Number(version))
                  ? Number(version)
                  : undefined,
        lastHash: readNonEmptyString(frontmatter?.["excalidash-last-hash"]),
        lastSynced: readNonEmptyString(frontmatter?.["excalidash-last-synced"]),
    };
}

function readNonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined;
}

/** 같은 key 로 연달아 들어오면 마지막 것만 남긴다. */
function debounceByKey(
    timers: Map<string, ReturnType<typeof setTimeout>>,
    key: string,
    delayMs: number,
    run: () => void,
): void {
    const existing = timers.get(key);
    if (existing !== undefined) {
        clearTimeout(existing);
    }
    timers.set(
        key,
        setTimeout(() => {
            timers.delete(key);
            run();
        }, delayMs),
    );
}

/**
 * 새 씬에 없는 원격 요소를 isDeleted 로 되돌려 보낸다.
 *
 * ExcaliDash 는 요소 단위로 병합한다(같은 id 는 version 큰 쪽이 이긴다). 그래서 지운 요소를
 * 그냥 빼고 PUT 하면 서버가 자기 사본을 그대로 들고 있어 **삭제가 반영되지 않는다**. Excalidraw
 * 플러그인은 지운 요소를 씬에서 아예 빼버리므로 로컬에는 tombstone 이 없다 — 여기서 만들어야 한다.
 *
 * 이미 죽은 id 도 매번 다시 싣는다(영구 tombstone). 떨어뜨리면 그 사이 열려 있던 편집기가
 * 다음 저장에서 서버와 병합하며 옛 요소를 되살린다.
 */
function elementId(element: unknown): string | null {
    return isRecord(element) && typeof element.id === "string" ? element.id : null;
}

function isLiveElement(element: unknown): boolean {
    return isRecord(element) && element.isDeleted !== true;
}

/**
 * 원격 씬을 로컬 씬에 합친다. **요소 단위로 version 큰 쪽이 이긴다** — Excalidraw 자체의 reconcile 과
 * 같은 규칙이라 공통 조상이 필요 없고, 그래서 여러 사람이 동시에 고쳐도 성립한다.
 * 삭제는 tombstone(`isDeleted`)이 그냥 하나의 상태로 참여한다.
 */
function mergeScenes(
    local: ExcalidrawScene,
    remoteElements: readonly unknown[],
): { scene: ExcalidrawScene; changed: number } {
    const byId = new Map<string, Record<string, unknown>>();
    for (const element of local.elements ?? []) {
        const id = elementId(element);
        if (id !== null) byId.set(id, element as Record<string, unknown>);
    }

    let changed = 0;
    for (const element of remoteElements) {
        const id = elementId(element);
        if (id === null) continue;
        const mine = byId.get(id);
        const theirs = element as Record<string, unknown>;
        if (mine === undefined) {
            byId.set(id, theirs);
            changed++;
            continue;
        }
        if (Number(theirs.version ?? 0) > Number(mine.version ?? 0)) {
            byId.set(id, theirs);
            changed++;
        }
    }

    return { scene: { ...local, elements: [...byId.values()] }, changed };
}

/**
 * Excalidraw 플러그인은 `## Text Elements` 를 **정확히 8 자 id**(`\s\^(.{8})\n+`)로만 끊어 읽는다.
 * 8 자가 아닌 id 의 줄은 경계로 안 잡혀 **다음 8 자 id 의 텍스트에 통째로 붙는다** — 2026-09-23 에
 * 텍스트 박스에 목록이 빨려 들어가던 사고의 진짜 원인(excalidraw 스킬이 만든 `desc:t0`·`th` 같은 id).
 * 그리고 저장할 때 **8 자 넘는 텍스트·링크 요소 id 는 무작위 8 자로 바꾼다**
 * (`findNewTextElementsInScene`, `^블록참조` 를 쓰려고). ExcaliDash 웹이 만드는 id 는 20 자라 전부 걸리고,
 * 서버엔 원래 id 가 살아 있으니 당겨올 때마다 한 벌씩 더 생긴다(2026-09-23 `claude-text-1` 두 벌).
 *
 * 그래서 들어올 때 **결정론적으로** 8 자로 줄이고(같은 id 는 늘 같은 짧은 id), 나갈 때 되돌린다.
 * 서버와 웹은 원래 id 를 그대로 본다.
 */
function shortElementId(id: string): string {
    // ponytail: 53 비트 해시(cyrb53)에서 8 자, 도면당 수천 요소까지 충돌 무시 가능
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < id.length; i++) {
        const c = id.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(8, "0").slice(-8);
}

/** 요소 id 와 그 id 를 가리키는 참조(컨테이너·바인딩·프레임)를 함께 바꾼다. */
function remapElementIds(elements: readonly unknown[], map: Map<string, string>): unknown[] {
    if (map.size === 0) return [...elements];
    const re = (id: unknown) => (typeof id === "string" ? (map.get(id) ?? id) : id);
    return elements.map((element) => {
        if (!isRecord(element)) return element;
        const out: Record<string, unknown> = { ...element, id: re(element.id) };
        if ("containerId" in element) out.containerId = re(element.containerId);
        if ("frameId" in element) out.frameId = re(element.frameId);
        if (Array.isArray(element.boundElements)) {
            out.boundElements = element.boundElements.map((b) =>
                isRecord(b) ? { ...b, id: re(b.id) } : b,
            );
        }
        for (const key of ["startBinding", "endBinding"]) {
            const binding = element[key];
            if (isRecord(binding)) out[key] = { ...binding, elementId: re(binding.elementId) };
        }
        return out;
    });
}

/** 서버 → 로컬. 로컬에 원래 id 그대로 있는 요소는 건드리지 않는다(예전에 올린 것). */
function toLocalIds(remote: readonly unknown[], localIds: ReadonlySet<string>): unknown[] {
    const map = new Map<string, string>();
    for (const element of remote) {
        const id = elementId(element);
        if (id !== null && id.length !== 8 && !localIds.has(id)) map.set(id, shortElementId(id));
    }
    return remapElementIds(remote, map);
}

/** 로컬 → 서버. 짧은 id 중 서버 id 에서 나온 것만 원래대로 되돌린다. */
function toRemoteIds(local: readonly unknown[], remoteIds: Iterable<string>): unknown[] {
    const localIds = new Set(
        local.map((element) => elementId(element)).filter((id): id is string => id !== null),
    );
    const remote = new Set(remoteIds);
    const map = new Map<string, string>();
    for (const id of remote) {
        if (id.length === 8 || localIds.has(id)) continue;
        const short = shortElementId(id);
        // 서버가 짧은 id 자체를 갖고 있으면(서버 쪽 id 정리 뒤) 되돌리지 않는다.
        if (localIds.has(short) && !remote.has(short)) map.set(short, id);
    }
    return remapElementIds(local, map);
}

function liveIdsOf(list: readonly unknown[]): Set<string> {
    return new Set(
        list
            .filter((element) => isLiveElement(element))
            .map((element) => elementId(element))
            .filter((id): id is string => id !== null),
    );
}

function withTombstones(
    scene: ExcalidrawScene,
    remoteElements: readonly unknown[],
    knownIds?: ReadonlySet<string>,
): ExcalidrawScene {
    // id 당 한 벌만 보낸다. 열린 도면은 화면(지운 요소 포함)을 올리므로, 로컬에 이미 죽은 사본이 있는 id 에
    // tombstone 을 또 붙이면 서버에 같은 id 가 두 벌 쌓이고 push 마다 불어난다(2026-09-23 05:35, 146→1,198).
    const byId = new Map<string, Record<string, unknown>>();
    for (const element of Array.isArray(scene.elements) ? scene.elements : []) {
        const id = elementId(element);
        if (id === null) continue;
        const e = element as Record<string, unknown>;
        const prev = byId.get(id);
        if (prev === undefined || Number(e.version ?? 0) > Number(prev.version ?? 0)) byId.set(id, e);
    }
    const stamp = Date.now();
    for (const element of remoteElements) {
        const id = elementId(element);
        if (id === null) continue;
        const mine = byId.get(id);
        if (mine !== undefined && isLiveElement(mine)) continue;
        // 본 적 없는 요소는 남이 방금 그린 것이다 — 우리가 지운 게 아니다.
        if (mine === undefined && knownIds !== undefined && !knownIds.has(id)) continue;
        const theirs = element as Record<string, unknown>;
        const base = mine ?? theirs;
        byId.set(id, {
            ...base,
            isDeleted: true,
            version: Math.max(Number(theirs.version ?? 0) + 1, Number(base.version ?? 0) + 1, stamp),
            versionNonce: stamp,
        });
    }

    return { ...scene, elements: [...byId.values()] };
}

/** 라이브러리 항목을 id 로 합친다. 같은 id 면 created 가 큰 쪽(더 최근에 만든 것)을 남긴다. */
function mergeLibraryItems(
    local: readonly unknown[],
    remote: readonly unknown[],
): unknown[] {
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of [...local, ...remote]) {
        if (!isRecord(item)) continue;
        const id = typeof item.id === "string" ? item.id : null;
        if (id === null) continue;
        const current = byId.get(id);
        if (
            current === undefined ||
            Number(item.created ?? 0) > Number(current.created ?? 0)
        ) {
            byId.set(id, item);
        }
    }
    return [...byId.values()];
}

/** Excalidraw 플러그인이 쓰는 스텐실 라이브러리 파일 경로. 설정을 읽고, 없으면 기본값. */
function excalidrawLibraryPath(app: App): string {
    const settings = (
        app as unknown as {
            plugins?: { plugins?: Record<string, { settings?: Record<string, unknown> }> };
        }
    ).plugins?.plugins?.["obsidian-excalidraw-plugin"]?.settings;
    const folder =
        typeof settings?.libraryFolderPath === "string" && settings.libraryFolderPath.length > 0
            ? settings.libraryFolderPath
            : "Excalidraw/Libraries";
    const name =
        typeof settings?.libraryFileName === "string" && settings.libraryFileName.length > 0
            ? settings.libraryFileName
            : "local-library";
    return `${folder}/${name}.excalidrawlib`;
}

/** 원격 드로잉 이름. `foo.excalidraw.md` 의 basename 은 `foo.excalidraw` 라 꼬리를 뗀다. */
/**
 * `## Text Elements` 구간을 씬에서 다시 만든다.
 *
 * Excalidraw 플러그인은 도면의 글자를 이 구간에 `<텍스트> ^<요소 id>` 로 풀어 적고(검색·링크용),
 * 파일을 읽을 때 **여기서 텍스트를 가져온다**. 그래서 씬 블록만 바꾸고 이 구간을 두면 둘이 어긋나
 * 엉뚱한 요소에 엉뚱한 글자가 들어간다 — 2026-09-23 에 도면 두 개가 이렇게 망가졌다.
 */
function rewriteTextElementsSection(raw: string, scene: ExcalidrawScene): string {
    const start = raw.indexOf("## Text Elements");
    if (start < 0) return raw;
    const after = raw.indexOf("\n## ", start + 1);
    const end = after < 0 ? raw.length : after + 1;

    const lines: string[] = [];
    for (const element of scene.elements ?? []) {
        if (!isRecord(element) || element.type !== "text" || element.isDeleted === true) continue;
        const id = elementId(element);
        const text = typeof element.text === "string" ? element.text : "";
        if (id === null || text.length === 0) continue;
        lines.push(`${text} ^${id}`);
    }

    return `${raw.slice(0, start)}## Text Elements\n${lines.join("\n\n")}\n\n${raw.slice(end)}`;
}

function remoteDrawingName(file: TFile): string {
    return file.basename.replace(/\.excalidraw$/i, "");
}

function isExcalidrawFile(file: TFile): boolean {
    return (
        file.path.endsWith(".excalidraw") ||
        file.path.endsWith(".excalidraw.md")
    );
}

function normalizeSettings(
    loaded: Partial<ExcaliDashSyncSettings> | null,
): ExcaliDashSyncSettings {
    return {
        targets: Array.isArray(loaded?.targets)
            ? loaded.targets.map((target) =>
                  normalizeTarget(target as PersistedExcaliDashTarget),
              )
            : [],
        syncState: isRecord(loaded?.syncState)
            ? (loaded.syncState as Record<string, SyncState>)
            : {},
    };
}

function normalizeTarget(target: PersistedExcaliDashTarget): ExcaliDashTarget {
    return {
        name: target.name ?? "",
        baseUrl: target.baseUrl ?? "",
        authMode:
            target.authMode === "username-password"
                ? "username-password"
                : "api-key",
        apiKey: target.apiKey ?? "",
        username: target.username ?? "",
        password: target.password ?? "",
        generatedApiKey: target.generatedApiKey ?? "",
    };
}

function createDefaultTarget(): ExcaliDashTarget {
    return normalizeTarget({ name: "home" });
}
