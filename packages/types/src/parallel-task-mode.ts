/** Task type categories for parallel task mode routing */
import { type TokenUsage } from "./message.js"

export enum ParallelTaskType {
	Search = "search", // Find information, look up code
	Doc = "doc", // Documentation, explanations
	Commit = "commit", // Write commit messages, changelogs
	Code = "code", // Implement features, write code
	Debug = "debug", // Investigate bugs, trace errors
	General = "general", // Default / unspecified (inherits from main task)
}

/** Per-mode LLM configuration override */
export interface ParallelTaskModeConfig {
	/** Which provider profile to use (e.g., "openai", "anthropic", "lmstudio") */
	apiProvider?: string
	/** Specific model ID within the provider (e.g., "gpt-4o-mini", "claude-haiku") */
	modelId?: string
	/** Optional temperature override (0.0-2.0) */
	temperature?: number
	/** Optional max tokens override */
	maxTokens?: number
	/** Tool auto-approve settings for this task type */
	autoApprove?: Partial<ParallelTaskAutoApprove>
}

/** Structured tool auto-approve configuration per task type.
 *  Controls which tools a background worker can use without user approval.
 *  Different task types get different defaults to balance cost vs capability. */
export interface ParallelTaskAutoApprove {
	readFiles: boolean // Allow reading files without approval
	writeFiles: boolean // Allow writing files without approval
	executeCommands: boolean // Allow shell commands without approval
	browserActions: boolean // Allow browser tools without approval
}

/** Default auto-approve settings per task type.
 *  Search/commit are conservative (read-only or minimal write).
 *  Code/debug are permissive (full tool access like foreground tasks). */
export const DEFAULT_AUTO_APPROVE_PER_TYPE: Record<ParallelTaskType, ParallelTaskAutoApprove> = {
	[ParallelTaskType.Search]: {
		readFiles: true,
		writeFiles: false, // Search usually doesn't modify files
		executeCommands: false,
		browserActions: false,
	},
	[ParallelTaskType.Doc]: {
		readFiles: true,
		writeFiles: true, // Doc might need to write documentation
		executeCommands: false,
		browserActions: false,
	},
	[ParallelTaskType.Commit]: {
		readFiles: true, // Read git diff / files for context
		writeFiles: false, // Commit usually doesn't modify source files
		executeCommands: true, // May need git commands (git add, git commit)
		browserActions: false,
	},
	[ParallelTaskType.Code]: {
		readFiles: true,
		writeFiles: true,
		executeCommands: true,
		browserActions: false,
	},
	[ParallelTaskType.Debug]: {
		readFiles: true,
		writeFiles: false, // Debug reads logs/files but rarely writes
		executeCommands: true, // May need to run debug commands / restart services
		browserActions: false,
	},
	[ParallelTaskType.General]: {
		readFiles: true,
		writeFiles: false, // Conservative default for unspecified types
		executeCommands: false,
		browserActions: false,
	},
}

/** User's parallel task settings — stored as flat fields in globalState */
export interface ParallelTaskSettings {
	enabled: boolean
	maxConcurrent: number // 1-16
	modeMap: Record<ParallelTaskType, ParallelTaskModeConfig | null>
}

/** Default settings when user hasn't configured anything */
export const DEFAULT_PARALLEL_TASK_SETTINGS: ParallelTaskSettings = {
	enabled: false,
	maxConcurrent: 8,
	modeMap: {
		[ParallelTaskType.Search]: { apiProvider: "openai", modelId: "gpt-4o-mini" },
		[ParallelTaskType.Doc]: { apiProvider: "anthropic", modelId: "claude-haiku" },
		[ParallelTaskType.Commit]: { apiProvider: "openai", modelId: "gpt-4o-mini" },
		[ParallelTaskType.Code]: null,
		[ParallelTaskType.Debug]: null,
		[ParallelTaskType.General]: null,
	},
}

/** Extended BGWorkerConfig with mode info and error recovery */
export interface BGWorkerConfig {
	/** Unique identifier — auto-generated if omitted (BGWorkerManager.spawn() creates one) */
	id?: string
	description: string
	mode: string // Roo Code mode slug (code, debug, architect)
	message: string
	todos?: string | null

	/** Task type for mode routing (user-selected or auto-detected) */
	taskType?: ParallelTaskType

	/** LLM config override from parallel task mode mapping */
	apiProviderOverride?: string
	modelIdOverride?: string
	temperatureOverride?: number
	maxTokensOverride?: number

	/** Error recovery settings */
	maxRetries?: number // default: 0 (no retry)
	retryDelayMs?: number // default: 1000, exponential backoff
	timeoutMs?: number // default: 1800000 (30 minutes)

	/** Structured tool auto-approve settings.
	 *  Resolved from DEFAULT_AUTO_APPROVE_PER_TYPE[taskType] + modeMap.autoApprove override.
	 *  If undefined, falls back to defaults for the task type. */
	autoApprove?: Partial<ParallelTaskAutoApprove>

	/** Maximum tool calls per background task (cost control).
	 *  Resolved from DEFAULT_AUTO_APPROVE_PER_TYPE[taskType] if not specified in config.
	 *  Worker stops after reaching this limit with a "max_tool_calls_reached" result. */
	maxToolCallsPerTask?: number

	/** Maximum API cost per background task (in USD).
	 *  Worker tracks token usage and stops when estimated cost exceeds this limit.
	 *  Useful for preventing runaway costs even with expensive models.
	 *  Default: $0.50 for Search/Commit, $1.00 for Doc/General, $2.00 for Code/Debug */
	maxCostPerTask?: number

	/** Maximum tokens per background task (input + output combined).
	 *  Worker stops after reaching this limit with a "max_tokens_reached" result.
	 *  More precise than maxToolCalls — prevents token bloat from large tool responses.
	 *  Default: Search/Commit: 8000, Doc: 16000, Code/Debug: 32000, General: 16000 */
	maxTokensPerTask?: number

	/** Context retention level for worker's conversation history.
	 *  - "minimal": keep only last 1 message pair (saves tokens, good for Search)
	 *  - "moderate": keep last 3 message pairs (default, balances cost vs context)
	 *  - "full": keep last 8 message pairs (needed for Debug to see error history) */
	contextRetention?: "minimal" | "moderate" | "full"

	/** Notification preference for worker completion/failure.
	 *  - "all": notify on both success and failure (default)
	 *  - "errors_only": only notify when worker fails
	 *  - "none": silent mode, no notifications */
	notificationMode?: "all" | "errors_only" | "none"

	priority?: number
}

/** Default cost/token limits per task type (v4.0 adjusted) */
export const DEFAULT_COST_LIMITS_PER_TYPE: Record<
	ParallelTaskType,
	{ maxCostPerTask: number; maxTokensPerTask: number }
> = {
	[ParallelTaskType.Search]: { maxCostPerTask: 2.0, maxTokensPerTask: 16000 },
	[ParallelTaskType.Doc]: { maxCostPerTask: 3.0, maxTokensPerTask: 32000 },
	[ParallelTaskType.Commit]: { maxCostPerTask: 1.0, maxTokensPerTask: 16000 },
	[ParallelTaskType.Code]: { maxCostPerTask: 5.0, maxTokensPerTask: 64000 },
	[ParallelTaskType.Debug]: { maxCostPerTask: 5.0, maxTokensPerTask: 64000 },
	[ParallelTaskType.General]: { maxCostPerTask: 3.0, maxTokensPerTask: 32000 },
}

/** Lightweight shared state between parallel workers — managed by BGWorkerManager */
export interface SharedWorkerContext {
	/** List of all active worker IDs and their task types (updated on spawn/cancel) */
	activeWorkers: Map<string, { taskId: string; type: ParallelTaskType }>

	/** Recent file modifications from any worker — used for conflict awareness.
	 *  Workers read this before each LLM call to enrich context with other workers' changes. */
	recentFileChanges: Array<{
		workerId: string
		filePath: string
		timestamp: number
	}>

	/** Maximum entries to keep (prevents unbounded growth, FIFO eviction) */
	maxRecentChanges: number // default: 50

	/** Last plan/tasks state shared between workers (if any). Phase 2+ candidate. */
	currentPlan?: string
	lastPlanUpdaterId?: string
	lastPlanUpdateTimestamp?: number
}

/** Worker lifecycle states */
export enum BGWorkerState {
	Queued = "queued",
	Running = "running",
	Paused = "paused",
	Completed = "completed",
	Failed = "failed",
	Cancelled = "cancelled",
}

/** Result of completed worker — delivered via VSCode notification */
export interface BGWorkerResult {
	id: string
	state: BGWorkerState.Completed | BGWorkerState.Failed | BGWorkerState.Cancelled
	summary?: string // Generated by LLM or manual summary
	totalToolCalls: number
	tokenUsage?: TokenUsage
	error?: string // Error message if failed
	durationMs: number
	notificationMode?: "all" | "errors_only" | "none" // For controlling completion notifications
}

/** State update sent to UI via postMessage (throttled to 2s interval) */
export interface BGWorkerStateUpdate {
	type: "bgWorkerState"
	workerId: string
	state: BGWorkerState
	description?: string
	taskType?: ParallelTaskType
	toolCallCount?: number
	currentTool?: string
}

/** Event types for BGWorkerManager EventEmitter */
export type BGWorkerManagerEvents = {
	workerStarted: [workerId: string]
	workerCompleted: [result: BGWorkerResult]
	workerFailed: [workerId: string, error: string]
	workerStateChanged: [workerId: string, newState: BGWorkerState]
	queueUpdated: [queueLength: number, activeCount: number]
}

/** Queue item — what gets queued when at capacity */
export interface BGQueueItem {
	id: string
	config: BGWorkerConfig
	priority: number
	enqueuedAt: number
}

/** Default context retention per task type */
export const DEFAULT_CONTEXT_RETENTION_PER_TYPE: Record<ParallelTaskType, "minimal" | "moderate" | "full"> = {
	[ParallelTaskType.Search]: "minimal", // Search doesn't need history
	[ParallelTaskType.Doc]: "moderate", // Doc needs some context for writing
	[ParallelTaskType.Commit]: "minimal", // Commit just needs current diff
	[ParallelTaskType.Code]: "moderate", // Code needs recent conversation context
	[ParallelTaskType.Debug]: "full", // Debug needs full error history
	[ParallelTaskType.General]: "moderate", // Conservative default
}

/** Default notification mode per task type */
export const DEFAULT_NOTIFICATION_MODE_PER_TYPE: Record<ParallelTaskType, "all" | "errors_only"> = {
	[ParallelTaskType.Search]: "errors_only", // Search is low-priority, only notify on errors
	[ParallelTaskType.Doc]: "errors_only", // Doc is low-priority
	[ParallelTaskType.Commit]: "errors_only", // Commit is quick, only notify on errors
	[ParallelTaskType.Code]: "all", // Code tasks are important, notify on completion
	[ParallelTaskType.Debug]: "all", // Debug tasks are important, notify on completion
	[ParallelTaskType.General]: "errors_only", // Conservative default
}
