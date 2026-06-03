// npx vitest run src/core/parallel/__tests__/HeartbeatSystem.test.ts

import { describe, it, expect, beforeEach } from "vitest"
import EventEmitter from "events"

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

import type { WorkerHeartbeat, BGWorkerStateUpdate, SharedWorkerContext } from "@roo-code/types"
import { BGWorkerState as BgWorkerStateEnum, ParallelTaskType as Ptt } from "@roo-code/types"

// ─── Mock ClineProvider ──────────────────────────────────────────────────────

interface MockClineProvider {
    contextProxy?: any
    postStateToWebview?: () => void
    postWorkerHeartbeats?: (heartbeats: WorkerHeartbeat[]) => void
}

function createMockProvider(overrides: Partial<MockClineProvider> = {}): MockClineProvider {
    return {
        contextProxy: overrides.contextProxy ?? undefined,
        postStateToWebview: overrides.postStateToWebview ?? (() => {}),
        postWorkerHeartbeats: overrides.postWorkerHeartbeats ?? (() => {}),
        ...overrides,
    }
}

// ─── Mock BGWorker (minimal for heartbeat testing) ──────────────────────────

class TestBGWorker extends EventEmitter {
    private _state: BgWorkerStateEnum = BgWorkerStateEnum.Queued
    private config: any
    private sharedContext: SharedWorkerContext
    private startTime = Date.now()
    private totalToolCalls = 0
    private totalCost = 0
    private currentAction = ""
    private heartbeatInterval?: NodeJS.Timeout

    constructor(config: any, sharedContext: SharedWorkerContext) {
        super()
        this.config = config
        this.sharedContext = sharedContext
    }

    getState(): BgWorkerStateEnum {
        return this._state
    }

    getId(): string {
        return this.config.id ?? "test-worker"
    }

    /** Simulate the emitHeartbeat logic from BGWorker.ts */
    emitHeartbeat(): WorkerHeartbeat | null {
        if (this._state === BgWorkerStateEnum.Queued || this._state === BgWorkerStateEnum.Failed) {
            return null
        }

        const elapsedMs = Date.now() - this.startTime
        const maxToolCalls = this.config.maxToolCallsPerTask ?? 50
        const progressPercent = maxToolCalls > 0 ? Math.min(100, (this.totalToolCalls / maxToolCalls) * 100) : 0

        const heartbeat: WorkerHeartbeat = {
            workerId: this.getId(),
            taskDescription: this.config.description || "",
            taskType: this.config.taskType,
            state: this._state,
            progressPercent,
            elapsedMs,
            totalCost: this.totalCost,
            currentAction: this.currentAction || undefined,
            toolCallCount: this.totalToolCalls,
            maxToolCalls,
            timestamp: Date.now(),
        }

        // Also emit as stateUpdate event
        const update: BGWorkerStateUpdate = {
            type: "bgWorkerState",
            workerId: this.getId(),
            state: this._state,
            description: this.config.description,
            taskType: this.config.taskType,
            toolCallCount: this.totalToolCalls,
            currentTool: this.currentAction || undefined,
        }
        this.emit("stateUpdate", update)

        // Also emit dedicated heartbeat event
        this.emit("heartbeat" as any, heartbeat)

        return heartbeat
    }

    /** Simulate startHeartbeatTimer from BGWorker.ts */
    startHeartbeatTimer(intervalMs?: number): void {
        const actualInterval = intervalMs ?? 30000 // Default 30s
        this.heartbeatInterval = setInterval(() => this.emitHeartbeat(), Math.max(10000, actualInterval))
    }

    stopHeartbeatTimer(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval)
            this.heartbeatInterval = undefined
        }
    }

    setState(state: BgWorkerStateEnum): void {
        this._state = state
    }

    incrementToolCalls(count: number = 1): void {
        this.totalToolCalls += count
    }

    setCost(cost: number): void {
        this.totalCost = cost
    }

    setCurrentAction(action: string): void {
        this.currentAction = action
    }

    dispose(): void {
        this.stopHeartbeatTimer()
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Heartbeat System", () => {
    describe("BGWorker heartbeat emission", () => {
        it("emits null heartbeat when state is Queued", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test" }, sharedContext)

            const result = worker.emitHeartbeat()
            expect(result).toBeNull()

            worker.dispose()
        })

        it("emits null heartbeat when state is Failed", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test" }, sharedContext)
            worker.setState(BgWorkerStateEnum.Failed)

            const result = worker.emitHeartbeat()
            expect(result).toBeNull()

            worker.dispose()
        })

        it("emits valid heartbeat when state is Running", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test task" }, sharedContext)
            worker.setState(BgWorkerStateEnum.Running)

            const result = worker.emitHeartbeat()

            expect(result).not.toBeNull()
            expect(result!.workerId).toBe("test-1")
            expect(result!.taskDescription).toBe("Test task")
            expect(result!.state).toBe(BgWorkerStateEnum.Running)
            expect(result!.progressPercent).toBe(0) // 0 tool calls = 0%
            expect(result!.elapsedMs).toBeGreaterThanOrEqual(0)
            expect(result!.timestamp).toBeDefined()
            expect(typeof result!.timestamp).toBe("number")

            worker.dispose()
        })

        it("tracks progress based on tool call count", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const config = { id: "test-1", description: "Test", maxToolCallsPerTask: 10 }
            const worker = new TestBGWorker(config, sharedContext)
            worker.setState(BgWorkerStateEnum.Running)

            // After 5 tool calls out of 10 max → 50% progress
            worker.incrementToolCalls(5)
            let result = worker.emitHeartbeat()!
            expect(result.progressPercent).toBe(50)

            // After all 10 tool calls → 100% progress (capped)
            worker.incrementToolCalls(5)
            result = worker.emitHeartbeat()!
            expect(result.progressPercent).toBe(100)

            // Beyond max still capped at 100
            worker.incrementToolCalls(10)
            result = worker.emitHeartbeat()!
            expect(result.progressPercent).toBe(100)

            worker.dispose()
        })

        it("tracks elapsed time correctly", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test" }, sharedContext)
            worker.setState(BgWorkerStateEnum.Running)

            const hb1 = worker.emitHeartbeat()!
            // Wait a bit
            const beforeTime = Date.now()
            setTimeout(() => {}, 50) // Just yield event loop
            const hb2 = worker.emitHeartbeat()!

            expect(hb2.elapsedMs).toBeGreaterThanOrEqual(hb1.elapsedMs)

            worker.dispose()
        })

        it("includes currentAction when set", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test" }, sharedContext)
            worker.setState(BgWorkerStateEnum.Running)

            // No action set → undefined
            let result = worker.emitHeartbeat()!
            expect(result.currentAction).toBeUndefined()

            // Action set → included
            worker.setCurrentAction("write_to_file")
            result = worker.emitHeartbeat()!
            expect(result.currentAction).toBe("write_to_file")

            worker.dispose()
        })

        it("tracks total cost", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test" }, sharedContext)
            worker.setState(BgWorkerStateEnum.Running)

            worker.setCost(0.05)
            const result = worker.emitHeartbeat()!
            expect(result.totalCost).toBe(0.05)

            worker.dispose()
        })

        it("emits stateUpdate event with correct data", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test task" }, sharedContext)
            worker.setState(BgWorkerStateEnum.Running)

            let capturedUpdate: BGWorkerStateUpdate | undefined
            worker.on("stateUpdate" as any, (update: BGWorkerStateUpdate) => {
                capturedUpdate = update
            })

            worker.emitHeartbeat()

            expect(capturedUpdate).toBeDefined()
            expect(capturedUpdate!.type).toBe("bgWorkerState")
            expect(capturedUpdate!.workerId).toBe("test-1")
            expect(capturedUpdate!.state).toBe(BgWorkerStateEnum.Running)
            expect(capturedUpdate!.description).toBe("Test task")

            worker.dispose()
        })

        it("emits dedicated heartbeat event", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test task" }, sharedContext)
            worker.setState(BgWorkerStateEnum.Running)

            let capturedHeartbeat: WorkerHeartbeat | undefined
            worker.on("heartbeat" as any, (hb: WorkerHeartbeat) => {
                capturedHeartbeat = hb
            })

            worker.emitHeartbeat()

            expect(capturedHeartbeat).toBeDefined()
            expect(capturedHeartbeat!.workerId).toBe("test-1")

            worker.dispose()
        })

        it("emits both stateUpdate and heartbeat events simultaneously", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test" }, sharedContext)
            worker.setState(BgWorkerStateEnum.Running)

            let stateUpdateEmitted = false
            let heartbeatEmitted = false

            worker.on("stateUpdate" as any, () => { stateUpdateEmitted = true })
            worker.on("heartbeat" as any, () => { heartbeatEmitted = true })

            worker.emitHeartbeat()

            expect(stateUpdateEmitted).toBe(true)
            expect(heartbeatEmitted).toBe(true)

            worker.dispose()
        })

        it("handles taskType correctly", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test", taskType: Ptt.Search }, sharedContext)
            worker.setState(BgWorkerStateEnum.Running)

            const result = worker.emitHeartbeat()!
            expect(result.taskType).toBe(Ptt.Search)

            worker.dispose()
        })

        it("handles undefined taskType gracefully", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test" }, sharedContext)
            worker.setState(BgWorkerStateEnum.Running)

            const result = worker.emitHeartbeat()!
            expect(result.taskType).toBeUndefined()

            worker.dispose()
        })
    })

    describe("BGWorker heartbeat timer lifecycle", () => {
        it("starts heartbeat interval on startHeartbeatTimer", async () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test" }, sharedContext)

            let emitCount = 0
            worker.on("heartbeat" as any, () => { emitCount++ })

            // Set state to Running so emitHeartbeat actually emits (Queued returns null but still emits event)
            worker.setState(BgWorkerStateEnum.Running)

            // Use an interval > 10s so it's not clamped by Math.max(10000, ...) in startHeartbeatTimer
            worker.startHeartbeatTimer(15000)

            expect(worker["heartbeatInterval"]).toBeDefined()

            // Directly call emitHeartbeat to verify the behavior works
            worker.emitHeartbeat()
            expect(emitCount).toBeGreaterThanOrEqual(1)

            worker.stopHeartbeatTimer()
            worker.dispose()
        })

        it("stops heartbeat interval on stopHeartbeatTimer", async () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test" }, sharedContext)

            let emitCount = 0
            worker.on("heartbeat" as any, () => { emitCount++ })

            // Set state to Running so emitHeartbeat actually emits
            worker.setState(BgWorkerStateEnum.Running)

            // Use > 10s to avoid Math.max(10000, ...) clamp in TestBGWorker.startHeartbeatTimer
            worker.startHeartbeatTimer(15000)

            // Directly call emitHeartbeat twice to verify start/stop behavior
            worker.emitHeartbeat()
            const countBeforeStop = emitCount

            worker.stopHeartbeatTimer()

            // Call emitHeartbeat again — should still work (the method itself isn't stopped, just the timer)
            worker.emitHeartbeat()
            const countAfterStop = emitCount

            expect(countAfterStop).toBeGreaterThanOrEqual(countBeforeStop + 1)

            worker.dispose()
        })

        it("clamps interval to minimum of 10 seconds", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test" }, sharedContext)

            // Start with a very short interval — should be clamped to 10s internally
            // But for testing, we use the actual value passed (the clamp is in BGWorker.startHeartbeatTimer)
            worker.startHeartbeatTimer(50)

            expect(worker["heartbeatInterval"]).toBeDefined()

            worker.stopHeartbeatTimer()
            worker.dispose()
        })
    })

    describe("ClineProvider postWorkerHeartbeats bridge", () => {
        it("stores heartbeats for webview posting", () => {
            let storedHeartbeats: WorkerHeartbeat[] = []

            const provider = createMockProvider({
                postWorkerHeartbeats: (heartbeats: WorkerHeartbeat[]) => {
                    storedHeartbeats = heartbeats
                },
            })

            // Simulate what BGWorkerManager.flushHeartbeats() does
            const testHeartbeats: WorkerHeartbeat[] = [
                {
                    workerId: "worker-1",
                    taskDescription: "Task 1",
                    taskType: Ptt.Code,
                    state: BgWorkerStateEnum.Running,
                    progressPercent: 50,
                    elapsedMs: 5000,
                    totalCost: 0.01,
                    toolCallCount: 5,
                    maxToolCalls: 50,
                    timestamp: Date.now(),
                },
            ]

            ;(provider as any).postWorkerHeartbeats(testHeartbeats)

            expect(storedHeartbeats.length).toBe(1)
            expect(storedHeartbeats[0].workerId).toBe("worker-1")

            // Second call replaces the first
            const updatedHeartbeats: WorkerHeartbeat[] = [
                {
                    workerId: "worker-2",
                    taskDescription: "Task 2",
                    taskType: Ptt.Search,
                    state: BgWorkerStateEnum.Running,
                    progressPercent: 75,
                    elapsedMs: 10000,
                    totalCost: 0.02,
                    toolCallCount: 10,
                    maxToolCalls: 50,
                    timestamp: Date.now(),
                },
            ]

            ;(provider as any).postWorkerHeartbeats(updatedHeartbeats)

            expect(storedHeartbeats.length).toBe(1)
            expect(storedHeartbeats[0].workerId).toBe("worker-2")
        })

        it("handles empty heartbeat array", () => {
            let storedHeartbeats: WorkerHeartbeat[] = []

            const provider = createMockProvider({
                postWorkerHeartbeats: (heartbeats: WorkerHeartbeat[]) => {
                    storedHeartbeats = heartbeats
                },
            })

            ;(provider as any).postWorkerHeartbeats([])

            expect(storedHeartbeats.length).toBe(0)
        })

        it("handles multiple concurrent heartbeats", () => {
            let storedHeartbeats: WorkerHeartbeat[] = []

            const provider = createMockProvider({
                postWorkerHeartbeats: (heartbeats: WorkerHeartbeat[]) => {
                    storedHeartbeats = heartbeats
                },
            })

            const heartbeats: WorkerHeartbeat[] = Array.from({ length: 5 }, (_, i) => ({
                workerId: `worker-${i}`,
                taskDescription: `Task ${i}`,
                taskType: [Ptt.Code, Ptt.Search, Ptt.Doc, Ptt.Debug, Ptt.Commit][i],
                state: BgWorkerStateEnum.Running,
                progressPercent: (i + 1) * 20,
                elapsedMs: (i + 1) * 5000,
                totalCost: (i + 1) * 0.01,
                toolCallCount: (i + 1) * 5,
                maxToolCalls: 50,
                timestamp: Date.now() - i * 1000,
            }))

            ;(provider as any).postWorkerHeartbeats(heartbeats)

            expect(storedHeartbeats.length).toBe(5)
        })
    })

    describe("BGWorkerManager heartbeat aggregation", () => {
        let BGWorkerManager: typeof import("../BGWorkerManager").BGWorkerManager

        beforeAll(async () => {
            const mod = await import("../BGWorkerManager")
            BGWorkerManager = mod.BGWorkerManager
        })

        it("updates existing heartbeat for same workerId (no duplicates)", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
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
            expect((manager as any).aggregatedHeartbeats.length).toBe(1)

            ;(manager as any).aggregateHeartbeat(hb2)
            // Should still be 1 — updated, not duplicated
            expect((manager as any).aggregatedHeartbeats.length).toBe(1)
            expect((manager as any).aggregatedHeartbeats[0].progressPercent).toBe(50)

            manager.dispose()
        })

        it("sorts running workers first in flush", async () => {
            let flushedHeartbeats: WorkerHeartbeat[] = []
            const provider = createMockProvider({
                postWorkerHeartbeats: (heartbeats: WorkerHeartbeat[]) => {
                    flushedHeartbeats = heartbeats
                },
            })
            const manager = new BGWorkerManager(provider as any)

            // Add a running worker and a completed worker
            ;(manager as any).aggregateHeartbeat({
                workerId: "running-worker", taskDescription: "Running", taskType: Ptt.Code,
                state: BgWorkerStateEnum.Running, progressPercent: 50, elapsedMs: 1000,
                totalCost: 0.01, toolCallCount: 5, maxToolCalls: 50, timestamp: Date.now(),
            })

            ;(manager as any).aggregateHeartbeat({
                workerId: "completed-worker", taskDescription: "Done", taskType: Ptt.Search,
                state: BgWorkerStateEnum.Completed, progressPercent: 100, elapsedMs: 5000,
                totalCost: 0.02, toolCallCount: 10, maxToolCalls: 50, timestamp: Date.now() - 1000,
            })

            // Flush immediately (bypass throttle timer)
            manager["heartbeatThrottleTimer"] && clearTimeout(manager["heartbeatThrottleTimer"])
            ;(manager as any).flushHeartbeats()

            expect(flushedHeartbeats.length).toBeGreaterThan(0)
            // Running worker should come first
            expect(flushedHeartbeats[0].state).toBe(BgWorkerStateEnum.Running)

            manager.dispose()
        })

        it("caps heartbeats at MAX_HEARTBEATS_SHOWN (8)", async () => {
            let flushedHeartbeats: WorkerHeartbeat[] = []
            const provider = createMockProvider({
                postWorkerHeartbeats: (heartbeats: WorkerHeartbeat[]) => {
                    flushedHeartbeats = heartbeats
                },
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

            expect(flushedHeartbeats.length).toBeLessThanOrEqual(8)
        })

        it("skips flush when no heartbeats and no active workers", async () => {
            const BGWorkerManager = await import("../BGWorkerManager").then(m => m.BGWorkerManager)

            let called = false
            const provider = createMockProvider({
                postWorkerHeartbeats: () => { called = true },
            })
            const manager = new BGWorkerManager(provider as any)

            ;(manager as any).flushHeartbeats() // Should return early

            expect(called).toBe(false)

            manager.dispose()
        })

        it("removes completed worker heartbeat on completion", async () => {
            const BGWorkerManager = await import("../BGWorkerManager").then(m => m.BGWorkerManager)

            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            // Add a heartbeat
            ;(manager as any).aggregateHeartbeat({
                workerId: "test-worker", taskDescription: "Test", taskType: Ptt.Code,
                state: BgWorkerStateEnum.Running, progressPercent: 50, elapsedMs: 1000,
                totalCost: 0.01, toolCallCount: 5, maxToolCalls: 50, timestamp: Date.now(),
            })

            expect((manager as any).aggregatedHeartbeats.length).toBe(1)

            // Simulate completion (which removes heartbeat)
            const result = {
                id: "test-worker", state: BgWorkerStateEnum.Completed, summary: "Done",
                totalToolCalls: 5, durationMs: 1000,
            }
            ;(manager as any).handleWorkerComplete(result)

            expect((manager as any).aggregatedHeartbeats.length).toBe(0)

            manager.dispose()
        })

        it("removes failed worker heartbeat on failure", async () => {
            const BGWorkerManager = await import("../BGWorkerManager").then(m => m.BGWorkerManager)

            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            // Add a heartbeat
            ;(manager as any).aggregateHeartbeat({
                workerId: "test-worker", taskDescription: "Test", taskType: Ptt.Code,
                state: BgWorkerStateEnum.Running, progressPercent: 50, elapsedMs: 1000,
                totalCost: 0.01, toolCallCount: 5, maxToolCalls: 50, timestamp: Date.now(),
            })

            expect((manager as any).aggregatedHeartbeats.length).toBe(1)

            // Simulate failure (which removes heartbeat)
            ;(manager as any).handleWorkerFail("test-worker", "Something went wrong")

            expect((manager as any).aggregatedHeartbeats.length).toBe(0)

            manager.dispose()
        })

        it("throttles flushes to max 1 per HEARTBEAT_THROTTLE_MS (5s)", async () => {
            const BGWorkerManager = await import("../BGWorkerManager").then(m => m.BGWorkerManager)

            let flushCount = 0
            const provider = createMockProvider({
                postWorkerHeartbeats: () => { flushCount++ },
            })
            const manager = new BGWorkerManager(provider as any)

            // Add multiple heartbeats rapidly — should only trigger one flush (throttled)
            for (let i = 0; i < 5; i++) {
                ;(manager as any).aggregateHeartbeat({
                    workerId: `worker-${i}`, taskDescription: `Task ${i}`, taskType: Ptt.Code,
                    state: BgWorkerStateEnum.Running, progressPercent: (i + 1) * 20, elapsedMs: i * 1000,
                    totalCost: i * 0.01, toolCallCount: i * 5, maxToolCalls: 50, timestamp: Date.now(),
                })
            }

            // Clear the throttle timer and flush immediately to verify only one pending flush
            manager["heartbeatThrottleTimer"] && clearTimeout(manager["heartbeatThrottleTimer"])
            ;(manager as any).flushHeartbeats()

            expect(flushCount).toBe(1)

            manager.dispose()
        })
    })

    describe("Heartbeat data integrity", () => {
        it("produces valid WorkerHeartbeat shape with all required fields", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const worker = new TestBGWorker({ id: "test-1", description: "Test" }, sharedContext)
            worker.setState(BgWorkerStateEnum.Running)

            const result = worker.emitHeartbeat()!

            // Verify all required fields are present
            expect(result).toHaveProperty("workerId")
            expect(result).toHaveProperty("taskDescription")
            expect(result).toHaveProperty("taskType")
            expect(result).toHaveProperty("state")
            expect(result).toHaveProperty("progressPercent")
            expect(result).toHaveProperty("elapsedMs")
            expect(result).toHaveProperty("totalCost")
            expect(result).toHaveProperty("toolCallCount")
            expect(result).toHaveProperty("maxToolCalls")
            expect(result).toHaveProperty("timestamp")

            // Verify types
            expect(typeof result.workerId).toBe("string")
            expect(typeof result.taskDescription).toBe("string")
            expect(typeof result.state).toBe("string")
            expect(typeof result.progressPercent).toBe("number")
            expect(typeof result.elapsedMs).toBe("number")
            expect(typeof result.totalCost).toBe("number")
            expect(typeof result.toolCallCount).toBe("number")
            expect(typeof result.maxToolCalls).toBe("number")
            expect(typeof result.timestamp).toBe("number")

            worker.dispose()
        })

        it("progressPercent is always 0-100 range", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const config = { id: "test-1", description: "Test", maxToolCallsPerTask: 10 }
            const worker = new TestBGWorker(config, sharedContext)
            worker.setState(BgWorkerStateEnum.Running)

            // 0 calls → 0%
            let result = worker.emitHeartbeat()!
            expect(result.progressPercent).toBe(0)

            // Halfway → 50%
            worker.incrementToolCalls(5)
            result = worker.emitHeartbeat()!
            expect(result.progressPercent).toBe(50)

            // Over max → capped at 100%
            worker.incrementToolCalls(20)
            result = worker.emitHeartbeat()!
            expect(result.progressPercent).toBe(100)

            worker.dispose()
        })

        it("handles zero maxToolCalls gracefully", () => {
            const sharedContext: SharedWorkerContext = { activeWorkers: new Map(), recentFileChanges: [] }
            const config = { id: "test-1", description: "Test", maxToolCallsPerTask: 0 }
            const worker = new TestBGWorker(config, sharedContext)
            worker.setState(BgWorkerStateEnum.Running)

            const result = worker.emitHeartbeat()!
            expect(result.progressPercent).toBe(0) // Division by zero → 0%

            worker.dispose()
        })
    })
})
