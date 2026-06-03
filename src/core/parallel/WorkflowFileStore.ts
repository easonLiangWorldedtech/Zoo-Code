/**
 * WorkflowFileStore — CRUD operations for workflow JSON files.
 *
 * Phase 7b: Persistent storage layer for TaskFlowAgent workflows.
 * All workflow files stored in `~/.hermes/zoo-code/workflows/`.
 */

import * as fs from "fs"
import * as path from "path"

import type { TaskFlowWorkflow } from "@roo-code/types"

// ─── Constants ────────────────────────────────────────────────────────────────

/** Base directory for workflow JSON files (user's home, not repo) */
const WORKFLOWS_DIR = path.join(
    process.env.HOME ?? "/tmp",
    ".hermes",
    "zoo-code",
    "workflows",
)

/** File extension for workflow definitions */
const WORKFLOW_FILE_EXT = ".json"

/** Maximum number of workflows to keep in the listing (most recent first) */
const MAX_WORKFLOWS_LISTED = 50

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Ensure the workflows directory exists, creating it if necessary */
function ensureDir(): void {
    if (!fs.existsSync(WORKFLOWS_DIR)) {
        fs.mkdirSync(WORKFLOWS_DIR, { recursive: true })
    }
}

/** Build the full file path for a workflow ID */
function workflowFilePath(workflowId: string): string {
    return path.join(WORKFLOWS_DIR, `${workflowId}${WORKFLOW_FILE_EXT}`)
}

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * Write a new workflow to disk.
 * Returns the file path on success, or null if write failed.
 */
export function createWorkflowFile(workflow: TaskFlowWorkflow): string | null {
    try {
        ensureDir()
        const filePath = workflowFilePath(workflow.id)

        // Overwrite if exists (idempotent — caller should check first)
        fs.writeFileSync(filePath, JSON.stringify(workflow, null, 2), "utf-8")
        return filePath
    } catch (error) {
        console.error(`[WorkflowFileStore] Failed to create workflow "${workflow.id}":`, error)
        return null
    }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read a single workflow by ID from disk.
 * Returns the parsed workflow, or null if not found / invalid JSON.
 */
export function readWorkflowFile(workflowId: string): TaskFlowWorkflow | null {
    try {
        const filePath = workflowFilePath(workflowId)

        if (!fs.existsSync(filePath)) {
            return null
        }

        const raw = fs.readFileSync(filePath, "utf-8")
        const parsed = JSON.parse(raw) as unknown

        // Basic shape validation — must have id and nodes array
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            !("id" in parsed) ||
            !Array.isArray((parsed as Record<string, unknown>).nodes)
        ) {
            console.warn(`[WorkflowFileStore] Invalid workflow file for "${workflowId}"`)
            return null
        }

        return parsed as TaskFlowWorkflow
    } catch (error) {
        console.error(`[WorkflowFileStore] Failed to read workflow "${workflowId}":`, error)
        return null
    }
}

/**
 * Read all available workflows from disk.
 * Returns an array sorted by updated_at descending (most recent first).
 */
export function listWorkflows(): TaskFlowWorkflow[] {
    try {
        ensureDir()

        const files = fs.readdirSync(WORKFLOWS_DIR)
            .filter((f) => f.endsWith(WORKFLOW_FILE_EXT))
            .map((f) => path.basename(f, WORKFLOW_FILE_EXT))

        const workflows: TaskFlowWorkflow[] = []

        for (const id of files) {
            const workflow = readWorkflowFile(id)
            if (workflow) {
                workflows.push(workflow)
            }
        }

        // Sort by updated_at descending (most recent first), cap at MAX_WORKFLOWS_LISTED
        workflows.sort((a, b) => {
            const aTime = new Date(a.updated_at).getTime()
            const bTime = new Date(b.updated_at).getTime()
            return bTime - aTime
        })

        return workflows.slice(0, MAX_WORKFLOWS_LISTED)
    } catch (error) {
        console.error("[WorkflowFileStore] Failed to list workflows:", error)
        return []
    }
}

// ─── Update ───────────────────────────────────────────────────────────────────

/**
 * Update an existing workflow on disk.
 * Writes the full workflow object (not a partial update).
 * Returns true on success, false if write failed.
 */
export function updateWorkflowFile(workflow: TaskFlowWorkflow): boolean {
    try {
        const filePath = workflowFilePath(workflow.id)

        // Verify file exists before updating
        if (!fs.existsSync(filePath)) {
            console.warn(`[WorkflowFileStore] Cannot update "${workflow.id}" — file not found`)
            return false
        }

        fs.writeFileSync(filePath, JSON.stringify(workflow, null, 2), "utf-8")
        return true
    } catch (error) {
        console.error(`[WorkflowFileStore] Failed to update workflow "${workflow.id}":`, error)
        return false
    }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * Delete a workflow file from disk.
 * Returns true if deleted, false if not found or delete failed.
 */
export function deleteWorkflowFile(workflowId: string): boolean {
    try {
        const filePath = workflowFilePath(workflowId)

        if (!fs.existsSync(filePath)) {
            return false
        }

        fs.unlinkSync(filePath)
        return true
    } catch (error) {
        console.error(`[WorkflowFileStore] Failed to delete workflow "${workflowId}":`, error)
        return false
    }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Get the base directory path for workflows (useful for tests / external access) */
export function getWorkflowsDir(): string {
    return WORKFLOWS_DIR
}
