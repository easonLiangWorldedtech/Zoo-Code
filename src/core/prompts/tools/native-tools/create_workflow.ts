import type OpenAI from "openai"

const CREATE_WORKFLOW_DESCRIPTION = `Create a new TaskFlowAgent workflow for managing parallel task dependencies.

Use this tool when the main task needs to orchestrate multiple sub-tasks with dependency relationships (DAG). The LLM should analyze the user's request, identify independent and dependent sub-tasks, then create a structured workflow that BGWorkerManager can execute.

CRITICAL: This tool MUST be called alone. Do NOT call this tool alongside other tools in the same message turn.`

const WORKFLOW_NAME_PARAMETER_DESCRIPTION = `Human-readable name for the workflow (e.g., "Implement OAuth flow", "Run full test suite")`

const NODES_PARAMETER_DESCRIPTION = `Array of workflow nodes, each representing a parallel task. Each node has:
- id: Unique single-letter or short identifier (A, B, C...)
- description: What this node should do
- type: Task type for LLM routing (search, doc, commit, code, debug, general)
- depends_on: Array of node IDs that must complete before this one starts (empty array = no dependencies)`

export default {
	type: "function",
	function: {
		name: "create_workflow",
		description: CREATE_WORKFLOW_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: WORKFLOW_NAME_PARAMETER_DESCRIPTION,
				},
				nodes: {
					type: "array",
					description: NODES_PARAMETER_DESCRIPTION,
					items: {
						type: "object",
						properties: {
							id: {
								type: "string",
								description: "Unique node identifier (e.g., 'A', 'B', 'C')",
							},
							description: {
								type: "string",
								description: "Task description for this node",
							},
							type: {
								type: ["string", "null"],
								enum: ["search", "doc", "commit", "code", "debug", "general", null],
								description: "Task type for LLM routing (defaults to 'general')",
							},
							depends_on: {
								type: ["array", "null"],
								items: {
									type: "string",
								},
								description: "Node IDs that must complete before this node starts",
							},
						},
						required: ["id", "description"],
						additionalProperties: false,
					},
				},
			},
			required: ["name", "nodes"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
