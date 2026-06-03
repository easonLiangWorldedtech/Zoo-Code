/**
 * WorkflowDAG — DAG parser, topological sort (Kahn's algorithm), cycle detection,
 * and ready queue resolver for TaskFlowAgent workflows.
 *
 * Phase 7a: TaskFlowAgent core infrastructure.
 */

import type {
    ErrorPolicy,
    ParallelTaskType,
    TaskFlowNode,
    TaskFlowNodeStatus,
    TaskFlowReadyNode,
    TaskFlowWorkflow,
    TaskFlowWorkflowStatus,
} from "@roo-code/types"

import {
    DEFAULT_ERROR_POLICY_PER_TYPE,
    DEFAULT_WORKFLOW_AUTO_APPROVE,
} from "@roo-code/types"

// ─── DAG Validation & Parsing ────────────────────────────────────────────────

/** Validate a workflow's node structure — checks for duplicate IDs, missing deps, self-loops */
export function validateWorkflowNodes(nodes: TaskFlowNode[]): string[] {
    const errors: string[] = []

    // Collect all valid IDs first (before checking dependencies)
    const idSet = new Set<string>()
    for (const node of nodes) {
        if (idSet.has(node.id)) {
            errors.push(`Duplicate node ID: "${node.id}"`)
        }
        idSet.add(node.id)
    }

    // Now check each node's properties against the full set
    for (const node of nodes) {
        // Check self-loop
        if (node.depends_on.includes(node.id)) {
            errors.push(`Node "${node.id}" depends on itself`)
        }

        // Check that all dependency IDs exist in the node set
        for (const depId of node.depends_on) {
            if (!idSet.has(depId)) {
                errors.push(`Node "${node.id}" depends on unknown node "${depId}"`)
            }
        }
    }

    return errors
}

/** Resolve dependency references — ensures all depends_on IDs exist in the node set */
export function resolveDependencies(nodes: TaskFlowNode[]): string[] {
    const idSet = new Set(nodes.map((n) => n.id))
    const warnings: string[] = []

    for (const node of nodes) {
        const validDeps = node.depends_on.filter((depId) => idSet.has(depId))
        const removed = node.depends_on.filter((depId) => !idSet.has(depId))

        if (removed.length > 0) {
            warnings.push(
                `Node "${node.id}": removing unknown dependencies [${removed.join(", ")}]`,
            )
            node.depends_on = validDeps
        }
    }

    return warnings
}

// ─── Cycle Detection (Kahn's Algorithm) ──────────────────────────────────────

/**
 * Detect cycles in the DAG using Kahn's algorithm.
 * Returns sortedIds if no cycle, or cycleNodes + error message if cycle detected.
 */
export function detectCycles(nodes: TaskFlowNode[]): {
    hasCycle: boolean
    sortedIds: string[]
    cycleNodes?: string[]
    cycleError?: string
} {
    const idSet = new Set(nodes.map((n) => n.id))
    const adjMap = new Map<string, string[]>() // node → list of dependents (reverse edges)
    const inDegree = new Map<string, number>()

    // Build adjacency list and in-degree count
    for (const node of nodes) {
        if (!adjMap.has(node.id)) {
            adjMap.set(node.id, [])
        }
        inDegree.set(node.id, 0)

        for (const depId of node.depends_on) {
            if (!idSet.has(depId)) continue // Skip unknown deps (already warned)

            if (!adjMap.has(depId)) {
                adjMap.set(depId, [])
            }
            // depId → node.id means "depId must complete before node"
            adjMap.get(depId)!.push(node.id)
            inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1)
        }
    }

    // Initialize queue with nodes that have no dependencies (in-degree = 0)
    const queue: string[] = []
    for (const [nodeId, degree] of inDegree.entries()) {
        if (degree === 0) {
            queue.push(nodeId)
        }
    }

    // Process queue — Kahn's algorithm
    const sortedIds: string[] = []
    while (queue.length > 0) {
        const current = queue.shift()!
        sortedIds.push(current)

        for (const dependent of adjMap.get(current) ?? []) {
            inDegree.set(dependent, inDegree.get(dependent)! - 1)
            if (inDegree.get(dependent) === 0) {
                queue.push(dependent)
            }
        }
    }

    // If sortedIds doesn't contain all nodes, there's a cycle
    const hasCycle = sortedIds.length !== idSet.size

    if (hasCycle) {
        const cycleNodes = Array.from(idSet).filter((id) => !sortedIds.includes(id))
        return {
            hasCycle: true,
            sortedIds,
            cycleNodes,
            cycleError: buildCycleErrorMessage(nodes, cycleNodes),
        }
    }

    return { hasCycle: false, sortedIds }
}

/** Build a human-readable error message for detected cycles */
function buildCycleErrorMessage(
    nodes: TaskFlowNode[],
    cycleNodes: string[],
): string {
    // Try to trace the actual cycle path
    const cycleSet = new Set(cycleNodes)
    let cyclePath: string[] = []

    // DFS from first cycle node to find a cycle path
    function dfsTrace(
        current: string,
        visited: Set<string>,
        path: string[],
    ): boolean {
        if (cyclePath.length > 0) return true // Already found

        for (const depId of nodes.find((n) => n.id === current)?.depends_on ?? []) {
            if (!cycleSet.has(depId)) continue

            if (depId === path[0]) {
                cyclePath = [...path, depId]
                return true
            }

            if (!visited.has(depId)) {
                visited.add(depId)
                path.push(depId)
                if (dfsTrace(depId, visited, path)) return true
                path.pop()
                visited.delete(depId)
            }
        }
        return false
    }

    const startNode = cycleNodes[0]
    dfsTrace(startNode, new Set([startNode]), [startNode])

    if (cyclePath.length > 0) {
        return `Circular dependency detected: ${cyclePath.join(" → ")}`
    }

    // Fallback: just list the nodes involved in cycles
    return `Circular dependency involving nodes: ${cycleNodes.join(", ")}`
}

// ─── Topological Sort (for execution order) ──────────────────────────────────

/**
 * Perform topological sort on workflow nodes.
 * Returns sorted node IDs — ready-to-execute nodes come first.
 */
export function topoSort(nodes: TaskFlowNode[]): string[] {
    const result = detectCycles(nodes)
    if (result.hasCycle) {
        // Return partial order anyway (nodes not in cycles, plus cycle nodes at end)
        return [...result.sortedIds, ...(result.cycleNodes ?? [])]
    }
    return result.sortedIds
}

// ─── Ready Queue Resolver ────────────────────────────────────────────────────

/**
 * Determine which nodes are ready to execute.
 * A node is "ready" when:
 *  - Its status is "pending" or "waiting"
 *  - All its dependencies have status "completed"
 */
export function getReadyNodes(
    nodes: TaskFlowNode[],
    maxConcurrent?: number,
): TaskFlowReadyNode[] {
    const completedSet = new Set(nodes.filter((n) => n.status === "completed").map((n) => n.id))
    const runningCount = nodes.filter((n) => n.status === "running").length

    // Respect maxConcurrent limit
    if (maxConcurrent !== undefined && runningCount >= maxConcurrent) {
        return []
    }

    const ready: TaskFlowReadyNode[] = []

    for (const node of nodes) {
        if (node.status !== "pending" && node.status !== "waiting") continue

        // Check if all dependencies are completed
        const depsMet = node.depends_on.every((depId) => completedSet.has(depId))

        if (depsMet) {
            ready.push({ nodeId: node.id, node })
        }
    }

    // Enforce maxConcurrent limit on the ready queue itself
    if (maxConcurrent !== undefined) {
        const availableSlots = Math.max(0, maxConcurrent - runningCount)
        return ready.slice(0, availableSlots)
    }

    return ready
}

/**
 * Update node statuses based on a completed/failed node.
 * Handles error_policy propagation (skip_dependents, stop_downstream).
 */
export function propagateNodeCompletion(
    nodes: TaskFlowNode[],
    completedNodeId: string,
    success: boolean,
    errorPolicy: ErrorPolicy,
): { updatedNodes: Set<string>; skippedNodes?: string[] } {
    const updatedNodes = new Set<string>()

    if (!success) {
        // Handle failure propagation based on error policy
        switch (errorPolicy) {
            case "continue":
                // Just mark this node as failed, don't affect dependents
                updatedNodes.add(completedNodeId)
                break

            case "stop_downstream": {
                // Stop all downstream nodes that depend on this one (directly or transitively)
                const stopped = stopDownstream(nodes, completedNodeId)
                updatedNodes.add(completedNodeId)
                return { updatedNodes, skippedNodes: stopped }
            }

            case "skip_dependents": {
                // Skip all direct and transitive dependents
                const skipped = skipDependents(nodes, completedNodeId)
                updatedNodes.add(completedNodeId)
                return { updatedNodes, skippedNodes: skipped }
            }

            case "retry":
                // Don't propagate — the node will be retried externally
                updatedNodes.add(completedNodeId)
                return { updatedNodes }
        }
    }

    // On success, mark dependents as no longer waiting (they become ready)
    for (const node of nodes) {
        if (node.status === "waiting" && node.depends_on.includes(completedNodeId)) {
            updatedNodes.add(node.id)
        }
    }

    return { updatedNodes }
}

/** Stop all downstream nodes (direct + transitive) — set to "skipped" */
function stopDownstream(nodes: TaskFlowNode[], startId: string): string[] {
    const stopped: string[] = []
    const visited = new Set<string>()

    function traverse(nodeId: string) {
        for (const node of nodes) {
            if (visited.has(node.id)) continue
            if (!node.depends_on.includes(nodeId)) continue

            visited.add(node.id)
            if (node.status === "pending" || node.status === "waiting") {
                node.status = "skipped"
                stopped.push(node.id)
            }
            traverse(node.id) // Recurse for transitive dependents
        }
    }

    traverse(startId)
    return stopped
}

/** Skip all direct and transitive dependents — same as stopDownstream but with skip semantics */
function skipDependents(nodes: TaskFlowNode[], startId: string): string[] {
    return stopDownstream(nodes, startId)
}

// ─── Workflow Status Computation ─────────────────────────────────────────────

/** Compute overall workflow status from node statuses */
export function computeWorkflowStatus(
    nodes: TaskFlowNode[],
    currentStatus: TaskFlowWorkflowStatus,
): TaskFlowWorkflowStatus {
    const allCompleted = nodes.every((n) => n.status === "completed")
    const anyFailed = nodes.some((n) => n.status === "failed")
    const anyRunning = nodes.some(
        (n) => n.status === "running" || n.status === "waiting",
    )

    if (allCompleted && nodes.length > 0) return "completed"
    if (anyFailed && !anyRunning) return "failed"
    if (currentStatus === "paused") return "paused"
    if (currentStatus === "cancelled") return "cancelled"
    if (anyRunning || anyFailed) return currentStatus

    // All pending/waiting but nothing running yet — still running (waiting for deps)
    const hasPendingOrWaiting = nodes.some(
        (n) => n.status === "pending" || n.status === "waiting",
    )
    if (hasPendingOrWaiting && !allCompleted) return currentStatus

    // Edge case: all skipped (e.g., first node failed with stop_downstream)
    const allSkipped = nodes.every((n) => n.status === "skipped")
    if (allSkipped && nodes.length > 0) return "failed"

    return currentStatus
}

// ─── Dependency Graph Utilities ──────────────────────────────────────────────

/** Get all transitive dependencies of a node (direct + indirect) */
export function getTransitiveDependencies(
    nodes: TaskFlowNode[],
    nodeId: string,
): string[] {
    const result: string[] = []
    const visited = new Set<string>()

    function collect(nodeId: string) {
        for (const depId of nodes.find((n) => n.id === nodeId)?.depends_on ?? []) {
            if (visited.has(depId)) continue
            visited.add(depId)
            result.push(depId)
            collect(depId)
        }
    }

    collect(nodeId)
    return result
}

/** Get all transitive dependents of a node (direct + indirect) */
export function getTransitiveDependents(
    nodes: TaskFlowNode[],
    nodeId: string,
): string[] {
    const result: string[] = []
    const visited = new Set<string>()

    function collect(nodeId: string) {
        for (const node of nodes) {
            if (visited.has(node.id)) continue
            if (!node.depends_on.includes(nodeId)) continue

            visited.add(node.id)
            result.push(node.id)
            collect(node.id)
        }
    }

    collect(nodeId)
    return result
}

/** Check if node A must execute before node B (A is a transitive dependency of B) */
export function isDependency(
    nodes: TaskFlowNode[],
    nodeIdA: string,
    nodeIdB: string,
): boolean {
    const deps = getTransitiveDependencies(nodes, nodeIdB)
    return deps.includes(nodeIdA)
}

/** Get the execution depth of a node (longest path from any root to this node) */
export function getNodeDepth(nodes: TaskFlowNode[], nodeId: string): number {
    const memo = new Map<string, number>()

    function compute(id: string): number {
        if (memo.has(id)) return memo.get(id)!

        const node = nodes.find((n) => n.id === id)
        if (!node || node.depends_on.length === 0) {
            memo.set(id, 0)
            return 0
        }

        const maxDepDepth = Math.max(
            ...node.depends_on.map((depId) => compute(depId)),
        )
        memo.set(id, maxDepDepth + 1)
        return maxDepDepth + 1
    }

    return compute(nodeId)
}

/** Get nodes at a specific execution depth (useful for parallel scheduling) */
export function getNodesAtDepth(nodes: TaskFlowNode[], depth: number): string[] {
    return nodes
        .filter((n) => getNodeDepth(nodes, n.id) === depth)
        .map((n) => n.id)
}

// ─── Workflow JSON Serialization Helpers ─────────────────────────────────────

/** Create a new workflow from node definitions */
export function createWorkflow(
    id: string,
    name: string,
    mainTaskId: string,
    nodes: TaskFlowNode[],
): TaskFlowWorkflow {
    const now = new Date().toISOString()

    return {
        id,
        name,
        main_task_id: mainTaskId,
        status: "running",
        created_at: now,
        updated_at: now,
        auto_approve: DEFAULT_WORKFLOW_AUTO_APPROVE,
        error_policy: { default: "stop_downstream" },
        nodes,
        node_state_map: {},
        chat_log: [],
    }
}

/** Validate a complete workflow object */
export function validateWorkflow(workflow: TaskFlowWorkflow): string[] {
    const errors: string[] = []

    if (!workflow.id || !workflow.name) {
        errors.push("Workflow must have id and name")
        return errors
    }

    // Validate nodes
    const nodeErrors = validateWorkflowNodes(workflow.nodes)
    errors.push(...nodeErrors)

    // Check for cycles
    const cycleResult = detectCycles(workflow.nodes)
    if (cycleResult.hasCycle) {
        errors.push(cycleResult.cycleError ?? "Circular dependency detected")
    }

    return errors
}
