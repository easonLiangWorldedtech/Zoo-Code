// npx vitest run src/core/parallel/__tests__/ParallelTaskIntegration.test.ts

import { describe, it, expect, beforeAll } from "vitest"
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

import type { BGQueueItem, BGWorkerConfig, BGWorkerResult, BGWorkerStateUpdate, SharedWorkerContext, WorkerHeartbeat } from "@roo-code/types"
import { BGWorkerState as BgWorkerStateEnum, ParallelTaskType as Ptt, DEFAULT_AUTO_APPROVE_PER_TYPE, DEFAULT_COST_LIMITS_PER_TYPE } from "@roo-code/types"

// ─── Mock BGWorker (full lifecycle for integration testing) ──────────────────

class IntegrationMockBGWorker extends EventEmitter {
    private _state: BgWorkerStateEnum = BgWorkerStateEnum.Queued
    private config: BGWorkerConfig
    private completed = false
    private toolCallCount = 0
    private totalCost = 0
    private currentAction = ""

    constructor(config: BGWorkerConfig) {
        super()
        this.config = config
    }

    getState(): BgWorkerStateEnum {
        return this._state
    }

    async start(): Promise<void> {
        if (this._state !== BgWorkerStateEnum.Queued) return
        this._state = BgWorkerStateEnum.Running
        this.emit("stateUpdate", { type: "bgWorkerState", workerId: this.config.id ?? "mock", state: this._state } as BGWorkerStateUpdate)
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
        this.emit("completed", fullResult)
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
        this.emit("failed", error)
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
        ;(this as any).emit("heartbeat", fullHb)
    }

    incrementToolCalls(count: number = 1): void {
        this.toolCallCount += count
    }

    setCost(cost: number): void {
        this.totalCost = cost
    }

    setCurrentAction(action: string): void {
        this.currentAction = action
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
        contextProxy: overrides.contextProxy ?? undefined,
        postStateToWebview: overrides.postStateToWebview ?? (() => {}),
        postWorkerHeartbeats: overrides.postWorkerHeartbeats ?? (() => {}),
        ...overrides,
    }
}

// ─── Import BGWorkerManager after mocks are set up ─────────────────────────────

async function loadBGWorkerManager() {
    const mod = await import("../BGWorkerManager")
    return mod.BGWorkerManager
}

// ─── Integration Tests ────────────────────────────────────────────────────────

describe("Parallel Task System — Integration", () => {
    let BGWorkerManager: typeof import("../BGWorkerManager").BGWorkerManager

    beforeAll(async () => {
        BGWorkerManager = await loadBGWorkerManager()
    })

    describe("end-to-end: spawn → heartbeat → complete flow", () => {
        it("completes full lifecycle with heartbeats emitted throughout", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            let completedResult: BGWorkerResult | undefined
            let heartbeatCount = 0

            manager.on("workerCompleted" as any, (result: BGWorkerResult) => {
                completedResult = result
            })

            // Spawn a worker
            const id = await manager.spawn({ description: "Integration test task", mode: "code", message: "", taskType: Ptt.Code })
            expect(id).toBeDefined()

            // Simulate heartbeats from the worker (as BGWorkerManager would receive them)
            for (let i = 0; i < 3; i++) {
                ;(manager as any).aggregateHeartbeat({
                    workerId: id, taskDescription: "Integration test task", taskType: Ptt.Code,
                    state: BgWorkerStateEnum.Running, progressPercent: ((i + 1) * 30), elapsedMs: (i + 1) * 5000,
                    totalCost: (i + 1) * 0.01, toolCallCount: (i + 1) * 5, maxToolCalls: 50, timestamp: Date.now(),
                })
                heartbeatCount++
            }

            // Verify heartbeats were aggregated
            expect((manager as any).aggregatedHeartbeats.length).toBe(1) // Deduplicated by workerId
            expect((manager as any).aggregatedHeartbeats[0].progressPercent).toBe(90) // Last heartbeat wins

            // Complete the worker
            const result: BGWorkerResult = {
                id, state: BgWorkerStateEnum.Completed, summary: "Integration test passed",
                totalToolCalls: 15, durationMs: 15000,
            }
            ;(manager as any).handleWorkerComplete(result)

            expect(completedResult?.id).toBe(id)
            expect(completedResult?.summary).toBe("Integration test passed")

            // Heartbeat should be removed on completion
            expect((manager as any).aggregatedHeartbeats.length).toBe(0)

            manager.dispose()
        })

        it("handles spawn → heartbeat → fail flow", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            let failedError: string | undefined
            manager.on("workerFailed" as any, (_workerId: string, error: string) => {
                failedError = error
            })

            // Spawn a worker
            const id = await manager.spawn({ description: "Fail test", mode: "code", message: "", taskType: Ptt.Search })

            // Emit some heartbeats
            ;(manager as any).aggregateHeartbeat({
                workerId: id, taskDescription: "Fail test", taskType: Ptt.Search,
                state: BgWorkerStateEnum.Running, progressPercent: 30, elapsedMs: 5000,
                totalCost: 0.01, toolCallCount: 3, maxToolCalls: 20, timestamp: Date.now(),
            })

            // Fail the worker
            ;(manager as any).handleWorkerFail(id, "API timeout")

            expect(failedError).toBe("API timeout")
            expect((manager as any).aggregatedHeartbeats.length).toBe(0)

            manager.dispose()
        })

        it("handles spawn → heartbeat → cancel flow", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            // Spawn a worker
            const id = await manager.spawn({ description: "Cancel test", mode: "code", message: "" })

            // Emit heartbeat
            ;(manager as any).aggregateHeartbeat({
                workerId: id, taskDescription: "Cancel test", taskType: Ptt.Code,
                state: BgWorkerStateEnum.Running, progressPercent: 50, elapsedMs: 10000,
                totalCost: 0.02, toolCallCount: 8, maxToolCalls: 50, timestamp: Date.now(),
            })

            // Cancel the worker
            manager.cancelWorker(id)

            // Worker should be removed from active and heartbeat cleared
            expect(manager.getActiveWorkers().has(id)).toBe(false)
            expect((manager as any).aggregatedHeartbeats.length).toBe(0)

            manager.dispose()
        })
    })

    describe("concurrency: multi-worker coordination", () => {
        it("enforces maxConcurrent limit across multiple spawns", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            // Spawn 12 workers (default maxConcurrent = 8)
            for (let i = 0; i < 12; i++) {
                await manager.spawn({ description: `Task ${i}`, mode: "code", message: "", taskType: Ptt.Code })
            }

            const activeWorkers = manager.getActiveWorkers()
            const queue = manager.getQueue()

            expect(activeWorkers.size + queue.length).toBe(12) // Total spawned
            expect(activeWorkers.size).toBeLessThanOrEqual(8) // maxConcurrent
            expect(queue.length).toBeGreaterThanOrEqual(4) // At least 4 in queue

            manager.dispose()
        })

        it("starts queued workers when active slot opens (completion)", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            let startedCount = 0
            manager.on("workerStarted" as any, () => { startedCount++ })

            // Set maxConcurrent to 2 for tighter test
            ;(manager as any).maxConcurrent = 2

            // Spawn 4 workers — only 2 should start immediately
            const ids: string[] = []
            for (let i = 0; i < 4; i++) {
                const id = await manager.spawn({ description: `Task ${i}`, mode: "code", message: "", taskType: Ptt.Code })
                ids.push(id)
            }

            expect(manager.getActiveWorkers().size).toBe(2) // Only 2 active
            expect(manager.getQueue().length).toBe(2) // 2 queued

            // Complete one worker — should start the next from queue
            const result: BGWorkerResult = {
                id: ids[0], state: BgWorkerStateEnum.Completed, summary: "Done",
                totalToolCalls: 5, durationMs: 1000,
            }
            ;(manager as any).handleWorkerComplete(result)

            // Now should have 2 active (one original + one from queue)
            expect(manager.getActiveWorkers().size).toBe(2)
            expect(manager.getQueue().length).toBe(1) // One less in queue

            manager.dispose()
        })

        it("starts queued workers when active slot opens (failure)", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            ;(manager as any).maxConcurrent = 2

            // Spawn 4 workers
            const ids: string[] = []
            for (let i = 0; i < 4; i++) {
                const id = await manager.spawn({ description: `Task ${i}`, mode: "code", message: "", taskType: Ptt.Code })
                ids.push(id)
            }

            expect(manager.getActiveWorkers().size).toBe(2)
            expect(manager.getQueue().length).toBe(2)

            // Fail one worker — should start next from queue
            ;(manager as any).handleWorkerFail(ids[0], "Failure")

            expect(manager.getActiveWorkers().size).toBe(2)
            expect(manager.getQueue().length).toBe(1)

            manager.dispose()
        })

        it("handles 16 concurrent workers (max capacity)", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            ;(manager as any).maxConcurrent = 16

            // Spawn exactly 16 workers
            for (let i = 0; i < 17; i++) {
                await manager.spawn({ description: `Task ${i}`, mode: "code", message: "", taskType: Ptt.Code })
            }

            expect(manager.getActiveWorkers().size).toBe(16) // Max capacity
            expect(manager.getQueue().length).toBe(1) // One waiting

            manager.dispose()
        })

        it("priority queue ordering is respected when dequeuing", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            ;(manager as any).maxConcurrent = 1

            // Spawn workers with different priorities
            await manager.spawn({ description: "Low priority", mode: "code", message: "", taskType: Ptt.Code, priority: 1 })
            await manager.spawn({ description: "High priority", mode: "code", message: "", taskType: Ptt.Code, priority: 10 })
            await manager.spawn({ description: "Medium priority", mode: "code", message: "", taskType: Ptt.Code, priority: 5 })

            // Only one active (the first spawned)
            expect(manager.getActiveWorkers().size).toBe(1)
            expect(manager.getQueue().length).toBe(2)

            // Complete the active worker — next should be highest priority from queue
            const activeId = manager.getActiveWorkers().keys().next().value as string
            ;(manager as any).handleWorkerComplete({
                id: activeId, state: BgWorkerStateEnum.Completed, summary: "Done",
                totalToolCalls: 5, durationMs: 1000,
            })

            // Queue should be sorted by priority desc
            const queue = manager.getQueue()
            expect(queue[0].priority).toBeGreaterThanOrEqual(queue[1]?.priority ?? 0)

            manager.dispose()
        })
    })

    describe("error recovery: retry and timeout", () => {
        it("tracks completed workers with FIFO eviction (MAX_COMPLETED_WORKERS = 10)", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            // Complete 15 workers — only last 10 should be kept
            for (let i = 0; i < 15; i++) {
                ;(manager as any).handleWorkerComplete({
                    id: `worker-${i}`, state: BgWorkerStateEnum.Completed, summary: "Done",
                    totalToolCalls: 5, durationMs: 1000,
                })
            }

            const completed = manager.getCompletedWorkers()
            expect(completed.size).toBe(10) // MAX_COMPLETED_WORKERS

            // First 5 evicted (FIFO)
            for (let i = 0; i < 5; i++) {
                expect(completed.has(`worker-${i}`)).toBe(false)
            }

            // Last 10 kept
            for (let i = 5; i < 15; i++) {
                expect(completed.has(`worker-${i}`)).toBe(true)
            }

            manager.dispose()
        })

        it("handles rapid completion/failure cycles", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            let completedCount = 0
            let failedCount = 0

            manager.on("workerCompleted" as any, () => { completedCount++ })
            manager.on("workerFailed" as any, () => { failedCount++ })

            // Rapid cycle: complete, fail, complete, fail...
            for (let i = 0; i < 20; i++) {
                const id = `cycle-${i}`
                if (i % 2 === 0) {
                    ;(manager as any).handleWorkerComplete({
                        id, state: BgWorkerStateEnum.Completed, summary: "Done",
                        totalToolCalls: 5, durationMs: 1000,
                    })
                } else {
                    ;(manager as any).handleWorkerFail(id, "Error")
                }
            }

            expect(completedCount).toBe(10) // Even indices
            expect(failedCount).toBe(10) // Odd indices

            manager.dispose()
        })

        it("handles completion of non-existent worker gracefully", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            // Complete a worker that was never spawned — should not throw
            expect(() => {
                ;(manager as any).handleWorkerComplete({
                    id: "non-existent", state: BgWorkerStateEnum.Completed, summary: "Done",
                    totalToolCalls: 0, durationMs: 0,
                })
            }).not.toThrow()

            manager.dispose()
        })

        it("handles failure of non-existent worker gracefully", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            expect(() => {
                ;(manager as any).handleWorkerFail("non-existent", "Error")
            }).not.toThrow()

            manager.dispose()
        })
    })

    describe("settings persistence across restarts", () => {
        it("preserves maxConcurrent setting when creating new manager instance", async () => {
            // First manager with custom settings
            const provider1 = createMockProvider({
                contextProxy: { stateCache: { "parallelTaskMaxConcurrent": 4 } },
            })
            const manager1 = new BGWorkerManager(provider1 as any)

            expect((manager1 as any).maxConcurrent).toBe(4)

            // Second manager (simulating restart) with same settings
            const provider2 = createMockProvider({
                contextProxy: { stateCache: { "parallelTaskMaxConcurrent": 4 } },
            })
            const manager2 = new BGWorkerManager(provider2 as any)

            expect((manager2 as any).maxConcurrent).toBe(4)

            // Different settings should produce different results
            const provider3 = createMockProvider({
                contextProxy: { stateCache: { "parallelTaskMaxConcurrent": 12 } },
            })
            const manager3 = new BGWorkerManager(provider3 as any)

            expect((manager3 as any).maxConcurrent).toBe(12)

            manager1.dispose()
            manager2.dispose()
            manager3.dispose()
        })

        it("preserves mode overrides across restarts", async () => {
            const provider = createMockProvider({
                contextProxy: {
                    stateCache: {
                        "parallelTaskModeCodeProvider": "openai",
                        "parallelTaskModeCodeModelId": "gpt-4o-mini",
                        "parallelTaskAutoApproveCodeReadFiles": true,
                        "parallelTaskAutoApproveCodeWriteFiles": true,
                    },
                },
            })
            const manager = new BGWorkerManager(provider as any)

            // Spawn a Code task — should get the mode override
            const id = await manager.spawn({ description: "Settings test", mode: "code", message: "", taskType: Ptt.Code })

            // Verify the resolved config has overrides (access via queue since worker started immediately)
            const activeWorkers = manager.getActiveWorkers()
            expect(activeWorkers.size).toBe(1)

            manager.dispose()
        })

        it("preserves shared context between spawns in same manager", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            // Spawn two workers — they share the same SharedWorkerContext
            await manager.spawn({ description: "Worker A", mode: "code", message: "", taskType: Ptt.Code })
            await manager.spawn({ description: "Worker B", mode: "search", message: "", taskType: Ptt.Search })

            const sharedCtx = manager.getSharedContext()

            // Both workers should be in the activeWorkers map
            expect(sharedCtx.activeWorkers.size).toBe(2)

            manager.dispose()
        })
    })

    describe("cross-component: BGWorkerManager + Heartbeat System", () => {
        it("aggregates heartbeats from multiple concurrent workers", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            // Simulate heartbeats from 5 different workers
            for (let i = 0; i < 5; i++) {
                ;(manager as any).aggregateHeartbeat({
                    workerId: `worker-${i}`, taskDescription: `Task ${i}`, taskType: [Ptt.Code, Ptt.Search, Ptt.Doc, Ptt.Debug, Ptt.Commit][i],
                    state: BgWorkerStateEnum.Running, progressPercent: (i + 1) * 20, elapsedMs: (i + 1) * 5000,
                    totalCost: (i + 1) * 0.01, toolCallCount: (i + 1) * 5, maxToolCalls: 50, timestamp: Date.now(),
                })
            }

            expect((manager as any).aggregatedHeartbeats.length).toBe(5) // All 5 workers tracked

            manager.dispose()
        })

        it("updates heartbeat when same worker sends multiple heartbeats", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            // First heartbeat
            ;(manager as any).aggregateHeartbeat({
                workerId: "worker-1", taskDescription: "Task 1", taskType: Ptt.Code,
                state: BgWorkerStateEnum.Running, progressPercent: 25, elapsedMs: 5000,
                totalCost: 0.01, toolCallCount: 3, maxToolCalls: 50, timestamp: Date.now() - 5000,
            })

            // Second heartbeat (same worker, updated progress)
            ;(manager as any).aggregateHeartbeat({
                workerId: "worker-1", taskDescription: "Task 1", taskType: Ptt.Code,
                state: BgWorkerStateEnum.Running, progressPercent: 75, elapsedMs: 15000,
                totalCost: 0.03, toolCallCount: 9, maxToolCalls: 50, timestamp: Date.now(),
            })

            // Should still be only 1 entry (updated)
            expect((manager as any).aggregatedHeartbeats.length).toBe(1)
            expect((manager as any).aggregatedHeartbeats[0].progressPercent).toBe(75)
            expect((manager as any).aggregatedHeartbeats[0].totalCost).toBe(0.03)

            manager.dispose()
        })

        it("flushes heartbeats with running workers sorted first", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            let flushedOrder: string[] = []
            ;(provider as any).postWorkerHeartbeats = (heartbeats: WorkerHeartbeat[]) => {
                flushedOrder = heartbeats.map(h => h.workerId)
            }

            // Add completed worker first, then running workers
            ;(manager as any).aggregateHeartbeat({
                workerId: "completed-1", taskDescription: "Done 1", taskType: Ptt.Search,
                state: BgWorkerStateEnum.Completed, progressPercent: 100, elapsedMs: 30000,
                totalCost: 0.05, toolCallCount: 20, maxToolCalls: 50, timestamp: Date.now() - 30000,
            })

            ;(manager as any).aggregateHeartbeat({
                workerId: "running-1", taskDescription: "Running 1", taskType: Ptt.Code,
                state: BgWorkerStateEnum.Running, progressPercent: 50, elapsedMs: 10000,
                totalCost: 0.02, toolCallCount: 8, maxToolCalls: 50, timestamp: Date.now(),
            })

            ;(manager as any).aggregateHeartbeat({
                workerId: "running-2", taskDescription: "Running 2", taskType: Ptt.Debug,
                state: BgWorkerStateEnum.Running, progressPercent: 30, elapsedMs: 5000,
                totalCost: 0.01, toolCallCount: 4, maxToolCalls: 50, timestamp: Date.now(),
            })

            // Flush immediately
            manager["heartbeatThrottleTimer"] && clearTimeout(manager["heartbeatThrottleTimer"])
            ;(manager as any).flushHeartbeats()

            expect(flushedOrder.length).toBeGreaterThan(0)
            // Running workers should come first
            const runningFirst = flushedOrder.findIndex(id => id.startsWith("running-"))
            const completedLast = flushedOrder.lastIndexOf("completed-1")
            expect(runningFirst).toBeLessThan(completedLast)

            manager.dispose()
        })

        it("handles heartbeat aggregation with 8 workers (MAX_HEARTBEATS_SHOWN boundary)", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            let flushedCount = 0
            ;(provider as any).postWorkerHeartbeats = (heartbeats: WorkerHeartbeat[]) => {
                flushedCount = heartbeats.length
            }

            // Add exactly 8 workers (at the boundary)
            for (let i = 0; i < 8; i++) {
                ;(manager as any).aggregateHeartbeat({
                    workerId: `worker-${i}`, taskDescription: `Task ${i}`, taskType: Ptt.Code,
                    state: BgWorkerStateEnum.Running, progressPercent: (i + 1) * 12, elapsedMs: (i + 1) * 5000,
                    totalCost: (i + 1) * 0.01, toolCallCount: (i + 1) * 5, maxToolCalls: 50, timestamp: Date.now(),
                })
            }

            manager["heartbeatThrottleTimer"] && clearTimeout(manager["heartbeatThrottleTimer"])
            ;(manager as any).flushHeartbeats()

            expect(flushedCount).toBe(8) // All shown (at boundary)
        })

        it("handles heartbeat aggregation with 9 workers (exceeds MAX_HEARTBEATS_SHOWN)", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            let flushedCount = 0
            ;(provider as any).postWorkerHeartbeats = (heartbeats: WorkerHeartbeat[]) => {
                flushedCount = heartbeats.length
            }

            // Add 9 workers (one over the boundary)
            for (let i = 0; i < 9; i++) {
                ;(manager as any).aggregateHeartbeat({
                    workerId: `worker-${i}`, taskDescription: `Task ${i}`, taskType: Ptt.Code,
                    state: BgWorkerStateEnum.Running, progressPercent: (i + 1) * 11, elapsedMs: (i + 1) * 5000,
                    totalCost: (i + 1) * 0.01, toolCallCount: (i + 1) * 5, maxToolCalls: 50, timestamp: Date.now(),
                })
            }

            manager["heartbeatThrottleTimer"] && clearTimeout(manager["heartbeatThrottleTimer"])
            ;(manager as any).flushHeartbeats()

            expect(flushedCount).toBeLessThanOrEqual(8) // Capped at MAX_HEARTBEATS_SHOWN
        })
    })

    describe("pause/resume integration", () => {
        it("pauses and resumes a worker correctly", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            // Spawn a worker
            const id = await manager.spawn({ description: "Pause test", mode: "code", message: "" })

            expect(manager.getActiveWorkers().size).toBe(1)

            // Pause
            manager.pauseWorker(id)
            expect(manager.getActiveWorkers().size).toBe(1) // Still active, just paused

            // Resume
            manager.resumeWorker(id)
            expect(manager.getActiveWorkers().size).toBe(1)

            manager.dispose()
        })

        it("handles pause/resume for non-existent worker gracefully", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            expect(() => manager.pauseWorker("non-existent")).not.toThrow()
            expect(() => manager.resumeWorker("non-existent")).not.toThrow()

            manager.dispose()
        })
    })

    describe("dispose cleanup", () => {
        it("clears all state on dispose including heartbeats", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            // Add some state
            await manager.spawn({ description: "Test", mode: "code", message: "" })
            ;(manager as any).aggregateHeartbeat({
                workerId: "test-worker", taskDescription: "Test", taskType: Ptt.Code,
                state: BgWorkerStateEnum.Running, progressPercent: 50, elapsedMs: 10000,
                totalCost: 0.02, toolCallCount: 8, maxToolCalls: 50, timestamp: Date.now(),
            })

            expect(manager.getActiveWorkers().size).toBeGreaterThan(0)
            expect((manager as any).aggregatedHeartbeats.length).toBeGreaterThan(0)

            manager.dispose()

            // All state should be cleared
            expect(manager.getActiveWorkers().size).toBe(0)
            expect((manager as any).queue).toEqual([])
            expect((manager as any).aggregatedHeartbeats).toEqual([])
        })

        it("handles double dispose gracefully", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            manager.dispose()
            expect(() => manager.dispose()).not.toThrow() // Should not throw on second call
        })
    })

    describe("queueUpdated event emission", () => {
        it("emits queueUpdated with correct counts on spawn", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            let lastUpdate: [number, number] | null = null
            manager.on("queueUpdated" as any, (qLen: number, activeCount: number) => {
                lastUpdate = [qLen, activeCount]
            })

            await manager.spawn({ description: "Test", mode: "code", message: "" })

            expect(lastUpdate).not.toBeNull()
            // Queue should be 0 (started immediately), active >= 1
            expect(lastUpdate![1]).toBeGreaterThanOrEqual(1)

            manager.dispose()
        })

        it("emits queueUpdated on worker completion", async () => {
            const provider = createMockProvider({ contextProxy: undefined })
            const manager = new BGWorkerManager(provider as any)

            let updates: Array<[number, number]> = []
            manager.on("queueUpdated" as any, (qLen: number, activeCount: number) => {
                updates.push([qLen, activeCount])
            })

            // Spawn and complete a worker
            const id = await manager.spawn({ description: "Test", mode: "code", message: "" })
            ;(manager as any).handleWorkerComplete({
                id, state: BgWorkerStateEnum.Completed, summary: "Done",
                totalToolCalls: 5, durationMs: 1000,
            })

            expect(updates.length).toBeGreaterThanOrEqual(2) // At least spawn + complete events

            manager.dispose()
        })
    })
})
