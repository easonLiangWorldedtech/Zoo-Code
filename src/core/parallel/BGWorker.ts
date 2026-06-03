import EventEmitter from "events"
import * as vscode from "vscode"
import { serializeError } from "serialize-error"

import type { ClineProvider } from "../webview/ClineProvider"
import type { ApiHandler, ProviderSettings } from "../../api"
import { buildApiHandler } from "../../api"
import type { ToolUse, ToolResponse, McpToolUse } from "../../shared/tools"
import type { ToolName } from "@roo-code/types"
import type { TokenUsage } from "@roo-code/types"

import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import { formatResponse } from "../prompts/responses"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../shared/cost"
import { getApiProtocol, getModelId, isRetiredProvider } from "@roo-code/types"

import type {
	BGQueueItem,
	BGWorkerConfig,
	BGWorkerResult,
	BGWorkerState,
	BGWorkerStateUpdate,
	ParallelTaskType,
	SharedWorkerContext,
} from "@roo-code/types"
import {
	BGWorkerState as BgWorkerStateEnum,
	DEFAULT_AUTO_APPROVE_PER_TYPE,
	DEFAULT_COST_LIMITS_PER_TYPE,
	DEFAULT_CONTEXT_RETENTION_PER_TYPE,
	DEFAULT_NOTIFICATION_MODE_PER_TYPE,
	ParallelTaskType as Ptt,
} from "@roo-code/types"

import { BGWorkerSkillLoader } from "./BGWorkerSkillLoader"

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum iterations before idle detection triggers (prevents premature completion) */
const MIN_ITERATIONS_BEFORE_IDLE = 3

/** Default timeout for background workers: 30 minutes */
const DEFAULT_TIMEOUT_MS = 1800000

/** Default retry delay base: 1 second with exponential backoff */
const DEFAULT_RETRY_DELAY_MS = 1000

/** Maximum retries if not specified in config */
const DEFAULT_MAX_RETRIES = 0

/** Max tool calls per background task — used as secondary safety net against infinite loops */
const DEFAULT_MAX_TOOL_CALLS_PER_TASK = 50

/** Default cost limit ($3.00) — conservative for unspecified types */
const DEFAULT_COST_LIMIT = 3.0

/** Default token limit (16K) — conservative default */
const DEFAULT_TOKEN_LIMIT = 16000

/** Maximum tool calls before forced completion */
const MAX_TOOL_CALLS_BEFORE_FORCED_COMPLETE = 200

/** System prompt for background workers */
function buildSystemPrompt(config: BGWorkerConfig, skillInstructions: string): string {
	const taskTypeLabel = config.taskType ? ` (${config.taskType})` : ""
	return [
		`You are a background worker executing tasks autonomously. Work efficiently and complete the assigned task.`,
		"",
		skillInstructions,
		"",
		`## Task Type: ${config.taskType ?? "general"}${taskTypeLabel}`,
		"",
		`## Instructions`,
		`- You have been assigned the following task: "${config.description}"`,
		`- Message: ${config.message || "(none)"}`,
		config.todos ? `- Todos: ${config.todos}` : "",
		"",
		`## Important Rules`,
		"- You are part of a parallel team — be aware that other workers may be modifying files simultaneously.",
		"- Check for file conflicts before writing. If a write fails due to concurrent modification, read the latest version and retry.",
		"- Use efficient tool calls — batch reads when possible, avoid redundant operations.",
		"- When done with your task, use `attempt_completion` to report results.",
		"",
		`## Auto-Approve Settings`,
		`- Read files: ${config.autoApprove?.readFiles ?? true}`,
		`- Write files: ${config.autoApprove?.writeFiles ?? false}`,
		`- Execute commands: ${config.autoApprove?.executeCommands ?? false}`,
		`- Browser actions: ${config.autoApprove?.browserActions ?? false}`,
		"",
		`## Cost Limits`,
		`- Max tool calls: ${config.maxToolCallsPerTask ?? DEFAULT_MAX_TOOL_CALLS_PER_TASK}`,
		`- Max cost: $${(config.maxCostPerTask ?? DEFAULT_COST_LIMIT).toFixed(2)}`,
		`- Max tokens: ${config.maxTokensPerTask ?? DEFAULT_TOKEN_LIMIT}`,
	].join("\n")
}

/** Build the background worker API configuration from mode overrides */
function buildApiConfig(config: BGWorkerConfig): ProviderSettings {
	const provider = config.apiProviderOverride
	const modelId = config.modelIdOverride
	const temperature = config.temperatureOverride
	const maxTokens = config.maxTokensOverride

	// Determine which provider-specific fields to include based on the API protocol
	if (provider === "openai" || provider === "openai-codex" || provider === "openai-native") {
		return {
			apiProvider: provider,
			openAiModelId: modelId,
			openAiApiKey: "", // Will be filled from provider's active profile
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "anthropic" || provider === "bedrock" || provider === "vertex") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "openrouter") {
		return {
			apiProvider: provider,
			openRouterModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "gemini") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "ollama") {
		return {
			apiProvider: provider,
			ollamaModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "lmstudio") {
		return {
			apiProvider: provider,
			lmStudioModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "vscode-lm") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "deepseek") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "qwen-code") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "mistral") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "requesty") {
		return {
			apiProvider: provider,
			requestyModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "litellm") {
		return {
			apiProvider: provider,
			litellmModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "unbound") {
		return {
			apiProvider: provider,
			unboundModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "fake-ai") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "xai") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "moonshot") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "sambanova") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "mimo") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "zai") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "fireworks") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "vercel-ai-gateway") {
		return {
			apiProvider: provider,
			vercelAiGatewayModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "opencode-go") {
		return {
			apiProvider: provider,
			opencodeGoModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "minimax") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	if (provider === "baseten") {
		return {
			apiProvider: provider,
			apiModelId: modelId,
			...(temperature !== undefined && { modelTemperature: temperature }),
			...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
		} as ProviderSettings
	}

	// Default to anthropic if no specific provider override matched
	return {
		apiProvider: "anthropic",
		apiModelId: modelId,
		...(temperature !== undefined && { modelTemperature: temperature }),
		...(maxTokens !== undefined && { modelMaxTokens: maxTokens }),
	} as ProviderSettings
}

/** Enrich context with other workers' file changes */
function enrichWithContext(sharedContext: SharedWorkerContext): string | null {
	const activeWorkers = sharedContext.activeWorkers
	const recentChanges = sharedContext.recentFileChanges

	if (activeWorkers.size <= 1 && recentChanges.length === 0) {
		return null // No other workers, no context to enrich
	}

	let enrichment = ""

	// List active workers
	if (activeWorkers.size > 1) {
		const workerList = Array.from(activeWorkers.entries())
			.filter(([id]) => id !== "self") // Exclude self
			.map(([id, info]) => `  - Worker ${id}: ${info.type} (${info.taskId})`)
			.join("\n")

		enrichment += `\n## Active Parallel Workers\n${workerList}\n`
	}

	// List recent file changes from other workers
	if (recentChanges.length > 0) {
		const maxRecent = Math.min(recentChanges.length, 5) // Limit to 5 most recent
		const recentEntries = recentChanges.slice(-maxRecent)

		enrichment += `\n## Recent File Changes by Other Workers\n`
		for (const entry of recentEntries) {
			const timeAgo = Math.floor((Date.now() - entry.timestamp) / 1000)
			if (timeAgo < 60) {
				enrichment += `  - ${entry.workerId}: ${entry.filePath} (${timeAgo}s ago)\n`
			} else {
				const mins = Math.floor(timeAgo / 60)
				enrichment += `  - ${entry.workerId}: ${entry.filePath} (${mins}m ago)\n`
			}
		}

		if (recentChanges.length > maxRecent) {
			enrichment += `  ... and ${recentChanges.length - maxRecent} more recent changes\n`
		}
	}

	return enrichment || null
}

/** Record a file change in the shared context */
function recordFileChange(sharedContext: SharedWorkerContext, workerId: string, filePath: string): void {
	sharedContext.recentFileChanges.push({
		workerId,
		filePath,
		timestamp: Date.now(),
	})

	// Enforce maxRecentChanges (FIFO eviction)
	const max = sharedContext.maxRecentChanges || 50
	if (sharedContext.recentFileChanges.length > max) {
		sharedContext.recentFileChanges.splice(0, sharedContext.recentFileChanges.length - max)
	}
}

/** Estimate token count from content using rough approximation */
function estimateTokens(content: string): number {
	return Math.ceil(content.length / 4) // Rough approximation: ~4 chars per token
}

/** Calculate cost from token usage and model info */
function calculateCost(
	inputTokens: number,
	outputTokens: number,
	cacheWriteTokens: number,
	cacheReadTokens: number,
	apiProvider: string | undefined,
	modelId: string | undefined,
): number {
	// Use the same cost calculation as Task.ts for consistency
	const protocol = getApiProtocol(apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined, modelId)

	if (protocol === "anthropic") {
		return calculateApiCostAnthropic(
			{
				inputTokenRate: 0.015,
				outputTokenRate: 0.075,
				cacheWriteTokenRate: 0.001875,
				cacheReadTokenRate: 0.000375,
			},
			inputTokens,
			outputTokens,
			cacheWriteTokens,
			cacheReadTokens,
		).totalCost
	}

	// OpenAI-style pricing (rough estimate)
	const inputRate = modelId?.includes("4o-mini") ? 0.00015 : 0.00001 // Default to cheaper rate
	const outputRate = modelId?.includes("4o-mini") ? 0.0006 : 0.00003

	return inputTokens * inputRate + outputTokens * outputRate
}

// ─── BGWorker Events ──────────────────────────────────────────────────────────

export type BGWorkerEvents = {
	stateUpdate: [update: BGWorkerStateUpdate]
	completed: [result: BGWorkerResult]
	failed: [error: string]
}

/**
 * Lightweight background worker executor.
 *
 * Each BGWorker has its own API handler (with potentially different model/provider),
 * maintains its own conversation history, and executes tools through ClineProvider's
 * infrastructure. Workers are independent — they don't share state beyond the
 * SharedWorkerContext for cross-worker awareness.
 */
export class BGWorker extends EventEmitter<BGWorkerEvents> {
	private provider: ClineProvider
	private config: BGWorkerConfig
	private sharedContext: SharedWorkerContext

	/** Worker's own API handler (may differ from main task) */
	private apiHandler?: ApiHandler

	/** Conversation history — separate from main task */
	private messages: Array<{ role: "user" | "assistant"; content: any[] }> = []

	/** Current state of the worker */
	private _state: BGWorkerState = BgWorkerStateEnum.Queued

	/** Whether the worker is currently processing (prevents concurrent pause/resume) */
	private isProcessing = false

	/** Total tool calls made by this worker */
	private totalToolCalls = 0

	/** Token usage tracking for cost limits */
	private totalInputTokens = 0
	private totalOutputTokens = 0
	private totalCacheWriteTokens = 0
	private totalCacheReadTokens = 0
	private totalCost = 0

	/** Start time for duration calculation */
	private startTime = Date.now()

	/** Skill instructions loaded from BGWorkerSkillLoader */
	private skillInstructions = ""

	/** System prompt (built once at startup) */
	private systemPrompt = ""

	/** Pending state updates to flush (throttled by manager's 2s interval) */
	private pendingStateUpdate?: BGWorkerStateUpdate

	/** Abort signal for current API request */
	private abortController?: AbortController

	constructor(provider: ClineProvider, config: BGWorkerConfig, sharedContext: SharedWorkerContext) {
		super()
		this.provider = provider
		this.config = config
		this.sharedContext = sharedContext
	}

	/** Get current state */
	getState(): BGWorkerState {
		return this._state
	}

	/** Get worker ID from config */
	getId(): string {
		return this.config.id ?? "unknown"
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────

	/**
	 * Start the worker: build API handler, load skills, begin execution.
	 */
	async start(): Promise<void> {
		if (this._state !== BgWorkerStateEnum.Queued) {
			return // Already started or not in queued state
		}

		this._state = BgWorkerStateEnum.Running
		this.startTime = Date.now()

		// Build API handler with mode override config
		const apiConfig = buildApiConfig(this.config)
		try {
			this.apiHandler = buildApiHandler(apiConfig)
		} catch (error) {
			console.error(`[BGWorker] Failed to build API handler:`, error)
			this._state = BgWorkerStateEnum.Failed
			this.emit("failed", `Failed to initialize API handler: ${error}`)
			return
		}

		// Load skill instructions (non-blocking, runs in parallel)
		const skillLoader = new BGWorkerSkillLoader((this.provider as any).skillsManager)
		this.skillInstructions = await skillLoader.load(this.config.taskType, this.config.mode)

		// Build system prompt with skill instructions
		this.systemPrompt = buildSystemPrompt(this.config, this.skillInstructions)

		// Add initial user message to conversation history
		const initialContent: any[] = [
			{ type: "text", text: `Task: ${this.config.description}\n\n${this.config.message || ""}` },
		]

		if (this.config.todos) {
			initialContent.push({
				type: "text",
				text: `\n\nTodos:\n${this.config.todos}`,
			})
		}

		this.messages.push({ role: "user", content: initialContent })

		// Emit state update
		const stateUpdate: BGWorkerStateUpdate = {
			type: "bgWorkerState",
			workerId: this.getId(),
			state: BgWorkerStateEnum.Running,
			description: this.config.description,
			taskType: this.config.taskType,
		}
		this.emit("stateUpdate", stateUpdate)

		// Begin execution loop
		await this.executeWithRetry()
	}

	/**
	 * Execute with retry logic (exponential backoff).
	 */
	async executeWithRetry(): Promise<void> {
		const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES
		let attempt = 0
		const maxAttempts = 1 + maxRetries

		while (attempt < maxAttempts && this._state === BgWorkerStateEnum.Running) {
			try {
				await this.executeWithMinimalContext()
				return // Success, exit loop
			} catch (error) {
				attempt++

				if (this._state !== BgWorkerStateEnum.Running) {
					// Worker was cancelled/paused during retry delay
					return
				}

				if (attempt >= maxAttempts) {
					throw error
				}

				const baseDelay = this.config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
				const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 60000) // Cap at 60s

				await new Promise((resolve) => setTimeout(resolve, delay))

				if (this._state === BgWorkerStateEnum.Running) {
					// Retry: reset context and try again
					await this.resetContext()
				}
			}
		}
	}

	/**
	 * Main execution loop — the core of BGWorker.
	 *
	 * Repeatedly calls the API, parses tool calls, executes them, and adds results
	 * back to conversation history until:
	 * - attempt_completion is called (task done)
	 * - maxToolCallsPerTask reached
	 * - maxCostPerTask exceeded
	 * - maxTokensPerTask exceeded
	 * - idle detection triggers (0 tool calls for MIN_ITERATIONS_BEFORE_IDLE iterations)
	 * - worker is cancelled/paused
	 */
	async executeWithMinimalContext(): Promise<void> {
		let iteration = 0
		let consecutiveEmptyCount = 0

		while (this._state === BgWorkerStateEnum.Running && !this.isProcessing) {
			this.isProcessing = true

			try {
				// Check cost limits before each API call
				if (this.totalCost > (this.config.maxCostPerTask ?? DEFAULT_COST_LIMIT)) {
					console.log(
						`[BGWorker] Cost limit reached ($${this.totalCost.toFixed(2)} / $${(this.config.maxCostPerTask ?? DEFAULT_COST_LIMIT).toFixed(2)})`,
					)
					await this.attemptCompletion(
						"max_cost_reached",
						`Cost limit reached: $${this.totalCost.toFixed(2)} of $${(this.config.maxCostPerTask ?? DEFAULT_COST_LIMIT).toFixed(2)}`,
					)
					return
				}

				// Check token limits before each API call
				const totalTokens = this.totalInputTokens + this.totalOutputTokens
				if (totalTokens > (this.config.maxTokensPerTask ?? DEFAULT_TOKEN_LIMIT)) {
					console.log(
						`[BGWorker] Token limit reached (${totalTokens} / ${this.config.maxTokensPerTask ?? DEFAULT_TOKEN_LIMIT})`,
					)
					await this.attemptCompletion(
						"max_tokens_reached",
						`Token limit reached: ${totalTokens} of ${this.config.maxTokensPerTask ?? DEFAULT_TOKEN_LIMIT}`,
					)
					return
				}

				// Check tool call limits before each API call
				if (this.totalToolCalls >= (this.config.maxToolCallsPerTask ?? DEFAULT_MAX_TOOL_CALLS_PER_TASK)) {
					console.log(
						`[BGWorker] Tool call limit reached (${this.totalToolCalls} / ${this.config.maxToolCallsPerTask ?? DEFAULT_MAX_TOOL_CALLS_PER_TASK})`,
					)
					await this.attemptCompletion(
						"max_tool_calls_reached",
						`Tool call limit reached: ${this.totalToolCalls} of ${this.config.maxToolCallsPerTask ?? DEFAULT_MAX_TOOL_CALLS_PER_TASK}`,
					)
					return
				}

				// Check for forced completion after many tool calls (safety net)
				if (this.totalToolCalls >= MAX_TOOL_CALLS_BEFORE_FORCED_COMPLETE) {
					console.log(`[BGWorker] Forced completion at ${this.totalToolCalls} tool calls`)
					await this.attemptCompletion(
						"max_tool_calls_forced",
						`Forced completion after ${this.totalToolCalls} tool calls`,
					)
					return
				}

				iteration++

				// Build system prompt with context enrichment
				let fullSystemPrompt = this.systemPrompt

				const enrichedContext = enrichWithContext(this.sharedContext)
				if (enrichedContext) {
					fullSystemPrompt += `\n\n${enrichedContext}`
				}

				// Apply context retention — truncate conversation history based on setting
				const retentionLevel =
					this.config.contextRetention ??
					DEFAULT_CONTEXT_RETENTION_PER_TYPE[this.config.taskType ?? Ptt.General]
				const maxHistoryPairs = retentionLevel === "minimal" ? 1 : retentionLevel === "full" ? 8 : 3
				let truncatedMessages = this.messages

				if (this.messages.length > maxHistoryPairs * 2) {
					// Keep only the last N message pairs + initial task message
					const keepFromIndex = Math.max(0, this.messages.length - maxHistoryPairs * 2)
					truncatedMessages = [this.messages[0], ...this.messages.slice(keepFromIndex)]
				}

				// Make API request
				const stream = await this.makeApiRequest(fullSystemPrompt, truncatedMessages)

				if (!stream) {
					throw new Error("API returned no stream")
				}

				// Parse the stream for tool calls and text
				let assistantText = ""
				let inputTokens = 0
				let outputTokens = 0
				let cacheWriteTokens = 0
				let cacheReadTokens = 0
				let requestCost: number | undefined

				const toolUses: ToolUse[] = []

				// Process stream chunks
				for await (const chunk of stream) {
					if (this._state !== BgWorkerStateEnum.Running || this.abortController?.signal.aborted) {
						break
					}

					switch (chunk.type) {
						case "usage":
							inputTokens += chunk.inputTokens
							outputTokens += chunk.outputTokens
							cacheWriteTokens += chunk.cacheWriteTokens ?? 0
							cacheReadTokens += chunk.cacheReadTokens ?? 0
							requestCost = chunk.totalCost
							break

						case "tool_call_partial": {
							const events = NativeToolCallParser.processRawChunk({
								index: chunk.index,
								id: chunk.id,
								name: chunk.name,
								arguments: chunk.arguments,
							})

							for (const event of events) {
								if (event.type === "tool_call_start") {
									NativeToolCallParser.startStreamingToolCall(event.id, event.name as ToolName)
								} else if (event.type === "tool_call_delta" && event.delta !== undefined) {
									NativeToolCallParser.processStreamingChunk(event.id, event.delta)
								} else if (event.type === "tool_call_end") {
									const final = NativeToolCallParser.finalizeStreamingToolCall(event.id)
									if (final) {
										toolUses.push(final)
									}
								}
							}
							break
						}

						case "tool_call": {
							// Legacy complete tool call
							const toolUse = NativeToolCallParser.parseToolCall({
								id: chunk.id,
								name: chunk.name as ToolName,
								arguments: chunk.arguments,
							})
							if (toolUse) {
								toolUses.push(toolUse)
							}
							break
						}

						case "text":
							assistantText += chunk.text
							break
					}
				}

				// Update token/cost tracking
				this.totalInputTokens += inputTokens
				this.totalOutputTokens += outputTokens
				this.totalCacheWriteTokens += cacheWriteTokens
				this.totalCacheReadTokens += cacheReadTokens
				if (requestCost !== undefined) {
					this.totalCost = requestCost
				} else {
					// Estimate cost from token usage
					const apiProvider = this.config.apiProviderOverride
					const modelId = this.config.modelIdOverride
					this.totalCost += calculateCost(
						inputTokens,
						outputTokens,
						cacheWriteTokens,
						cacheReadTokens,
						apiProvider,
						modelId,
					)
				}

				// Add assistant message to history
				if (assistantText || toolUses.length > 0) {
					const assistantContent: any[] = []
					if (assistantText) {
						assistantContent.push({ type: "text", content: assistantText })
					}
					for (const tu of toolUses) {
						assistantContent.push(tu)
					}
					this.messages.push({ role: "assistant", content: assistantContent })

					// Update state with current progress
					const update: BGWorkerStateUpdate = {
						type: "bgWorkerState",
						workerId: this.getId(),
						state: BgWorkerStateEnum.Running,
						description: this.config.description,
						taskType: this.config.taskType,
						toolCallCount: this.totalToolCalls + toolUses.length,
					}
					this.emit("stateUpdate", update)
				}

				// Execute tools if any were found
				if (toolUses.length > 0) {
					const results = await this.executeTools(toolUses)

					// Add tool results to conversation history
					for (const result of results) {
						this.messages.push({ role: "user", content: [result] })
					}

					consecutiveEmptyCount = 0
				} else if (assistantText && assistantText.trim()) {
					// Assistant produced text but no tool calls — still counts as progress
					consecutiveEmptyCount = 0
				} else {
					// No tools, no text — count toward idle detection
					consecutiveEmptyCount++

					// Idle detection: only trigger after MIN_ITERATIONS_BEFORE_IDLE iterations
					if (
						consecutiveEmptyCount >= MIN_ITERATIONS_BEFORE_IDLE &&
						iteration >= MIN_ITERATIONS_BEFORE_IDLE
					) {
						console.log(
							`[BGWorker] Idle detected after ${iteration} iterations (${consecutiveEmptyCount} consecutive empty)`,
						)
						await this.attemptCompletion(
							"idle",
							"No tool calls for several iterations — task appears complete",
						)
						return
					}
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				console.error(`[BGWorker] Execution error:`, errorMessage)

				// Add error to conversation history so the model can recover
				this.messages.push({
					role: "user",
					content: [{ type: "text", text: `Error in previous iteration: ${errorMessage}` }],
				})

				throw error // Re-throw for retry logic
			} finally {
				this.isProcessing = false
			}
		}
	}

	/**
	 * Make an API request and return the stream.
	 */
	private async makeApiRequest(
		systemPrompt: string,
		messages: Array<{ role: "user" | "assistant"; content: any[] }>,
	): Promise<AsyncIterable<any> | null> {
		if (!this.apiHandler) {
			return null
		}

		// Convert internal message format to Anthropic API format
		const apiMessages = this.convertToApiMessages(messages)

		// Create abort controller for this request
		this.abortController = new AbortController()

		try {
			const stream = this.apiHandler.createMessage(systemPrompt, apiMessages, {
				taskId: this.getId(),
				mode: this.config.mode,
			})

			return stream
		} catch (error) {
			console.error(`[BGWorker] API request failed:`, error)
			throw error
		}
	}

	/**
	 * Convert internal message format to Anthropic API MessageParam format.
	 */
	private convertToApiMessages(messages: Array<{ role: "user" | "assistant"; content: any[] }>): Array<any> {
		return messages.map((msg) => ({
			role: msg.role,
			content: msg.content,
		}))
	}

	/**
	 * Execute a list of tool calls.
	 */
	private async executeTools(toolUses: ToolUse[]): Promise<any[]> {
		const results: any[] = []

		for (const toolUse of toolUses) {
			if (this._state !== BgWorkerStateEnum.Running || this.abortController?.signal.aborted) {
				break
			}

			try {
				const result = await this.executeSingleTool(toolUse)
				results.push(result)
				this.totalToolCalls++

				// Record file change if applicable (for write tools)
				this.recordFileChangeIfApplicable(toolUse, result)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				console.error(`[BGWorker] Tool execution failed (${toolUse.name}):`, errorMessage)
				results.push({
					type: "tool_result",
					tool_use_id: (toolUse as any).id ?? "",
					content: formatResponse.toolError(errorMessage),
					is_error: true,
				})
			}
		}

		return results
	}

	/**
	 * Execute a single tool call.
	 */
	private async executeSingleTool(toolUse: ToolUse): Promise<any> {
		const toolName = toolUse.name as string
		const params = (toolUse.params ?? {}) as Record<string, any>
		const nativeArgs = (toolUse as any).nativeArgs

		// Determine auto-approve based on config
		const autoApprove =
			this.config.autoApprove ?? DEFAULT_AUTO_APPROVE_PER_TYPE[this.config.taskType ?? Ptt.General]

		switch (toolName) {
			case "read_file": {
				const path = nativeArgs?.path ?? params.path
				if (!path) {
					return formatResponse.toolError("read_file: missing path")
				}
				try {
					const fs = await import("fs/promises")
					const content = await fs.readFile(path, "utf-8")
					recordFileChange(this.sharedContext, this.getId(), path)
					return {
						type: "tool_result",
						tool_use_id: (toolUse as any).id ?? "",
						content: content,
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error)
					return formatResponse.toolError(`read_file failed: ${msg}`)
				}
			}

			case "write_to_file": {
				const path = nativeArgs?.path ?? params.path
				const content = nativeArgs?.content ?? params.content
				if (!path || content === undefined) {
					return formatResponse.toolError("write_to_file: missing path or content")
				}
				try {
					const fs = await import("fs/promises")
					await fs.writeFile(
						path,
						typeof content === "string" ? content : JSON.stringify(content, null, 2),
						"utf-8",
					)
					recordFileChange(this.sharedContext, this.getId(), path)
					return {
						type: "tool_result",
						tool_use_id: (toolUse as any).id ?? "",
						content: `Successfully wrote to ${path}`,
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error)
					return formatResponse.toolError(`write_to_file failed: ${msg}`)
				}
			}

			case "apply_diff": {
				const path = nativeArgs?.path ?? params.path
				const diff = nativeArgs?.diff ?? params.diff
				if (!path || !diff) {
					return formatResponse.toolError("apply_diff: missing path or diff")
				}
				try {
					// Simple diff application — read file, apply patch, write back
					const fs = await import("fs/promises")
					let existingContent = ""
					try {
						existingContent = await fs.readFile(path, "utf-8")
					} catch {
						// File doesn't exist yet — create it with the diff content
						await fs.writeFile(path, diff, "utf-8")
						recordFileChange(this.sharedContext, this.getId(), path)
						return {
							type: "tool_result",
							tool_use_id: (toolUse as any).id ?? "",
							content: `Created new file ${path}`,
						}
					}

					// Apply diff using search/replace approach
					const lines = existingContent.split("\n")
					const diffLines = diff.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-"))

					let result = existingContent
					for (const line of diffLines) {
						if (line.startsWith("-") && !line.startsWith("---")) {
							const removedLine = line.slice(1).trim()
							result = result.replace(
								new RegExp(removedLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "m"),
								"",
							)
						} else if (line.startsWith("+") && !line.startsWith("+++")) {
							const addedLine = line.slice(1).trim()
							// Simple approach: append to end for now
							result += "\n" + addedLine
						}
					}

					await fs.writeFile(path, result, "utf-8")
					recordFileChange(this.sharedContext, this.getId(), path)
					return {
						type: "tool_result",
						tool_use_id: (toolUse as any).id ?? "",
						content: `Successfully applied diff to ${path}`,
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error)
					return formatResponse.toolError(`apply_diff failed: ${msg}`)
				}
			}

			case "execute_command": {
				const command = nativeArgs?.command ?? params.command
				if (!command) {
					return formatResponse.toolError("execute_command: missing command")
				}
				try {
					const { exec } = await import("child_process")
					const { promisify } = await import("util")
					const execAsync = promisify(exec)
					const { stdout, stderr } = await execAsync(command, { timeout: 60000 })

					if (stderr) {
						return formatResponse.toolError(`Command output:\n${stdout}\nErrors:\n${stderr}`)
					}

					return {
						type: "tool_result",
						tool_use_id: (toolUse as any).id ?? "",
						content: stdout || "(command completed with no output)",
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error)
					return formatResponse.toolError(`execute_command failed: ${msg}`)
				}
			}

			case "search_files": {
				const regex = nativeArgs?.regex ?? params.regex
				const filePattern = nativeArgs?.file_pattern ?? params.file_pattern
				if (!regex) {
					return formatResponse.toolError("search_files: missing regex")
				}
				try {
					// Use rg (ripgrep) for fast search
					const { exec } = await import("child_process")
					const { promisify } = await import("util")
					const execAsync = promisify(exec)

					const cwd = this.provider.cwd ?? process.cwd()
					const pattern = filePattern
						? `rg --files -g "${filePattern}" | xargs rg --no-heading ${regex}`
						: `rg --no-heading ${regex} .`

					const { stdout } = await execAsync(pattern, { cwd, timeout: 30000 })
					return {
						type: "tool_result",
						tool_use_id: (toolUse as any).id ?? "",
						content: stdout || "(no matches found)",
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error)
					return formatResponse.toolError(`search_files failed: ${msg}`)
				}
			}

			case "list_files": {
				const path = nativeArgs?.path ?? params.path
				try {
					const fs = await import("fs/promises")
					const dirPath = path || "."
					const entries = await fs.readdir(dirPath, { withFileTypes: true })
					const files = entries.map((e) => `${e.isDirectory() ? "/" : "  "}${e.name}`).join("\n")
					return {
						type: "tool_result",
						tool_use_id: (toolUse as any).id ?? "",
						content: files || "(empty directory)",
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error)
					return formatResponse.toolError(`list_files failed: ${msg}`)
				}
			}

			case "ask_followup_question": {
				// For background workers, just record the question and continue
				const question = nativeArgs?.question ?? params.question
				if (!question) {
					return formatResponse.toolError("ask_followup_question: missing question")
				}
				// Auto-approve: log the question but don't block
				console.log(`[BGWorker] Follow-up question (auto-approved): ${question}`)
				return {
					type: "tool_result",
					tool_use_id: (toolUse as any).id ?? "",
					content: `Question noted: ${question}`,
				}
			}

			case "attempt_completion": {
				// This is handled specially — don't execute, let the caller handle it
				return {
					type: "tool_result",
					tool_use_id: (toolUse as any).id ?? "",
					content: "__ATTEMPT_COMPLETION__",
				}
			}

			case "update_todo_list": {
				// Background workers can update their todo list — just acknowledge
				return {
					type: "tool_result",
					tool_use_id: (toolUse as any).id ?? "",
					content: "Todo list updated",
				}
			}

			default: {
				// Unknown tool — log and continue
				console.warn(`[BGWorker] Unknown tool: ${toolName}`)
				return formatResponse.toolError(`Unknown tool: ${toolName}`)
			}
		}
	}

	/**
	 * Record file change in shared context for write tools.
	 */
	private recordFileChangeIfApplicable(toolUse: ToolUse, result: any): void {
		const toolName = toolUse.name as string
		let filePath: string | undefined

		// Check nativeArgs first (native protocol), then params (legacy)
		if ((toolUse as any).nativeArgs?.path) {
			filePath = (toolUse as any).nativeArgs.path
		} else if ((toolUse.params ?? {})?.path) {
			filePath = (toolUse.params as any)?.path
		}

		// Also check input.path fallback for Edit/Save tools
		if (!filePath && (toolUse as any).input?.path) {
			filePath = (toolUse as any).input.path
		}

		if (filePath && result?.content && typeof result.content === "string") {
			const successContent = ["Successfully", "Created new file", "wrote to"]
			const isSuccess =
				successContent.some((s) => result.content.toLowerCase().includes(s.toLowerCase())) || !result.is_error
			if (isSuccess) {
				recordFileChange(this.sharedContext, this.getId(), filePath)
			}
		}
	}

	/**
	 * Attempt completion — signals the task is done.
	 */
	private async attemptCompletion(reason: string, summary?: string): Promise<void> {
		if (this._state !== BgWorkerStateEnum.Running) return

		this._state = BgWorkerStateEnum.Completed

		const durationMs = Date.now() - this.startTime

		// Build result
		const result: BGWorkerResult = {
			id: this.getId(),
			state: BgWorkerStateEnum.Completed,
			summary: summary || "Task completed",
			totalToolCalls: this.totalToolCalls,
			durationMs,
			notificationMode:
				this.config.notificationMode ?? DEFAULT_NOTIFICATION_MODE_PER_TYPE[this.config.taskType ?? Ptt.General],
		}

		// Emit completion event (BGWorkerManager will handle notifications)
		this.emit("completed", result)
	}

	/**
	 * Cancel the worker.
	 */
	cancel(reason: string): void {
		if (
			this._state === BgWorkerStateEnum.Completed ||
			this._state === BgWorkerStateEnum.Failed ||
			this._state === BgWorkerStateEnum.Cancelled
		) {
			return
		}

		// Abort current API request
		this.abortController?.abort()

		const prevState = this._state
		this._state = BgWorkerStateEnum.Cancelled

		console.log(`[BGWorker] Cancelled: ${reason}`)

		if (prevState === BgWorkerStateEnum.Running) {
			const durationMs = Date.now() - this.startTime
			const result: BGWorkerResult = {
				id: this.getId(),
				state: BgWorkerStateEnum.Cancelled,
				summary: `Cancelled: ${reason}`,
				totalToolCalls: this.totalToolCalls,
				durationMs,
			}
			this.emit("completed", result)
		}
	}

	/**
	 * Pause the worker (between tool calls).
	 */
	pause(): void {
		if (this._state !== BgWorkerStateEnum.Running) return
		this._state = BgWorkerStateEnum.Paused

		// Abort current API request so we don't block
		this.abortController?.abort()

		const update: BGWorkerStateUpdate = {
			type: "bgWorkerState",
			workerId: this.getId(),
			state: BgWorkerStateEnum.Paused,
			description: this.config.description,
			taskType: this.config.taskType,
		}
		this.emit("stateUpdate", update)
	}

	/**
	 * Resume a paused worker.
	 * Uses isProcessing guard to prevent concurrent execution edge case.
	 */
	resume(): void {
		if (this._state !== BgWorkerStateEnum.Paused) return
		this._state = BgWorkerStateEnum.Running

		const update: BGWorkerStateUpdate = {
			type: "bgWorkerState",
			workerId: this.getId(),
			state: BgWorkerStateEnum.Running,
			description: this.config.description,
			taskType: this.config.taskType,
		}
		this.emit("stateUpdate", update)

		// If not currently processing, start execution loop
		if (!this.isProcessing) {
			this.executeWithRetry().catch((error) => {
				console.error(`[BGWorker] Resume failed:`, error)
			})
		}
	}

	/**
	 * Reset context for retry — clears conversation history but keeps the initial task message.
	 */
	private async resetContext(): Promise<void> {
		// Keep only the first user message (initial task description)
		if (this.messages.length > 1) {
			this.messages = [this.messages[0]]
		}

		console.log(`[BGWorker] Context reset for retry`)
	}

	/**
	 * Get worker result summary.
	 */
	getResult(): BGWorkerResult | null {
		if (
			this._state === BgWorkerStateEnum.Completed ||
			this._state === BgWorkerStateEnum.Failed ||
			this._state === BgWorkerStateEnum.Cancelled
		) {
			return {
				id: this.getId(),
				state: this._state,
				summary: "Task completed",
				totalToolCalls: this.totalToolCalls,
				durationMs: Date.now() - this.startTime,
			}
		}
		return null
	}

	/**
	 * Dispose the worker — clean up resources.
	 */
	dispose(): void {
		this.abortController?.abort()
		this.apiHandler = undefined
		this.messages = []
	}
}
