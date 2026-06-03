/**
 * Tests for WorkflowFileStore — CRUD operations for workflow JSON files.
 * Phase 7b: Workflow file persistence layer.
 */

import * as fs from "fs"
import * as path from "path"

import type { TaskFlowWorkflow } from "@roo-code/types"
import { ParallelTaskType as Ptt, DEFAULT_WORKFLOW_AUTO_APPROVE } from "@roo-code/types"

import {
    createWorkflowFile,
    readWorkflowFile,
    updateWorkflowFile,
    deleteWorkflowFile,
    listWorkflows,
} from "../WorkflowFileStore"

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/** Create a minimal valid workflow for testing */
function createTestWorkflow(overrides?: Partial<TaskFlowWorkflow>): TaskFlowWorkflow {
    return {
        id: "test-wf-001",
        name: "Test Workflow",
        main_task_id: "task-test-001",
        status: "running",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        auto_approve: DEFAULT_WORKFLOW_AUTO_APPROVE,
        error_policy: { default: "stop_downstream" },
        nodes: [
            {
                id: "A",
                taskDescription: "Analyze structure",
                type: Ptt.Search,
                depends_on: [],
                status: "pending",
            },
            {
                id: "B",
                taskDescription: "Write code",
                type: Ptt.Code,
                depends_on: ["A"],
                status: "pending",
            },
        ],
        node_state_map: {},
        chat_log: [],
        ...overrides,
    }
}

/** Clean all test workflow files from disk (test isolation) */
function cleanTestWorkflows(): void {
    const workflowsDir = path.join(
        process.env.HOME ?? "/tmp",
        ".hermes",
        "zoo-code",
        "workflows",
    )
    if (!fs.existsSync(workflowsDir)) return

    const files = fs.readdirSync(workflowsDir)
    for (const file of files) {
        try {
            fs.unlinkSync(path.join(workflowsDir, file))
        } catch {
            // Ignore cleanup errors
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WorkflowFileStore", () => {
    beforeAll(() => {
        cleanTestWorkflows()
    })

    beforeEach(() => {
        // Clean up all workflow files before each test for isolation
        cleanTestWorkflows()
    })

    afterAll(() => {
        // Final cleanup
        cleanTestWorkflows()
    })

    describe("createWorkflowFile", () => {
        it("should create a workflow file on disk", () => {
            const workflow = createTestWorkflow({ id: "wf-create-test" })
            const result = createWorkflowFile(workflow)

            expect(result).not.toBeNull()
            expect(fs.existsSync(result!)).toBe(true)

            // Verify content matches
            const raw = fs.readFileSync(result!, "utf-8")
            const parsed = JSON.parse(raw) as TaskFlowWorkflow
            expect(parsed.id).toBe("wf-create-test")
            expect(parsed.name).toBe("Test Workflow")
            expect(parsed.nodes.length).toBe(2)
        })

        it("should handle long workflow IDs", () => {
            // Use a very long ID — exceeds ext4 max filename (255 bytes)
            const longId = "w".repeat(300)
            const workflow = createTestWorkflow({ id: longId })
            const result = createWorkflowFile(workflow)

            // Should return null when filename is too long for the filesystem
            expect(result).toBeNull()
        })

        it("should handle write errors gracefully", () => {
            // Create a workflow normally first
            const workflow = createTestWorkflow({ id: "wf-write-error" })
            const result = createWorkflowFile(workflow)
            expect(result).not.toBeNull()

            // Verify the file was created
            expect(fs.existsSync(result!)).toBe(true)
        })

        it("should overwrite existing file with same ID", () => {
            const wf1 = createTestWorkflow({ id: "wf-overwrite" })
            createWorkflowFile(wf1)

            // Update the workflow
            const wf2 = createTestWorkflow({
                id: "wf-overwrite",
                name: "Updated Workflow",
                status: "completed",
            })
            const result = createWorkflowFile(wf2)

            expect(result).not.toBeNull()
            const raw = fs.readFileSync(result!, "utf-8")
            const parsed = JSON.parse(raw) as TaskFlowWorkflow
            expect(parsed.name).toBe("Updated Workflow")
            expect(parsed.status).toBe("completed")
        })
    })

    describe("readWorkflowFile", () => {
        it("should read a workflow that was previously created", () => {
            const workflow = createTestWorkflow({ id: "wf-read-test" })
            createWorkflowFile(workflow)

            const result = readWorkflowFile("wf-read-test")

            expect(result).not.toBeNull()
            if (result) {
                expect(result.id).toBe("wf-read-test")
                expect(result.name).toBe("Test Workflow")
                expect(result.nodes.length).toBe(2)
            }
        })

        it("should return null for non-existent workflow", () => {
            const result = readWorkflowFile("non-existent-wf")
            expect(result).toBeNull()
        })

        it("should handle corrupted JSON gracefully", () => {
            // Write invalid JSON directly to the workflows directory
            const workflowsDir = path.join(
                process.env.HOME ?? "/tmp",
                ".hermes",
                "zoo-code",
                "workflows",
            )
            fs.mkdirSync(workflowsDir, { recursive: true })
            const filePath = path.join(workflowsDir, "wf-corrupt.json")
            fs.writeFileSync(filePath, "{ invalid json }", "utf-8")

            const result = readWorkflowFile("wf-corrupt")
            expect(result).toBeNull()
        })

        it("should handle malformed workflow shape", () => {
            // Write a JSON object without required fields
            const workflowsDir = path.join(
                process.env.HOME ?? "/tmp",
                ".hermes",
                "zoo-code",
                "workflows",
            )
            fs.mkdirSync(workflowsDir, { recursive: true })
            const filePath = path.join(workflowsDir, "wf-malformed.json")
            fs.writeFileSync(filePath, JSON.stringify({ name: "No ID" }), "utf-8")

            const result = readWorkflowFile("wf-malformed")
            expect(result).toBeNull()
        })
    })

    describe("updateWorkflowFile", () => {
        it("should update an existing workflow file", () => {
            const wf1 = createTestWorkflow({ id: "wf-update-test" })
            createWorkflowFile(wf1)

            // Update the workflow
            const wf2 = createTestWorkflow({
                id: "wf-update-test",
                name: "Updated via updateWorkflowFile",
                status: "paused",
            })
            const result = updateWorkflowFile(wf2)

            expect(result).toBe(true)

            // Verify the update persisted
            const readBack = readWorkflowFile("wf-update-test")
            expect(readBack).not.toBeNull()
            if (readBack) {
                expect(readBack.name).toBe("Updated via updateWorkflowFile")
                expect(readBack.status).toBe("paused")
            }
        })

        it("should return false for non-existent workflow", () => {
            const wf = createTestWorkflow({ id: "wf-nonexistent-update" })
            const result = updateWorkflowFile(wf)
            expect(result).toBe(false)
        })

        it("should preserve unchanged fields during update", () => {
            const wf1 = createTestWorkflow({ id: "wf-preserve-test" })
            createWorkflowFile(wf1)

            // Update only name and status, keep nodes intact
            const wf2 = createTestWorkflow({
                id: "wf-preserve-test",
                name: "Partially Updated",
                status: "completed",
            })
            updateWorkflowFile(wf2)

            const readBack = readWorkflowFile("wf-preserve-test")
            expect(readBack).not.toBeNull()
            if (readBack) {
                expect(readBack.name).toBe("Partially Updated")
                expect(readBack.status).toBe("completed")
                // Nodes should still have 2 entries
                expect(readBack.nodes.length).toBe(2)
                // First node should still be Search type
                expect(readBack.nodes[0].type).toBe(Ptt.Search)
            }
        })
    })

    describe("deleteWorkflowFile", () => {
        it("should delete an existing workflow file", () => {
            const workflow = createTestWorkflow({ id: "wf-delete-test" })
            createWorkflowFile(workflow)

            const workflowsDir = path.join(
                process.env.HOME ?? "/tmp",
                ".hermes",
                "zoo-code",
                "workflows",
            )
            expect(fs.existsSync(path.join(workflowsDir, "wf-delete-test.json"))).toBe(true)

            const result = deleteWorkflowFile("wf-delete-test")
            expect(result).toBe(true)
            expect(fs.existsSync(path.join(workflowsDir, "wf-delete-test.json"))).toBe(false)
        })

        it("should return false for non-existent workflow", () => {
            const result = deleteWorkflowFile("non-existent-wf-2")
            expect(result).toBe(false)
        })

        it("should not affect other workflows when deleting one", () => {
            createWorkflowFile(createTestWorkflow({ id: "wf-delete-a" }))
            createWorkflowFile(createTestWorkflow({ id: "wf-delete-b" }))

            deleteWorkflowFile("wf-delete-a")

            // B should still exist
            const b = readWorkflowFile("wf-delete-b")
            expect(b).not.toBeNull()
        })
    })

    describe("listWorkflows", () => {
        it("should list all workflows sorted by updated_at descending", () => {
            const now = new Date().toISOString()
            const olderTime = new Date(Date.now() - 60000).toISOString() // 1 minute ago

            createWorkflowFile({
                ...createTestWorkflow({ id: "wf-list-older" }),
                updated_at: olderTime,
            })

            createWorkflowFile({
                ...createTestWorkflow({ id: "wf-list-newer" }),
                updated_at: now,
            })

            const workflows = listWorkflows()

            expect(workflows.length).toBe(2)
            // Most recent first
            expect(workflows[0].id).toBe("wf-list-newer")
            expect(workflows[1].id).toBe("wf-list-older")
        })

        it("should return empty array when no workflows exist", () => {
            const workflows = listWorkflows()
            expect(workflows.length).toBe(0)
        })

        it("should skip invalid workflow files in listing", () => {
            // Create a valid workflow
            createWorkflowFile(createTestWorkflow({ id: "wf-list-valid" }))

            // Write an invalid file directly to the workflows directory
            const workflowsDir = path.join(
                process.env.HOME ?? "/tmp",
                ".hermes",
                "zoo-code",
                "workflows",
            )
            fs.mkdirSync(workflowsDir, { recursive: true })
            const filePath = path.join(workflowsDir, "wf-list-invalid.json")
            fs.writeFileSync(filePath, "{ bad json }", "utf-8")

            const workflows = listWorkflows()
            expect(workflows.length).toBe(1)
            expect(workflows[0].id).toBe("wf-list-valid")
        })

        it("should cap results at MAX_WORKFLOWS_LISTED (50)", () => {
            // Create 55 workflows
            for (let i = 0; i < 55; i++) {
                createWorkflowFile({
                    ...createTestWorkflow({ id: `wf-list-cap-${i}` }),
                    updated_at: new Date(Date.now() - i * 1000).toISOString(),
                })
            }

            const workflows = listWorkflows()
            expect(workflows.length).toBe(50) // Capped at MAX_WORKFLOWS_LISTED
        })
    })

    describe("getWorkflowsDir", () => {
        it("should return the base directory path", () => {
            const workflowsDir = path.join(
                process.env.HOME ?? "/tmp",
                ".hermes",
                "zoo-code",
                "workflows",
            )
            expect(workflowsDir).toContain(".hermes")
            expect(workflowsDir).toContain("workflows")
        })
    })

    describe("integration: full CRUD cycle", () => {
        it("should support create → read → update → delete lifecycle", () => {
            const id = "wf-lifecycle-test"

            // Create
            const wf1 = createTestWorkflow({ id })
            expect(createWorkflowFile(wf1)).not.toBeNull()

            // Read back
            const read1 = readWorkflowFile(id)
            expect(read1).not.toBeNull()
            if (read1) {
                expect(read1.status).toBe("running")
            }

            // Update
            const wf2 = createTestWorkflow({ id, status: "completed", name: "Done" })
            expect(updateWorkflowFile(wf2)).toBe(true)

            const read2 = readWorkflowFile(id)
            expect(read2).not.toBeNull()
            if (read2) {
                expect(read2.status).toBe("completed")
                expect(read2.name).toBe("Done")
            }

            // Delete
            expect(deleteWorkflowFile(id)).toBe(true)
            expect(readWorkflowFile(id)).toBeNull()
        })
    })
})
