/**
 * TaskFlowPanel — DAG visualization (3 levels) + chat interface for TaskFlowAgent.
 *
 * Phase 7f: Three visualization modes:
 *   - simple: Text-based tree/list, low resource
 *   - graph: SVG Mermaid-style diagram with nodes + edges (default)
 *   - interactive: Full drag-and-drop DAG editor with zoom/pan
 */

import React, { useCallback, useEffect, useMemo, useState } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui"
import type { TaskFlowWorkflow, TaskFlowNodeStatus, ParallelTaskType } from "@roo-code/types"
import { TASK_TYPE_ICONS, Ptt } from "@roo-code/types"
import { SplitNodeModal } from "./SplitNodeModal"
import { AddNodeModal } from "./AddNodeModal"

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Node colors by status */
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

/** Node border colors by status */
const NODE_BORDER_COLORS: Record<TaskFlowNodeStatus, string> = {
    pending: "#505050",
    waiting: "#c09020",
    running: "#3a7cbf",
    completed: "#2d8a6e",
    failed: "#c42020",
    paused: "#b0a040",
    skipped: "#707070",
    cancelled: "#505050",
}

// ─── Types ──────────────────────────────────────────────────────────────────────

type VisualizationLevel = "simple" | "graph" | "interactive"

interface TaskFlowPanelProps {
    workflowId?: string
    onClose?: () => void
}

// ─── Helper Functions ───────────────────────────────────────────────────────────

/** Get topological order of nodes (Kahn's algorithm) */
function getTopoOrder(nodes: Array<{ id: string; depends_on: string[] }>): string[] {
    const inDegree = new Map<string, number>()
    const adjList = new Map<string, string[]>()

    for (const node of nodes) {
        if (!inDegree.has(node.id)) inDegree.set(node.id, 0)
        if (!adjList.has(node.id)) adjList.set(node.id, [])
    }

    for (const node of nodes) {
        for (const depId of node.depends_on) {
            if (adjList.has(depId)) {
                adjList.get(depId)!.push(node.id)
            }
            inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1)
        }
    }

    const queue: string[] = []
    for (const [id, degree] of inDegree.entries()) {
        if (degree === 0) queue.push(id)
    }

    const order: string[] = []
    while (queue.length > 0) {
        const current = queue.shift()!
        order.push(current)
        for (const neighbor of adjList.get(current) ?? []) {
            inDegree.set(neighbor, inDegree.get(neighbor)! - 1)
            if (inDegree.get(neighbor) === 0) {
                queue.push(neighbor)
            }
        }
    }

    return order
}

/** Get all transitive dependents of a node */
function getTransitiveDependents(nodes: Array<{ id: string; depends_on: string[] }>, nodeId: string): string[] {
    const adjList = new Map<string, string[]>()
    for (const node of nodes) {
        if (!adjList.has(node.id)) adjList.set(node.id, [])
        for (const depId of node.depends_on) {
            if (adjList.has(depId)) {
                adjList.get(depId)!.push(node.id)
            }
        }
    }

    const visited = new Set<string>()
    const queue: string[] = [nodeId]

    while (queue.length > 0) {
        const current = queue.shift()!
        if (visited.has(current)) continue
        visited.add(current)
        for (const dep of adjList.get(current) ?? []) {
            if (!visited.has(dep)) {
                queue.push(dep)
            }
        }
    }

    visited.delete(nodeId) // Remove the source node itself
    return Array.from(visited)
}

/** Format milliseconds to human-readable duration */
function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
}

// ─── Simple Visualization (Text Tree) ──────────────────────────────────────────

/** Render a simple text-based tree visualization of the DAG */
const SimpleVisualization: React.FC<{
    workflow: TaskFlowWorkflow
    onNodeAction?: (nodeId: string, action: string) => void
}> = ({ workflow, onNodeAction }) => {
    const { t } = useAppTranslation()
    const topoOrder = useMemo(() => getTopoOrder(workflow.nodes), [workflow.nodes])

    // Build parent-child map for tree rendering
    const childrenMap = useMemo(() => {
        const map = new Map<string, string[]>()
        for (const node of workflow.nodes) {
            if (!map.has(node.id)) map.set(node.id, [])
            for (const depId of node.depends_on) {
                if (map.has(depId)) {
                    if (!map.get(depId)!.includes(node.id)) {
                        map.get(depId)!.push(node.id)
                    }
                }
            }
        }
        return map
    }, [workflow.nodes])

    // Find root nodes (no dependencies)
    const rootNodes = useMemo(
        () => workflow.nodes.filter((n) => n.depends_on.length === 0).map((n) => n.id),
        [workflow.nodes],
    )

    /** Recursively render a node and its children */
    function renderNode(nodeId: string, depth: number): React.ReactNode {
        const node = workflow.nodes.find((n) => n.id === nodeId)
        if (!node) return null

        const color = NODE_COLORS[node.status] ?? "#808080"
        const icon = TASK_TYPE_ICONS[node.type as ParallelTaskType] ?? "⚙️"
        const indent = "\u00A0\u00A0".repeat(depth)

        return (
            <div key={nodeId} style={{ marginLeft: depth * 24 }}>
                {/* Node row */}
                <div className="flex items-center gap-2 py-1">
                    <span
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: color }}
                    />
                    <span>{icon}</span>
                    <span className="font-mono text-xs opacity-60">[{node.id}]</span>
                    <span className="flex-1 truncate">{node.taskDescription}</span>
                    <span className="text-xs text-vscode-descriptionForeground flex-shrink-0">
                        {t(`parallelTasks:states.${node.status}`)}
                    </span>

                    {/* Split button */}
                    {!["completed", "cancelled"].includes(node.status) && (
                        <button
                            onClick={() => onNodeAction?.(node.id, "split")}
                            className="text-xs text-vscode-button-foreground bg-vscode-button-background px-1.5 py-0 rounded hover:bg-vscode-button-hoverBackground"
                        >
                            Split
                        </button>
                    )}

                    {/* Add child button */}
                    {!["completed", "cancelled"].includes(node.status) && (
                        <button
                            onClick={() => onNodeAction?.(node.id, "add")}
                            className="text-xs text-vscode-button-foreground bg-vscode-button-background px-1.5 py-0 rounded hover:bg-vscode-button-hoverBackground"
                        >
                            + Add
                        </button>
                    )}
                </div>

                {/* Children */}
                {(childrenMap.get(nodeId) ?? []).map((childId) => renderNode(childId, depth + 1))}
            </div>
        )
    }

    return (
        <div className="p-3 font-mono text-sm space-y-1">
            {/* Workflow header */}
            <div className="pb-2 border-b border-vscode-panel-border mb-2">
                <div className="font-bold">{workflow.name}</div>
                <div className="text-xs text-vscode-descriptionForeground">
                    {t(`parallelTasks:states.${workflow.status}`)} · {workflow.nodes.length} nodes
                </div>
            </div>

            {/* Tree */}
            {rootNodes.map((id) => renderNode(id, 0))}

            {/* Legend */}
            <div className="pt-2 mt-2 border-t border-vscode-panel-border text-xs text-vscode-descriptionForeground">
                {t("parallelTasks:taskFlow.legend")}
            </div>
        </div>
    )
}

// ─── Graph Visualization (SVG Mermaid-style) ────────────────────────────────────

/** Render a graph visualization using SVG with nodes and edges */
const GraphVisualization: React.FC<{
    workflow: TaskFlowWorkflow
    onNodeAction?: (nodeId: string, action: string) => void
}> = ({ workflow, onNodeAction }) => {
    const { t } = useAppTranslation()
    const topoOrder = useMemo(() => getTopoOrder(workflow.nodes), [workflow.nodes])

    // Compute node positions based on topological order + depth
    const nodePositions = useMemo(() => {
        const positions = new Map<string, { x: number; y: number }>()
        const childrenMap = new Map<string, string[]>()

        for (const node of workflow.nodes) {
            if (!childrenMap.has(node.id)) childrenMap.set(node.id, [])
            for (const depId of node.depends_on) {
                if (childrenMap.has(depId)) {
                    childrenMap.get(depId)!.push(node.id)
                }
            }
        }

        // Assign layers based on longest path from roots
        const layer = new Map<string, number>()
        const queue: string[] = []

        for (const node of workflow.nodes) {
            if (node.depends_on.length === 0) {
                layer.set(node.id, 0)
                queue.push(node.id)
            } else {
                layer.set(node.id, -1) // Not yet computed
            }
        }

        while (queue.length > 0) {
            const current = queue.shift()!
            const currentLayer = layer.get(current)!
            for (const child of childrenMap.get(current) ?? []) {
                const newLayer = Math.max(layer.get(child) ?? -1, currentLayer + 1)
                layer.set(child, newLayer)
                if (!queue.includes(child)) {
                    queue.push(child)
                }
            }
        }

        // Group nodes by layer
        const layers = new Map<number, string[]>()
        for (const node of workflow.nodes) {
            const l = layer.get(node.id) ?? 0
            if (!layers.has(l)) layers.set(l, [])
            layers.get(l)!.push(node.id)
        }

        // Assign positions
        const nodeWidth = 160
        const nodeHeight = 48
        const hGap = 24
        const vGap = 72

        for (const [layerNum, nodeIds] of layers.entries()) {
            const totalWidth = nodeIds.length * nodeWidth + (nodeIds.length - 1) * hGap
            const startX = Math.max(0, (800 - totalWidth) / 2) // Center in canvas

            for (let i = 0; i < nodeIds.length; i++) {
                positions.set(nodeIds[i], {
                    x: startX + i * (nodeWidth + hGap),
                    y: layerNum * vGap,
                })
            }
        }

        return positions
    }, [workflow.nodes])

    // Build edges from dependencies
    const edges = useMemo(() => {
        const result: Array<{ from: string; to: string }> = []
        for (const node of workflow.nodes) {
            for (const depId of node.depends_on) {
                result.push({ from: depId, to: node.id })
            }
        }
        return result
    }, [workflow.nodes])

    const canvasWidth = 800
    const canvasHeight = Math.max(200, (Math.max(...Array.from(nodePositions.values()).map((p) => p.y)) / 72 + 1) * 72 + 60)

    return (
        <div className="overflow-auto">
            {/* Workflow header */}
            <div className="px-4 py-3 border-b border-vscode-panel-border bg-vscode-editor-background/50">
                <div className="font-bold">{workflow.name}</div>
                <div className="text-xs text-vscode-descriptionForeground flex items-center gap-2">
                    <span>{t(`parallelTasks:states.${workflow.status}`)}</span>
                    <span>·</span>
                    <span>{workflow.nodes.length} {t("parallelTasks:taskFlow.nodes")}</span>
                </div>
            </div>

            {/* SVG Graph */}
            <svg
                width={canvasWidth}
                height={canvasHeight}
                className="mx-auto"
                style={{ background: "transparent" }}
            >
                {/* Edges */}
                {edges.map((edge, i) => {
                    const fromPos = nodePositions.get(edge.from)
                    const toPos = nodePositions.get(edge.to)
                    if (!fromPos || !toPos) return null

                    const fromNodeWidth = 160
                    const fromNodeHeight = 48
                    const startX = fromPos.x + fromNodeWidth / 2
                    const startY = fromPos.y + fromNodeHeight
                    const endX = toPos.x + fromNodeWidth / 2
                    const endY = toPos.y

                    return (
                        <g key={`edge-${i}`}>
                            {/* Edge line */}
                            <line
                                x1={startX}
                                y1={startY}
                                x2={endX}
                                y2={endY - 24}
                                stroke="#505050"
                                strokeWidth={1.5}
                                markerEnd="url(#arrowhead)"
                            />
                        </g>
                    )
                })}

                {/* Arrowhead marker */}
                <defs>
                    <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                        <polygon points="0 0, 10 3.5, 0 7" fill="#505050" />
                    </marker>
                </defs>

                {/* Nodes */}
                {workflow.nodes.map((node) => {
                    const pos = nodePositions.get(node.id)
                    if (!pos) return null

                    const color = NODE_COLORS[node.status] ?? "#808080"
                    const borderColor = NODE_BORDER_COLORS[node.status] ?? "#505050"
                    const icon = TASK_TYPE_ICONS[node.type as ParallelTaskType] ?? "⚙️"

                    return (
                        <g key={`node-${node.id}`} className="cursor-pointer">
                            {/* Node background */}
                            <rect
                                x={pos.x}
                                y={pos.y}
                                width={160}
                                height={48}
                                rx={6}
                                fill="#2d2d30"
                                stroke={borderColor}
                                strokeWidth={node.status === "running" ? 2 : 1}
                            />

                            {/* Status indicator bar */}
                            <rect
                                x={pos.x}
                                y={pos.y}
                                width={4}
                                height={48}
                                rx={2}
                                fill={color}
                            />

                            {/* Icon */}
                            <text
                                x={pos.x + 16}
                                y={pos.y + 20}
                                fontSize="14"
                                fill="#d4d4d4"
                            >
                                {icon}
                            </text>

                            {/* Node ID */}
                            <text
                                x={pos.x + 36}
                                y={pos.y + 18}
                                fontSize="10"
                                fill="#808080"
                                fontFamily="monospace"
                            >
                                [{node.id}]
                            </text>

                            {/* Task description (truncated) */}
                            <text
                                x={pos.x + 36}
                                y={pos.y + 34}
                                fontSize="10"
                                fill="#d4d4d4"
                            >
                                {node.taskDescription.length > 25
                                    ? node.taskDescription.slice(0, 25) + "..."
                                    : node.taskDescription}
                            </text>

                            {/* Status text */}
                            <text
                                x={pos.x + 148}
                                y={pos.y + 36}
                                fontSize="9"
                                fill={color}
                                textAnchor="end"
                            >
                                {t(`parallelTasks:states.${node.status}`)}
                            </text>

                            {/* Split button */}
                            {!["completed", "cancelled"].includes(node.status) && (
                                <g
                                    onClick={() => onNodeAction?.(node.id, "split")}
                                    className="cursor-pointer"
                                >
                                    <circle cx={pos.x + 148} cy={pos.y + 12} r={8} fill="#3c3c3c" stroke="#505050" />
                                    <text x={pos.x + 148} y={pos.y + 16} textAnchor="middle" fontSize="10" fill="#d4d4d4">
                                        ÷
                                    </text>
                                </g>
                            )}

                            {/* Add button */}
                            {!["completed", "cancelled"].includes(node.status) && (
                                <g
                                    onClick={() => onNodeAction?.(node.id, "add")}
                                    className="cursor-pointer"
                                >
                                    <circle cx={pos.x + 128} cy={pos.y + 12} r={8} fill="#3c3c3c" stroke="#505050" />
                                    <text x={pos.x + 128} y={pos.y + 16} textAnchor="middle" fontSize="12" fill="#d4d4d4">
                                        +
                                    </text>
                                </g>
                            )}
                        </g>
                    )
                })}
            </svg>

            {/* Legend */}
            <div className="px-4 py-2 border-t border-vscode-panel-border text-xs text-vscode-descriptionForeground flex items-center gap-3">
                {Object.entries(NODE_COLORS).map(([status, color]) => (
                    <span key={status} className="flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                        {t(`parallelTasks:states.${status}`)}
                    </span>
                ))}
            </div>
        </div>
    )
}

// ─── Interactive Visualization (Placeholder) ────────────────────────────────────

/**
 * Interactive visualization — full drag-and-drop DAG editor.
 * MVP: Shows the graph view with node click-to-select + action buttons.
 * Full implementation would use a canvas-based renderer with pan/zoom.
 */
const InteractiveVisualization: React.FC<{
    workflow: TaskFlowWorkflow
    onNodeAction: (nodeId: string, action: string) => void
}> = ({ workflow, onNodeAction }) => {
    const { t } = useAppTranslation()
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            <div className="px-4 py-2 border-b border-vscode-panel-border bg-vscode-editor-background/50 flex items-center gap-2">
                <span className="text-xs text-vscode-descriptionForeground mr-auto">
                    {selectedNodeId
                        ? `Selected: [${selectedNodeId}] — ${workflow.nodes.find((n) => n.id === selectedNodeId)?.taskDescription}`
                        : "Click a node to select it"}
                </span>

                {/* Action buttons for selected node */}
                {selectedNodeId && (
                    <div className="flex items-center gap-1">
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => onNodeAction(selectedNodeId, "pause")}
                        >
                            Pause
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => onNodeAction(selectedNodeId, "resume")}
                        >
                            Resume
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => onNodeAction(selectedNodeId, "cancel")}
                        >
                            Cancel
                        </Button>
                    </div>
                )}
            </div>

            {/* Graph with click-to-select */}
            <GraphVisualizationWithSelection workflow={workflow} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} onNodeAction={onNodeAction} />

            {/* Legend */}
            <div className="px-4 py-2 border-t border-vscode-panel-border text-xs text-vscode-descriptionForeground flex items-center gap-3">
                {Object.entries(NODE_COLORS).map(([status, color]) => (
                    <span key={status} className="flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                        {t(`parallelTasks:states.${status}`)}
                    </span>
                ))}
            </div>
        </div>
    )
}

/** Graph visualization with click-to-select for interactive mode */
const GraphVisualizationWithSelection: React.FC<{
    workflow: TaskFlowWorkflow
    selectedNodeId: string | null
    onSelect: (nodeId: string | null) => void
    onNodeAction?: (nodeId: string, action: string) => void
}> = ({ workflow, selectedNodeId, onSelect, onNodeAction }) => {
    const { t } = useAppTranslation()
    const topoOrder = useMemo(() => getTopoOrder(workflow.nodes), [workflow.nodes])

    const nodePositions = useMemo(() => {
        const positions = new Map<string, { x: number; y: number }>()
        const childrenMap = new Map<string, string[]>()

        for (const node of workflow.nodes) {
            if (!childrenMap.has(node.id)) childrenMap.set(node.id, [])
            for (const depId of node.depends_on) {
                if (childrenMap.has(depId)) {
                    childrenMap.get(depId)!.push(node.id)
                }
            }
        }

        const layer = new Map<string, number>()
        const queue: string[] = []

        for (const node of workflow.nodes) {
            if (node.depends_on.length === 0) {
                layer.set(node.id, 0)
                queue.push(node.id)
            } else {
                layer.set(node.id, -1)
            }
        }

        while (queue.length > 0) {
            const current = queue.shift()!
            const currentLayer = layer.get(current)!
            for (const child of childrenMap.get(current) ?? []) {
                const newLayer = Math.max(layer.get(child) ?? -1, currentLayer + 1)
                layer.set(child, newLayer)
                if (!queue.includes(child)) {
                    queue.push(child)
                }
            }
        }

        const layers = new Map<number, string[]>()
        for (const node of workflow.nodes) {
            const l = layer.get(node.id) ?? 0
            if (!layers.has(l)) layers.set(l, [])
            layers.get(l)!.push(node.id)
        }

        const nodeWidth = 160
        const nodeHeight = 48
        const hGap = 24
        const vGap = 72

        for (const [layerNum, nodeIds] of layers.entries()) {
            const totalWidth = nodeIds.length * nodeWidth + (nodeIds.length - 1) * hGap
            const startX = Math.max(0, (800 - totalWidth) / 2)

            for (let i = 0; i < nodeIds.length; i++) {
                positions.set(nodeIds[i], {
                    x: startX + i * (nodeWidth + hGap),
                    y: layerNum * vGap,
                })
            }
        }

        return positions
    }, [workflow.nodes])

    const edges = useMemo(() => {
        const result: Array<{ from: string; to: string }> = []
        for (const node of workflow.nodes) {
            for (const depId of node.depends_on) {
                result.push({ from: depId, to: node.id })
            }
        }
        return result
    }, [workflow.nodes])

    const canvasWidth = 800
    const canvasHeight = Math.max(200, (Math.max(...Array.from(nodePositions.values()).map((p) => p.y)) / 72 + 1) * 72 + 60)

    return (
        <svg
            width={canvasWidth}
            height={canvasHeight}
            className="mx-auto"
            style={{ background: "transparent" }}
        >
            {/* Edges */}
            {edges.map((edge, i) => {
                const fromPos = nodePositions.get(edge.from)
                const toPos = nodePositions.get(edge.to)
                if (!fromPos || !toPos) return null

                const startX = fromPos.x + 80
                const startY = fromPos.y + 48
                const endX = toPos.x + 80
                const endY = toPos.y

                return (
                    <g key={`edge-${i}`}>
                        <line
                            x1={startX}
                            y1={startY}
                            x2={endX}
                            y2={endY - 24}
                            stroke="#505050"
                            strokeWidth={1.5}
                            markerEnd="url(#arrowhead)"
                        />
                    </g>
                )
            })}

            <defs>
                <marker id="arrowhead-interactive" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#505050" />
                </marker>
            </defs>

            {/* Nodes */}
            {workflow.nodes.map((node) => {
                const pos = nodePositions.get(node.id)
                if (!pos) return null

                const color = NODE_COLORS[node.status] ?? "#808080"
                const borderColor = NODE_BORDER_COLORS[node.status] ?? "#505050"
                const isSelected = selectedNodeId === node.id
                const icon = TASK_TYPE_ICONS[node.type as ParallelTaskType] ?? "⚙️"

                return (
                    <g
                        key={`node-${node.id}`}
                        className="cursor-pointer"
                        onClick={() => onSelect(isSelected ? null : node.id)}
                    >
                        {/* Node background */}
                        <rect
                            x={pos.x}
                            y={pos.y}
                            width={160}
                            height={48}
                            rx={6}
                            fill={isSelected ? "#3a3a40" : "#2d2d30"}
                            stroke={isSelected ? "#569cd6" : borderColor}
                            strokeWidth={isSelected ? 2.5 : 1}
                        />

                        {/* Status indicator bar */}
                        <rect
                            x={pos.x}
                            y={pos.y}
                            width={4}
                            height={48}
                            rx={2}
                            fill={color}
                        />

                        {/* Icon */}
                        <text x={pos.x + 16} y={pos.y + 20} fontSize="14" fill="#d4d4d4">
                            {icon}
                        </text>

                        {/* Node ID */}
                        <text x={pos.x + 36} y={pos.y + 18} fontSize="10" fill="#808080" fontFamily="monospace">
                            [{node.id}]
                        </text>

                        {/* Task description (truncated) */}
                        <text x={pos.x + 36} y={pos.y + 34} fontSize="10" fill="#d4d4d4">
                            {node.taskDescription.length > 25 ? node.taskDescription.slice(0, 25) + "..." : node.taskDescription}
                        </text>

                        {/* Status text */}
                        <text x={pos.x + 148} y={pos.y + 36} fontSize="9" fill={color} textAnchor="end">
                            {t(`parallelTasks:states.${node.status}`)}
                        </text>

                        {/* Split button */}
                        {!["completed", "cancelled"].includes(node.status) && (
                            <g
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onNodeAction?.(node.id, "split")
                                }}
                                className="cursor-pointer"
                            >
                                <circle cx={pos.x + 148} cy={pos.y + 12} r={8} fill="#3c3c3c" stroke="#505050" />
                                <text x={pos.x + 148} y={pos.y + 16} textAnchor="middle" fontSize="10" fill="#d4d4d4">
                                    ÷
                                </text>
                            </g>
                        )}

                        {/* Add button */}
                        {!["completed", "cancelled"].includes(node.status) && (
                            <g
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onNodeAction?.(node.id, "add")
                                }}
                                className="cursor-pointer"
                            >
                                <circle cx={pos.x + 128} cy={pos.y + 12} r={8} fill="#3c3c3c" stroke="#505050" />
                                <text x={pos.x + 128} y={pos.y + 16} textAnchor="middle" fontSize="12" fill="#d4d4d4">
                                    +
                                </text>
                            </g>
                        )}
                    </g>
                )
            })}
        </svg>
    )
}

// ─── Node Action Panel ──────────────────────────────────────────────────────────

/** Panel showing node details and available actions */
const NodeActionPanel: React.FC<{
    workflow: TaskFlowWorkflow
    onNodeAction: (nodeId: string, action: string) => void
}> = ({ workflow, onNodeAction }) => {
    const { t } = useAppTranslation()

    return (
        <div className="border-t border-vscode-panel-border p-3">
            {/* Node list with actions */}
            <div className="space-y-1 max-h-48 overflow-auto">
                {workflow.nodes.map((node) => {
                    const color = NODE_COLORS[node.status] ?? "#808080"
                    const icon = TASK_TYPE_ICONS[node.type as ParallelTaskType] ?? "⚙️"

                    return (
                        <div key={node.id} className="flex items-center gap-2 py-1 px-2 rounded hover:bg-vscode-list-hoverBackground">
                            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                            <span>{icon}</span>
                            <span className="font-mono text-xs opacity-60">[{node.id}]</span>
                            <span className="flex-1 truncate text-sm">{node.taskDescription}</span>
                            <span className="text-xs text-vscode-descriptionForeground flex-shrink-0 w-24 text-right">
                                {t(`parallelTasks:states.${node.status}`)}
                            </span>

                            {/* Action buttons based on status */}
                            {(node.status === "running" || node.status === "paused") && (
                                <Button size="sm" variant="secondary" onClick={() => onNodeAction(node.id, node.status === "paused" ? "resume" : "pause")} className="px-1.5 py-0 text-xs">
                                    {node.status === "paused" ? t("parallelTasks:states.running") : t("parallelTasks:states.paused")}
                                </Button>
                            )}

                            {(node.status === "running" || node.status === "pending" || node.status === "waiting") && (
                                <Button size="sm" variant="secondary" onClick={() => onNodeAction(node.id, "cancel")} className="px-1.5 py-0 text-xs">
                                    {t("parallelTasks:states.cancelled")}
                                </Button>
                            )}

                            {(node.status === "paused") && (
                                <Button size="sm" variant="secondary" onClick={() => onNodeAction(node.id, "skip")} className="px-1.5 py-0 text-xs">
                                    {t("parallelTasks:states.skipped")}
                                </Button>
                            )}

                            {/* Split button */}
                            {!["completed", "cancelled"].includes(node.status) && (
                                <Button size="sm" variant="secondary" onClick={() => onNodeAction(node.id, "split")} className="px-1.5 py-0 text-xs">
                                    Split
                                </Button>
                            )}

                            {/* Add child button */}
                            {!["completed", "cancelled"].includes(node.status) && (
                                <Button size="sm" variant="secondary" onClick={() => onNodeAction(node.id, "add")} className="px-1.5 py-0 text-xs">
                                    + Add
                                </Button>
                            )}
                        </div>
                    )
                })}
            </div>

            {/* Workflow-level actions */}
            <div className="flex items-center gap-2 mt-3 pt-2 border-t border-vscode-panel-border">
                {workflow.status === "running" && (
                    <Button size="sm" variant="secondary" onClick={() => onNodeAction("__workflow__", "pause")}>
                        Pause Workflow
                    </Button>
                )}
                {workflow.status === "paused" && (
                    <Button size="sm" variant="secondary" onClick={() => onNodeAction("__workflow__", "resume")}>
                        Resume Workflow
                    </Button>
                )}
                {(workflow.status === "running" || workflow.status === "paused") && (
                    <Button size="sm" variant="secondary" onClick={() => onNodeAction("__workflow__", "cancel")}>
                        Cancel All
                    </Button>
                )}
            </div>
        </div>
    )
}

// ─── Chat Interface ─────────────────────────────────────────────────────────────

/** Simple chat interface for controlling the workflow */
const TaskFlowChat: React.FC<{ workflowId?: string }> = ({ workflowId }) => {
    const { t } = useAppTranslation()
    const [message, setMessage] = useState("")

    const handleSubmit = useCallback(() => {
        if (!message.trim()) return
        vscode.postMessage({
            type: "taskFlowChat",
            workflowId,
            message: message.trim(),
        })
        setMessage("")
    }, [message, workflowId])

    return (
        <div className="border-t border-vscode-panel-border p-3">
            {/* Chat input */}
            <div className="flex items-center gap-2">
                <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault()
                            handleSubmit()
                        }
                    }}
                    placeholder={`${t("parallelTasks:taskFlow.chatPlaceholder")} — ${t("parallelTasks:chatCommands.available")}`}
                    className="flex-1 bg-vscode-input-background border border-vscode-input-border rounded px-3 py-1.5 text-sm text-vscode-input-foreground focus:border-vscode-focusBorder outline-none"
                />
                <Button size="sm" onClick={handleSubmit}>
                    {t("parallelTasks:chatCommands.send")}
                </Button>
            </div>

            {/* Quick commands */}
            <div className="flex items-center gap-1 mt-2 flex-wrap">
                {[
                    { label: "list", cmd: "/list" },
                    { label: "status", cmd: "/status" },
                    { label: "pause all", cmd: "/pause-all" },
                    { label: "resume all", cmd: "/resume-all" },
                ].map((cmd) => (
                    <button
                        key={cmd.cmd}
                        className="text-xs text-vscode-descriptionForeground hover:text-vscode-foreground px-2 py-0.5 rounded bg-vscode-editor-background border border-vscode-input-border cursor-pointer transition-colors"
                        onClick={() => {
                            setMessage(cmd.cmd)
                        }}
                    >
                        {cmd.cmd}
                    </button>
                ))}
            </div>
        </div>
    )
}

// ─── Main TaskFlowPanel Component ──────────────────────────────────────────────

/**
 * TaskFlowPanel — DAG visualization + chat interface for workflow management.
 * Supports three visualization levels: simple, graph, interactive.
 */
export const TaskFlowPanel: React.FC<TaskFlowPanelProps> = ({ workflowId, onClose }) => {
    const { t } = useAppTranslation()
    const [vizLevel, setVizLevel] = useState<VisualizationLevel>("graph")
    const [workflow, setWorkflow] = useState<TaskFlowWorkflow | null>(null)
    const [splitModalNode, setSplitModalNode] = useState<{ id: string; description: string } | null>(null)
    const [showAddModal, setShowAddModal] = useState(false)

    /** Load workflow data from extension */
    useEffect(() => {
        if (!workflowId) return
        vscode.postMessage({ type: "getTaskFlow", workflowId })
    }, [workflowId])

    // Listen for workflow updates (handled by webview message listener)
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            if (typeof event.data !== "object" || event.data === null) return
            const msg = event.data as Record<string, unknown>
            if (msg.type === "taskFlowUpdate" && typeof msg.workflow === "object") {
                setWorkflow(msg.workflow as TaskFlowWorkflow)
            }
        }
        window.addEventListener("message", handler)
        return () => window.removeEventListener("message", handler)
    }, [])

    /** Handle node actions from UI */
    const handleNodeAction = useCallback(
        (nodeId: string, action: string) => {
            if (!workflowId) return
            vscode.postMessage({
                type: "taskFlowAction",
                workflowId,
                nodeId,
                action,
            })
        },
        [workflowId],
    )

    /** Handle split node action — opens modal */
    const handleSplitNode = useCallback(
        (nodeId: string, description: string) => {
            if (!workflowId) return
            setSplitModalNode({ id: nodeId, description })
        },
        [workflowId],
    )

    /** Handle add node action — opens modal */
    const handleAddNode = useCallback(() => {
        setShowAddModal(true)
    }, [])

    /** Handle workflow-level actions */
    const handleWorkflowAction = useCallback(
        (action: string) => {
            if (!workflowId) return
            vscode.postMessage({
                type: "taskFlowAction",
                workflowId,
                nodeId: "__workflow__",
                action,
            })
        },
        [workflowId],
    )

    // If no workflow loaded yet, show loading state
    if (!workflow) {
        return (
            <div className="flex items-center justify-center h-full text-vscode-descriptionForeground">
                {t("parallelTasks:taskFlow.loading")}
            </div>
        )
    }

    // Visualization level selector
    const vizLevels: Array<{ value: VisualizationLevel; labelKey: string }> = [
        { value: "simple", labelKey: "parallelTasks:taskFlow.viz.simple" },
        { value: "graph", labelKey: "parallelTasks:taskFlow.viz.graph" },
        { value: "interactive", labelKey: "parallelTasks:taskFlow.viz.interactive" },
    ]

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="px-4 py-3 border-b border-vscode-panel-border bg-vscode-editor-background/50 flex items-center gap-2">
                <span className="codicon codicon-flow text-vscode-icon-foreground" />
                <span className="font-bold">{workflow.name}</span>

                {/* Status badge */}
                <span
                    className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                    style={{
                        backgroundColor: NODE_COLORS[workflow.status as TaskFlowNodeStatus] + "30",
                        color: NODE_COLORS[workflow.status as TaskFlowNodeStatus],
                    }}
                >
                    {t(`parallelTasks:states.${workflow.status}`)}
                </span>

                {/* Visualization level selector */}
                <div className="ml-auto flex items-center gap-1">
                    {vizLevels.map((level) => (
                        <button
                            key={level.value}
                            className={`px-2 py-0.5 text-xs rounded transition-colors ${
                                vizLevel === level.value
                                    ? "bg-vscode-button-background text-vscode-button-foreground"
                                    : "text-vscode-descriptionForeground hover:text-vscode-foreground hover:bg-vscode-editor-background"
                            }`}
                            onClick={() => setVizLevel(level.value)}
                        >
                            {t(level.labelKey)}
                        </button>
                    ))}
                </div>

                {/* Close button */}
                {onClose && (
                    <span
                        className="codicon codicon-close text-vscode-descriptionForeground hover:text-vscode-foreground cursor-pointer ml-2"
                        onClick={onClose}
                    />
                )}
            </div>

            {/* Visualization area */}
            <div className="flex-1 overflow-auto">
                {vizLevel === "simple" && <SimpleVisualization workflow={workflow} onNodeAction={handleNodeAction} />}
                {vizLevel === "graph" && <GraphVisualization workflow={workflow} onNodeAction={handleNodeAction} />}
                {vizLevel === "interactive" && (
                    <InteractiveVisualization workflow={workflow} onNodeAction={handleNodeAction} />
                )}

                {/* Node action panel */}
                <NodeActionPanel workflow={workflow} onNodeAction={handleNodeAction} />
            </div>

            {/* Chat interface */}
            {workflowId && <TaskFlowChat workflowId={workflowId} />}

            {/* Split node modal */}
            {splitModalNode && (
                <SplitNodeModal
                    workflowId={workflowId}
                    nodeId={splitModalNode.id}
                    nodeDescription={splitModalNode.description}
                    onClose={() => setSplitModalNode(null)}
                />
            )}

            {/* Add node modal */}
            {showAddModal && workflow && (
                <AddNodeModal
                    workflow={workflow}
                    workflowId={workflowId}
                    onClose={() => setShowAddModal(false)}
                />
            )}
        </div>
    )
}
