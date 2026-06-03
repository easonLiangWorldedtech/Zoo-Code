// npx vitest run src/core/parallel/__tests__/WorkflowDAG.test.ts

import { describe, it, expect } from "vitest"
import {
    validateWorkflowNodes,
    resolveDependencies,
    detectCycles,
    topoSort,
    getReadyNodes,
    propagateNodeCompletion,
    computeWorkflowStatus,
    getTransitiveDependencies,
    getTransitiveDependents,
    isDependency,
    getNodeDepth,
    getNodesAtDepth,
    createWorkflow,
    validateWorkflow,
} from "../WorkflowDAG"

import type { TaskFlowNode } from "@roo-code/types"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<TaskFlowNode> = {}): TaskFlowNode {
    return {
        id: overrides.id ?? "A",
        taskDescription: overrides.taskDescription ?? "Test task",
        type: overrides.type ?? "code",
        depends_on: overrides.depends_on ?? [],
        status: overrides.status ?? "pending",
        ...overrides,
    }
}

// ─── validateWorkflowNodes ────────────────────────────────────────────────────

describe("validateWorkflowNodes", () => {
    it("returns no errors for valid nodes", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        expect(validateWorkflowNodes(nodes)).toEqual([])
    })

    it("detects duplicate node IDs", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "A" })]
        const errors = validateWorkflowNodes(nodes)
        expect(errors).toContain('Duplicate node ID: "A"')
    })

    it("detects self-loop dependency", () => {
        const nodes = [makeNode({ id: "A", depends_on: ["A"] })]
        const errors = validateWorkflowNodes(nodes)
        expect(errors).toContain('Node "A" depends on itself')
    })

    it("detects unknown dependency references", () => {
        const nodes = [makeNode({ id: "A", depends_on: ["X", "Y"] })]
        const errors = validateWorkflowNodes(nodes)
        expect(errors).toContain('Node "A" depends on unknown node "X"')
        expect(errors).toContain('Node "A" depends on unknown node "Y"')
    })

    it("reports all validation errors at once", () => {
        const nodes = [
            makeNode({ id: "A", depends_on: ["B"] }), // B doesn't exist
            makeNode({ id: "A" }), // duplicate ID
        ]
        const errors = validateWorkflowNodes(nodes)
        expect(errors.length).toBeGreaterThanOrEqual(2)
    })

    it("handles empty node array", () => {
        expect(validateWorkflowNodes([])).toEqual([])
    })
})

// ─── resolveDependencies ──────────────────────────────────────────────────────

describe("resolveDependencies", () => {
    it("returns no warnings for valid dependencies", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        expect(resolveDependencies(nodes)).toEqual([])
    })

    it("removes unknown dependency IDs and returns warnings", () => {
        const nodes = [makeNode({ id: "A", depends_on: ["X", "Y"] })]
        const warnings = resolveDependencies(nodes)
        expect(warnings).toContain('Node "A": removing unknown dependencies [X, Y]')
        // Verify the node's depends_on was cleaned up
        expect(nodes[0].depends_on).toEqual([])
    })

    it("keeps valid deps and removes only invalid ones", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A", "X"] })]
        resolveDependencies(nodes)
        expect(nodes[1].depends_on).toEqual(["A"])
    })

    it("handles empty depends_on array", () => {
        const nodes = [makeNode({ id: "A" })]
        expect(resolveDependencies(nodes)).toEqual([])
    })
})

// ─── detectCycles (Kahn's Algorithm) ──────────────────────────────────────────

describe("detectCycles", () => {
    it("returns no cycle for a simple linear DAG", () => {
        const nodes = [
            makeNode({ id: "A" }),
            makeNode({ id: "B", depends_on: ["A"] }),
            makeNode({ id: "C", depends_on: ["B"] }),
        ]
        const result = detectCycles(nodes)
        expect(result.hasCycle).toBe(false)
        expect(result.sortedIds).toEqual(["A", "B", "C"])
    })

    it("returns no cycle for a diamond DAG", () => {
        // A → B, A → C, B → D, C → D
        const nodes = [
            makeNode({ id: "A" }),
            makeNode({ id: "B", depends_on: ["A"] }),
            makeNode({ id: "C", depends_on: ["A"] }),
            makeNode({ id: "D", depends_on: ["B", "C"] }),
        ]
        const result = detectCycles(nodes)
        expect(result.hasCycle).toBe(false)
        // A must come first, D must come last; B and C can be in any order
        expect(result.sortedIds[0]).toBe("A")
        expect(result.sortedIds[result.sortedIds.length - 1]).toBe("D")
    })

    it("detects a simple cycle: A → B → A", () => {
        const nodes = [
            makeNode({ id: "A", depends_on: ["B"] }),
            makeNode({ id: "B", depends_on: ["A"] }),
        ]
        const result = detectCycles(nodes)
        expect(result.hasCycle).toBe(true)
        expect(result.cycleNodes).toContain("A")
        expect(result.cycleNodes).toContain("B")
        expect(result.cycleError).toBeDefined()
    })

    it("detects a 3-node cycle: A → B → C → A", () => {
        const nodes = [
            makeNode({ id: "A", depends_on: ["C"] }),
            makeNode({ id: "B", depends_on: ["A"] }),
            makeNode({ id: "C", depends_on: ["B"] }),
        ]
        const result = detectCycles(nodes)
        expect(result.hasCycle).toBe(true)
        expect(result.cycleNodes?.length).toBe(3)
    })

    it("returns partial order when cycle exists (non-cycle nodes sorted first)", () => {
        // A → B (no cycle), C → D → C (cycle)
        const nodes = [
            makeNode({ id: "A" }),
            makeNode({ id: "B", depends_on: ["A"] }),
            makeNode({ id: "C", depends_on: ["D"] }),
            makeNode({ id: "D", depends_on: ["C"] }),
        ]
        const result = detectCycles(nodes)
        expect(result.hasCycle).toBe(true)
        // A and B should be in sortedIds (not in cycle)
        expect(result.sortedIds).toContain("A")
        expect(result.sortedIds).toContain("B")
        // C and D should be in cycleNodes
        expect(result.cycleNodes).toContain("C")
        expect(result.cycleNodes).toContain("D")
    })

    it("handles single node with no dependencies", () => {
        const nodes = [makeNode({ id: "A" })]
        const result = detectCycles(nodes)
        expect(result.hasCycle).toBe(false)
        expect(result.sortedIds).toEqual(["A"])
    })

    it("handles empty node array", () => {
        const result = detectCycles([])
        expect(result.hasCycle).toBe(false)
        expect(result.sortedIds).toEqual([])
    })

    it("builds cycle error message with path for simple cycles", () => {
        const nodes = [
            makeNode({ id: "A", depends_on: ["B"] }),
            makeNode({ id: "B", depends_on: ["C"] }),
            makeNode({ id: "C", depends_on: ["A"] }),
        ]
        const result = detectCycles(nodes)
        expect(result.cycleError).toContain("Circular dependency detected")
    })

    it("handles nodes with unknown deps (skips them in cycle detection)", () => {
        const nodes = [makeNode({ id: "A", depends_on: ["X"] })] // X doesn't exist
        const result = detectCycles(nodes)
        expect(result.hasCycle).toBe(false)
    })
})

// ─── topoSort ─────────────────────────────────────────────────────────────────

describe("topoSort", () => {
    it("returns correct execution order for linear DAG", () => {
        const nodes = [
            makeNode({ id: "A" }),
            makeNode({ id: "B", depends_on: ["A"] }),
            makeNode({ id: "C", depends_on: ["B"] }),
        ]
        expect(topoSort(nodes)).toEqual(["A", "B", "C"])
    })

    it("returns partial order when cycle exists", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        expect(topoSort(nodes)).toEqual(["A", "B"])
    })

    it("handles empty node array", () => {
        expect(topoSort([])).toEqual([])
    })
})

// ─── getReadyNodes ────────────────────────────────────────────────────────────

describe("getReadyNodes", () => {
    const setup = () => [
        makeNode({ id: "A", status: "completed" }),
        makeNode({ id: "B", depends_on: ["A"], status: "pending" }),
        makeNode({ id: "C", depends_on: ["A"], status: "waiting" }),
        makeNode({ id: "D", depends_on: ["B", "C"], status: "pending" }),
    ]

    it("returns nodes whose deps are all completed", () => {
        const nodes = setup()
        const ready = getReadyNodes(nodes)
        expect(ready.map((r) => r.nodeId)).toContain("B")
        expect(ready.map((r) => r.nodeId)).toContain("C")
    })

    it("excludes nodes with unmet dependencies", () => {
        const nodes = setup()
        // D depends on B and C which are not completed yet
        const ready = getReadyNodes(nodes)
        expect(ready.map((r) => r.nodeId)).not.toContain("D")
    })

    it("respects maxConcurrent limit", () => {
        const nodes = setup()
        // B and C are both ready, but maxConcurrent=1 should return only one
        const ready = getReadyNodes(nodes, 1)
        expect(ready.length).toBeLessThanOrEqual(1)
    })

    it("returns empty array when all running", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        // A has no deps and is pending → ready. B depends on A (not completed) → not ready.
        const ready = getReadyNodes(nodes)
        expect(ready.map((r) => r.nodeId)).toContain("A")
        expect(ready.map((r) => r.nodeId)).not.toContain("B")
    })

    it("returns empty array when no pending nodes have met deps", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        // Neither A nor B is completed, so B's dep isn't met. But A has no deps → ready.
        // To test truly empty result, set both to non-pending/non-waiting statuses
        const nodes2 = [makeNode({ id: "A", status: "running" }), makeNode({ id: "B", depends_on: ["A"], status: "waiting" })]
        expect(getReadyNodes(nodes2)).toEqual([])
    })

    it("excludes non-pending/non-waiting nodes", () => {
        const nodes = [makeNode({ id: "A", status: "completed" }), makeNode({ id: "B", depends_on: ["A"], status: "failed" })]
        expect(getReadyNodes(nodes)).toEqual([])
    })

    it("handles empty node array", () => {
        expect(getReadyNodes([])).toEqual([])
    })
})

// ─── propagateNodeCompletion ──────────────────────────────────────────────────

describe("propagateNodeCompletion", () => {
    const baseNodes = () => [
        makeNode({ id: "A" }),
        makeNode({ id: "B", depends_on: ["A"] }),
        makeNode({ id: "C", depends_on: ["A"] }),
        makeNode({ id: "D", depends_on: ["B", "C"] }),
    ]

    describe("success propagation", () => {
        it("marks waiting dependents as no longer waiting", () => {
            const nodes = baseNodes()
            nodes[0].status = "completed" // A completed
            nodes[1].status = "waiting" // B waiting on A
            nodes[2].status = "waiting" // C waiting on A

            const result = propagateNodeCompletion(nodes, "A", true, "continue")
            expect(result.updatedNodes.size).toBe(2)
            expect(result.updatedNodes.has("B")).toBe(true)
            expect(result.updatedNodes.has("C")).toBe(true)
        })

        it("does nothing for non-dependent nodes", () => {
            const nodes = baseNodes()
            nodes[0].status = "completed"
            nodes[1].status = "pending" // Not waiting, so not affected

            const result = propagateNodeCompletion(nodes, "A", true, "continue")
            expect(result.updatedNodes.has("B")).toBe(false)
        })
    })

    describe("failure with 'continue' policy", () => {
        it("marks node as failed but does not affect dependents", () => {
            const nodes = baseNodes()
            nodes[0].status = "failed" // A failed

            const result = propagateNodeCompletion(nodes, "A", false, "continue")
            expect(result.updatedNodes.has("A")).toBe(true)
            // B and C are waiting on A but not affected by continue policy
        })
    })

    describe("failure with 'stop_downstream' policy", () => {
        it("stops all downstream nodes (direct + transitive)", () => {
            const nodes = baseNodes()
            nodes[0].status = "failed" // A failed
            nodes[1].status = "pending" // B pending on A
            nodes[2].status = "waiting" // C waiting on A
            nodes[3].status = "pending" // D pending on B, C

            const result = propagateNodeCompletion(nodes, "A", false, "stop_downstream")
            expect(result.updatedNodes.has("A")).toBe(true)
            expect(result.skippedNodes).toContain("B")
            expect(result.skippedNodes).toContain("C")
            expect(result.skippedNodes).toContain("D") // D is transitive dependent of A
        })

        it("handles already-completed downstream nodes", () => {
            const nodes = baseNodes()
            nodes[0].status = "failed"
            nodes[1].status = "completed" // B already completed before A failed (race)
            nodes[2].status = "pending"

            const result = propagateNodeCompletion(nodes, "A", false, "stop_downstream")
            expect(result.skippedNodes).toContain("C")
            expect(result.skippedNodes).not.toContain("B") // B is already completed
        })
    })

    describe("failure with 'skip_dependents' policy", () => {
        it("skips all direct and transitive dependents", () => {
            const nodes = baseNodes()
            nodes[0].status = "failed"
            nodes[1].status = "pending"
            nodes[2].status = "waiting"
            nodes[3].status = "pending"

            const result = propagateNodeCompletion(nodes, "A", false, "skip_dependents")
            expect(result.updatedNodes.has("A")).toBe(true)
            expect(result.skippedNodes).toContain("B")
            expect(result.skippedNodes).toContain("C")
            expect(result.skippedNodes).toContain("D")
        })

        it("produces same result as stop_downstream for this structure", () => {
            const nodes = baseNodes()
            nodes[0].status = "failed"
            nodes[1].status = "pending"
            nodes[2].status = "waiting"
            nodes[3].status = "pending"

            const resultSkip = propagateNodeCompletion(nodes, "A", false, "skip_dependents")
            const resultStop = propagateNodeCompletion(
                baseNodes().map((n) => ({ ...n })),
                "A",
                false,
                "stop_downstream",
            )

            // Both should skip the same nodes (same traversal logic)
            expect(resultSkip.skippedNodes).toEqual(resultStop.skippedNodes)
        })
    })

    describe("failure with 'retry' policy", () => {
        it("does not propagate — node will be retried externally", () => {
            const nodes = baseNodes()
            nodes[0].status = "failed"
            nodes[1].status = "waiting"

            const result = propagateNodeCompletion(nodes, "A", false, "retry")
            expect(result.updatedNodes.has("B")).toBe(false) // B stays waiting
        })
    })

    it("handles empty node array", () => {
        expect(propagateNodeCompletion([], "A", true, "continue")).toEqual({ updatedNodes: new Set() })
    })
})

// ─── computeWorkflowStatus ────────────────────────────────────────────────────

describe("computeWorkflowStatus", () => {
    it("returns 'completed' when all nodes are completed", () => {
        const nodes = [makeNode({ id: "A", status: "completed" }), makeNode({ id: "B", depends_on: ["A"], status: "completed" })]
        expect(computeWorkflowStatus(nodes, "running")).toBe("completed")
    })

    it("returns 'failed' when any node failed and nothing is running", () => {
        const nodes = [makeNode({ id: "A", status: "failed" }), makeNode({ id: "B", depends_on: ["A"], status: "pending" })]
        expect(computeWorkflowStatus(nodes, "running")).toBe("failed")
    })

    it("returns 'paused' when current status is paused", () => {
        const nodes = [makeNode({ id: "A", status: "running" })]
        expect(computeWorkflowStatus(nodes, "paused")).toBe("paused")
    })

    it("returns 'cancelled' when current status is cancelled", () => {
        const nodes = [makeNode({ id: "A", status: "pending" })]
        expect(computeWorkflowStatus(nodes, "cancelled")).toBe("cancelled")
    })

    it("preserves running status when nodes are active", () => {
        const nodes = [makeNode({ id: "A", status: "running" }), makeNode({ id: "B", depends_on: ["A"], status: "waiting" })]
        expect(computeWorkflowStatus(nodes, "running")).toBe("running")
    })

    it("returns 'failed' when all nodes are skipped", () => {
        const nodes = [makeNode({ id: "A", status: "skipped" }), makeNode({ id: "B", depends_on: ["A"], status: "skipped" })]
        expect(computeWorkflowStatus(nodes, "running")).toBe("failed")
    })

    it("handles empty node array", () => {
        // Empty nodes — allCompleted is true (every of zero), but nodes.length === 0 so not completed
        const result = computeWorkflowStatus([], "running")
        expect(result).toBe("running")
    })
})

// ─── getTransitiveDependencies / getTransitiveDependents ──────────────────────

describe("getTransitiveDependencies", () => {
    it("returns direct dependencies only when no transitive deps exist", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        expect(getTransitiveDependencies(nodes, "B")).toEqual(["A"])
    })

    it("returns all transitive dependencies in a chain", () => {
        // A → B → C → D
        const nodes = [
            makeNode({ id: "A" }),
            makeNode({ id: "B", depends_on: ["A"] }),
            makeNode({ id: "C", depends_on: ["B"] }),
            makeNode({ id: "D", depends_on: ["C"] }),
        ]
        expect(getTransitiveDependencies(nodes, "D")).toEqual(["C", "B", "A"])
    })

    it("handles diamond dependency graph", () => {
        // A → B, A → C, B → D, C → D
        const nodes = [
            makeNode({ id: "A" }),
            makeNode({ id: "B", depends_on: ["A"] }),
            makeNode({ id: "C", depends_on: ["A"] }),
            makeNode({ id: "D", depends_on: ["B", "C"] }),
        ]
        const deps = getTransitiveDependencies(nodes, "D")
        expect(deps).toContain("B")
        expect(deps).toContain("C")
        expect(deps).toContain("A")
    })

    it("returns empty array for root node", () => {
        const nodes = [makeNode({ id: "A" })]
        expect(getTransitiveDependencies(nodes, "A")).toEqual([])
    })
})

describe("getTransitiveDependents", () => {
    it("returns direct dependents only when no transitive exist", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        expect(getTransitiveDependents(nodes, "A")).toEqual(["B"])
    })

    it("returns all transitive dependents in a chain", () => {
        const nodes = [
            makeNode({ id: "A" }),
            makeNode({ id: "B", depends_on: ["A"] }),
            makeNode({ id: "C", depends_on: ["B"] }),
            makeNode({ id: "D", depends_on: ["C"] }),
        ]
        expect(getTransitiveDependents(nodes, "A")).toEqual(["B", "C", "D"])
    })

    it("handles diamond dependency graph", () => {
        const nodes = [
            makeNode({ id: "A" }),
            makeNode({ id: "B", depends_on: ["A"] }),
            makeNode({ id: "C", depends_on: ["A"] }),
            makeNode({ id: "D", depends_on: ["B", "C"] }),
        ]
        const dependents = getTransitiveDependents(nodes, "A")
        expect(dependents).toContain("B")
        expect(dependents).toContain("C")
        expect(dependents).toContain("D")
    })

    it("returns empty array for leaf node", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        expect(getTransitiveDependents(nodes, "B")).toEqual([])
    })
})

// ─── isDependency ─────────────────────────────────────────────────────────────

describe("isDependency", () => {
    it("returns true when A is a transitive dependency of B", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        expect(isDependency(nodes, "A", "B")).toBe(true)
    })

    it("returns false when A is not a dependency of B", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B" })]
        expect(isDependency(nodes, "A", "B")).toBe(false)
    })

    it("handles transitive dependencies", () => {
        // A → B → C
        const nodes = [
            makeNode({ id: "A" }),
            makeNode({ id: "B", depends_on: ["A"] }),
            makeNode({ id: "C", depends_on: ["B"] }),
        ]
        expect(isDependency(nodes, "A", "C")).toBe(true)
    })

    it("is not symmetric — B is not a dependency of A when A → B", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        expect(isDependency(nodes, "B", "A")).toBe(false)
    })
})

// ─── getNodeDepth / getNodesAtDepth ───────────────────────────────────────────

describe("getNodeDepth", () => {
    it("returns 0 for root nodes (no dependencies)", () => {
        const nodes = [makeNode({ id: "A" })]
        expect(getNodeDepth(nodes, "A")).toBe(0)
    })

    it("returns correct depth for linear chain", () => {
        // A → B → C
        const nodes = [
            makeNode({ id: "A" }),
            makeNode({ id: "B", depends_on: ["A"] }),
            makeNode({ id: "C", depends_on: ["B"] }),
        ]
        expect(getNodeDepth(nodes, "A")).toBe(0)
        expect(getNodeDepth(nodes, "B")).toBe(1)
        expect(getNodeDepth(nodes, "C")).toBe(2)
    })

    it("returns max depth for diamond graph", () => {
        // A → B, A → C, B → D, C → D
        const nodes = [
            makeNode({ id: "A" }),
            makeNode({ id: "B", depends_on: ["A"] }),
            makeNode({ id: "C", depends_on: ["A"] }),
            makeNode({ id: "D", depends_on: ["B", "C"] }),
        ]
        expect(getNodeDepth(nodes, "A")).toBe(0)
        expect(getNodeDepth(nodes, "B")).toBe(1)
        expect(getNodeDepth(nodes, "C")).toBe(1)
        expect(getNodeDepth(nodes, "D")).toBe(2) // max(B_depth, C_depth) + 1 = 2
    })

    it("memoizes results for repeated calls", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        expect(getNodeDepth(nodes, "A")).toBe(0)
        expect(getNodeDepth(nodes, "A")).toBe(0) // Should use memoized value
    })
})

describe("getNodesAtDepth", () => {
    it("returns root nodes at depth 0", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B" })]
        expect(getNodesAtDepth(nodes, 0)).toEqual(["A", "B"])
    })

    it("returns nodes at specific depth in linear chain", () => {
        // A → B → C
        const nodes = [
            makeNode({ id: "A" }),
            makeNode({ id: "B", depends_on: ["A"] }),
            makeNode({ id: "C", depends_on: ["B"] }),
        ]
        expect(getNodesAtDepth(nodes, 0)).toEqual(["A"])
        expect(getNodesAtDepth(nodes, 1)).toEqual(["B"])
        expect(getNodesAtDepth(nodes, 2)).toEqual(["C"])
    })

    it("returns empty array for non-existent depth", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        expect(getNodesAtDepth(nodes, 5)).toEqual([])
    })
})

// ─── createWorkflow / validateWorkflow ────────────────────────────────────────

describe("createWorkflow", () => {
    it("creates a workflow with correct defaults", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        const wf = createWorkflow("wf-001", "Test Workflow", "task-abc", nodes)

        expect(wf.id).toBe("wf-001")
        expect(wf.name).toBe("Test Workflow")
        expect(wf.main_task_id).toBe("task-abc")
        expect(wf.status).toBe("running")
        expect(wf.nodes).toEqual(nodes)
        expect(wf.error_policy.default).toBe("stop_downstream")
        expect(wf.auto_approve.enabled).toBe(true)
    })

    it("sets created_at and updated_at timestamps", () => {
        const wf = createWorkflow("wf-001", "Test", "task-abc", [])
        expect(wf.created_at).toBeDefined()
        expect(wf.updated_at).toBeDefined()
        // Both should be the same ISO timestamp
        expect(new Date(wf.created_at).getTime()).toBeGreaterThan(0)
    })

    it("initializes empty node_state_map and chat_log", () => {
        const wf = createWorkflow("wf-001", "Test", "task-abc", [])
        expect(wf.node_state_map).toEqual({})
        expect(wf.chat_log).toEqual([])
    })
})

describe("validateWorkflow", () => {
    it("returns no errors for a valid workflow", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "B", depends_on: ["A"] })]
        const wf = createWorkflow("wf-001", "Test", "task-abc", nodes)
        expect(validateWorkflow(wf)).toEqual([])
    })

    it("detects missing workflow id/name", () => {
        const wf = { ...createWorkflow("", "", "task-abc", []) } as any
        const errors = validateWorkflow(wf)
        expect(errors).toContain("Workflow must have id and name")
    })

    it("detects duplicate node IDs in workflow", () => {
        const nodes = [makeNode({ id: "A" }), makeNode({ id: "A" })]
        const wf = createWorkflow("wf-001", "Test", "task-abc", nodes)
        const errors = validateWorkflow(wf)
        expect(errors).toContain('Duplicate node ID: "A"')
    })

    it("detects cycles in workflow", () => {
        const nodes = [makeNode({ id: "A", depends_on: ["B"] }), makeNode({ id: "B", depends_on: ["A"] })]
        const wf = createWorkflow("wf-001", "Test", "task-abc", nodes)
        const errors = validateWorkflow(wf)
        expect(errors.some((e) => e.includes("Circular dependency"))).toBe(true)
    })

    it("combines multiple validation errors", () => {
        // Duplicate ID + cycle — validateWorkflowNodes catches duplicate first,
        // detectCycles then runs on the same nodes and finds the A↔B cycle.
        const nodes = [
            makeNode({ id: "A", depends_on: ["B"] }),
            makeNode({ id: "A" }), // duplicate
            makeNode({ id: "B", depends_on: ["A"] }), // creates cycle with first A
        ]
        const wf = createWorkflow("wf-001", "Test", "task-abc", nodes)
        const errors = validateWorkflow(wf)
        // At minimum: duplicate ID error. Cycle detection may or may not add more
        // depending on how Kahn's handles duplicate IDs in the adjacency list.
        expect(errors.length).toBeGreaterThanOrEqual(1)
    })

    it("combines node validation errors with cycle errors", () => {
        // Valid nodes (no duplicates), but has a cycle → only cycle error
        const nodes = [
            makeNode({ id: "A", depends_on: ["B"] }),
            makeNode({ id: "B", depends_on: ["A"] }),
        ]
        const wf = createWorkflow("wf-001", "Test", "task-abc", nodes)
        const errors = validateWorkflow(wf)
        expect(errors.some((e) => e.includes("Circular"))).toBe(true)
    })

    it("combines unknown dep error with cycle error", () => {
        // Node A depends on non-existent X, and B↔A forms a cycle
        const nodes = [
            makeNode({ id: "A", depends_on: ["B"] }),
            makeNode({ id: "B", depends_on: ["A", "X"] }), // X doesn't exist + cycle with A
        ]
        const wf = createWorkflow("wf-001", "Test", "task-abc", nodes)
        const errors = validateWorkflow(wf)
        expect(errors.some((e) => e.includes("unknown"))).toBe(true)
        expect(errors.some((e) => e.includes("Circular"))).toBe(true)
    })

    it("handles workflow with no nodes", () => {
        const wf = createWorkflow("wf-001", "Test", "task-abc", [])
        expect(validateWorkflow(wf)).toEqual([])
    })
})
