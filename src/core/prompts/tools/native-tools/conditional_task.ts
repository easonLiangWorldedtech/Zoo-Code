import type OpenAI from "openai"

const CONDITIONAL_TASK_DESCRIPTION = `Evaluate a subtask's condition and decide the next action.

Use this tool when you need to make a decision about how to proceed with a parallel task:
- **restart**: The current approach failed or produced wrong results. Restart with clearer/more specific instructions.
- **continue**: The task is making progress but needs additional guidance. Continue in the existing subtask.
- **user_input**: You need user's decision on an ambiguous situation. Pauses execution and asks the user.

CRITICAL: This tool MUST be called alone. Do NOT call this tool alongside other tools in the same message turn.`

const ACTION_PARAMETER_DESCRIPTION = `Action to take: "restart" (retry with clearer prompt), "continue" (add instructions to existing subtask), or "user_input" (ask user for decision)`

export default {
	type: "function",
	function: {
		name: "conditional_task",
		description: CONDITIONAL_TASK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["restart", "continue", "user_input"],
					description: ACTION_PARAMETER_DESCRIPTION,
				},
				target_id: {
					type: "string",
					description: "Node ID in the workflow to apply this action to (e.g., 'A', 'B')",
				},
				reason: {
					type: "string",
					description: "Brief explanation of why this decision was made",
				},
				additional_prompt: {
					type: ["string", "null"],
					description: "Extra instructions to include when restarting or continuing the task",
				},
				question_for_user: {
					type: ["string", "null"],
					description: "Question to ask the user when action is 'user_input'",
				},
			},
			required: ["action", "target_id", "reason"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
