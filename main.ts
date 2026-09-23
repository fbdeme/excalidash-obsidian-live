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

// Excalidraw 는 그리는 동안 파일을 계속 저장한다. 이 정도는 기다려야 획 하나마다 서버로 쏘지 않는다.
const AUTO_SYNC_DEBOUNCE_MS = 2500;

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

interface ExcaliDashSyncSettings {
    targets: ExcaliDashTarget[];
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
};

export default class ExcaliDashSyncPlugin extends Plugin {
    settings: ExcaliDashSyncSettings = DEFAULT_SETTINGS;
    private autoSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private autoSyncRunning = new Set<string>();

    async onload(): Promise<void> {
        await this.loadSettings();

        // 저장할 때마다 자동으로 올린다. opt-in 된 파일만 건드리므로 별도 설정을 두지 않는다.
        // 되쓰기 루프는 구조적으로 생기지 않는다: syncFile 은 씬 해시가 그대로면 skipped 로 빠져
        // frontmatter 를 아예 쓰지 않는다.
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (file instanceof TFile) {
                    this.queueAutoSync(file);
                }
            }),
        );

        this.addCommand({
            id: "perform-sync",
            name: "Sync current drawing",
            callback: () => {
                void this.performSync();
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

    async syncFile(
        file: TFile,
        target: ExcaliDashTarget,
        frontmatter: DrawingFrontmatter,
    ): Promise<SyncResult> {
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

            const localHash = await sceneHash(parsed.scene);
            const localChanged = localHash !== frontmatter.lastHash;
            const collectionId = await resolveDrawingCollectionId(
                target,
                frontmatter.collection,
            );

            if (frontmatter.id === undefined) {
                const created = await createRemoteDrawing(
                    target,
                    file.basename,
                    parsed.scene,
                    collectionId,
                );
                await this.updateSyncFrontmatter(
                    file,
                    created.id,
                    created.version,
                    localHash,
                );
                return {
                    path: file.path,
                    status: "synced",
                    message: `Created remote drawing ${created.id}.`,
                };
            }

            const remote = await getRemoteDrawing(target, frontmatter.id);
            const remoteHash = await sceneHash(remote);
            const remoteChanged =
                frontmatter.version !== undefined &&
                remote.version !== frontmatter.version;
            const collectionChanged =
                (remote.collectionId ?? null) !== collectionId;

            if (
                frontmatter.direction === "bidirectional" &&
                remoteChanged &&
                !localChanged
            ) {
                await this.writeRemoteSceneToLocal(file, raw, parsed, remote);
                await this.updateSyncFrontmatter(
                    file,
                    remote.id,
                    remote.version,
                    remoteHash,
                );
                return {
                    path: file.path,
                    status: "synced",
                    message: "Pulled remote changes into Obsidian.",
                };
            }

            if (remoteChanged) {
                return {
                    path: file.path,
                    status: "conflict",
                    message: `Remote version is ${remote.version}; last synced version was ${frontmatter.version ?? "unknown"}.`,
                };
            }

            if (!localChanged && !collectionChanged) {
                return {
                    path: file.path,
                    status: "skipped",
                    message: "No local changes.",
                };
            }

            const outgoing = withTombstones(parsed.scene, remote.elements ?? []);
            const updated = await updateRemoteDrawing(
                target,
                frontmatter.id,
                file.basename,
                outgoing,
                remote.version,
                collectionId,
            );

            // 올린 뒤 대조한다. 살아 있는 id 집합이 어긋나면 조용히 넘기지 않는다.
            const liveIdsOf = (list: readonly unknown[]): Set<string> =>
                new Set(
                    list
                        .filter((element) => isLiveElement(element))
                        .map((element) => elementId(element))
                        .filter((id): id is string => id !== null),
                );
            const expectedLive = liveIdsOf(outgoing.elements ?? []);
            const actualLive = liveIdsOf(updated.elements ?? []);
            const ghosts = [...actualLive].filter((id) => !expectedLive.has(id));
            if (ghosts.length > 0) {
                return {
                    path: file.path,
                    status: "error",
                    message: `Remote kept ${ghosts.length} element(s) that are gone locally (first: ${ghosts[0]}).`,
                };
            }
            await this.updateSyncFrontmatter(
                file,
                updated.id,
                updated.version,
                localHash,
            );
            return {
                path: file.path,
                status: "synced",
                message: `Updated remote drawing to version ${updated.version}.`,
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

    async updateSyncFrontmatter(
        file: TFile,
        id: string,
        version: number,
        hash: string,
    ): Promise<void> {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            frontmatter["excalidash-id"] = id;
            frontmatter["excalidash-version"] = version;
            frontmatter["excalidash-last-hash"] = hash;
            frontmatter["excalidash-last-synced"] = new Date().toISOString();
        });
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
        const nextContent =
            parsed.jsonStart === 0 && parsed.jsonEnd === raw.length
                ? replacement
                : `${raw.slice(0, parsed.jsonStart)}${replacement}${raw.slice(parsed.jsonEnd)}`;

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
        const summary = `ExcaliDash Live: ${synced} synced, ${skipped} skipped, ${conflicts.length} conflicts, ${errors.length} errors.`;
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

        const summary = `ExcaliDash Live: updated ${updated} drawings in ${folder.path}. ${errors.length} errors.`;
        new Notice(
            errors.length > 0 ? `${summary}\n${errors.join("\n")}` : summary,
            errors.length > 0 ? 12000 : 5000,
        );
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

function withTombstones(
    scene: ExcalidrawScene,
    remoteElements: readonly unknown[],
): ExcalidrawScene {
    const elements = Array.isArray(scene.elements) ? scene.elements : [];
    const liveIds = new Set(
        elements
            .filter((element) => isLiveElement(element))
            .map((element) => elementId(element))
            .filter((id): id is string => id !== null),
    );
    const stamp = Date.now();
    const tombstones = remoteElements
        .filter((element) => {
            const id = elementId(element);
            return id !== null && !liveIds.has(id);
        })
        .map((element) => ({
            ...(element as Record<string, unknown>),
            isDeleted: true,
            version: Math.max(
                Number((element as Record<string, unknown>).version ?? 0) + 1,
                stamp,
            ),
            versionNonce: stamp,
        }));

    return { ...scene, elements: [...elements, ...tombstones] };
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
