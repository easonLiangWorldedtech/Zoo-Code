/**
* TaskFlowAgent — Workflow Orchestrator for Parallel Tasks.
*
* Phase 7a: Core orchestrator that manages DAG workflows, resolves dependencies,
* spawns BGWorkers for ready nodes, and handles lifecycle events.
*
* Architecture:
*   User (Main Chat) → TaskFlowAgent (delegate_task) → BGWorkerManager → BGWorkers
*                                                    ↕
*                                              Workflow JSON file
*/

import EventEmitter from "events"
import * as vscode from "vscode"

import type { ClineProvider } from "../webview/ClineProvider"
import type {
	BGWorkerConfig,
	BGWorkerResult,
	BGWorkerState,
	ParallelTaskType,
} from "@roo-code/types"
import {
	DEFAULT_AUTO_APPROVE_PER_TYPE,
	DEFAULT_COST_LIMITS_PER_TYPE,
	DEFAULT_CONTEXT_RETENTION_PER_TYPE,
	DEFAULT_NOTIFICATION_MODE_PER_TYPE,
	BGWorkerState as BgWorkerStateEnum,
	ParallelTaskType as Ptt,
} from "@roo-code/types"

import type { BGWorkerManager } from "./BGWorkerManager"
import {
	createWorkflow,
	detectCycles,
	getReadyNodes,
	propagateNodeCompletion,
	validateWorkflow,
	computeWorkflowStatus,
	getTransitiveDependents,
} from "./WorkflowDAG"

import type {
	ErrorPolicy,
	TaskFlowNode,
	TaskFlowNodeStatus,
	TaskFlowReadyNode,
	TaskFlowWorkflow,
	TaskFlowWorkflowStatus,
	WorkflowAutoApproveConfig,
	ExtendedBGWorkerManagerEvents,
} from "@roo-code/types"

import { DEFAULT_ERROR_POLICY_PER_TYPE } from "@roo-code/types"
import { updateWorkflowFile } from "./WorkflowFileStore"

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default error policy for workflows without explicit config */
const DEFAULT_WORKFLOW_ERROR_POLICY: ErrorPolicy = "stop_downstream"

/** Default workflow name prefix when auto-generating */
const WORKFLOW_NAME_PREFIX = "Workflow"

// ─── TaskFlowAgent Events ─────────────────────────────────────────────────────

export type TaskFlowAgentEvents = {
	/** Emitted when a new node starts executing */
	nodeStarted: [nodeId: string, workerId: string];
	/** Emitted when a node completes successfully */
	nodeCompleted: [nodeId: string, result: BGWorkerResult];
	/** Emitted when a node fails */
	nodeFailed: [nodeId: string, error: string];
	/** Emitted when the workflow status changes */
	workflowStatusChanged: [oldStatus: TaskFlowWorkflowStatus, newStatus: TaskFlowWorkflowStatus];
	/** Emitted when ready nodes are available for spawning */
	readyNodesAvailable: [readyNodes: TaskFlowReadyNode[]];
};

// ─── TaskFlowAgent Class ──────────────────────────────────────────────────────

/**
* TaskFlowAgent manages a single workflow DAG.
* It runs as a delegate_task — independent agent with its own conversation context.
* Lifecycle follows the main task: spawned when user creates a workflow, disposed when main task ends.
*/
export class TaskFlowAgent extends EventEmitter<TaskFlowAgentEvents> {
	private provider: ClineProvider
	private bgWorkerManager: BGWorkerManager

	/** The workflow being managed */
	private workflow: TaskFlowWorkflow

	/** Whether the agent is currently processing (prevents concurrent spawn) */
	private isProcessing = false

	/** Max concurrent workers for this workflow's nodes */
	private maxConcurrent: number

	constructor(
		provider: ClineProvider,
		bgWorkerManager: BGWorkerManager,
		workflow: TaskFlowWorkflow,
	) {
		super()
		this.provider = provider
		this.bgWorkerManager = bgWorkerManager
		this.workflow = workflow
		this.maxConcurrent = Math.min(16, Math.max(1, this.loadMaxConcurrent()))

		// Auto-spawn ready nodes on initialization
		this.trySpawnReadyNodes()
	}

	/** Load max concurrent from settings */
	private loadMaxConcurrent(): number {
		const proxy = (this.provider as any).contextProxy
		if (!proxy) return 8

		const stateCache = (proxy as any)?.stateCache ?? {}
		const value = stateCache["parallelTaskMaxConcurrent"]
		if (typeof value === "number" && Number.isInteger(value)) {
			return Math.min(16, Math.max(1, value))
		}
		return 8 // Default
	}

	/** Get the workflow object */
	getWorkflow(): TaskFlowWorkflow {
		return this.workflow
	}

	/** Get all nodes */
	getNodes(): TaskFlowNode[] {
		return this.workflow.nodes
	}

	/** Get a specific node by ID */
	getNode(nodeId: string): TaskFlowNode | undefined {
		return this.workflow.nodes.find((n) => n.id === nodeId)
	}

	/** Get current workflow status */
	getStatus(): TaskFlowWorkflowStatus {
		// Recompute from actual node states
		return computeWorkflowStatus(this.workflow.nodes, this.workflow.status)
	}

	/** Check if a node is ready to execute (deps met, not already running/completed) */
	isNodeReady(nodeId: string): boolean {
		const node = this.getNode(nodeId)
		if (!node) return false
		if (node.status !== "pending" && node.status !== "waiting") return false

		// Check all dependencies are completed
		const completedSet = new Set(
			this.workflow.nodes.filter((n) => n.status === "completed").map((n) => n.id),
		)
		return node.depends_on.every((depId) => completedSet.has(depId))
	}

	/** Get all currently ready nodes */
	getReadyNodes(): TaskFlowReadyNode[] {
		return getReadyNodes(this.workflow.nodes, this.maxConcurrent)
	}

	// ─── Node Lifecycle ──────────────────────────────────────────────────────

	/** Spawn a BGWorker for a specific node */
	async spawnNode(nodeId: string): Promise<string | null> {
		if (this.isProcessing) return null

		const node = this.getNode(nodeId)
		if (!node) return null

		// Check if already running or completed
		if (node.status === "running" || node.status === "completed") return null

		// Check dependencies are met
		if (!this.isNodeReady(nodeId)) {
			console.warn(`[TaskFlowAgent] Node "${nodeId}" not ready — deps not met`)
			return null
		}

		this.isProcessing = true
		try {
			const workerId = await this.createWorkerForNode(node)
			if (workerId) {
				node.status = "running"
				node.worker_id = workerId
				node.started_at = new Date().toISOString()
				this.updateTimestamp()

				this.emit("nodeStarted", nodeId, workerId)
				console.log(`[TaskFlowAgent] Node "${nodeId}" spawned → worker ${workerId}`)
			}
			return workerId ?? null
		} finally {
			this.isProcessing = false
		}
	}

	/** Create a BGWorkerConfig from a TaskFlowNode */
	private createWorkerForNode(node: TaskFlowNode): Promise<string | null> {
		const config = this.buildWorkerConfig(node)
		return this.bgWorkerManager.spawn(config)
	}

	/** Build BGWorkerConfig from node definition + workflow settings */
	private buildWorkerConfig(node: TaskFlowNode): BGWorkerConfig {
		// Resolve auto-approve from workflow config or defaults
		const autoApprove = this.resolveAutoApprove(node.type)

		// Resolve cost/token limits from task type defaults
		const costLimits = DEFAULT_COST_LIMITS_PER_TYPE[node.type] ?? DEFAULT_COST_LIMITS_PER_TYPE[Ptt.General]
		const contextRetention = DEFAULT_CONTEXT_RETENTION_PER_TYPE[node.type]
		const notificationMode = DEFAULT_NOTIFICATION_MODE_PER_TYPE[node.type]

		return {
			description: node.taskDescription,
			message: `TaskFlowAgent node "${node.id}": ${node.taskDescription}`,
			mode: this.resolveNodeMode(node),
			taskType: node.type,
			autoApprove,
			maxCostPerTask: costLimits.maxCostPerTask,
			maxTokensPerTask: costLimits.maxTokensPerTask,
			contextRetention,
			notificationMode: notificationMode as "all" | "errors_only",
		}
	}

	/** Resolve task type's auto-approve settings */
	private resolveAutoApprove(taskType: ParallelTaskType): Partial<typeof DEFAULT_AUTO_APPROVE_PER_TYPE[ParallelTaskType]> {
		const defaults = DEFAULT_AUTO_APPROVE_PER_TYPE[taskType] ?? DEFAULT_AUTO_APPROVE_PER_TYPE[Ptt.General]

		// Check workflow-level per-node override
		if (this.workflow.auto_approve?.perNode) {
			for (const node of this.workflow.nodes) {
				const override = this.workflow.auto_approve.perNode[node.id]
				if (override && !override.autoApprove) {
					return { ...defaults, writeFiles: false } // Override disables auto-approve
				}
			}
		}

		return defaults
	}

	/** Resolve the Roo Code mode for a node based on its task type */
	private resolveNodeMode(node: TaskFlowNode): string {
		switch (node.type) {
			case Ptt.Code:
				return "code"
			case Ptt.Debug:
				return "debug"
			case Ptt.Search:
				return "search"
			case Ptt.Doc:
				return "doc"
			case Ptt.Commit:
				return "commit"
			default:
				return "code" // Default to code mode for general tasks
		}
	}

	/** Handle node completion — propagate status, spawn next ready nodes */
	handleNodeComplete(nodeId: string, result: BGWorkerResult): void {
		const node = this.getNode(nodeId)
		if (!node) return

		node.status = "completed" as TaskFlowNodeStatus
		node.completed_at = new Date().toISOString()
		this.updateTimestamp()

		// Resolve error policy for this node
		const errorPolicy = this.resolveErrorPolicy(node.type, nodeId)

		// Propagate completion status to dependents
		const propagation = propagateNodeCompletion(
			this.workflow.nodes,
			nodeId,
			true,
			errorPolicy,
		)

		if (propagation.skippedNodes) {
			for (const skippedId of propagation.skippedNodes) {
				const skippedNode = this.getNode(skippedId)
				if (skippedNode && skippedNode.status === "waiting") {
					skippedNode.status = "skipped" as TaskFlowNodeStatus
					skippedNode.completed_at = new Date().toISOString()
				}
			}
		}

		// Update workflow status
		this.workflow.status = computeWorkflowStatus(this.workflow.nodes, this.workflow.status)

		this.emit("nodeCompleted", nodeId, result)
		this.trySpawnReadyNodes()
	}

	/** Handle node failure — propagate error policy */
	handleNodeFail(nodeId: string, workerId: string, error: string): void {
		const node = this.getNode(nodeId)
		if (!node) return

		node.status = "failed" as TaskFlowNodeStatus
		node.completed_at = new Date().toISOString()
		this.updateTimestamp()

		// Resolve error policy for this node
		const errorPolicy = this.resolveErrorPolicy(node.type, nodeId)

		// Propagate failure based on error policy
		if (errorPolicy === "stop_downstream" || errorPolicy === "skip_dependents") {
			const dependents = getTransitiveDependents(this.workflow.nodes, nodeId)
			for (const depId of dependents) {
				const depNode = this.getNode(depId)
				if (depNode && (depNode.status === "pending" || depNode.status === "waiting")) {
					depNode.status = errorPolicy === "stop_downstream" ? "skipped" : "skipped" as TaskFlowNodeStatus
					depNode.completed_at = new Date().toISOString()
				}
			}
		}

		// Update workflow status
		this.workflow.status = computeWorkflowStatus(this.workflow.nodes, this.workflow.status)

		this.emit("nodeFailed", nodeId, error)
	}

	/** Pause a node's worker */
	pauseNode(nodeId: string): boolean {
		const node = this.getNode(nodeId)
		if (!node || node.worker_id == null) return false

		node.status = "paused" as TaskFlowNodeStatus
		node.completed_at = new Date().toISOString()
		this.updateTimestamp()

		this.bgWorkerManager.pauseWorker(node.worker_id)
		console.log(`[TaskFlowAgent] Node "${nodeId}" paused`)
		return true
	}

	/** Resume a paused node */
	resumeNode(nodeId: string): boolean {
		const node = this.getNode(nodeId)
		if (!node || node.status !== "paused") return false

		// If there's an existing worker, try to resume it
		if (node.worker_id != null) {
			this.bgWorkerManager.resumeWorker(node.worker_id)
			node.status = "running" as TaskFlowNodeStatus
			delete node.completed_at
			this.updateTimestamp()
			return true
		}

		// No existing worker — spawn a new one
		return !!this.spawnNode(nodeId)
	}

	/** Cancel a node and its worker */
	cancelNode(nodeId: string): boolean {
		const node = this.getNode(nodeId)
		if (!node) return false

		if (node.worker_id != null) {
			this.bgWorkerManager.cancelWorker(node.worker_id)
		}

		node.status = "cancelled" as TaskFlowNodeStatus
		node.completed_at = new Date().toISOString()
		this.updateTimestamp()

		console.log(`[TaskFlowAgent] Node "${nodeId}" cancelled`)
		return true
	}

	/** Skip a node (mark as skipped, propagate to dependents) */
	skipNode(nodeId: string): boolean {
		const node = this.getNode(nodeId)
		if (!node) return false

		if (node.worker_id != null) {
			this.bgWorkerManager.cancelWorker(node.worker_id)
		}

		node.status = "skipped" as TaskFlowNodeStatus
		node.completed_at = new Date().toISOString()
		this.updateTimestamp()

		// Propagate to dependents
		const dependents = getTransitiveDependents(this.workflow.nodes, nodeId)
		for (const depId of dependents) {
			const depNode = this.getNode(depId)
			if (depNode && (depNode.status === "pending" || depNode.status === "waiting")) {
				depNode.status = "skipped" as TaskFlowNodeStatus
				depNode.completed_at = new Date().toISOString()
			}
		}

		this.workflow.status = computeWorkflowStatus(this.workflow.nodes, this.workflow.status)
			console.log(`[TaskFlowAgent] Node "${nodeId}" skipped + dependents`)
			return true
		}

		/** Restart a node — cancel current worker, reset to pending, spawn with updated prompt */
			async restartNode(nodeId: string, additionalPrompt?: string): Promise<boolean> {
				const node = this.getNode(nodeId)
				if (!node) return false

				// Cancel existing worker if running
				if (node.worker_id != null) {
					this.bgWorkerManager.cancelWorker(node.worker_id)
				}

				// Reset node to pending for re-execution
				node.status = "pending" as TaskFlowNodeStatus
				delete node.completed_at
				delete node.started_at
				delete node.worker_id
				if (additionalPrompt) {
					node.additional_prompt = additionalPrompt
				}

				this.updateTimestamp()

				// Try to spawn immediately if dependencies are met
				await this.trySpawnReadyNodes()
				console.log(`[TaskFlowAgent] Node "${nodeId}" restarted${additionalPrompt ? " with updated prompt" : ""}`)
				return true
			}

		/** Continue a node — inject additional instructions into running worker or mark for follow-up */
			async continueNode(nodeId: string, additionalInstructions: string): Promise<boolean> {
				const node = this.getNode(nodeId)
				if (!node) return false

				// Store the additional instructions on the node (Phase 7l)
				node.additional_prompt = additionalInstructions

				// If still running, the worker will pick up new context on next iteration
				// If completed/paused, mark as running so it can be resumed with new instructions
				if (node.status === "completed" || node.status === "paused") {
					node.status = "running" as TaskFlowNodeStatus
					delete node.completed_at
					this.updateTimestamp()

					// Try to spawn a worker if none exists
					if (node.worker_id == null) {
						await this.trySpawnReadyNodes()
					} else {
						// Resume existing paused worker
						this.bgWorkerManager.resumeWorker(node.worker_id)
					}
				}

				console.log(`[TaskFlowAgent] Node "${nodeId}" continued with additional instructions`)
				return true
			}

			/** Split a node into two or more sub-nodes (Phase 7l) */
			async splitNode(
				nodeId: string,
				splits: Array<{ id: string; description: string; type?: ParallelTaskType }>,
			): Promise<boolean> {
				const node = this.getNode(nodeId)
				if (!node || !this.bgWorkerManager) return false

				// Cancel existing worker
				if (node.worker_id != null) {
					this.bgWorkerManager.cancelWorker(node.worker_id)
				}

				// Remove original node from the workflow
				this.workflow.nodes = this.workflow.nodes.filter((n) => n.id !== nodeId)

				// Add split nodes inheriting deps from original
				for (const split of splits) {
					const newNode: TaskFlowNode = {
						id: split.id,
						taskDescription: split.description,
						type: split.type ?? node.type,
						depends_on: [...node.depends_on], // Inherit original dependencies
						status: "pending" as TaskFlowNodeStatus,
						_split_from: nodeId, // Track that this is a child of the original node
					}
					this.workflow.nodes.push(newNode)
				}

				// Update ALL downstream nodes' depends_on to point to new split IDs
				for (const n of this.workflow.nodes) {
					if (n.depends_on.includes(nodeId)) {
						const idx = n.depends_on.indexOf(nodeId)
						n.depends_on[idx] = splits[0].id // Point first split node as dependency
					}
				}

				// Cycle detection on modified graph
				const cycleResult = detectCycles(this.workflow.nodes)
				if (cycleResult.hasCycle) {
					console.warn(`[TaskFlowAgent] Cannot split "${nodeId}": ${cycleResult.cycleError}`)
					return false
				}

				this.saveWorkflow()
				await this.trySpawnReadyNodes()
				console.log(`[TaskFlowAgent] Node "${nodeId}" split into ${splits.map((s) => s.id).join(", ")}`)
				return true
			}

			/** Save workflow to disk via WorkflowFileStore (Phase 7l) */
			private saveWorkflow(): void {
				updateWorkflowFile(this.workflow)
				this.updateTimestamp()
			}

			// ─── Ready Queue Spawning ────────────────────────────────────────────────

	/** Try to spawn all ready nodes (up to maxConcurrent limit) */
	private async trySpawnReadyNodes(): Promise<void> {
		if (this.isProcessing) return

		const ready = this.getReadyNodes()
		if (ready.length === 0) return

		// Emit event for UI notification
		this.emit("readyNodesAvailable", ready)

		// Spawn all ready nodes concurrently
		await Promise.all(ready.map((rn) => this.spawnNode(rn.nodeId)))
	}

	// ─── Error Policy Resolution ─────────────────────────────────────────────

	/** Resolve error policy for a node — per-node override or type default */
	private resolveErrorPolicy(taskType: ParallelTaskType, nodeId: string): ErrorPolicy {
		// Check workflow-level per-node override first
		if (this.workflow.error_policy.per_node?.[nodeId]) {
			return this.workflow.error_policy.per_node[nodeId]
		}

		// Fall back to type default
		return DEFAULT_ERROR_POLICY_PER_TYPE[taskType] ?? DEFAULT_WORKFLOW_ERROR_POLICY
	}

	/** Update the workflow's updated_at timestamp */
	private updateTimestamp(): void {
		this.workflow.updated_at = new Date().toISOString()
	}

	// ─── Workflow Management ────────────────────────────────────────────────

	/** Add a new node to the workflow and spawn if ready */
	async addNode(
		id: string,
		taskDescription: string,
		type: ParallelTaskType,
		dependsOn: string[],
	): Promise<boolean> {
		// Validate no duplicate ID
		if (this.getNode(id)) return false

		const newNode: TaskFlowNode = {
			id,
			taskDescription,
			type,
			depends_on: dependsOn,
			status: "pending",
		}

		this.workflow.nodes.push(newNode)
		this.updateTimestamp()

		// Validate no cycles introduced
		const cycleResult = detectCycles(this.workflow.nodes)
		if (cycleResult.hasCycle) {
			this.workflow.nodes.pop() // Remove the new node
			console.warn(`[TaskFlowAgent] Cannot add node "${id}": ${cycleResult.cycleError}`)
			return false
		}

		// Try to spawn immediately if ready
		await this.trySpawnReadyNodes()
		return true
	}

	/** Check if all nodes are completed */
	isComplete(): boolean {
		return this.workflow.nodes.every((n) => n.status === "completed")
	}

	/** Check if any node has failed (and no retry policy applies) */
	hasFailed(): boolean {
		const anyFailed = this.workflow.nodes.some((n) => n.status === "failed")
		const allDone = this.workflow.nodes.every(
			(n) => ["completed", "failed", "skipped", "cancelled"].includes(n.status),
		)
		return anyFailed && allDone
	}

	// ─── Disposal ──────────────────────────────────────────────────────────────

	/** Cancel all running nodes and clean up */
	dispose(): void {
		for (const node of this.workflow.nodes) {
			if (node.status === "running" && node.worker_id != null) {
				this.bgWorkerManager.cancelWorker(node.worker_id)
			}
		}

		this.workflow.status = "cancelled" as TaskFlowWorkflowStatus
		this.updateTimestamp()
		console.log(`[TaskFlowAgent] Disposed workflow "${this.workflow.id}"`)
	}
}

// ─── Factory Function ────────────────────────────────────────────────────────

/** Create a new TaskFlowAgent from a workflow definition */
export function createTaskFlowAgent(
	provider: ClineProvider,
	bgWorkerManager: BGWorkerManager,
	workflow: TaskFlowWorkflow,
): TaskFlowAgent {
	return new TaskFlowAgent(provider, bgWorkerManager, workflow)
}

/** Create a simple linear workflow from an array of task descriptions */
export function createLinearWorkflow(
	id: string,
	name: string,
	mainTaskId: string,
	tasks: Array<{ description: string; type?: ParallelTaskType }>,
): TaskFlowWorkflow {
	const nodes: TaskFlowNode[] = []

	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i]
		// Each node depends on the previous one (linear chain)
		const dependsOn = i > 0 ? [nodes[i - 1].id] : []

		nodes.push({
			id: `step-${i + 1}`,
			taskDescription: task.description,
			type: task.type ?? Ptt.General,
			depends_on: dependsOn,
			status: "pending",
		})
	}

	return createWorkflow(id, name, mainTaskId, nodes)
}

/** Create a fan-out workflow (all nodes independent, single completion check) */
export function createFanoutWorkflow(
	id: string,
	name: string,
	mainTaskId: string,
	tasks: Array<{ description: string; type?: ParallelTaskType }>,
): TaskFlowWorkflow {
	const nodes: TaskFlowNode[] = []

	for (let i = 0; i < tasks.length; i++) {
		// All nodes have no dependencies — they all run in parallel
		nodes.push({
			id: `task-${i + 1}`,
			taskDescription: tasks[i].description,
			type: tasks[i].type ?? Ptt.General,
			depends_on: [],
			status: "pending",
		})
	}

	return createWorkflow(id, name, mainTaskId, nodes)
}
