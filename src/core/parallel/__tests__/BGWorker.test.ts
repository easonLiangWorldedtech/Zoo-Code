// npx vitest run src/core/parallel/__tests__/BGWorker.test.ts

import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "events"

// Mock vscode for vitest (BGWorker imports it at top level)
vi.mock("vscode", () => ({
    workspace: {
        workspaceFolders: [],
        getWorkspaceFolder: () => null,
        onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
        getConfiguration: () => ({ get: (key, defaultValue) => defaultValue }),
        createFileSystemWatcher: () => ({
            onDidCreate: () => ({ dispose: () => {} }),
            onDidChange: () => ({ dispose: () => {} }),
            onDidDelete: () => ({ dispose: () => {} }),
            dispose: () => {},
        }),
    },
    window: {
        activeTextEditor: null,
        onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
        showErrorMessage: () => Promise.resolve(),
        showWarningMessage: () => Promise.resolve(),
        showInformationMessage: () => Promise.resolve(),
        createOutputChannel: () => ({ appendLine: () => {}, append: () => {}, clear: () => {}, show: () => {}, dispose: () => {} }),
        createTerminal: () => ({ exitStatus: undefined, name: "Roo Code", processId: Promise.resolve(123), creationOptions: {}, state: { isInteractedWith: true }, dispose: () => {}, hide: () => {}, show: () => {}, sendText: () => {} }),
        onDidCloseTerminal: () => ({ dispose: () => {} }),
        createTextEditorDecorationType: () => ({ dispose: () => {} }),
    },
    commands: { registerCommand: () => ({ dispose: () => {} }), executeCommand: () => Promise.resolve() },
    languages: { createDiagnosticCollection: () => ({ set: () => {}, delete: () => {}, clear: () => {}, dispose: () => {} }) },
    extensions: { getExtension: () => null },
    env: { openExternal: () => Promise.resolve() },
    Uri: class { constructor(...args) { this.fsPath = args[0]; this.path = args[0]; this.scheme = "file"; } static file = (...a) => new Uri(...a); static parse = (...a) => new Uri(...a); },
    Range: class { constructor(s, e) { this.start = s; this.end = e; } },
    Position: class { constructor(l, c) { this.line = l; this.character = c; } },
    Selection: class extends (class { constructor(s, e) { this.anchor = s; this.active = e; } }) {},
    Disposable: { dispose: () => {} },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    CodeAction: class { constructor(title, kind) { this.title = title; this.kind = kind; } },
    CodeActionKind: { QuickFix: { value: "quickfix" }, RefactorRewrite: { value: "refactor.rewrite" } },
    EventEmitter: class { event() { return () => {}; } fire() {} dispose() {} },
}))

// Mock @roo-code/telemetry to avoid ESM resolution issues with missing .ts extensions
vi.mock("@roo-code/telemetry", () => ({
    TelemetryService: {
        hasInstance: vi.fn().mockReturnValue(false),
        createInstance: vi.fn(),
    },
}))

import type { SharedWorkerContext } from "@roo-code/types"
import { ParallelTaskType as Ptt } from "@roo-code/types"
import {
    buildSystemPrompt,
    enrichWithContext,
    recordFileChange,
    estimateTokens,
} from "../BGWorker"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Record<string, unknown> = {}): any {
    return {
        description: "Test background task",
        mode: "code",
        message: "",
        taskType: Ptt.Code,
        autoApprove: { readFiles: true, writeFiles: false },
        maxToolCallsPerTask: 50,
        maxCostPerTask: 3.0,
        maxTokensPerTask: 16000,
        ...overrides,
    }
}

// ─── buildSystemPrompt ────────────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
    it("includes task description and type in prompt", () => {
        const config = makeConfig({ description: "Write a function" })
        const prompt = buildSystemPrompt(config, "")

        expect(prompt).toContain("Write a function")
        expect(prompt).toContain("(code)")
    })

    it("includes skill instructions when provided", () => {
        const config = makeConfig()
        const skillInstructions = "## Skill: parallel-task-code\n\nUse TypeScript."
        const prompt = buildSystemPrompt(config, skillInstructions)

        expect(prompt).toContain("Skill: parallel-task-code")
        expect(prompt).toContain("Use TypeScript.")
    })

    it("includes auto-approve settings", () => {
        const config = makeConfig({
            autoApprove: { readFiles: true, writeFiles: false, executeCommands: true, browserActions: false },
        })
        const prompt = buildSystemPrompt(config, "")

        expect(prompt).toContain("Read files: true")
        expect(prompt).toContain("Write files: false")
        expect(prompt).toContain("Execute commands: true")
        expect(prompt).toContain("Browser actions: false")
    })

    it("includes cost limits", () => {
        const config = makeConfig({ maxToolCallsPerTask: 100, maxCostPerTask: 5.0, maxTokensPerTask: 32000 })
        const prompt = buildSystemPrompt(config, "")

        expect(prompt).toContain("Max tool calls: 100")
        expect(prompt).toContain("$5.00")
        expect(prompt).toContain("32000")
    })

    it("uses defaults when config values missing", () => {
        const config = makeConfig({
            autoApprove: {}, // No explicit settings → should use defaults
        })
        const prompt = buildSystemPrompt(config, "")

        expect(prompt).toContain("Read files: true") // Default true
        expect(prompt).toContain("Write files: false") // Default false
    })

    it("handles undefined taskType (shows 'general')", () => {
        const config = makeConfig({ taskType: undefined })
        const prompt = buildSystemPrompt(config, "")

        expect(prompt).toContain("Task Type: general")
    })

    it("includes todos when provided", () => {
        const config = makeConfig({ todos: "1. Read file\n2. Write changes" })
        const prompt = buildSystemPrompt(config, "")

        expect(prompt).toContain("Todos:")
        expect(prompt).toContain("Read file")
    })

    it("handles empty message gracefully", () => {
        const config = makeConfig({ message: "" })
        const prompt = buildSystemPrompt(config, "")

        expect(prompt).toContain("(none)")
    })

    it("includes parallel team awareness rules", () => {
        const config = makeConfig()
        const prompt = buildSystemPrompt(config, "")

        expect(prompt).toContain("parallel team")
        expect(prompt).toContain("file conflicts")
        expect(prompt).toContain("attempt_completion")
    })

    it("produces a non-empty string", () => {
        const config = makeConfig()
        const prompt = buildSystemPrompt(config, "")

        expect(prompt.length).toBeGreaterThan(100)
        expect(typeof prompt).toBe("string")
    })
})

// ─── enrichWithContext ────────────────────────────────────────────────────────

describe("enrichWithContext", () => {
    it("returns null when no other workers and no file changes", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map(),
            recentFileChanges: [],
        }

        expect(enrichWithContext(sharedContext)).toBeNull()
    })

    it("returns null when only one worker (self) and no file changes", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map([["worker-1", { taskId: "Self task", type: Ptt.Code }]]),
            recentFileChanges: [],
        }

        expect(enrichWithContext(sharedContext)).toBeNull()
    })

    it("includes other workers in enrichment when multiple exist", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map([
                ["worker-1", { taskId: "Self task", type: Ptt.Code }],
                ["worker-2", { taskId: "Other task", type: Ptt.Search }],
            ]),
            recentFileChanges: [],
        }

        const result = enrichWithContext(sharedContext)
        expect(result).not.toBeNull()
        expect(result!).toContain("Active Parallel Workers")
        expect(result!).toContain("worker-2")
        expect(result!).toContain("search") // enum value is lowercase "search"
    })

    it("excludes self from worker list", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map([
                ["self", { taskId: "Self task", type: Ptt.Code }],
                ["worker-2", { taskId: "Other task", type: Ptt.Search }],
            ]),
            recentFileChanges: [],
        }

        const result = enrichWithContext(sharedContext)
        expect(result!).not.toContain("self")
        expect(result!).toContain("worker-2")
    })

    it("includes recent file changes from other workers", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map(),
            recentFileChanges: [
                { workerId: "worker-A", filePath: "/src/a.ts", timestamp: Date.now() - 1000 },
                { workerId: "worker-B", filePath: "/src/b.ts", timestamp: Date.now() - 5000 },
            ],
        }

        const result = enrichWithContext(sharedContext)
        expect(result).not.toBeNull()
        expect(result!).toContain("Recent File Changes")
        expect(result!).toContain("/src/a.ts")
        expect(result!).toContain("/src/b.ts")
    })

    it("limits recent file changes to 5 most recent", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map(),
            recentFileChanges: Array.from({ length: 10 }, (_, i) => ({
                workerId: `worker-${i}`,
                filePath: `/src/file${i}.ts`,
                timestamp: Date.now() - (i * 1000),
            })),
        }

        const result = enrichWithContext(sharedContext)
        expect(result!).toContain("and 5 more recent changes") // 10 total, show last 5 + "more" message
    })

    it("shows seconds for changes within 60s", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map(),
            recentFileChanges: [
                { workerId: "worker-1", filePath: "/src/a.ts", timestamp: Date.now() - 30_000 }, // 30s ago
            ],
        }

        const result = enrichWithContext(sharedContext)
        expect(result!).toContain("30s ago")
    })

    it("shows minutes for changes older than 60s", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map(),
            recentFileChanges: [
                { workerId: "worker-1", filePath: "/src/a.ts", timestamp: Date.now() - 300_000 }, // 5m ago
            ],
        }

        const result = enrichWithContext(sharedContext)
        expect(result!).toContain("5m ago")
    })

    it("handles empty activeWorkers but has file changes", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map(),
            recentFileChanges: [
                { workerId: "worker-1", filePath: "/src/a.ts", timestamp: Date.now() - 1000 },
            ],
        }

        const result = enrichWithContext(sharedContext)
        expect(result).not.toBeNull()
        expect(result!).toContain("Recent File Changes")
    })

    it("handles empty file changes but has multiple workers", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map([
                ["worker-1", { taskId: "Task 1", type: Ptt.Code }],
                ["worker-2", { taskId: "Task 2", type: Ptt.Search }],
            ]),
            recentFileChanges: [],
        }

        const result = enrichWithContext(sharedContext)
        expect(result).not.toBeNull()
        expect(result!).toContain("Active Parallel Workers")
    })
})

// ─── recordFileChange ─────────────────────────────────────────────────────────

describe("recordFileChange", () => {
    it("adds file change to recent changes list", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map(),
            recentFileChanges: [],
        }

        recordFileChange(sharedContext, "worker-1", "/src/new-file.ts")

        expect(sharedContext.recentFileChanges.length).toBe(1)
        expect(sharedContext.recentFileChanges[0].workerId).toBe("worker-1")
        expect(sharedContext.recentFileChanges[0].filePath).toBe("/src/new-file.ts")
    })

    it("records timestamp", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map(),
            recentFileChanges: [],
        }

        const before = Date.now()
        recordFileChange(sharedContext, "worker-1", "/src/file.ts")
        const after = Date.now()

        expect(sharedContext.recentFileChanges[0].timestamp).toBeGreaterThanOrEqual(before)
        expect(sharedContext.recentFileChanges[0].timestamp).toBeLessThanOrEqual(after)
    })

    it("enforces maxRecentChanges with FIFO eviction", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map(),
            recentFileChanges: [],
            maxRecentChanges: 3,
        }

        // Add 5 changes — should keep only last 3
        for (let i = 0; i < 5; i++) {
            recordFileChange(sharedContext, `worker-${i}`, `/src/file${i}.ts`)
        }

        expect(sharedContext.recentFileChanges.length).toBe(3)
        // First 2 evicted (FIFO), last 3 kept
        expect(sharedContext.recentFileChanges[0].workerId).toBe("worker-2")
        expect(sharedContext.recentFileChanges[1].workerId).toBe("worker-3")
        expect(sharedContext.recentFileChanges[2].workerId).toBe("worker-4")
    })

    it("uses default maxRecentChanges of 50 when not specified", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map(),
            recentFileChanges: [],
        }

        // Add 60 changes — should keep only last 50 (default)
        for (let i = 0; i < 60; i++) {
            recordFileChange(sharedContext, `worker-${i}`, `/src/file${i}.ts`)
        }

        expect(sharedContext.recentFileChanges.length).toBe(50)
    })

    it("handles empty workerId and filePath", () => {
        const sharedContext: SharedWorkerContext = {
            activeWorkers: new Map(),
            recentFileChanges: [],
        }

        recordFileChange(sharedContext, "", "")

        expect(sharedContext.recentFileChanges.length).toBe(1)
    })
})

// ─── estimateTokens ───────────────────────────────────────────────────────────

describe("estimateTokens", () => {
    it("returns approximate token count using 4 chars per token ratio", () => {
        // 400 characters → ~100 tokens
        const content = "a".repeat(400)
        expect(estimateTokens(content)).toBe(100)
    })

    it("rounds up for non-multiple-of-4 lengths", () => {
        // 403 characters → ceil(403/4) = 101 tokens
        const content = "a".repeat(403)
        expect(estimateTokens(content)).toBe(101)
    })

    it("returns 0 for empty string", () => {
        expect(estimateTokens("")).toBe(0)
    })

    it("handles single character", () => {
        // ceil(1/4) = 1 token
        expect(estimateTokens("a")).toBe(1)
    })

    it("handles very long content", () => {
        const content = "x".repeat(10_000)
        expect(estimateTokens(content)).toBe(2500)
    })

    it("returns positive number for any non-empty string", () => {
        expect(estimateTokens("hello world")).toBeGreaterThan(0)
    })
})
