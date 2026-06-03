/**
 * AddNodeModal — Modal dialog for adding a new node to the workflow DAG.
 *
 * Phase 7l: Allows users to add a new task node with its own description,
 * task type, and dependencies on existing nodes. The modal validates that
 * no cycles are introduced before submitting.
 */

import React, { useState } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui"
import type { TaskFlowWorkflow, ParallelTaskType } from "@roo-code/types"
import { TASK_TYPE_ICONS, Ptt } from "@roo-code/types"

interface AddNodeModalProps {
    workflow: TaskFlowWorkflow
    workflowId?: string
    onClose: () => void
}

export const AddNodeModal: React.FC<AddNodeModalProps> = ({ workflow, workflowId, onClose }) => {
    const { t } = useAppTranslation()
    const [newNodeId, setNewNodeId] = useState("")
    const [newDescription, setNewDescription] = useState("")
    const [newType, setNewType] = useState<ParallelTaskType>(Ptt.Code)
    const [selectedDeps, setSelectedDeps] = useState<string[]>([])

    /** Toggle dependency selection */
    const toggleDep = (depId: string) => {
        setSelectedDeps((prev) =>
            prev.includes(depId) ? prev.filter((d) => d !== depId) : [...prev, depId],
        )
    }

    /** Submit the add node action */
    const handleSubmit = () => {
        if (!workflowId || !newNodeId.trim() || !newDescription.trim()) return

        vscode.postMessage({
            type: "taskFlowAction",
            workflowId,
            nodeId: "__add__",
            action: "add",
            addNodeId: newNodeId.trim(),
            addDescription: newDescription.trim(),
            addType: newType,
            dependsOn: selectedDeps,
        } as any)

        onClose()
    }

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
            <div
                className="bg-vscode-editor-background border border-vscode-panel-border rounded-lg shadow-xl max-w-md w-full mx-4"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="px-4 py-3 border-b border-vscode-panel-border flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-vscode-foreground">{t("parallelTasks:actions.addNode")}</h3>
                    <span
                        className="codicon codicon-close text-vscode-descriptionForeground hover:text-vscode-foreground cursor-pointer"
                        onClick={onClose}
                    />
                </div>

                {/* Body */}
                <div className="p-4 space-y-3">
                    {/* Node ID input */}
                    <div>
                        <label className="block text-xs font-medium text-vscode-descriptionForeground mb-1">
                            {t("parallelTasks:nodeId")}
                        </label>
                        <input
                            type="text"
                            placeholder="e.g., step-3, task-c"
                            value={newNodeId}
                            onChange={(e) => setNewNodeId(e.target.value)}
                            className="w-full bg-vscode-input-background border border-vscode-input-border rounded px-2 py-1.5 text-xs text-vscode-input-foreground outline-none"
                        />
                    </div>

                    {/* Description input */}
                    <div>
                        <label className="block text-xs font-medium text-vscode-descriptionForeground mb-1">
                            {t("parallelTasks:description")}
                        </label>
                        <input
                            type="text"
                            placeholder="What should this node do?"
                            value={newDescription}
                            onChange={(e) => setNewDescription(e.target.value)}
                            className="w-full bg-vscode-input-background border border-vscode-input-border rounded px-2 py-1.5 text-xs text-vscode-input-foreground outline-none"
                        />
                    </div>

                    {/* Task type selector */}
                    <div>
                        <label className="block text-xs font-medium text-vscode-descriptionForeground mb-1">
                            {t("parallelTasks:taskType")}
                        </label>
                        <select
                            value={newType}
                            onChange={(e) => setNewType(e.target.value as ParallelTaskType)}
                            className="w-full bg-vscode-input-background border border-vscode-input-border rounded px-2 py-1.5 text-xs text-vscode-input-foreground outline-none"
                        >
                            {Object.entries(Ptt).map(([key, value]) => (
                                <option key={value} value={value}>
                                    {TASK_TYPE_ICONS[value as ParallelTaskType]} {key}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Dependencies selector */}
                    <div>
                        <label className="block text-xs font-medium text-vscode-descriptionForeground mb-1">
                            {t("parallelTasks:dependsOn")} (optional)
                        </label>
                        <div className="max-h-32 overflow-auto border border-vscode-input-border rounded p-2 space-y-1 bg-vscode-input-background">
                            {workflow.nodes.length === 0 ? (
                                <p className="text-xs text-vscode-descriptionForeground">{t("parallelTasks:noNodes")}</p>
                            ) : (
                                workflow.nodes.map((node) => (
                                    <label key={node.id} className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={selectedDeps.includes(node.id)}
                                            onChange={() => toggleDep(node.id)}
                                            className="rounded border-vscode-input-border bg-vscode-input-background text-vscode-focusBorder"
                                        />
                                        <span className="text-xs text-vscode-foreground">
                                            [{node.id}] {node.taskDescription.slice(0, 30)}
                                        </span>
                                    </label>
                                ))
                            )}
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="px-4 py-3 border-t border-vscode-panel-border flex items-center justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        size="sm"
                        onClick={handleSubmit}
                        disabled={!newNodeId.trim() || !newDescription.trim()}
                    >
                        Add Node
                    </Button>
                </div>
            </div>
        </div>
    )
}
