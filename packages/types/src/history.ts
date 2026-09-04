import { z } from "zod"

import { reasoningEffortExtendedSchema } from "./model.js"
import { todoItemSchema } from "./todo.js"

/**
 * HistoryItem
 */

export const pendingTaskActionSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("create_subtask"),
		actionId: z.string(),
		approvalText: z.string(),
		mode: z.string(),
		message: z.string(),
		todos: z.array(todoItemSchema),
	}),
	z.object({
		kind: z.literal("finish_subtask"),
		actionId: z.string(),
		approvalText: z.string(),
		parentTaskId: z.string(),
		result: z.string(),
	}),
])

export type PendingTaskAction = z.infer<typeof pendingTaskActionSchema>

export const historyItemSchema = z.object({
	id: z.string(),
	rootTaskId: z.string().optional(),
	parentTaskId: z.string().optional(),
	number: z.number(),
	ts: z.number(),
	task: z.string(),
	tokensIn: z.number(),
	tokensOut: z.number(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
	totalCost: z.number(),
	size: z.number().optional(),
	workspace: z.string().optional(),
	mode: z.string().optional(),
	apiConfigName: z.string().optional(), // Provider profile name for sticky profile feature
	status: z.enum(["active", "completed", "delegated", "interrupted"]).optional(),
	delegatedToId: z.string().optional(), // Last child this parent delegated to
	childIds: z.array(z.string()).optional(), // All children spawned by this task
	awaitingChildId: z.string().optional(), // Child currently awaited (set when delegated)
	completedByChildId: z.string().optional(), // Child that completed and resumed this parent
	completionResultSummary: z.string().optional(), // Summary from completed child
	// DTE series 2/5: task-local thinking effort override persisted with the history
	// item so a task reopened from history keeps the effort it had (user-set or
	// model/parent-chosen) instead of falling back to the settings value.
	thinkingEffort: reasoningEffortExtendedSchema.optional(),
	// Provenance of the persisted effort (e.g. "you", "model", "parent").
	thinkingEffortSource: z.string().optional(),
	pendingAction: pendingTaskActionSchema.optional(),
})

export type HistoryItem = z.infer<typeof historyItemSchema>
