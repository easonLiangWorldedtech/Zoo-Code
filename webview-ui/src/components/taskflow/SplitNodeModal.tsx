/**
 * SplitNodeModal — Modal dialog for splitting a node into multiple sub-nodes.
 *
 * Phase 7l: Allows users to split a workflow node into two or more child nodes,
 * each with its own description and task type. The original node is replaced by
 * the new split nodes which inherit the original's dependencies.
 */

import React, { useState } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui"
import type { ParallelTaskType } from "@roo-code/types"
import { TASK_TYPE_ICONS, Ptt } from "@roo-code/types"

interface SplitNodeModalProps {
    workflowId?: string
    nodeId: string
    nodeDescription: string
    onClose: () => void
}

export const SplitNodeModal: React.FC<SplitNodeModalProps> = ({ workflowId, nodeId, nodeDescription, onClose }) => {
    const { t } = useAppTranslation()
    const [splits, setSplits] = useState<Array<{ id: string; description: string; type: ParallelTaskType }>>([
        { id: `${nodeId}-a`, description: `${nodeDescription} — Part A`, type: Ptt.Code },
        { id: `${nodeId}-b`, description: `${nodeDescription} — Part B`, type: Ptt.Code },
    ])

    /** Add a new split slot */
    const addSplit = () => {
        setSplits((prev) => [
            ...prev,
            {
                id: `${nodeId}-${String.fromCharCode(97 + prev.length)}`,
                description: "",
                type: Ptt.Code,
            },
        ])
    }

    /** Remove a split slot */
    const removeSplit = (index: number) => {
        if (splits.length <= 2) return // Keep at least 2 splits
        setSplits((prev) => prev.filter((_, i) => i !== index))
    }

    /** Update a split field */
    const updateSplit = (index: number, field: "id" | "description" | "type", value: string) => {
        setSplits((prev) => {
            const updated = [...prev]
            if (field === "type") {
                updated[index] = { ...updated[index], [field]: value as ParallelTaskType }
            } else {
                updated[index] = { ...updated[index], [field]: value }
            }
            return updated
        })
    }

    /** Submit the split action */
    const handleSubmit = () => {
        // Validate all splits have IDs and descriptions
        const validSplits = splits.filter((s) => s.id.trim() && s.description.trim())
        if (validSplits.length < 2) return

        vscode.postMessage({
            type: "taskFlowAction",
            workflowId,
            nodeId,
            action: "split",
            splits: validSplits.map((s) => ({ id: s.id, description: s.description, type: s.type })),
        } as any)

        onClose()
    }

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
            <div
                className="bg-vscode-editor-background border border-vscode-panel-border rounded-lg shadow-xl max-w-lg w-full mx-4"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="px-4 py-3 border-b border-vscode-panel-border flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-vscode-foreground">{t("parallelTasks:actions.splitNode")}</h3>
                    <span
                        className="codicon codicon-close text-vscode-descriptionForeground hover:text-vscode-foreground cursor-pointer"
                        onClick={onClose}
                    />
                </div>

                {/* Body */}
                <div className="p-4 space-y-3 max-h-[60vh] overflow-auto">
                    <p className="text-xs text-vscode-descriptionForeground">
                        Node [{nodeId}] will be replaced by {splits.length} sub-nodes. Original dependencies are inherited.
                    </p>

                    {/* Split slots */}
                    {splits.map((split, index) => (
                        <div key={index} className="flex items-start gap-2 p-2 rounded bg-vscode-editor-background border border-vscode-input-border">
                            {/* Remove button */}
                            {splits.length > 2 && (
                                <Button size="sm" variant="secondary" onClick={() => removeSplit(index)} className="px-1.5 py-0 text-xs flex-shrink-0">
                                    ×
                                </Button>
                            )}

                            {/* ID input */}
                            <input
                                type="text"
                                placeholder="Node ID"
                                value={split.id}
                                onChange={(e) => updateSplit(index, "id", e.target.value)}
                                className="flex-1 bg-vscode-input-background border border-vscode-input-border rounded px-2 py-1 text-xs text-vscode-input-foreground outline-none min-w-[60px]"
                            />

                            {/* Type selector */}
                            <select
                                value={split.type}
                                onChange={(e) => updateSplit(index, "type", e.target.value)}
                                className="bg-vscode-input-background border border-vscode-input-border rounded px-2 py-1 text-xs text-vscode-input-foreground outline-none w-24"
                            >
                                {Object.entries(Ptt).map(([key, value]) => (
                                    <option key={value} value={value}>
                                        {TASK_TYPE_ICONS[value as ParallelTaskType]} {key}
                                    </option>
                                ))}
                            </select>

                            {/* Description input */}
                            <input
                                type="text"
                                placeholder="Description"
                                value={split.description}
                                onChange={(e) => updateSplit(index, "description", e.target.value)}
                                className="flex-[2] bg-vscode-input-background border border-vscode-input-border rounded px-2 py-1 text-xs text-vscode-input-foreground outline-none min-w-[100px]"
                            />
                        </div>
                    ))}

                    {/* Add split button */}
                    <Button size="sm" variant="secondary" onClick={addSplit} className="w-full">
                        + Add Split
                    </Button>
                </div>

                {/* Footer */}
                <div className="px-4 py-3 border-t border-vscode-panel-border flex items-center justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button size="sm" onClick={handleSubmit} disabled={splits.some((s) => !s.id.trim() || !s.description.trim())}>
                        Split Node
                    </Button>
                </div>
            </div>
        </div>
    )
}
