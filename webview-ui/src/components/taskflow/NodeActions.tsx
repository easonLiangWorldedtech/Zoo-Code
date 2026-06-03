/**
 * NodeActions — Fixed action buttons + custom input for TaskFlowAgent node management.
 *
 * Phase 7l: Provides a consistent UI for pausing, resuming, cancelling, skipping,
 * restarting, continuing, splitting, and adding nodes in the workflow DAG.
 */

import React, { useState } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui"
import type { TaskFlowWorkflow, TaskFlowNodeStatus, ParallelTaskType } from "@roo-code/types"
import { TASK_TYPE_ICONS, Ptt } from "@roo-code/types"

interface NodeActionsProps {
    workflow: TaskFlowWorkflow
    workflowId?: string
}

/** Status-based button visibility rules */
const STATUS_BUTTONS: Record<TaskFlowNodeStatus, Array<{ action: string; labelKey: string }>> = {
    pending: [{ action: "cancel", labelKey: "parallelTasks:states.cancelled" }],
    waiting: [{ action: "cancel", labelKey: "parallelTasks:states.cancelled" }],
    running: [
        { action: "pause", labelKey: "parallelTasks:states.paused" },
        { action: "cancel", labelKey: "parallelTasks:states.cancelled" },
    ],
    completed: [], // No actions for completed nodes
    failed: [
        { action: "restart", labelKey: "parallelTasks:actions.restart" },
        { action: "skip", labelKey: "parallelTasks:states.skipped" },
    ],
    paused: [
        { action: "resume", labelKey: "parallelTasks:states.running" },
        { action: "cancel", labelKey: "parallelTasks:states.cancelled" },
        { action: "skip", labelKey: "parallelTasks:states.skipped" },
    ],
    skipped: [], // No actions for skipped nodes
    cancelled: [], // No actions for cancelled nodes
}

export const NodeActions: React.FC<NodeActionsProps> = ({ workflow, workflowId }) => {
    const { t } = useAppTranslation()
    const [customInput, setCustomInput] = useState<Record<string, string>>({})

    /** Send a node action to the extension */
    const sendAction = (nodeId: string, action: string, additionalPrompt?: string) => {
        if (!workflowId) return

        const payload: Record<string, unknown> = {
            type: "taskFlowAction",
            workflowId,
            nodeId,
            action,
        }

        if (additionalPrompt) {
            payload.additional_prompt = additionalPrompt
        }

        vscode.postMessage(payload as any)
    }

    /** Send a split action to the extension */
    const sendSplit = (nodeId: string, splits: Array<{ id: string; description: string; type?: string }>) => {
        if (!workflowId) return
        vscode.postMessage({
            type: "taskFlowAction",
            workflowId,
            nodeId,
            action: "split",
            splits,
        } as any)
    }

    /** Send an add node action to the extension */
    const sendAddNode = (nodeId: string, description: string, type: ParallelTaskType, dependsOn: string[]) => {
        if (!workflowId) return
        vscode.postMessage({
            type: "taskFlowAction",
            workflowId,
            nodeId: "__add__",
            action: "add",
            addNodeId: nodeId,
            addDescription: description,
            addType: type,
            dependsOn,
        } as any)
    }

    return (
        <div className="border-t border-vscode-panel-border p-3 space-y-2">
            {/* Workflow-level actions */}
            {workflow.status !== "completed" && workflow.status !== "cancelled" && (
                <div className="flex items-center gap-2 pb-2 border-b border-vscode-panel-border">
                    {workflow.status === "running" && (
                        <Button size="sm" variant="secondary" onClick={() => sendAction("__workflow__", "pause_workflow")}>
                            {t("parallelTasks:actions.pauseAll")}
                        </Button>
                    )}
                    {workflow.status === "paused" && (
                        <Button size="sm" variant="secondary" onClick={() => sendAction("__workflow__", "resume_workflow")}>
                            {t("parallelTasks:actions.resumeAll")}
                        </Button>
                    )}
                    {(workflow.status === "running" || workflow.status === "paused") && (
                        <Button size="sm" variant="secondary" onClick={() => sendAction("__workflow__", "cancel_all")}>
                            {t("parallelTasks:actions.cancelAll")}
                        </Button>
                    )}
                </div>
            )}

            {/* Per-node actions */}
            <div className="space-y-1 max-h-64 overflow-auto">
                {workflow.nodes.map((node) => {
                    const color = NODE_COLORS[node.status] ?? "#808080"
                    const icon = TASK_TYPE_ICONS[node.type as ParallelTaskType] ?? "⚙️"
                    const buttons = STATUS_BUTTONS[node.status] ?? []

                    return (
                        <div key={node.id} className="flex items-center gap-2 py-1 px-2 rounded hover:bg-vscode-list-hoverBackground">
                            {/* Status indicator */}
                            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                            <span>{icon}</span>

                            {/* Node ID + description */}
                            <span className="font-mono text-xs opacity-60">[{node.id}]</span>
                            <span className="flex-1 truncate text-sm">{node.taskDescription}</span>

                            {/* Status label */}
                            <span className="text-xs text-vscode-descriptionForeground flex-shrink-0 w-24 text-right">
                                {t(`parallelTasks:states.${node.status}`)}
                            </span>

                            {/* Action buttons */}
                            <div className="flex items-center gap-1 flex-shrink-0">
                                {buttons.map(({ action, labelKey }) => (
                                    <Button
                                        key={action}
                                        size="sm"
                                        variant="secondary"
                                        onClick={() => sendAction(node.id, action)}
                                        className="px-1.5 py-0 text-xs"
                                    >
                                        {t(labelKey)}
                                    </Button>
                                ))}

                                {/* Split button (always available for non-terminal states) */}
                                {!["completed", "cancelled"].includes(node.status) && (
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        onClick={() => sendSplit(node.id, [
                                            { id: `${node.id}-a`, description: `${node.taskDescription} — Part A` },
                                            { id: `${node.id}-b`, description: `${node.taskDescription} — Part B` },
                                        ])}
                                        className="px-1.5 py-0 text-xs"
                                    >
                                        Split
                                    </Button>
                                )}

                                {/* Add child node button */}
                                {!["completed", "cancelled"].includes(node.status) && (
                                    <AddNodeInline
                                        parentNodeId={node.id}
                                        onAdd={(newId, desc, type, deps) => sendAddNode(newId, desc, type, deps)}
                                    />
                                )}
                            </div>
                        </div>
                    )
                })}
            </div>

            {/* Custom prompt input for restart/continue */}
            <CustomPromptInput workflow={workflow} onSendAction={sendAction} />
        </div>
    )
}

/** Inline add-node input — shows a small text field when triggered */
const AddNodeInline: React.FC<{
    parentNodeId: string
    onAdd: (nodeId: string, description: string, type: ParallelTaskType, dependsOn: string[]) => void
}> = ({ parentNodeId, onAdd }) => {
    const [showInput, setShowInput] = useState(false)
    const [newNodeId, setNewNodeId] = useState("")
    const [newDesc, setNewDesc] = useState("")

    if (!showInput) {
        return (
            <Button size="sm" variant="secondary" onClick={() => setShowInput(true)} className="px-1.5 py-0 text-xs">
                + Add
            </Button>
        )
    }

    return (
        <div className="flex items-center gap-1">
            <input
                type="text"
                placeholder="ID"
                value={newNodeId}
                onChange={(e) => setNewNodeId(e.target.value)}
                className="w-12 bg-vscode-input-background border border-vscode-input-border rounded px-1 py-0.5 text-xs text-vscode-input-foreground outline-none"
            />
            <input
                type="text"
                placeholder="Description"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                className="w-24 bg-vscode-input-background border border-vscode-input-border rounded px-1 py-0.5 text-xs text-vscode-input-foreground outline-none"
            />
            <Button size="sm" variant="secondary" onClick={() => {
                if (newNodeId && newDesc) {
                    onAdd(newNodeId, newDesc, Ptt.Code, [parentNodeId])
                    setShowInput(false)
                    setNewNodeId("")
                    setNewDesc("")
                }
            }} className="px-1.5 py-0 text-xs">
                ✓
            </Button>
        </div>
    )
}

/** Custom prompt input for restart/continue actions */
const CustomPromptInput: React.FC<{
    workflow: TaskFlowWorkflow
    onSendAction: (nodeId: string, action: string, additionalPrompt?: string) => void
}> = ({ workflow, onSendAction }) => {
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
    const [promptText, setPromptText] = useState("")

    return (
        <div className="flex items-center gap-2 pt-1">
            {/* Node selector */}
            <select
                value={selectedNodeId ?? ""}
                onChange={(e) => setSelectedNodeId(e.target.value || null)}
                className="bg-vscode-input-background border border-vscode-input-border rounded px-2 py-1 text-xs text-vscode-input-foreground outline-none max-w-[120px]"
            >
                <option value="">Select node...</option>
                {workflow.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                        [{node.id}] {node.taskDescription.slice(0, 20)}
                    </option>
                ))}
            </select>

            {/* Prompt input */}
            <input
                type="text"
                placeholder="Additional instructions..."
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && selectedNodeId && promptText.trim()) {
                        onSendAction(selectedNodeId, "continue", promptText.trim())
                        setPromptText("")
                    }
                }}
                className="flex-1 bg-vscode-input-background border border-vscode-input-border rounded px-2 py-1 text-xs text-vscode-input-foreground outline-none"
            />

            {/* Action buttons */}
            {selectedNodeId && (
                <div className="flex items-center gap-1">
                    <Button size="sm" variant="secondary" onClick={() => onSendAction(selectedNodeId, "restart", promptText)} className="px-2 py-0 text-xs">
                        Restart
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => onSendAction(selectedNodeId, "continue", promptText)} className="px-2 py-0 text-xs">
                        Continue
                    </Button>
                </div>
            )}
        </div>
    )
}

/** Node colors by status (mirrors TaskFlowPanel constants) */
const NODE_COLORS: Record<TaskFlowNodeStatus, string> = {
    pending: "#808080",
    waiting: "#f0c040",
    running: "#569cd6",
    completed: "#4ec9b0",
    failed: "#f44747",
    paused: "#dcdcaa",
    skipped: "#a0a0a0",
    cancelled: "#808080",
}
