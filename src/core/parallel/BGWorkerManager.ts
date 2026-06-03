import EventEmitter from "events"
import * as vscode from "vscode"

import type { ClineProvider } from "../webview/ClineProvider"
import type {
	BGQueueItem,
	BGWorkerConfig,
	BGWorkerManagerEvents,
	BGWorkerResult,
	BGWorkerState,
	BGWorkerStateUpdate,
	ParallelTaskType,
	SharedWorkerContext,
} from "@roo-code/types"
import {
	DEFAULT_AUTO_APPROVE_PER_TYPE,
	DEFAULT_CONTEXT_RETENTION_PER_TYPE,
	DEFAULT_COST_LIMITS_PER_TYPE,
	DEFAULT_NOTIFICATION_MODE_PER_TYPE,
	BGWorkerState as BgWorkerStateEnum,
	ParallelTaskType as Ptt,
} from "@roo-code/types"

import { BGWorker } from "./BGWorker"
import { ContextProxy } from "../config/ContextProxy"

/** Maximum number of completed workers to keep in memory (FIFO eviction) */
const MAX_COMPLETED_WORKERS = 10

/** Default timeout for background workers: 30 minutes */
const DEFAULT_TIMEOUT_MS = 1800000

/** Default retry delay base: 1 second with exponential backoff */
const DEFAULT_RETRY_DELAY_MS = 1000

export class BGWorkerManager extends EventEmitter<BGWorkerManagerEvents> {
	private provider: ClineProvider
	private queue: BGQueueItem[] = []
	private activeWorkers: Map<string, BGWorker> = new Map()
	/** Completed workers — limited to prevent unbounded growth. Only kept for UI display. */
	private completedWorkers: Map<string, BGWorkerResult> = new Map()
	private maxConcurrent: number // configurable 1-16

	/** v4.0: Shared state between workers for cross-worker awareness */
	private sharedContext: SharedWorkerContext = {
		activeWorkers: new Map(),
		recentFileChanges: [],
		maxRecentChanges: 50,
	}

	/** Throttled state update interval (2s) */
	private stateFlushInterval?: NodeJS.Timeout

	constructor(provider: ClineProvider) {
		super()
		this.provider = provider
		this.maxConcurrent = Math.min(16, Math.max(1, this.loadMaxConcurrent()))

		// Throttled state updates every 2s
		this.stateFlushInterval = setInterval(() => this.flushStateUpdates(), 2000)
	}

	/** Load max concurrent workers from settings */
	private loadMaxConcurrent(): number {
		const proxy = this.getContextProxy()
		const value = proxy.get("parallelTaskMaxConcurrent")
		if (typeof value === "number" && Number.isInteger(value)) {
			return Math.min(16, Math.max(1, value))
		}
		return 8 // Default
	}

	private getContextProxy(): ContextProxy {
		// Access contextProxy from ClineProvider — it's a public readonly property
		const proxy = (this.provider as any).contextProxy
		if (!proxy) {
			console.warn("[BGWorkerManager] contextProxy not available, using defaults")
		}
		return proxy
	}

	/** Spawn a background worker with mode resolution */
	async spawn(config: BGWorkerConfig): Promise<string> {
		const id = config.id ?? `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

		// Resolve LLM override from task type → mode mapping
		const resolvedConfig = this.resolveModeOverride(config)

		const item: BGQueueItem = {
			id,
			config: resolvedConfig,
			priority: config.priority ?? 0,
			enqueuedAt: Date.now(),
		}

		if (this.activeWorkers.size >= this.maxConcurrent) {
			// Queue up with priority sorting (no preemption — queue only)
			this.queue.push(item)
			this.sortQueue()
		} else {
			await this.startWorker(item)
		}

		this.emit("queueUpdated", this.queue.length, this.activeWorkers.size)
		return id
	}

	/** Look up task type → LLM config override + auto-approve settings + cost limits */
	private resolveModeOverride(config: BGWorkerConfig): BGWorkerConfig {
		if (!config.taskType) {
			return config // No override, inherit from main task
		}

		const modeMap = this.loadModeMap()

		const modeConfig = modeMap[config.taskType]
		if (!modeConfig) {
			return config // No mapping for this type, inherit
		}

		// Resolve auto-approve: merge DEFAULT_AUTO_APPROVE_PER_TYPE + mode-specific override
		const defaultAutoApprove =
			DEFAULT_AUTO_APPROVE_PER_TYPE[config.taskType] ?? DEFAULT_AUTO_APPROVE_PER_TYPE[Ptt.General]
		const resolvedAutoApprove = { ...defaultAutoApprove, ...(modeConfig.autoApprove ?? {}) }

		// Resolve maxToolCallsPerTask from defaults if not specified in config
		const defaultMaxToolCalls: Record<ParallelTaskType, number> = {
			[Ptt.Search]: 20,
			[Ptt.Doc]: 30,
			[Ptt.Commit]: 10,
			[Ptt.Code]: 50,
			[Ptt.Debug]: 40,
			[Ptt.General]: 25,
		}
		const maxToolCallsPerTask = config.maxToolCallsPerTask ?? defaultMaxToolCalls[config.taskType]

		// Resolve cost/token limits from defaults if not specified in config
		const defaultCostLimits = DEFAULT_COST_LIMITS_PER_TYPE[config.taskType]
		const maxCostPerTask = config.maxCostPerTask ?? defaultCostLimits.maxCostPerTask
		const maxTokensPerTask = config.maxTokensPerTask ?? defaultCostLimits.maxTokensPerTask

		// Resolve context retention from defaults if not specified in config
		const contextRetention = config.contextRetention ?? DEFAULT_CONTEXT_RETENTION_PER_TYPE[config.taskType]

		// Resolve notification mode from defaults if not specified in config
		const notificationMode =
			config.notificationMode ??
			(DEFAULT_NOTIFICATION_MODE_PER_TYPE[config.taskType] as "all" | "errors_only" | "none")

		// Merge: base config + mode-specific overrides
		return {
			...config,
			apiProviderOverride: modeConfig.apiProvider,
			modelIdOverride: modeConfig.modelId,
			temperatureOverride: modeConfig.temperature ?? config.temperatureOverride,
			maxTokensOverride: modeConfig.maxTokens ?? config.maxTokensOverride,
			autoApprove: resolvedAutoApprove,
			maxToolCallsPerTask,
			maxCostPerTask,
			maxTokensPerTask,
			contextRetention,
			notificationMode,
		}
	}

	/** Load mode map from flat settings */
	private loadModeMap(): Record<
		ParallelTaskType,
		{
			apiProvider?: string
			modelId?: string
			autoApprove?: Partial<(typeof DEFAULT_AUTO_APPROVE_PER_TYPE)[ParallelTaskType]>
		} | null
	> {
		const proxy = this.getContextProxy()

		return {
			[Ptt.Search]: this.readModeOverride(proxy, "Search"),
			[Ptt.Doc]: this.readModeOverride(proxy, "Doc"),
			[Ptt.Commit]: this.readModeOverride(proxy, "Commit"),
			// v5 fix: Code/Debug also support provider+model override (was missing in initial implementation)
			[Ptt.Code]: this.readModeOverride(proxy, "Code"),
			[Ptt.Debug]: this.readModeOverride(proxy, "Debug"),
			[Ptt.General]: null, // inherit from main task — truly generic
		}
	}

	private readModeOverride(
		proxy: ContextProxy | undefined,
		taskType: string,
	): {
		apiProvider?: string
		modelId?: string
		autoApprove?: Partial<(typeof DEFAULT_AUTO_APPROVE_PER_TYPE)[ParallelTaskType]>
	} | null {
		if (!proxy) return null

		const provider = proxy.get(`parallelTaskMode${taskType}Provider`) as string | undefined
		const modelId = proxy.get(`parallelTaskMode${taskType}ModelId`) as string | undefined

		// Read auto-approve settings (flat → structured)
		const prefix = `parallelTaskAutoApprove${taskType}`
		const autoApprove: Record<string, boolean> = {}

		if (proxy.get(`${prefix}ReadFiles`) !== undefined) {
			autoApprove.readFiles = proxy.get(`${prefix}ReadFiles`) as boolean
		}
		if (proxy.get(`${prefix}WriteFiles`) !== undefined) {
			autoApprove.writeFiles = proxy.get(`${prefix}WriteFiles`) as boolean
		}
		if (proxy.get(`${prefix}ExecuteCommands`) !== undefined) {
			autoApprove.executeCommands = proxy.get(`${prefix}ExecuteCommands`) as boolean
		}
		if (proxy.get(`${prefix}BrowserActions`) !== undefined) {
			autoApprove.browserActions = proxy.get(`${prefix}BrowserActions`) as boolean
		}

		if (provider || modelId || Object.keys(autoApprove).length > 0) {
			return {
				apiProvider: provider,
				modelId,
				autoApprove:
					Object.keys(autoApprove).length > 0
						? (autoApprove as Partial<(typeof DEFAULT_AUTO_APPROVE_PER_TYPE)[ParallelTaskType]>)
						: undefined,
			}
		}
		return null // No override configured → inherit from main task
	}

	private sortQueue(): void {
		// Priority desc, then enqueue time asc (FIFO within same priority)
		this.queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt)
	}

	private async startWorker(item: BGQueueItem): Promise<void> {
		// Remove from queue
		const idx = this.queue.findIndex((q) => q.id === item.id)
		if (idx !== -1) this.queue.splice(idx, 1)

		// Register worker in shared context
		this.sharedContext.activeWorkers.set(item.id, {
			taskId: item.config.description,
			type: item.config.taskType ?? Ptt.General,
		})

		const worker = new BGWorker(this.provider, item.config, this.sharedContext)
		this.activeWorkers.set(item.id, worker)

		// Wire up event listeners
		worker.on("stateUpdate", (update: BGWorkerStateUpdate) => {
			this.emit("workerStateChanged", update.workerId, update.state)
		})

		worker.on("completed", (result: BGWorkerResult) => {
			this.handleWorkerComplete(result)
		})

		worker.on("failed", (error: string) => {
			this.handleWorkerFail(item.id, error)
		})

		// Start timeout timer if configured
		const timeoutMs = item.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
		this.startTimeoutTimer(item.id, timeoutMs)

		await worker.start()
	}

	private handleWorkerComplete(result: BGWorkerResult): void {
		// Remove from shared context (v4.0)
		this.sharedContext.activeWorkers.delete(result.id)

		// Move to completed workers (with FIFO eviction)
		this.completedWorkers.set(result.id, result)
		if (this.completedWorkers.size > MAX_COMPLETED_WORKERS) {
			const firstKey = this.completedWorkers.keys().next().value
			if (firstKey) this.completedWorkers.delete(firstKey)
		}

		// v4.1+: Re-sort queue before starting next worker
		this.sortQueue()

		// Show VSCode notification to user (respect notificationMode, but always show for failures)
		this.showCompletionNotification(result)

		this.emit("workerCompleted", result)

		// Try to start next from queue (no preemption — just fill open slot)
		if (this.queue.length > 0 && this.activeWorkers.size < this.maxConcurrent) {
			const next = this.queue.shift()!
			this.startWorker(next)
		}

		this.emit("queueUpdated", this.queue.length, this.activeWorkers.size)
	}

	private handleWorkerFail(workerId: string, error: string): void {
		this.activeWorkers.delete(workerId)

		const result: BGWorkerResult = {
			id: workerId,
			state: BgWorkerStateEnum.Failed,
			totalToolCalls: 0,
			durationMs: Date.now() - (this.queue.find((q) => q.id === workerId)?.enqueuedAt ?? Date.now()),
			error,
		}

		this.completedWorkers.set(workerId, result)
		this.showFailureNotification(result)

		this.emit("workerFailed", workerId, error)

		// v4.2+: Re-sort queue after failure too (not just completion)
		this.sortQueue()

		// Try to start next from queue
		if (this.queue.length > 0 && this.activeWorkers.size < this.maxConcurrent) {
			const next = this.queue.shift()!
			this.startWorker(next)
		}

		this.emit("queueUpdated", this.queue.length, this.activeWorkers.size)
	}

	private showCompletionNotification(result: BGWorkerResult): void {
		// Check notificationMode before showing
		if (result.notificationMode === "none") return // Silent mode

		const summaryText = result.summary ? `\n\n${result.summary}` : ""
		vscode.window.showInformationMessage(
			`[Background Task] "${result.summary || "Task"}" completed (${result.totalToolCalls} tool calls, ${this.formatDuration(result.durationMs)})${summaryText}`,
			"Dismiss",
		)
	}

	private showFailureNotification(result: BGWorkerResult): void {
		// Always show failure notifications (even if mode is errors_only or none)
		vscode.window.showErrorMessage(
			`[Background Task] "${result.summary || "Task"}" failed: ${result.error}`,
			"Dismiss",
		)
	}

	private flushStateUpdates(): void {
		if (this.activeWorkers.size === 0 && this.queue.length === 0)
			return // Post batched state to webview (throttled by the 2s interval)
		;(this.provider as any).postStateToWebview?.()
	}

	private startTimeoutTimer(workerId: string, timeoutMs: number): void {
		setTimeout(() => {
			const worker = this.activeWorkers.get(workerId)
			if (worker && worker.getState() === BgWorkerStateEnum.Running) {
				worker.cancel("timeout")
				this.emit("workerFailed", workerId, `Worker timed out after ${timeoutMs}ms`)
			}
		}, timeoutMs)
	}

	/** Cancel a specific worker by ID */
	cancelWorker(workerId: string): void {
		const worker = this.activeWorkers.get(workerId)
		if (worker) {
			worker.cancel("user_cancelled")
		}
	}

	/** Pause a specific worker by ID */
	pauseWorker(workerId: string): void {
		const worker = this.activeWorkers.get(workerId)
		if (worker) {
			worker.pause()
		}
	}

	/** Resume a paused worker by ID */
	resumeWorker(workerId: string): void {
		const worker = this.activeWorkers.get(workerId)
		if (worker) {
			worker.resume()
		}
	}

	/** Get all active workers */
	getActiveWorkers(): Map<string, BGWorker> {
		return new Map(this.activeWorkers)
	}

	/** Get completed workers */
	getCompletedWorkers(): Map<string, BGWorkerResult> {
		return new Map(this.completedWorkers)
	}

	/** Get current queue */
	getQueue(): BGQueueItem[] {
		return [...this.queue]
	}

	/** Get shared context for debugging */
	getSharedContext(): SharedWorkerContext {
		return this.sharedContext
	}

	dispose(): void {
		if (this.stateFlushInterval) {
			clearInterval(this.stateFlushInterval)
		}
		for (const [, worker] of this.activeWorkers) {
			worker.cancel("manager_dispose")
		}
		this.activeWorkers.clear()
		this.queue = []
	}

	private formatDuration(ms: number): string {
		const seconds = Math.floor(ms / 1000)
		const minutes = Math.floor(seconds / 60)
		const remainingSeconds = seconds % 60
		if (minutes > 0) {
			return `${minutes}m ${remainingSeconds}s`
		}
		return `${seconds}s`
	}
}
