// npx vitest run src/core/parallel/__tests__/BGWorkerManager.test.ts

import { describe, it, expect, beforeAll } from "vitest"
import { EventEmitter } from "events"

// Mock vscode for vitest (BGWorkerManager imports it at top level)
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

import type { BGQueueItem, BGWorkerConfig, BGWorkerResult, BGWorkerStateUpdate, WorkerHeartbeat } from "@roo-code/types"
import { BGWorkerState as BgWorkerStateEnum, ParallelTaskType as Ptt, DEFAULT_AUTO_APPROVE_PER_TYPE, DEFAULT_COST_LIMITS_PER_TYPE, DEFAULT_CONTEXT_RETENTION_PER_TYPE, DEFAULT_NOTIFICATION_MODE_PER_TYPE } from "@roo-code/types"

// ─── Mock BGWorker ────────────────────────────────────────────────────────────

class MockBGWorker extends EventEmitter {
    private _state: BgWorkerStateEnum = BgWorkerStateEnum.Queued
    private config: BGWorkerConfig
    private completed = false

    constructor(config: BGWorkerConfig) {
        super()
        this.config = config
    }

    getState(): BgWorkerStateEnum {
        return this._state
    }

    async start(): Promise<void> {
        // Emit stateUpdate synchronously (tests expect this during start)
        this._state = BgWorkerStateEnum.Running
        this.emit("stateUpdate", { type: "bgWorkerState", workerId: this.config.id ?? "mock", state: this._state } as BGWorkerStateUpdate)

        // Resolve immediately so await returns synchronously, but defer completion
        // to a microtask. This creates a gap where tests can inspect intermediate
        // queue states before handleWorkerComplete auto-starts the next queued item.
        return Promise.resolve()
    }

    cancel(reason?: string): void {
        if (!this.completed) {
            this._state = BgWorkerStateEnum.Cancelled
            this.emit("failed", `Cancelled: ${reason}`)
        }
    }

    pause(): void {
        this._state = BgWorkerStateEnum.Paused
    }

    resume(): void {
        if (this._state === BgWorkerStateEnum.Paused) {
            this._state = BgWorkerStateEnum.Running
        }
    }

    complete(result: Partial<BGWorkerResult> = {}): void {
        this.completed = true
        const fullResult: BGWorkerResult = {
            id: this.config.id ?? "mock",
            state: BgWorkerStateEnum.Completed,
            summary: result.summary ?? "Task completed",
            totalToolCalls: result.totalToolCalls ?? 5,
            durationMs: result.durationMs ?? Date.now() - (this.config.enqueuedAt || Date.now()),
            notificationMode: this.config.notificationMode,
        }
        // Defer completion event to microtask so tests can inspect intermediate states
        Promise.resolve().then(() => {
            this.emit("completed", fullResult)
        })
    }

    fail(error: string): void {
        this.completed = true
        const fullResult: BGWorkerResult = {
            id: this.config.id ?? "mock",
            state: BgWorkerStateEnum.Failed,
            totalToolCalls: 0,
            durationMs: Date.now() - (this.config.enqueuedAt || Date.now()),
            error,
        }
        // Defer failure event to microtask so tests can inspect intermediate states
        Promise.resolve().then(() => {
            this.emit("failed", error)
        })
    }

    emitHeartbeat(heartbeat: Partial<WorkerHeartbeat>): void {
        const fullHb: WorkerHeartbeat = {
            workerId: this.config.id ?? "mock",
            taskDescription: this.config.description,
            taskType: this.config.taskType,
            state: this._state,
            progressPercent: 0,
            elapsedMs: Date.now() - (this.config.enqueuedAt || Date.now()),
            totalCost: 0,
            toolCallCount: 0,
            maxToolCalls: this.config.maxToolCallsPerTask ?? 50,
            timestamp: Date.now(),
            ...heartbeat,
        }
        // Use 'any' to bypass type checking for custom event names
        ;(this as any).emit("heartbeat", fullHb)
    }
}

// ─── Mock ClineProvider ──────────────────────────────────────────────────────

interface MockClineProvider {
    contextProxy?: any
    postStateToWebview?: () => void
    postWorkerHeartbeats?: (heartbeats: WorkerHeartbeat[]) => void
}

function createMockProvider(overrides: Partial<MockClineProvider> = {}): MockClineProvider {
    return {
        contextProxy: undefined,
        postStateToWebview: overrides.postStateToWebview ?? (() => {}),
        postWorkerHeartbeats: overrides.postWorkerHeartbeats ?? (() => {}),
        ...overrides,
    }
}

// ─── Import BGWorkerManager after mocks are set up ─────────────────────────────

// We need to dynamically import because BGWorkerManager imports vscode and other modules
async function loadBGWorkerManager() {
    const mod = await import("../BGWorkerManager")
    return mod.BGWorkerManager
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BGWorkerManager", () => {
    let BGWorkerManager: typeof import("../BGWorkerManager").BGWorkerManager

    beforeAll(async () => {
        BGWorkerManager = await loadBGWorkerManager()
    })

    describe("constructor", () => {
        it("initializes with default maxConcurrent of 8 when no settings available", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            expect(manager["maxConcurrent"]).toBe(8) // Default from loadMaxConcurrent()
            manager.dispose()
        })

        it("respects maxConcurrent from settings", async () => {
            const provider = createMockProvider({
                contextProxy: { stateCache: { "parallelTaskMaxConcurrent": 4 } },
            })
            const manager = new BGWorkerManager(provider as any)

            expect(manager["maxConcurrent"]).toBe(4)
            manager.dispose()
        })

        it("caps maxConcurrent at 16", async () => {
            const provider = createMockProvider({
                contextProxy: { stateCache: { "parallelTaskMaxConcurrent": 20 } },
            })
            const manager = new BGWorkerManager(provider as any)

            expect(manager["maxConcurrent"]).toBe(16)
            manager.dispose()
        })

        it("caps maxConcurrent at minimum of 1", async () => {
            const provider = createMockProvider({
                contextProxy: { stateCache: { "parallelTaskMaxConcurrent": 0 } },
            })
            const manager = new BGWorkerManager(provider as any)

            expect(manager["maxConcurrent"]).toBe(1)
            manager.dispose()
        })
    })

    describe("resolveModeOverride", () => {
        it("returns config unchanged when taskType is undefined", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            const config: BGWorkerConfig = { description: "Test", mode: "code", message: "test" }
            const resolved = (manager as any).resolveModeOverride(config)

            expect(resolved.apiProviderOverride).toBeUndefined()
            manager.dispose()
        })

        it("applies Search mode overrides from settings", async () => {
            const provider = createMockProvider({
                contextProxy: {
                    stateCache: {
                        "parallelTaskModeSearchProvider": "openai",
                        "parallelTaskModeSearchModelId": "gpt-4o-mini",
                    },
                },
            })
            const manager = new BGWorkerManager(provider as any)

            const config: BGWorkerConfig = { description: "Test", mode: "code", message: "test", taskType: Ptt.Search }
            const resolved = (manager as any).resolveModeOverride(config)

            expect(resolved.apiProviderOverride).toBe("openai")
            expect(resolved.modelIdOverride).toBe("gpt-4o-mini")
            manager.dispose()
        })

        it("applies Code mode overrides from settings", async () => {
            const provider = createMockProvider({
                contextProxy: {
                    stateCache: {
                        "parallelTaskModeCodeProvider": "anthropic",
                        "parallelTaskModeCodeModelId": "claude-sonnet-4-20250514",
                    },
                },
            })
            const manager = new BGWorkerManager(provider as any)

            const config: BGWorkerConfig = { description: "Test", mode: "code", message: "test", taskType: Ptt.Code }
            const resolved = (manager as any).resolveModeOverride(config)

            expect(resolved.apiProviderOverride).toBe("anthropic")
            expect(resolved.modelIdOverride).toBe("claude-sonnet-4-20250514")
            manager.dispose()
        })

        it("applies Debug mode overrides from settings", async () => {
            const provider = createMockProvider({
                contextProxy: {
                    stateCache: {
                        "parallelTaskModeDebugProvider": "openai",
                        "parallelTaskModeDebugModelId": "o3",
                    },
                },
            })
            const manager = new BGWorkerManager(provider as any)

            const config: BGWorkerConfig = { description: "Test", mode: "debug", message: "test", taskType: Ptt.Debug }
            const resolved = (manager as any).resolveModeOverride(config)

            expect(resolved.apiProviderOverride).toBe("openai")
            expect(resolved.modelIdOverride).toBe("o3")
            manager.dispose()
        })

        it("merges auto-approve settings from flat state", async () => {
            const provider = createMockProvider({
                contextProxy: {
                    stateCache: {
                        "parallelTaskModeSearchProvider": "openai",
                        "parallelTaskModeSearchModelId": "gpt-4o-mini",
                        "parallelTaskAutoApproveSearchReadFiles": true,
                        "parallelTaskAutoApproveSearchWriteFiles": true, // Override default (false)
                    },
                },
            })
            const manager = new BGWorkerManager(provider as any)

            const config: BGWorkerConfig = { description: "Test", mode: "code", message: "test", taskType: Ptt.Search }
            const resolved = (manager as any).resolveModeOverride(config)

            expect(resolved.autoApprove?.readFiles).toBe(true)
            expect(resolved.autoApprove?.writeFiles).toBe(true) // Overridden from default false
            manager.dispose()
        })

        it("applies cost limits from defaults when not in config", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            const config: BGWorkerConfig = { description: "Test", mode: "code", message: "test", taskType: Ptt.Search }
            const resolved = (manager as any).resolveModeOverride(config)

            // Search default cost limit is $2.00, maxTokensPerTask is 16000
            expect(resolved.maxCostPerTask).toBe(DEFAULT_COST_LIMITS_PER_TYPE[Ptt.Search].maxCostPerTask)
            expect(resolved.maxTokensPerTask).toBe(DEFAULT_COST_LIMITS_PER_TYPE[Ptt.Search].maxTokensPerTask)
            manager.dispose()
        })

        it("applies context retention from defaults", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            const config: BGWorkerConfig = { description: "Test", mode: "code", message: "test", taskType: Ptt.Debug }
            const resolved = (manager as any).resolveModeOverride(config)

            expect(resolved.contextRetention).toBe(DEFAULT_CONTEXT_RETENTION_PER_TYPE[Ptt.Debug]) // "full"
            manager.dispose()
        })

        it("applies notification mode from defaults", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            const config: BGWorkerConfig = { description: "Test", mode: "code", message: "test", taskType: Ptt.Search }
            const resolved = (manager as any).resolveModeOverride(config)

            expect(resolved.notificationMode).toBe("errors_only") // Search default
            manager.dispose()
        })

        it("uses config values when explicitly set (overrides defaults)", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            const config: BGWorkerConfig = {
                description: "Test", mode: "code", message: "test", taskType: Ptt.Search,
                maxCostPerTask: 10.0, // Override default $2.00
                maxTokensPerTask: 50000, // Override default 16000
            }
            const resolved = (manager as any).resolveModeOverride(config)

            expect(resolved.maxCostPerTask).toBe(10.0)
            expect(resolved.maxTokensPerTask).toBe(50000)
            manager.dispose()
        })

        it("returns null for General taskType (inherit from main)", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            const modeMap = (manager as any).loadModeMap()
            expect(modeMap[Ptt.General]).toBeNull()
            manager.dispose()
        })

        it("handles missing proxy gracefully", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            const result = (manager as any).readModeOverride(undefined, "Search")
            expect(result).toBeNull()
            manager.dispose()
        })

        it("handles empty stateCache gracefully", async () => {
            const provider = createMockProvider({ contextProxy: { stateCache: {} } })
            const manager = new BGWorkerManager(provider as any)

            const result = (manager as any).readModeOverride({} as any, "Search")
            expect(result).toBeNull()
            manager.dispose()
        })
    })

    describe("sortQueue", () => {
        it("sorts by priority descending", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Manually set up queue items with different priorities
            manager["queue"] = [
                { id: "low", config: { description: "Low", mode: "code", message: "" }, priority: 1, enqueuedAt: Date.now() - 3000 },
                { id: "high", config: { description: "High", mode: "code", message: "" }, priority: 10, enqueuedAt: Date.now() - 1000 },
                { id: "mid", config: { description: "Mid", mode: "code", message: "" }, priority: 5, enqueuedAt: Date.now() - 2000 },
            ]

            ;(manager as any).sortQueue()

            expect(manager["queue"][0].id).toBe("high") // Priority 10 first
            expect(manager["queue"][1].id).toBe("mid")   // Priority 5 second
            expect(manager["queue"][2].id).toBe("low")    // Priority 1 last
            manager.dispose()
        })

        it("sorts by enqueue time ascending within same priority (FIFO)", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            const baseTime = Date.now()
            manager["queue"] = [
                { id: "later", config: { description: "Later", mode: "code", message: "" }, priority: 5, enqueuedAt: baseTime + 2000 },
                { id: "earlier", config: { description: "Earlier", mode: "code", message: "" }, priority: 5, enqueuedAt: baseTime },
                { id: "middle", config: { description: "Middle", mode: "code", message: "" }, priority: 5, enqueuedAt: baseTime + 1000 },
            ]

            ;(manager as any).sortQueue()

            expect(manager["queue"][0].id).toBe("earlier")   // Same priority, earliest first
            expect(manager["queue"][1].id).toBe("middle")     // Same priority, middle second
            expect(manager["queue"][2].id).toBe("later")      // Same priority, latest last
            manager.dispose()
        })

        it("handles empty queue", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)
            manager["queue"] = []

            ;(manager as any).sortQueue()
            expect(manager["queue"]).toEqual([])
            manager.dispose()
        })
    })

    describe("handleWorkerComplete", () => {
        it("moves worker from active to completed", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Manually set up an active worker and a completed result
            const mockWorker = new MockBGWorker({ id: "test-worker", description: "Test", mode: "code", message: "" })
            manager["activeWorkers"].set("test-worker", mockWorker as any)

            const result: BGWorkerResult = {
                id: "test-worker",
                state: BgWorkerStateEnum.Completed,
                summary: "Done",
                totalToolCalls: 5,
                durationMs: 1000,
            }

            ;(manager as any).handleWorkerComplete(result)

            expect(manager["activeWorkers"].has("test-worker")).toBe(false)
            expect(manager["completedWorkers"].has("test-worker")).toBe(true)
            manager.dispose()
        })

        it("emits workerCompleted event", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            let emittedResult: BGWorkerResult | undefined
            manager.on("workerCompleted" as any, (result: BGWorkerResult) => {
                emittedResult = result
            })

            const result: BGWorkerResult = {
                id: "test-worker", state: BgWorkerStateEnum.Completed, summary: "Done", totalToolCalls: 5, durationMs: 1000,
            }
            ;(manager as any).handleWorkerComplete(result)

            expect(emittedResult?.id).toBe("test-worker")
            manager.dispose()
        })

        it("enforces MAX_COMPLETED_WORKERS FIFO eviction", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Fill up completed workers beyond the limit (MAX_COMPLETED_WORKERS = 10)
            for (let i = 0; i < 12; i++) {
                const result: BGWorkerResult = {
                    id: `worker-${i}`, state: BgWorkerStateEnum.Completed, summary: "Done", totalToolCalls: 5, durationMs: 1000,
                }
                ;(manager as any).handleWorkerComplete(result)
            }

            // Should only keep the last 10 (first 2 evicted)
            expect(manager["completedWorkers"].size).toBe(10)
            expect(manager["completedWorkers"].has("worker-0")).toBe(false)
            expect(manager["completedWorkers"].has("worker-1")).toBe(false)
            expect(manager["completedWorkers"].has("worker-11")).toBe(true)
            manager.dispose()
        })

        it("calls sortQueue after completion", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Set up queue with wrong order (different priorities to test sorting)
            manager["queue"] = [
                { id: "low", config: { description: "Low", mode: "code", message: "" }, priority: 1, enqueuedAt: Date.now() - 3000 },
                { id: "high", config: { description: "High", mode: "code", message: "" }, priority: 10, enqueuedAt: Date.now() - 1000 },
            ]

            const result: BGWorkerResult = {
                id: "test-worker", state: BgWorkerStateEnum.Completed, summary: "Done", totalToolCalls: 5, durationMs: 1000,
            }
            ;(manager as any).handleWorkerComplete(result)

            // Queue should be sorted by priority desc after completion
            expect(manager["queue"][0].id).toBe("high")
            manager.dispose()
        })
    })

    describe("handleWorkerFail", () => {
        it("removes worker from active and marks as failed in completed", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            const mockWorker = new MockBGWorker({ id: "test-worker", description: "Test", mode: "code", message: "" })
            manager["activeWorkers"].set("test-worker", mockWorker as any)

            ;(manager as any).handleWorkerFail("test-worker", "Something went wrong")

            expect(manager["activeWorkers"].has("test-worker")).toBe(false)
            const completed = manager["completedWorkers"].get("test-worker")
            expect(completed?.state).toBe(BgWorkerStateEnum.Failed)
            expect(completed?.error).toBe("Something went wrong")
            manager.dispose()
        })

        it("emits workerFailed event with error", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            let emittedError: string | undefined
            manager.on("workerFailed" as any, (_workerId: string, error: string) => {
                emittedError = error
            })

            ;(manager as any).handleWorkerFail("test-worker", "Test failure")

            expect(emittedError).toBe("Test failure")
            manager.dispose()
        })

        it("calls sortQueue after failure (v4.2+ fix)", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Set up queue with wrong order
            manager["queue"] = [
                { id: "low", config: { description: "Low", mode: "code", message: "" }, priority: 1, enqueuedAt: Date.now() - 3000 },
                { id: "high", config: { description: "High", mode: "code", message: "" }, priority: 10, enqueuedAt: Date.now() - 1000 },
            ]

            ;(manager as any).handleWorkerFail("test-worker", "Failure")

            // Queue should be sorted after failure too
            expect(manager["queue"][0].id).toBe("high")
            manager.dispose()
        })

        it("removes failed worker from shared context activeWorkers", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Add to shared context
            manager["sharedContext"].activeWorkers.set("test-worker", { taskId: "Test", type: Ptt.Code })

            ;(manager as any).handleWorkerFail("test-worker", "Failure")

            expect(manager["sharedContext"].activeWorkers.has("test-worker")).toBe(false)
            manager.dispose()
        })

        it("removes failed worker from aggregated heartbeats", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Add heartbeat for this worker
            manager["aggregatedHeartbeats"] = [{
                workerId: "test-worker", taskDescription: "Test", taskType: Ptt.Code,
                state: BgWorkerStateEnum.Running, progressPercent: 50, elapsedMs: 1000,
                totalCost: 0.01, toolCallCount: 5, maxToolCalls: 50, timestamp: Date.now(),
            }]

            ;(manager as any).handleWorkerFail("test-worker", "Failure")

            expect(manager["aggregatedHeartbeats"].length).toBe(0)
            manager.dispose()
        })
    })

    describe("aggregateHeartbeat", () => {
        it("adds new heartbeat to aggregated list", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            const hb: WorkerHeartbeat = {
                workerId: "test-worker", taskDescription: "Test", taskType: Ptt.Code,
                state: BgWorkerStateEnum.Running, progressPercent: 50, elapsedMs: 1000,
                totalCost: 0.01, toolCallCount: 5, maxToolCalls: 50, timestamp: Date.now(),
            }

            ;(manager as any).aggregateHeartbeat(hb)

            expect(manager["aggregatedHeartbeats"].length).toBe(1)
            manager.dispose()
        })

        it("updates existing heartbeat for same workerId", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            const hb1: WorkerHeartbeat = {
                workerId: "test-worker", taskDescription: "Test", taskType: Ptt.Code,
                state: BgWorkerStateEnum.Running, progressPercent: 25, elapsedMs: 500,
                totalCost: 0.005, toolCallCount: 2, maxToolCalls: 50, timestamp: Date.now() - 1000,
            }

            const hb2: WorkerHeartbeat = {
                workerId: "test-worker", taskDescription: "Test", taskType: Ptt.Code,
                state: BgWorkerStateEnum.Running, progressPercent: 50, elapsedMs: 1000,
                totalCost: 0.01, toolCallCount: 5, maxToolCalls: 50, timestamp: Date.now(),
            }

            ;(manager as any).aggregateHeartbeat(hb1)
            ;(manager as any).aggregateHeartbeat(hb2)

            // Should only have one entry for test-worker (updated, not duplicated)
            expect(manager["aggregatedHeartbeats"].length).toBe(1)
            expect(manager["aggregatedHeartbeats"][0].progressPercent).toBe(50)
            manager.dispose()
        })

        it("sorts heartbeats with running workers first in flush", async () => {
            const postHeartbeats = vi.fn()
            const provider = createMockProvider({
                postWorkerHeartbeats: postHeartbeats,
            })
            const manager = new BGWorkerManager(provider as any)

            const hbRunning: WorkerHeartbeat = {
                workerId: "running-worker", taskDescription: "Running", taskType: Ptt.Code,
                state: BgWorkerStateEnum.Running, progressPercent: 50, elapsedMs: 1000,
                totalCost: 0.01, toolCallCount: 5, maxToolCalls: 50, timestamp: Date.now(),
            }

            const hbCompleted: WorkerHeartbeat = {
                workerId: "completed-worker", taskDescription: "Done", taskType: Ptt.Search,
                state: BgWorkerStateEnum.Completed, progressPercent: 100, elapsedMs: 5000,
                totalCost: 0.02, toolCallCount: 10, maxToolCalls: 50, timestamp: Date.now() - 1000,
            }

            ;(manager as any).aggregateHeartbeat(hbRunning)
            ;(manager as any).aggregateHeartbeat(hbCompleted)

            // Flush immediately (don't wait for throttle timer)
            manager["heartbeatThrottleTimer"] && clearTimeout(manager["heartbeatThrottleTimer"])
            ;(manager as any).flushHeartbeats()

            expect(postHeartbeats).toHaveBeenCalled()
            const heartbeats = postHeartbeats.mock.calls[0][0]
            // Verify sorting: running workers should come first
            for (let i = 0; i < heartbeats.length - 1; i++) {
                if (heartbeats[i].state === BgWorkerStateEnum.Running) continue
                expect(heartbeats[i + 1].state).not.toBe(BgWorkerStateEnum.Running)
            }
            manager.dispose()
        })

        it("caps heartbeats at MAX_HEARTBEATS_SHOWN (8)", async () => {
            const postHeartbeats = vi.fn()
            const provider = createMockProvider({
                postWorkerHeartbeats: postHeartbeats,
            })
            const manager = new BGWorkerManager(provider as any)

            // Add 12 heartbeats
            for (let i = 0; i < 12; i++) {
                ;(manager as any).aggregateHeartbeat({
                    workerId: `worker-${i}`, taskDescription: `Task ${i}`, taskType: Ptt.Code,
                    state: BgWorkerStateEnum.Running, progressPercent: (i + 1) * 8, elapsedMs: i * 1000,
                    totalCost: i * 0.01, toolCallCount: i * 5, maxToolCalls: 50, timestamp: Date.now() - i * 1000,
                })
            }

            manager["heartbeatThrottleTimer"] && clearTimeout(manager["heartbeatThrottleTimer"])
            ;(manager as any).flushHeartbeats()

            expect(postHeartbeats).toHaveBeenCalled()
            const heartbeats = postHeartbeats.mock.calls[0][0]
            expect(heartbeats.length).toBeLessThanOrEqual(8)
            manager.dispose()
        })

        it("skips flush when no heartbeats and no active workers", async () => {
            const provider = createMockProvider({
                postWorkerHeartbeats: () => { throw new Error("Should not be called") },
            })
            const manager = new BGWorkerManager(provider as any)

            ;(manager as any).flushHeartbeats() // Should return early
            expect(true).toBe(true) // No error thrown
            manager.dispose()
        })
    })

    describe("cancelWorker / pauseWorker / resumeWorker", () => {
        it("cancels a specific worker by ID", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            const mockWorker = new MockBGWorker({ id: "test-worker", description: "Test", mode: "code", message: "" })
            manager["activeWorkers"].set("test-worker", mockWorker as any)

            let cancelled = false
            mockWorker.on("failed" as any, () => { cancelled = true })

            manager.cancelWorker("test-worker")
            expect(cancelled).toBe(true)
            manager.dispose()
        })

        it("pauses a specific worker by ID", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            const mockWorker = new MockBGWorker({ id: "test-worker", description: "Test", mode: "code", message: "" })
            manager["activeWorkers"].set("test-worker", mockWorker as any)

            manager.pauseWorker("test-worker")
            expect(mockWorker.getState()).toBe(BgWorkerStateEnum.Paused)
            manager.dispose()
        })

        it("resumes a paused worker by ID", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            const mockWorker = new MockBGWorker({ id: "test-worker", description: "Test", mode: "code", message: "" })
            manager["activeWorkers"].set("test-worker", mockWorker as any)

            manager.pauseWorker("test-worker")
            expect(mockWorker.getState()).toBe(BgWorkerStateEnum.Paused)

            manager.resumeWorker("test-worker")
            expect(mockWorker.getState()).toBe(BgWorkerStateEnum.Running)
            manager.dispose()
        })

        it("handles cancel for non-existent worker gracefully", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Should not throw
            expect(() => manager.cancelWorker("non-existent")).not.toThrow()
            manager.dispose()
        })
    })

    describe("getters", () => {
        it("returns a copy of active workers", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            const workers = manager.getActiveWorkers()
            expect(workers).toBeInstanceOf(Map)
            expect(workers.size).toBe(0)
            manager.dispose()
        })

        it("returns a copy of completed workers", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            const results = manager.getCompletedWorkers()
            expect(results).toBeInstanceOf(Map)
            expect(results.size).toBe(0)
            manager.dispose()
        })

        it("returns a copy of the queue", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            const queue = manager.getQueue()
            expect(Array.isArray(queue)).toBe(true)
            expect(queue.length).toBe(0)
            manager.dispose()
        })

        it("returns shared context", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            const ctx = manager.getSharedContext()
            expect(ctx.activeWorkers).toBeInstanceOf(Map)
            expect(Array.isArray(ctx.recentFileChanges)).toBe(true)
            manager.dispose()
        })
    })

    describe("dispose", () => {
        it("clears all timers and workers", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Add a worker
            const mockWorker = new MockBGWorker({ id: "test-worker", description: "Test", mode: "code", message: "" })
            manager["activeWorkers"].set("test-worker", mockWorker as any)

            manager.dispose()

            expect(manager["activeWorkers"].size).toBe(0)
            expect(manager["queue"]).toEqual([])
            // Heartbeats should be cleared too (Phase 6a)
            expect(manager["aggregatedHeartbeats"]).toEqual([])
        })

        it("cancels all active workers on dispose", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            let cancelledCount = 0
            for (let i = 0; i < 3; i++) {
                const mockWorker = new MockBGWorker({ id: `worker-${i}`, description: "Test", mode: "code", message: "" })
                manager["activeWorkers"].set(`worker-${i}`, mockWorker as any)
                mockWorker.on("failed" as any, () => { cancelledCount++ })
            }

            manager.dispose()
            expect(cancelledCount).toBe(3)
        })
    })

    describe("integration: spawn → start → complete flow", () => {
        // Initialize TelemetryService so BGWorker's AnthropicHandler doesn't throw
        beforeAll(() => {
            const { TelemetryService } = require("@roo-code/telemetry")
            if (!TelemetryService.hasInstance()) {
                TelemetryService.createInstance([])
            }
        })

        it("emits queueUpdated events on spawn and completion", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            let queueUpdates: Array<[number, number]> = []
            manager.on("queueUpdated" as any, (qLen: number, activeCount: number) => {
                queueUpdates.push([qLen, activeCount])
            })

            // Spawn a worker (should start immediately since no concurrency limit hit)
            const id = await manager.spawn({ description: "Test", mode: "code", message: "" })
            expect(id).toBeDefined()

            // Should have emitted queueUpdated with queue=0, active=1
            expect(queueUpdates.length).toBeGreaterThanOrEqual(1)
            const lastUpdate = queueUpdates[queueUpdates.length - 1]
            expect(lastUpdate[1]).toBeGreaterThanOrEqual(1) // At least 1 active

            manager.dispose()
        })

        it("handles concurrent workers up to maxConcurrent", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            let startedCount = 0
            manager.on("workerStarted" as any, () => { startedCount++ })

            // Spawn more workers than maxConcurrent (default 8)
            for (let i = 0; i < 12; i++) {
                await manager.spawn({ description: `Task ${i}`, mode: "code", message: "" })
            }

            const activeWorkers = manager.getActiveWorkers()
            expect(activeWorkers.size).toBeLessThanOrEqual(8) // maxConcurrent
            expect(manager.getQueue().length + activeWorkers.size).toBe(12) // Total spawned
            manager.dispose()
        })
    })

    describe("TaskFlowAgent lifecycle hooks (Phase 7c)", () => {
        it("registerNodeWorker creates bidirectional mapping", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            manager.registerNodeWorker("node-A", "worker-001")

            expect(manager.getNodeForWorker("worker-001")).toBe("node-A")
            expect(manager.getWorkerForNode("node-A")).toBe("worker-001")
            // Maps should be empty initially
            const nodeMap = manager.getNodeToWorkerMap()
            const workerMap = manager.getWorkerToNodeMap()
            expect(nodeMap.size).toBe(1)
            expect(workerMap.size).toBe(1)

            manager.dispose()
        })

        it("registerNodeWorker overwrites existing mappings", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // First mapping
            manager.registerNodeWorker("node-A", "worker-001")
            expect(manager.getNodeForWorker("worker-001")).toBe("node-A")

            // Overwrite with different worker for same node
            manager.registerNodeWorker("node-A", "worker-002")
            expect(manager.getNodeForWorker("worker-001")).toBeUndefined() // Old worker removed
            expect(manager.getNodeForWorker("worker-002")).toBe("node-A")
            expect(manager.getWorkerForNode("node-A")).toBe("worker-002")

            manager.dispose()
        })

        it("getNodeForWorker returns undefined for unmapped workers", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            expect(manager.getNodeForWorker("unknown-worker")).toBeUndefined()
            expect(manager.getWorkerForNode("unknown-node")).toBeUndefined()

            manager.dispose()
        })

        it("emits nodeComplete event when mapped worker completes", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Register mapping
            manager.registerNodeWorker("node-A", "worker-001")

            let emittedNodeId: string | undefined
            let emittedResult: BGWorkerResult | undefined
            ;(manager as any).on("nodeComplete", (nodeId: string, result: BGWorkerResult) => {
                emittedNodeId = nodeId
                emittedResult = result
            })

            const result: BGWorkerResult = {
                id: "worker-001", state: BgWorkerStateEnum.Completed, summary: "Done", totalToolCalls: 5, durationMs: 1000,
            }
            ;(manager as any).handleWorkerComplete(result)

            expect(emittedNodeId).toBe("node-A")
            expect(emittedResult?.id).toBe("worker-001")
            // Mapping should be cleaned up after completion
            expect(manager.getNodeForWorker("worker-001")).toBeUndefined()
            expect(manager.getWorkerForNode("node-A")).toBeUndefined()

            manager.dispose()
        })

        it("emits nodeFail event when mapped worker fails", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Register mapping
            manager.registerNodeWorker("node-B", "worker-002")

            let emittedNodeId: string | undefined
            let emittedWorkerId: string | undefined
            let emittedError: string | undefined
            ;(manager as any).on("nodeFail", (nodeId: string, workerId: string, error: string) => {
                emittedNodeId = nodeId
                emittedWorkerId = workerId
                emittedError = error
            })

            ;(manager as any).handleWorkerFail("worker-002", "Test failure")

            expect(emittedNodeId).toBe("node-B")
            expect(emittedWorkerId).toBe("worker-002")
            expect(emittedError).toBe("Test failure")
            // Mapping should be cleaned up after failure
            expect(manager.getNodeForWorker("worker-002")).toBeUndefined()

            manager.dispose()
        })

        it("emits nodePause event when mapped worker is paused", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Register mapping and add active worker
            manager.registerNodeWorker("node-C", "worker-003")
            const mockWorker = new MockBGWorker({ id: "worker-003", description: "Test", mode: "code", message: "" })
            manager["activeWorkers"].set("worker-003", mockWorker as any)

            let emittedNodeId: string | undefined
            ;(manager as any).on("nodePause", (nodeId: string, workerId: string) => {
                emittedNodeId = nodeId
            })

            manager.pauseWorker("worker-003")

            expect(emittedNodeId).toBe("node-C")
            expect(mockWorker.getState()).toBe(BgWorkerStateEnum.Paused)

            manager.dispose()
        })

        it("emits nodeResume event when mapped worker is resumed", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Register mapping and add active worker
            manager.registerNodeWorker("node-D", "worker-004")
            const mockWorker = new MockBGWorker({ id: "worker-004", description: "Test", mode: "code", message: "" })
            manager["activeWorkers"].set("worker-004", mockWorker as any)

            let emittedNodeId: string | undefined
            ;(manager as any).on("nodeResume", (nodeId: string, workerId: string) => {
                emittedNodeId = nodeId
            })

            // Pause first
            manager.pauseWorker("worker-004")
            expect(mockWorker.getState()).toBe(BgWorkerStateEnum.Paused)

            // Resume and check event
            manager.resumeWorker("worker-004")

            expect(emittedNodeId).toBe("node-D")
            expect(mockWorker.getState()).toBe(BgWorkerStateEnum.Running)

            manager.dispose()
        })

        it("does not emit lifecycle events for unmapped workers", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            let nodeCompleteFired = false
            ;(manager as any).on("nodeComplete", () => { nodeCompleteFired = true })

            // Complete a worker that has no mapping
            const result: BGWorkerResult = {
                id: "unmapped-worker", state: BgWorkerStateEnum.Completed, summary: "Done", totalToolCalls: 5, durationMs: 1000,
            }
            ;(manager as any).handleWorkerComplete(result)

            expect(nodeCompleteFired).toBe(false) // Should NOT fire for unmapped workers

            manager.dispose()
        })

        it("cleans up node↔worker maps on dispose", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Register multiple mappings
            manager.registerNodeWorker("node-X", "worker-x")
            manager.registerNodeWorker("node-Y", "worker-y")
            manager.registerNodeWorker("node-Z", "worker-z")

            expect(manager.getNodeToWorkerMap().size).toBe(3)
            expect(manager.getWorkerToNodeMap().size).toBe(3)

            manager.dispose()

            // Maps should be cleared after dispose
            expect(manager.getNodeToWorkerMap().size).toBe(0)
            expect(manager.getWorkerToNodeMap().size).toBe(0)
        })

        it("multiple node↔worker mappings coexist correctly", async () => {
            const provider = createMockProvider()
            const manager = new BGWorkerManager(provider as any)

            // Register multiple independent mappings
            manager.registerNodeWorker("A", "w1")
            manager.registerNodeWorker("B", "w2")
            manager.registerNodeWorker("C", "w3")

            expect(manager.getNodeForWorker("w1")).toBe("A")
            expect(manager.getNodeForWorker("w2")).toBe("B")
            expect(manager.getNodeForWorker("w3")).toBe("C")
            expect(manager.getWorkerForNode("A")).toBe("w1")
            expect(manager.getWorkerForNode("B")).toBe("w2")
            expect(manager.getWorkerForNode("C")).toBe("w3")

            manager.dispose()
        })
    })
})
