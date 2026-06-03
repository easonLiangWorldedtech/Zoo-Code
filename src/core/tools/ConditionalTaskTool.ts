import type { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"

interface ConditionalTaskParams {
	action: "restart" | "continue" | "user_input"
	target_id: string
	reason: string
	additional_prompt?: string
}

/** Validate conditional_task parameters */
function validateParams(params: Record<string, unknown>): string | null {
	if (!params.action || !["restart", "continue", "user_input"].includes(params.action as string)) {
		return "action must be one of: 'restart', 'continue', 'user_input'"
	}
	if (typeof params.target_id !== "string" || !params.target_id.trim()) {
		return "target_id must be a non-empty string"
	}
	if (typeof params.reason !== "string" || !params.reason.trim()) {
		return "reason must be a non-empty string"
	}
	return null
}

export class ConditionalTaskTool extends BaseTool<"conditional_task"> {
	readonly name = "conditional_task" as const

	async execute(params: ConditionalTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { action, target_id, reason, additional_prompt } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters
			if (!action || !target_id || !reason) {
				task.consecutiveMistakeCount++
				task.recordToolError("conditional_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("conditional_task", "action"))
				return
			}

			const provider = task.providerRef.deref()
			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			// Look up the TaskFlowAgent on the provider
			const agent: any = (provider as any)._taskFlowAgent
			if (!agent) {
				task.consecutiveMistakeCount++
				task.recordToolError("conditional_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError("No active TaskFlowAgent — cannot resolve target_id"))
				return
			}

			// Find the node by target_id
			const node = agent.getNode(target_id)
			if (!node) {
				task.consecutiveMistakeCount++
				task.recordToolError("conditional_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(`Node '${target_id}' not found in workflow`))
				return
			}

			// Execute based on action type
			switch (action) {
				case "restart": {
					const additionalPrompt = additional_prompt ?? reason
					await agent.restartNode(target_id, additionalPrompt)
					pushToolResult(`🔄 Node "${target_id}" restarted${additional_prompt ? ` with updated prompt` : ""}`)
					break
				}

				case "continue": {
					const additionalInstructions = additional_prompt ?? reason
					await agent.continueNode(target_id, additionalInstructions)
					pushToolResult(`▶️ Node "${target_id}" continued${additional_prompt ? ` with additional instructions` : ""}`)
					break
				}

				case "user_input": {
					const question = `Node "${target_id}" needs your input. ${reason}`
					await agent.pauseNode(target_id)

					const approvalMsg = JSON.stringify({
						tool: "conditional_task",
						action: "user_input",
						nodeId: target_id,
						reason,
						additional_prompt: additional_prompt,
					})

					const approved = await askApproval("tool", approvalMsg)

					if (approved) {
						pushToolResult(`⏸️ Node "${target_id}" paused — awaiting user input`)
					} else {
						await agent.resumeNode(target_id)
						pushToolResult(`▶️ Node "${target_id}" resumed after user declined`)
					}
					break
				}
			}

			task.consecutiveMistakeCount = 0
		} catch (error) {
			await handleError("conditional_task", error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"conditional_task">): Promise<void> {
		const action: string | undefined = block.params.action
		const targetId: string | undefined = block.params.target_id
		const reason: string | undefined = block.params.reason

		const partialMessage = JSON.stringify({
			tool: "conditionalTask",
			action: action ?? "",
			target_id: targetId ?? "",
			reason: reason ?? "",
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const conditionalTaskTool = new ConditionalTaskTool()
