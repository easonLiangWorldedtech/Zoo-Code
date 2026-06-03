import * as vscode from "vscode"

import type { ParallelTaskType } from "@roo-code/types"
import { Ptt, DEFAULT_AUTO_APPROVE_PER_TYPE, DEFAULT_COST_LIMITS_PER_TYPE, DEFAULT_CONTEXT_RETENTION_PER_TYPE, DEFAULT_NOTIFICATION_MODE_PER_TYPE } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"
import { Package } from "../../shared/package"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"

import { createWorkflowFile, readWorkflowFile } from "../parallel/WorkflowFileStore"
import { detectCycles, createWorkflow as createWorkflowDef } from "../parallel/WorkflowDAG"
import { TaskFlowAgent, createTaskFlowAgent } from "../parallel/TaskFlowAgent"

interface CreateWorkflowParams {
	name: string
	nodes: Array<{
		id: string
		description: string
		type?: ParallelTaskType | null
		depends_on?: string[] | null
	}>
}

/** Validate a node definition */
function validateNode(node: Record<string, unknown>, seenIds: Set<string>): string | null {
	if (typeof node.id !== "string" || !node.id.trim()) {
		return `Node must have a non-empty 'id'`
	}
	if (seenIds.has(node.id as string)) {
		return `Duplicate node ID: '${node.id}'`
	}
	seenIds.add(node.id as string)

	if (typeof node.description !== "string" || !node.description.trim()) {
		return `Node '${node.id}' must have a non-empty 'description'`
	}

	const validTypes = ["search", "doc", "commit", "code", "debug", "general"]
	if (node.type !== null && node.type !== undefined) {
		if (typeof node.type === "string" && !validTypes.includes(node.type as string)) {
			return `Node '${node.id}' has invalid type: '${node.type}'. Must be one of: ${validTypes.join(", ")}`
		}
	}

	if (node.depends_on !== null && node.depends_on !== undefined) {
		if (!Array.isArray(node.depends_on)) {
			return `Node '${node.id}' depends_on must be an array`
		}
		for (const dep of node.depends_on as string[]) {
			if (typeof dep !== "string") {
				return `Node '${node.id}' has non-string dependency: ${JSON.stringify(dep)}`
			}
		}
	}

	return null
}

export class CreateWorkflowTool extends BaseTool<"create_workflow"> {
	readonly name = "create_workflow" as const

	async execute(params: CreateWorkflowParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { name, nodes } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters
			if (!name || typeof name !== "string" || !name.trim()) {
				task.consecutiveMistakeCount++
				task.recordToolError("create_workflow")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("create_workflow", "name"))
				return
			}

			if (!Array.isArray(nodes) || nodes.length === 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("create_workflow")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("create_workflow", "nodes"))
				return
			}

			const provider = task.providerRef.deref()
			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			// Validate all nodes
			const seenIds = new Set<string>()
			for (const node of nodes) {
				const validationError = validateNode(node, seenIds)
				if (validationError) {
					task.consecutiveMistakeCount++
					task.recordToolError("create_workflow")
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError(validationError))
					return
				}
			}

			// Check for cycles in the DAG
			const nodeObjects = nodes.map((n) => ({
				id: n.id,
				taskDescription: n.description,
				type: (n.type as ParallelTaskType | undefined) ?? Ptt.General,
				depends_on: n.depends_on ?? [],
				status: "pending" as const,
			}))

			const cycleResult = detectCycles(nodeObjects)
			if (cycleResult.hasCycle) {
				task.consecutiveMistakeCount++
				task.recordToolError("create_workflow")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(`Circular dependency detected: ${cycleResult.cycleError}`))
				return
			}

			// Check if auto-approve is enabled for workflow creation
			const state = await provider.getState()
			const autoApproveWorkflow = vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("parallelTaskAutoApproveWorkflow", false)

			if (!autoApproveWorkflow) {
				const approvalMsg = JSON.stringify({
					tool: "create_workflow",
					name,
					nodeCount: nodes.length,
					nodes: nodes.map((n) => ({ id: n.id, description: n.description, type: n.type })),
				})

				const didApprove = await askApproval("tool", approvalMsg)
				if (!didApprove) {
					return
				}
			}

			task.consecutiveMistakeCount = 0

			// Create workflow definition
			const workflowId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
			const mainTaskId = task.taskId

			const workflow = createWorkflowDef(workflowId, name, mainTaskId, nodeObjects)

			// Save to disk via WorkflowFileStore
			const filePath = createWorkflowFile(workflow)
			if (!filePath) {
				pushToolResult(formatResponse.toolError(`Failed to save workflow "${name}" to disk`))
				return
			}

			// Register with BGWorkerManager — start TaskFlowAgent
			const bgWorkerManager = (provider as any).bgWorkerManager
			if (bgWorkerManager) {
				try {
					const agent: TaskFlowAgent | null = createTaskFlowAgent(
						provider,
						bgWorkerManager,
						workflow,
					)

					// Store the agent reference on provider for lifecycle management
						(provider as any)._taskFlowAgent = agent

					console.log(`[CreateWorkflowTool] TaskFlowAgent spawned for workflow "${name}" (${workflowId})`)
				} catch (agentError) {
					console.warn(`[CreateWorkflowTool] Failed to spawn TaskFlowAgent:`, agentError)
					// Don't fail the tool — workflow is saved, just agent didn't start
				}
			}

			const result = `✅ Workflow "${name}" created successfully (${workflowId})\n` +
				`${nodes.length} nodes defined:\n` +
				nodes.map((n) => {
					const deps = n.depends_on && n.depends_on.length > 0 ? ` (depends: [${n.depends_on.join(", ")}])` : ""
					return `  - ${n.id}: "${n.description}" [${n.type ?? "general"}]${deps}`
				}).join("\n")

			pushToolResult(result)
		} catch (error) {
			await handleError("creating workflow", error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"create_workflow">): Promise<void> {
		const name: string | undefined = block.params.name
		const nodesStr: string | undefined = block.params.nodes

		const partialMessage = JSON.stringify({
			tool: "createWorkflow",
			name: name ?? "",
			nodes: nodesStr ? JSON.parse(nodesStr) : [],
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const createWorkflowTool = new CreateWorkflowTool()
