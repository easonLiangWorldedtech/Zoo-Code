/** Task type categories for parallel task mode routing */
import { type TokenUsage } from "./message.js"

export enum ParallelTaskType {
    Search = "search",       // Find information, look up code
    Doc = "doc",             // Documentation, explanations
    Commit = "commit",       // Write commit messages, changelogs
    Code = "code",           // Implement features, write code
    Debug = "debug",         // Investigate bugs, trace errors
    General = "general",     // Default / unspecified (inherits from main task)
}

/** Alias for ParallelTaskType — used as a namespace in UI components */
export const Ptt = ParallelTaskType

/** Per-mode LLM configuration override */
export interface ParallelTaskModeConfig {
    /** Which provider profile to use (e.g., "openai", "anthropic", "lmstudio") */
    apiProvider?: string;
    /** Specific model ID within the provider (e.g., "gpt-4o-mini", "claude-haiku") */
    modelId?: string;
    /** Optional temperature override (0.0-2.0) */
    temperature?: number;
    /** Optional max tokens override */
    maxTokens?: number;
    /** Tool auto-approve settings for this task type */
    autoApprove?: Partial<ParallelTaskAutoApprove>;
}

/** Structured tool auto-approve configuration per task type.
 *  Controls which tools a background worker can use without user approval.
 *  Different task types get different defaults to balance cost vs capability. */
export interface ParallelTaskAutoApprove {
    readFiles: boolean;        // Allow reading files without approval
    writeFiles: boolean;       // Allow writing files without approval
    executeCommands: boolean;  // Allow shell commands without approval
    browserActions: boolean;   // Allow browser tools without approval
}

/** Default auto-approve settings per task type.
 *  Search/commit are conservative (read-only or minimal write).
 *  Code/debug are permissive (full tool access like foreground tasks). */
export const DEFAULT_AUTO_APPROVE_PER_TYPE: Record<ParallelTaskType, ParallelTaskAutoApprove> = {
    [ParallelTaskType.Search]: {
        readFiles: true,
        writeFiles: false,     // Search usually doesn't modify files
        executeCommands: false,
        browserActions: false,
    },
    [ParallelTaskType.Doc]: {
        readFiles: true,
        writeFiles: true,      // Doc might need to write documentation
        executeCommands: false,
        browserActions: false,
    },
    [ParallelTaskType.Commit]: {
        readFiles: true,       // Read git diff / files for context
        writeFiles: false,     // Commit usually doesn't modify source files
        executeCommands: true,  // May need git commands (git add, git commit)
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
        writeFiles: false,     // Debug reads logs/files but rarely writes
        executeCommands: true,  // May need to run debug commands / restart services
        browserActions: false,
    },
    [ParallelTaskType.General]: {
        readFiles: true,
        writeFiles: false,     // Conservative default for unspecified types
        executeCommands: false,
        browserActions: false,
    },
};

/** User's parallel task settings — stored as flat fields in globalState */
export interface ParallelTaskSettings {
    enabled: boolean;
    maxConcurrent: number;  // 1-16
    modeMap: Record<ParallelTaskType, ParallelTaskModeConfig | null>;
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
};

/** Extended BGWorkerConfig with mode info and error recovery */
export interface BGWorkerConfig {
    /** Unique identifier — auto-generated if omitted (BGWorkerManager.spawn() creates one) */
    id?: string;
    description: string;
    mode: string;  // Roo Code mode slug (code, debug, architect)
    message: string;
    todos?: string | null;

    /** Task type for mode routing (user-selected or auto-detected) */
    taskType?: ParallelTaskType;

    /** LLM config override from parallel task mode mapping */
    apiProviderOverride?: string;
    modelIdOverride?: string;
    temperatureOverride?: number;
    maxTokensOverride?: number;

    /** Error recovery settings */
    maxRetries?: number;        // default: 0 (no retry)
    retryDelayMs?: number;      // default: 1000, exponential backoff
    timeoutMs?: number;         // default: 1800000 (30 minutes)

    /** Structured tool auto-approve settings.
     *  Resolved from DEFAULT_AUTO_APPROVE_PER_TYPE[taskType] + modeMap.autoApprove override.
     *  If undefined, falls back to defaults for the task type. */
    autoApprove?: Partial<ParallelTaskAutoApprove>;

    /** Maximum tool calls per background task (cost control).
     *  Resolved from DEFAULT_AUTO_APPROVE_PER_TYPE[taskType] if not specified in config.
     *  Worker stops after reaching this limit with a "max_tool_calls_reached" result. */
    maxToolCallsPerTask?: number;

    /** Maximum API cost per background task (in USD).
     *  Worker tracks token usage and stops when estimated cost exceeds this limit.
     *  Useful for preventing runaway costs even with expensive models.
     *  Default: $0.50 for Search/Commit, $1.00 for Doc/General, $2.00 for Code/Debug */
    maxCostPerTask?: number;

    /** Maximum tokens per background task (input + output combined).
     *  Worker stops after reaching this limit with a "max_tokens_reached" result.
     *  More precise than maxToolCalls — prevents token bloat from large tool responses.
     *  Default: Search/Commit: 8000, Doc: 16000, Code/Debug: 32000, General: 16000 */
    maxTokensPerTask?: number;

    /** Context retention level for worker's conversation history.
     *  - "minimal": keep only last 1 message pair (saves tokens, good for Search)
     *  - "moderate": keep last 3 message pairs (default, balances cost vs context)
     *  - "full": keep last 8 message pairs (needed for Debug to see error history) */
    contextRetention?: "minimal" | "moderate" | "full";

    /** Notification preference for worker completion/failure.
     *  - "all": notify on both success and failure (default)
     *  - "errors_only": only notify when worker fails
     *  - "none": silent mode, no notifications */
    notificationMode?: "all" | "errors_only" | "none";

    /** TaskFlowAgent workflow ID — set when this worker is spawned for a workflow node.
     *  Used to link heartbeats back to their parent workflow DAG. */
    workflowId?: string;

    priority?: number;
}

/** Default cost/token limits per task type (v4.0 adjusted) */
export const DEFAULT_COST_LIMITS_PER_TYPE: Record<ParallelTaskType, { maxCostPerTask: number; maxTokensPerTask: number }> = {
    [ParallelTaskType.Search]: { maxCostPerTask: 2.00, maxTokensPerTask: 16000 },
    [ParallelTaskType.Doc]: { maxCostPerTask: 3.00, maxTokensPerTask: 32000 },
    [ParallelTaskType.Commit]: { maxCostPerTask: 1.00, maxTokensPerTask: 16000 },
    [ParallelTaskType.Code]: { maxCostPerTask: 5.00, maxTokensPerTask: 64000 },
    [ParallelTaskType.Debug]: { maxCostPerTask: 5.00, maxTokensPerTask: 64000 },
    [ParallelTaskType.General]: { maxCostPerTask: 3.00, maxTokensPerTask: 32000 },
};

/** Lightweight shared state between parallel workers — managed by BGWorkerManager */
export interface SharedWorkerContext {
    /** List of all active worker IDs and their task types (updated on spawn/cancel) */
    activeWorkers: Map<string, { taskId: string; type: ParallelTaskType }>;

    /** Recent file modifications from any worker — used for conflict awareness.
     *  Workers read this before each LLM call to enrich context with other workers' changes. */
    recentFileChanges: Array<{
        workerId: string;
        filePath: string;
        timestamp: number;
    }>;

    /** Maximum entries to keep (prevents unbounded growth, FIFO eviction) */
    maxRecentChanges: number;  // default: 50

    /** Last plan/tasks state shared between workers (if any). Phase 2+ candidate. */
    currentPlan?: string;
    lastPlanUpdaterId?: string;
    lastPlanUpdateTimestamp?: number;
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
    id: string;
    state: BGWorkerState.Completed | BGWorkerState.Failed | BGWorkerState.Cancelled;
    summary?: string;          // Generated by LLM or manual summary
    totalToolCalls: number;
    tokenUsage?: TokenUsage;
    error?: string;            // Error message if failed
    durationMs: number;
    notificationMode?: "all" | "errors_only" | "none";  // For controlling completion notifications
}

/** State update sent to UI via postMessage (throttled to 2s interval) */
export interface BGWorkerStateUpdate {
    type: "bgWorkerState";
    workerId: string;
    state: BGWorkerState;
    description?: string;
    taskType?: ParallelTaskType;
    toolCallCount?: number;
    currentTool?: string;

    /** Aggregate stats for the UI — set by BGWorkerManager when flushing */
    activeWorkers?: number;
    queuedTasks?: number;
}

/** Event types for BGWorkerManager EventEmitter */
export type BGWorkerManagerEvents = {
    workerStarted: [workerId: string];
    workerCompleted: [result: BGWorkerResult];
    workerFailed: [workerId: string, error: string];
    workerStateChanged: [workerId: string, newState: BGWorkerState];
    queueUpdated: [queueLength: number, activeCount: number];
};

/** Queue item — what gets queued when at capacity */
export interface BGQueueItem {
    id: string;
    config: BGWorkerConfig;
    priority: number;
    enqueuedAt: number;
}

/** Default context retention per task type */
export const DEFAULT_CONTEXT_RETENTION_PER_TYPE: Record<ParallelTaskType, "minimal" | "moderate" | "full"> = {
    [ParallelTaskType.Search]: "minimal",   // Search doesn't need history
    [ParallelTaskType.Doc]: "moderate",      // Doc needs some context for writing
    [ParallelTaskType.Commit]: "minimal",    // Commit just needs current diff
    [ParallelTaskType.Code]: "moderate",     // Code needs recent conversation context
    [ParallelTaskType.Debug]: "full",        // Debug needs full error history
    [ParallelTaskType.General]: "moderate",  // Conservative default
};

/** Default notification mode per task type */
export const DEFAULT_NOTIFICATION_MODE_PER_TYPE: Record<ParallelTaskType, "all" | "errors_only"> = {
    [ParallelTaskType.Search]: "errors_only",   // Search is low-priority, only notify on errors
    [ParallelTaskType.Doc]: "errors_only",       // Doc is low-priority
    [ParallelTaskType.Commit]: "errors_only",    // Commit is quick, only notify on errors
    [ParallelTaskType.Code]: "all",              // Code tasks are important, notify on completion
    [ParallelTaskType.Debug]: "all",             // Debug tasks are important, notify on completion
    [ParallelTaskType.General]: "errors_only",   // Conservative default
};

// ─── Shared Heartbeat System (Phase 6a) ──────────────────────────────────────

/** Task type icons for UI rendering */
export const TASK_TYPE_ICONS: Record<ParallelTaskType, string> = {
    [ParallelTaskType.Search]: "🔍",
    [ParallelTaskType.Doc]: "📄",
    [ParallelTaskType.Commit]: "💾",
    [ParallelTaskType.Code]: "⚡",
    [ParallelTaskType.Debug]: "🐛",
    [ParallelTaskType.General]: "⚙️",
};

/** Heartbeat emitted by BGWorker every N seconds — aggregated by BGWorkerManager */
export interface WorkerHeartbeat {
    /** Unique worker identifier */
    workerId: string;
    /** Task description shown in UI */
    taskDescription: string;
    /** Task type for icon + color selection */
    taskType: ParallelTaskType | undefined;
    /** Current BGWorkerState (running/paused/completed/failed) */
    state: BGWorkerState;
    /** Progress percentage 0-100, calculated as toolCallCount / maxToolCallsPerTask × 100 */
    progressPercent: number;
    /** Elapsed time in milliseconds since worker started */
    elapsedMs: number;
    /** Estimated API cost in USD for this worker */
    totalCost: number;
    /** Current action/tool being executed (for "running" state) */
    currentAction?: string;
    /** Total tool calls made so far */
    toolCallCount: number;
    /** Maximum allowed tool calls (from config) */
    maxToolCalls: number;
    /** Timestamp of this heartbeat (epoch ms) */
    timestamp: number;
    /** TaskFlowAgent workflow ID — only present when worker belongs to a workflow DAG. Used by UI to show "Open TaskFlow Agent" button. */
    workflowId?: string;
}

/** Heartbeat settings — stored in ExtensionState, read by BGWorkerManager */
export interface WorkerHeartbeatSettings {
    /** How often workers emit heartbeats (in seconds). Default: 30. Range: 10-60. */
    updateIntervalSeconds: number;
    /** Throttle mode for heartbeat aggregation in UI.
     * - "all": show all active workers' heartbeats (max 8 shown)
     * - "errors_only": only show heartbeats from failed/paused workers
     * - "none": disable heartbeat system entirely */
    mode: "all" | "errors_only" | "none";
}

/** Default heartbeat settings */
export const DEFAULT_HEARTBEAT_SETTINGS: WorkerHeartbeatSettings = {
    updateIntervalSeconds: 30,
    mode: "all",
};

// ─── TaskFlowAgent / Workflow DAG (Phase 7a) ──────────────────────────────────

/** Error policy for a node in the workflow */
export type ErrorPolicy =
    | "continue"           // Continue with downstream nodes regardless of failure
    | "stop_downstream"    // Stop all dependent nodes when this fails
    | "skip_dependents"    // Skip dependents but continue other branches
    | "retry";             // Retry once before failing

/** Default error policies by task type */
export const DEFAULT_ERROR_POLICY_PER_TYPE: Record<ParallelTaskType, ErrorPolicy> = {
    [ParallelTaskType.Search]: "continue",
    [ParallelTaskType.Doc]: "skip_dependents",
    [ParallelTaskType.Code]: "stop_downstream",
    [ParallelTaskType.Debug]: "retry",
    [ParallelTaskType.Commit]: "stop_downstream",
    [ParallelTaskType.General]: "continue",
};

/** Auto-approve mode for a node in the workflow */
export type AutoApproveMode = "auto" | "ask" | "always";

/** Per-node auto-approve override */
export interface NodeAutoApproveOverride {
    /** Which task type to use (overrides node's default) */
    mode?: ParallelTaskType;
    /** Whether to auto-approve tool execution for this node */
    autoApprove: boolean;
}

/** Workflow-level auto-approve configuration */
export interface WorkflowAutoApproveConfig {
    enabled: boolean;
    /** Default task type for auto-approve resolution */
    defaultMode: ParallelTaskType;
    /** Per-node overrides (nodeId → override) */
    perNode?: Record<string, NodeAutoApproveOverride>;
}

/** Default workflow-level auto-approve config */
export const DEFAULT_WORKFLOW_AUTO_APPROVE: WorkflowAutoApproveConfig = {
    enabled: true,
    defaultMode: ParallelTaskType.Code,
};

/** Status of a single DAG node */
export type TaskFlowNodeStatus =
    | "pending"       // Not yet started (deps may or may not be met)
    | "waiting"       // Dependencies not yet satisfied
    | "running"       // Currently executing via BGWorker
    | "completed"     // Successfully finished
    | "failed"        // Execution failed
    | "paused"        // Paused by user
    | "skipped"       // Skipped due to upstream failure (error_policy = skip_dependents)
    | "cancelled";    // Cancelled by user

/** A single node in the workflow DAG */
export interface TaskFlowNode {
    /** Unique node identifier within this workflow (e.g., "A", "B", "step-1") */
    id: string;
    /** Human-readable description of what this node does */
    taskDescription: string;
    /** Task type for mode routing and error policy defaults */
    type: ParallelTaskType;
    /** Node IDs that must complete before this one can start */
    depends_on: string[];
    /** Current execution status */
    status: TaskFlowNodeStatus;
    /** Worker ID assigned to this node (set when running) */
    worker_id?: string;
    /** When the node started executing */
    started_at?: string;
    /** When the node completed/failed/paused */
    completed_at?: string;

    /** Additional prompt instructions for restart/continue actions.
     *  Set by conditional_task tool when user provides extra guidance. */
    additional_prompt?: string;

    /** Source node ID that was split to create this node (for splitNode tracking).
     *  Only set on nodes created via the splitNode action. */
    _split_from?: string;
}

/** Overall workflow status */
export type TaskFlowWorkflowStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

/** Chat log entry for a workflow's conversation history */
export interface TaskFlowChatEntry {
    role: "agent" | "user" | "system";
    message: string;
    timestamp?: number;
}

/** A complete workflow definition — stored as JSON file or in memory */
export interface TaskFlowWorkflow {
    /** Unique workflow identifier (e.g., "wf-001") */
    id: string;
    /** Human-readable name for the workflow */
    name: string;
    /** Main task ID that owns this workflow */
    main_task_id: string;
    /** Current overall status */
    status: TaskFlowWorkflowStatus;
    /** When the workflow was created */
    created_at: string;
    /** Last time the workflow state changed */
    updated_at: string;

    /** Auto-approve configuration for this workflow */
    auto_approve?: WorkflowAutoApproveConfig;

    /** Error policy — default + per-node overrides */
    error_policy: {
        /** Default policy applied to all nodes without override */
        default: ErrorPolicy;
        /** Per-node policy overrides (nodeId → policy) */
        per_node?: Record<string, ErrorPolicy>;
    };

    /** DAG nodes — the actual workflow definition */
    nodes: TaskFlowNode[];

    /** Bidirectional mapping: nodeId ↔ workerId for lifecycle tracking */
    node_state_map: Record<string, string>;

    /** Chat log for user interaction with TaskFlowAgent */
    chat_log?: TaskFlowChatEntry[];
}

/** Result of a DAG topo sort — includes execution order and any cycles detected */
export interface DagSortResult {
    /** Topologically sorted node IDs (ready to execute first) */
    sortedIds: string[];
    /** Nodes that couldn't be sorted due to cycles */
    cycleNodes?: string[];
    /** Error message if cycles were found */
    cycleError?: string;
}

/** Ready queue item — a node whose dependencies are all met and is ready to spawn */
export interface TaskFlowReadyNode {
    nodeId: string;
    node: TaskFlowNode;
    priority?: number;
}

// ─── BGWorkerManager Lifecycle Events for TaskFlowAgent (Phase 7c) ────────────

/** Event types added by TaskFlowAgent integration */
export type TaskFlowLifecycleEvents = {
    /** Emitted when a node completes successfully — includes nodeId mapping */
    nodeComplete: [nodeId: string, result: BGWorkerResult];
    /** Emitted when a node fails — includes nodeId mapping and error */
    nodeFail: [nodeId: string, workerId: string, error: string];
    /** Emitted when a node is paused by user */
    nodePause: [nodeId: string, workerId: string];
    /** Emitted when a node is resumed by user */
    nodeResume: [nodeId: string, workerId: string];
};

/** Combined event types for BGWorkerManager (existing + TaskFlowAgent) */
export type ExtendedBGWorkerManagerEvents = BGWorkerManagerEvents & TaskFlowLifecycleEvents;
