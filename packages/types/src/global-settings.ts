import { z } from "zod"

import { type Keys } from "./type-fu.js"
import {
	type ProviderSettings,
	PROVIDER_SETTINGS_KEYS,
	providerSettingsEntrySchema,
	providerSettingsSchema,
} from "./provider-settings.js"
import { historyItemSchema } from "./history.js"
import { codebaseIndexModelsSchema, codebaseIndexConfigSchema } from "./codebase-index.js"
import { experimentsSchema } from "./experiment.js"
import { telemetrySettingsSchema } from "./telemetry.js"
import { modeConfigSchema } from "./mode.js"
import { customModePromptsSchema, customSupportPromptsSchema } from "./mode.js"
import { toolNamesSchema } from "./tool.js"
import { languagesSchema } from "./vscode.js"

/** Zod schema for WorkerHeartbeatSettings (parallel task heartbeat config) */
export const workerHeartbeatSettingsSchema = z.object({
	updateIntervalSeconds: z.number().int().min(10).max(60).optional(),
	mode: z.enum(["all", "errors_only", "none"]).optional(),
})

export type WorkerHeartbeatSettingsSchema = z.infer<typeof workerHeartbeatSettingsSchema>

/**
 * Default delay in milliseconds after writes to allow diagnostics to detect potential problems.
 * This delay is particularly important for Go and other languages where tools like goimports
 * need time to automatically clean up unused imports.
 */
export const DEFAULT_WRITE_DELAY_MS = 1000

/**
 * Terminal output preview size options for persisted command output.
 *
 * Controls how much command output is kept in memory as a "preview" before
 * the LLM decides to retrieve more via `read_command_output`. Larger previews
 * mean more immediate context but consume more of the context window.
 *
 * - `small`: 5KB preview - Best for long-running commands with verbose output
 * - `medium`: 10KB preview - Balanced default for most use cases
 * - `large`: 20KB preview - Best when commands produce critical info early
 *
 * @see OutputInterceptor - Uses this setting to determine when to spill to disk
 * @see PersistedCommandOutput - Contains the resulting preview and artifact reference
 */
export type TerminalOutputPreviewSize = "small" | "medium" | "large"

/**
 * Byte limits for each terminal output preview size.
 *
 * Maps preview size names to their corresponding byte thresholds.
 * When command output exceeds these thresholds, the excess is persisted
 * to disk and made available via the `read_command_output` tool.
 */
export const TERMINAL_PREVIEW_BYTES: Record<TerminalOutputPreviewSize, number> = {
	small: 5 * 1024, // 5KB
	medium: 10 * 1024, // 10KB
	large: 20 * 1024, // 20KB
}

/**
 * Default terminal output preview size.
 * The "medium" (10KB) setting provides a good balance between immediate
 * visibility and context window conservation for most use cases.
 */
export const DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE: TerminalOutputPreviewSize = "medium"

/**
 * Minimum checkpoint timeout in seconds.
 */
export const MIN_CHECKPOINT_TIMEOUT_SECONDS = 10

/**
 * Maximum checkpoint timeout in seconds.
 */
export const MAX_CHECKPOINT_TIMEOUT_SECONDS = 60

/**
 * Default checkpoint timeout in seconds.
 */
export const DEFAULT_CHECKPOINT_TIMEOUT_SECONDS = 15

/**
 * GlobalSettings
 */

export const globalSettingsSchema = z.object({
	currentApiConfigName: z.string().optional(),
	listApiConfigMeta: z.array(providerSettingsEntrySchema).optional(),
	pinnedApiConfigs: z.record(z.string(), z.boolean()).optional(),

	lastShownAnnouncementId: z.string().optional(),
	customInstructions: z.string().optional(),
	taskHistory: z.array(historyItemSchema).optional(),
	dismissedUpsells: z.array(z.string()).optional(),

	// Image generation settings (experimental) - flattened for simplicity
	imageGenerationProvider: z.enum(["openrouter"]).optional(),
	openRouterImageApiKey: z.string().optional(),
	openRouterImageGenerationSelectedModel: z.string().optional(),

	customCondensingPrompt: z.string().optional(),

	autoApprovalEnabled: z.boolean().optional(),
	alwaysAllowReadOnly: z.boolean().optional(),
	alwaysAllowReadOnlyOutsideWorkspace: z.boolean().optional(),
	alwaysAllowWrite: z.boolean().optional(),
	alwaysAllowWriteOutsideWorkspace: z.boolean().optional(),
	alwaysAllowWriteProtected: z.boolean().optional(),
	writeDelayMs: z.number().min(0).optional(),
	requestDelaySeconds: z.number().optional(),
	alwaysAllowMcp: z.boolean().optional(),
	alwaysAllowModeSwitch: z.boolean().optional(),
	alwaysAllowSubtasks: z.boolean().optional(),
	alwaysAllowExecute: z.boolean().optional(),
	alwaysAllowFollowupQuestions: z.boolean().optional(),
	followupAutoApproveTimeoutMs: z.number().optional(),
	allowedCommands: z.array(z.string()).optional(),
	deniedCommands: z.array(z.string()).optional(),
	commandExecutionTimeout: z.number().optional(),
	commandTimeoutAllowlist: z.array(z.string()).optional(),
	preventCompletionWithOpenTodos: z.boolean().optional(),
	allowedMaxRequests: z.number().nullish(),
	allowedMaxCost: z.number().nullish(),
	autoCondenseContext: z.boolean().optional(),
	autoCondenseContextPercent: z.number().optional(),

	/**
	 * Whether to include current time in the environment details
	 * @default true
	 */
	includeCurrentTime: z.boolean().optional(),
	/**
	 * Whether to include current cost in the environment details
	 * @default true
	 */
	includeCurrentCost: z.boolean().optional(),
	/**
	 * Maximum number of git status file entries to include in the environment details.
	 * Set to 0 to disable git status. The header (branch, commits) is always included when > 0.
	 * @default 0
	 */
	maxGitStatusFiles: z.number().optional(),

	/**
	 * Whether to include diagnostic messages (errors, warnings) in tool outputs
	 * @default true
	 */
	includeDiagnosticMessages: z.boolean().optional(),
	/**
	 * Maximum number of diagnostic messages to include in tool outputs
	 * @default 50
	 */
	maxDiagnosticMessages: z.number().optional(),

	enableCheckpoints: z.boolean().optional(),
	checkpointTimeout: z
		.number()
		.int()
		.min(MIN_CHECKPOINT_TIMEOUT_SECONDS)
		.max(MAX_CHECKPOINT_TIMEOUT_SECONDS)
		.optional(),

	ttsEnabled: z.boolean().optional(),
	ttsSpeed: z.number().optional(),
	soundEnabled: z.boolean().optional(),
	soundVolume: z.number().optional(),

	maxOpenTabsContext: z.number().optional(),
	maxWorkspaceFiles: z.number().optional(),
	showRooIgnoredFiles: z.boolean().optional(),
	enableSubfolderRules: z.boolean().optional(),
	maxImageFileSize: z.number().optional(),
	maxTotalImageSize: z.number().optional(),

	terminalOutputPreviewSize: z.enum(["small", "medium", "large"]).optional(),
	terminalShellIntegrationTimeout: z.number().optional(),
	terminalShellIntegrationDisabled: z.boolean().optional(),
	terminalCommandDelay: z.number().optional(),
	terminalPowershellCounter: z.boolean().optional(),
	terminalZshClearEolMark: z.boolean().optional(),
	terminalZshOhMy: z.boolean().optional(),
	terminalZshP10k: z.boolean().optional(),
	terminalZdotdir: z.boolean().optional(),
	execaShellPath: z.string().optional(),

	diagnosticsEnabled: z.boolean().optional(),

	rateLimitSeconds: z.number().optional(),
	experiments: experimentsSchema.optional(),

	codebaseIndexModels: codebaseIndexModelsSchema.optional(),
	codebaseIndexConfig: codebaseIndexConfigSchema.optional(),

	language: languagesSchema.optional(),

	telemetrySetting: telemetrySettingsSchema.optional(),

	mcpEnabled: z.boolean().optional(),

	mode: z.string().optional(),
	modeApiConfigs: z.record(z.string(), z.string()).optional(),
	customModes: z.array(modeConfigSchema).optional(),
	customModePrompts: customModePromptsSchema.optional(),
	customSupportPrompts: customSupportPromptsSchema.optional(),
	enhancementApiConfigId: z.string().optional(),
	includeTaskHistoryInEnhance: z.boolean().optional(),
	historyPreviewCollapsed: z.boolean().optional(),
	reasoningBlockCollapsed: z.boolean().optional(),
	/**
	 * Font size (in pixels) for the Zoo Code chat/webview UI.
	 * When unset (or `null`), the webview inherits VS Code's `--vscode-font-size`.
	 */
	chatFontSize: z.number().int().min(8).max(32).nullish(),
	/**
	 * Controls the keyboard behavior for sending messages in the chat input.
	 * - "send": Enter sends message, Shift+Enter creates newline (default)
	 * - "newline": Enter creates newline, Shift+Enter/Ctrl+Enter sends message
	 * @default "send"
	 */
	enterBehavior: z.enum(["send", "newline"]).optional(),
	profileThresholds: z.record(z.string(), z.number()).optional(),
	hasOpenedModeSelector: z.boolean().optional(),
	lastModeExportPath: z.string().optional(),
	lastModeImportPath: z.string().optional(),
	lastSettingsExportPath: z.string().optional(),
	lastTaskExportPath: z.string().optional(),
	lastImageSavePath: z.string().optional(),

	/**
	 * Path to worktree to auto-open after switching workspaces.
	 * Used by the worktree feature to open the Roo Code sidebar in a new window.
	 */
	worktreeAutoOpenPath: z.string().optional(),
	/**
	 * Whether to show the worktree selector in the home screen.
	 * @default true
	 */
	showWorktreesInHomeScreen: z.boolean().optional(),

	/**
	 * List of native tool names to globally disable.
	 * Tools in this list will be excluded from prompt generation and rejected at execution time.
	 */
	disabledTools: z.array(toolNamesSchema).optional(),

	// ── Parallel Task Settings (flat fields for globalState serialization) ──

	/** Whether parallel task mode is enabled */
	parallelTaskEnabled: z.boolean().optional(),
	/** Maximum concurrent background workers (1-16) */
	parallelTaskMaxConcurrent: z.number().int().min(1).max(16).optional(),

	// Task type → model mappings (flat format)
	parallelTaskModeSearchProvider: z.string().optional(),
	parallelTaskModeSearchModelId: z.string().optional(),
	parallelTaskModeDocProvider: z.string().optional(),
	parallelTaskModeDocModelId: z.string().optional(),
	parallelTaskModeCommitProvider: z.string().optional(),
	parallelTaskModeCommitModelId: z.string().optional(),

	// Code/Debug can also override provider+model (v5 fix — was missing, users couldn't customize these)
	parallelTaskModeCodeProvider: z.string().optional(),
	parallelTaskModeCodeModelId: z.string().optional(),
	parallelTaskModeDebugProvider: z.string().optional(),
	parallelTaskModeDebugModelId: z.string().optional(),

	// Auto-approve settings per task type (flat format)
	parallelTaskAutoApproveSearchReadFiles: z.boolean().optional(),
	parallelTaskAutoApproveSearchWriteFiles: z.boolean().optional(),
	parallelTaskAutoApproveSearchExecuteCommands: z.boolean().optional(),
	parallelTaskAutoApproveSearchBrowserActions: z.boolean().optional(),

	parallelTaskAutoApproveDocReadFiles: z.boolean().optional(),
	parallelTaskAutoApproveDocWriteFiles: z.boolean().optional(),
	parallelTaskAutoApproveDocExecuteCommands: z.boolean().optional(),
	parallelTaskAutoApproveDocBrowserActions: z.boolean().optional(),

	parallelTaskAutoApproveCommitReadFiles: z.boolean().optional(),
	parallelTaskAutoApproveCommitWriteFiles: z.boolean().optional(),
	parallelTaskAutoApproveCommitExecuteCommands: z.boolean().optional(),
	parallelTaskAutoApproveCommitBrowserActions: z.boolean().optional(),

	// Max tool calls per task type (flat format)
	parallelTaskMaxToolCallsSearch: z.number().int().positive().optional(),
	parallelTaskMaxToolCallsDoc: z.number().int().positive().optional(),
	parallelTaskMaxToolCallsCommit: z.number().int().positive().optional(),

	// Cost limits per task type (flat format, USD)
	parallelTaskMaxCostSearch: z.number().nonnegative().optional(),
	parallelTaskMaxCostDoc: z.number().nonnegative().optional(),
	parallelTaskMaxCostCommit: z.number().nonnegative().optional(),

	// Token limits per task type
	parallelTaskMaxTokensSearch: z.number().int().positive().optional(),
	parallelTaskMaxTokensDoc: z.number().int().positive().optional(),
	parallelTaskMaxTokensCommit: z.number().int().positive().optional(),

	// Context retention per task type (stored as strings: "minimal" | "moderate" | "full")
	parallelTaskContextRetentionSearch: z.enum(["minimal", "moderate", "full"]).optional(),
	parallelTaskContextRetentionDoc: z.enum(["minimal", "moderate", "full"]).optional(),
	parallelTaskContextRetentionCommit: z.enum(["minimal", "moderate", "full"]).optional(),

	// Notification mode per task type (stored as strings: "all" | "errors_only" | "none")
	parallelTaskNotificationModeSearch: z.enum(["all", "errors_only", "none"]).optional(),
	parallelTaskNotificationModeDoc: z.enum(["all", "errors_only", "none"]).optional(),
	parallelTaskNotificationModeCommit: z.enum(["all", "errors_only", "none"]).optional(),

	/** Default task type for new tasks when parallel mode is enabled ("main" | "search" | "doc" | "commit") */
	parallelTaskDefaultMode: z.enum(["main", "search", "doc", "commit"]).optional(),

	// ── TaskFlow DAG Visualization (Phase 7j) ──

	/** DAG visualization level for TaskFlowPanel — controls how workflows are rendered in the UI */
	parallelTaskDagVisualizationLevel: z.enum(["simple", "graph", "interactive"]).optional(),

	// ── Heartbeat Settings (Phase 6b) ──

	/** Worker heartbeat configuration — controls how often workers emit heartbeats and what gets shown in UI */
	workerHeartbeatSettings: workerHeartbeatSettingsSchema.optional(),
})

export type GlobalSettings = z.infer<typeof globalSettingsSchema>

export const GLOBAL_SETTINGS_KEYS = globalSettingsSchema.keyof().options

/**
 * RooCodeSettings
 */

export const rooCodeSettingsSchema = providerSettingsSchema.merge(globalSettingsSchema)

export type RooCodeSettings = GlobalSettings & ProviderSettings

/**
 * SecretState
 */
export const SECRET_STATE_KEYS = [
	"apiKey",
	"openRouterApiKey",
	"awsAccessKey",
	"awsApiKey",
	"awsSecretKey",
	"awsSessionToken",
	"openAiApiKey",
	"ollamaApiKey",
	"geminiApiKey",
	"openAiNativeApiKey",
	"deepSeekApiKey",
	"moonshotApiKey",
	"mistralApiKey",
	"minimaxApiKey",
	"requestyApiKey",
	"unboundApiKey",
	"xaiApiKey",
	"litellmApiKey",
	"codeIndexOpenAiKey",
	"codeIndexQdrantApiKey",
	"codebaseIndexOpenAiCompatibleApiKey",
	"codebaseIndexGeminiApiKey",
	"codebaseIndexMistralApiKey",
	"codebaseIndexVercelAiGatewayApiKey",
	"codebaseIndexOpenRouterApiKey",
	"sambaNovaApiKey",
	"zaiApiKey",
	"fireworksApiKey",
	"vercelAiGatewayApiKey",
	"opencodeGoApiKey",
	"basetenApiKey",
] as const

// Global secrets that are part of GlobalSettings (not ProviderSettings)
export const GLOBAL_SECRET_KEYS = [
	"openRouterImageApiKey", // For image generation
] as const

// Type for the actual secret storage keys
type ProviderSecretKey = (typeof SECRET_STATE_KEYS)[number]
type GlobalSecretKey = (typeof GLOBAL_SECRET_KEYS)[number]

// Type representing all secrets that can be stored
export type SecretState = Pick<ProviderSettings, Extract<ProviderSecretKey, keyof ProviderSettings>> & {
	[K in GlobalSecretKey]?: string
}

export const isSecretStateKey = (key: string): key is Keys<SecretState> =>
	SECRET_STATE_KEYS.includes(key as ProviderSecretKey) || GLOBAL_SECRET_KEYS.includes(key as GlobalSecretKey)

/**
 * GlobalState
 */

export type GlobalState = Omit<RooCodeSettings, Keys<SecretState>>

export const GLOBAL_STATE_KEYS = [...GLOBAL_SETTINGS_KEYS, ...PROVIDER_SETTINGS_KEYS].filter(
	(key: Keys<RooCodeSettings>) => !isSecretStateKey(key),
) as Keys<GlobalState>[]

export const isGlobalStateKey = (key: string): key is Keys<GlobalState> =>
	GLOBAL_STATE_KEYS.includes(key as Keys<GlobalState>)
