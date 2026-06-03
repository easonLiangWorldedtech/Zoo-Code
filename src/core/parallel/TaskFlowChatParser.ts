/**
 * TaskFlowChatParser — Chat command parser for TaskFlowAgent workflow control.
 *
 * Phase 7e: Parses natural language (zh/en) and slash commands into structured
 * actions that the TaskFlowAgent can execute. Includes an AI options system
 * for disambiguation when user intent is unclear.
 *
 * Architecture:
 *   User input → parseChatInput() → { action, nodeId?, params? } | null
 *              → generateOptions() → numbered choices for ambiguous inputs
 */

import type { ParallelTaskType } from "@roo-code/types"
import { ParallelTaskType as Ptt } from "@roo-code/types"

// ─── Action Types ──────────────────────────────────────────────────────────────

/** Supported TaskFlowAgent actions */
export type TaskFlowAction =
    | "pause"       // Pause a node's worker
    | "resume"      // Resume a paused node
    | "cancel"      // Cancel a node and its worker
    | "skip"        // Skip a node (mark as skipped, propagate to dependents)
    | "rerun"       // Rerun a node with different type/mode
    | "add_node"    // Add a new node to the workflow
    | "list"        // List all nodes and their status
    | "status"      // Show current workflow status

/** Parsed chat input result */
export interface TaskFlowParsedInput {
    /** The action to perform */
    action: TaskFlowAction
    /** Target node ID (for actions that target a specific node) */
    nodeId?: string
    /** Additional parameters (e.g., task description for add_node, type for rerun) */
    params?: Record<string, string>
}

/** AI-generated options for disambiguation */
export interface TaskFlowOption {
    /** Display number [1], [2], etc. */
    number: number
    /** Human-readable label */
    label: string
    /** Parsed result if user selects this option */
    parsedInput: TaskFlowParsedInput
}

// ─── Node Status Keywords (zh + en) ────────────────────────────────────────────

/** Common keywords for node status in both languages */
const STATUS_KEYWORDS = {
    running: ["running", "run", "active", "執行中", "運行中", "進行中"],
    paused: ["paused", "pause", "暫停", "擱置"],
    completed: ["completed", "done", "finished", "完成", "已完成"],
    failed: ["failed", "fail", "error", "失敗", "錯誤"],
    pending: ["pending", "waiting", "待處理", "等待中"],
} as const

// ─── Action Keywords (zh + en) ────────────────────────────────────────────────

/** Maps action names to their keywords in both languages */
const ACTION_KEYWORDS: Record<TaskFlowAction, string[]> = {
    pause: ["pause", "暫停", "擱置", "stop"],
    cancel: ["cancel", "取消", "中止", "abort"],
    skip: ["skip", "跳過", "略過", "bypass"],
    rerun: ["rerun", "重新執行", "重做", "retry", "redo"],
    resume: ["resume", "繼續", "恢復", "restart", "re-run"],
    add_node: ["add", "新增", "加入", "create", "new", "新建"],
    list: ["list", "列出", "顯示所有", "show all"],
    status: ["status", "狀態", "check", "檢查"],
}

// ─── Node ID Pattern ──────────────────────────────────────────────────────────

/** Match node IDs like "A", "B1", "step-3" — alphanumeric with optional hyphens/underscores */
const NODE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/

// ─── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse a chat input string into a structured TaskFlow action.
 * Supports both slash commands (/pause A) and natural language (暫停 A).
 */
export function parseChatInput(input: string): TaskFlowParsedInput | null {
    const trimmed = input.trim()
    if (!trimmed) return null

    // Check for slash command first
    if (trimmed.startsWith("/")) {
        return parseSlashCommand(trimmed.slice(1))
    }

    // Try natural language parsing
    return parseNaturalLanguage(trimmed)
}

/** Parse a slash command like "pause A" or "/rerun B search" */
function parseSlashCommand(command: string): TaskFlowParsedInput | null {
    const parts = command.trim().split(/\s+/)
    if (parts.length === 0) return null

    const actionName = parts[0].toLowerCase() as TaskFlowAction
    const nodeId = parts[1]
    const extraParam = parts.slice(2).join(" ")

    // Validate action
    if (!ACTION_KEYWORDS[actionName]) {
        return null
    }

    // Validate node ID (required for most actions)
    if (nodeId && !NODE_ID_PATTERN.test(nodeId)) {
        return null
    }

    const result: TaskFlowParsedInput = { action: actionName, nodeId: nodeId || undefined }

    // Handle extra params
    if (extraParam) {
        if (actionName === "add_node") {
            result.params = { taskDescription: extraParam }
        } else if (actionName === "rerun") {
            const type = parseTaskType(extraParam)
            if (type) {
                result.params = { type }
            }
        }
    }

    return result
}

/** Parse natural language input like "暫停 B" or "Pause C with search mode" */
function parseNaturalLanguage(input: string): TaskFlowParsedInput | null {
    const lower = input.toLowerCase()

    // Try to find an action keyword first
    let matchedAction: TaskFlowAction | null = null
    for (const [action, keywords] of Object.entries(ACTION_KEYWORDS)) {
        if (keywords.some((kw) => lower.includes(kw))) {
            matchedAction = action as TaskFlowAction
            break
        }
    }

    if (!matchedAction) return null

    // Extract node ID from the input
    const words = input.split(/\s+/)
    let nodeId: string | undefined

    for (const word of words) {
        // Skip action keywords and common stop words
        const allKeywords = Object.values(ACTION_KEYWORDS).flat()
        if (allKeywords.includes(word.toLowerCase())) continue
        if (
            [
                "with",
                "用",
                "使用",
                "in",
                "the",
                "a",
                "an",
                "new",
                "新",
                "個",
                "將",
                "要",
            ].includes(word.toLowerCase())
        ) continue

        // Check if this looks like a node ID
        if (NODE_ID_PATTERN.test(word)) {
            nodeId = word
            break
        }
    }

    const result: TaskFlowParsedInput = { action: matchedAction, nodeId }

    // Extract extra params for specific actions
    if (matchedAction === "add_node" && input) {
        // Try to extract task description after the action keyword
        const descMatch = input.match(/(?:新增|加入|create|new)\s+(.+)$/i)
        if (descMatch) {
            result.params = { taskDescription: descMatch[1].trim() }
        }
    }

    if (matchedAction === "rerun" && nodeId) {
        // Try to extract type after node ID
        const typeMatch = input.match(new RegExp(`${nodeId}\\s+(?:用|with|using)?\\s*(search|doc|code|debug|commit|general)`))
        if (typeMatch) {
            const type = parseTaskType(typeMatch[1])
            if (type) {
                result.params = { type }
            }
        }
    }

    return result
}

/** Parse a task type string to ParallelTaskType enum value */
function parseTaskType(input: string): ParallelTaskType | undefined {
    const lower = input.toLowerCase()
    for (const [key, value] of Object.entries(Ptt)) {
        if (typeof value === "string" && value.toLowerCase() === lower) {
            return value as ParallelTaskType
        }
        if (key.toLowerCase() === lower) {
            return value as ParallelTaskType
        }
    }
    return undefined
}

// ─── AI Options System ────────────────────────────────────────────────────────

/**
 * Generate numbered options for ambiguous user input.
 * Called when the agent needs to ask the user to clarify their intent.
 */
export function generateOptions(
    action: TaskFlowAction,
    nodes: Array<{ id: string; status: string }>,
): TaskFlowOption[] {
    const options: TaskFlowOption[] = []

    switch (action) {
        case "pause":
        case "resume":
        case "cancel":
        case "skip":
            // List all running/paused nodes as options
            const targetNodes = nodes.filter((n) =>
                action === "pause" ? n.status === "running" :
                action === "resume" ? n.status === "paused" :
                true, // cancel/skip: any node
            )

            for (const node of targetNodes.slice(0, 8)) {
                options.push({
                    number: options.length + 1,
                    label: `${node.id} (${node.status})`,
                    parsedInput: { action, nodeId: node.id },
                })
            }
            break

        case "rerun":
            // List all completed/failed nodes as rerun candidates
            const rerunnable = nodes.filter((n) => n.status === "completed" || n.status === "failed")
            for (const node of rerunnable.slice(0, 8)) {
                options.push({
                    number: options.length + 1,
                    label: `${node.id} (${node.status})`,
                    parsedInput: { action: "rerun", nodeId: node.id },
                })
            }
            break

        case "add_node":
            // No specific nodes to choose from — user provides description
            options.push({
                number: 1,
                label: "Add new node (provide description)",
                parsedInput: { action: "add_node" },
            })
            break

        default:
            break
    }

    return options
}

/**
 * Resolve a numbered option selection back to a TaskFlowParsedInput.
 */
export function resolveOptionSelection(
    options: TaskFlowOption[],
    selection: number,
): TaskFlowParsedInput | null {
    const option = options.find((o) => o.number === selection)
    return option ? option.parsedInput : null
}
