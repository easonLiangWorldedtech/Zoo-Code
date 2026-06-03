import React, { useState } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { WorkerHeartbeat, BGWorkerState, TASK_TYPE_ICONS } from "@roo-code/types"
import { vscode } from "@/utils/vscode"

/** Duration in ms after which a completed worker card auto-collapses */
const COLLAPSE_DELAY_MS = 30_000

/** Color mapping for heartbeat states (matches ParallelTaskPanel STATE_COLORS) */
const STATE_COLORS: Record<BGWorkerState, string> = {
	[BGWorkerState.Queued]: "#f0c040",
	[BGWorkerState.Running]: "#569cd6",
	[BGWorkerState.Paused]: "#dcdcaa",
	[BGWorkerState.Completed]: "#4ec9b0",
	[BGWorkerState.Failed]: "#f44747",
	[BGWorkerState.Cancelled]: "#808080",
}

/** Format milliseconds to a human-readable duration string */
function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000)
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`
	const hours = Math.floor(minutes / 60)
	return `${hours}h ${minutes % 60}m`
}

/** Format cost to USD string */
function formatCost(usd: number): string {
	if (usd < 0.01) return "<$0.01"
	return `$${usd.toFixed(2)}`
}

export const WorkerHeartbeatCard: React.FC<{ heartbeat: WorkerHeartbeat }> = ({ heartbeat }) => {
	const { t } = useAppTranslation()
	const [collapsed, setCollapsed] = useState(false)
	const [autoCollapseTimer, setAutoCollapseTimer] = useState<ReturnType<typeof setTimeout> | null>(null)

	// Auto-collapse completed workers after a delay so they don't clutter the chat
	const isTerminalState =
		heartbeat.state === BGWorkerState.Completed ||
		heartbeat.state === BGWorkerState.Failed ||
		heartbeat.state === BGWorkerState.Cancelled

	React.useEffect(() => {
		if (isTerminalState && !collapsed) {
			const timer = setTimeout(() => setCollapsed(true), COLLAPSE_DELAY_MS)
			setAutoCollapseTimer(timer)
			return () => clearTimeout(timer)
		}
	}, [heartbeat.state, collapsed, isTerminalState])

	const color = STATE_COLORS[heartbeat.state] ?? "#808080"
	const icon = heartbeat.taskType ? TASK_TYPE_ICONS[heartbeat.taskType] ?? "⚙️" : "⚙️"
	const progressPercent = Math.min(100, Math.max(0, heartbeat.progressPercent))

	return (
		<div className="mx-[15px] my-2">
			{/* Card header — always visible */}
			<button
				className={`w-full flex items-center gap-2 px-3 py-2 rounded border text-left transition-colors ${
					collapsed
						? "bg-vscode-editor-background/60 border-vscode-panel-border opacity-75 hover:opacity-100"
						: "bg-vscode-editor-background border-vscode-panel-border hover:bg-vscode-list-hoverBackground"
				}`}
				onClick={() => setCollapsed((prev) => !prev)}
			>
				{/* Status indicator */}
				<span
					className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-1 ring-offset-1 ring-vscode-editor-background"
					style={{ backgroundColor: color }}
					title={t(`parallelTasks:states.${heartbeat.state}`)}
				/>

				{/* Task description */}
				<span className="flex-1 text-sm text-vscode-foreground truncate">
					{icon} {heartbeat.taskDescription}
				</span>

				{/* Progress + cost (only when expanded) */}
				{!collapsed && (
					<div className="flex items-center gap-3 flex-shrink-0 ml-2">
						{/* Cost badge */}
						<span className="text-xs text-vscode-descriptionForeground tabular-nums">
							{formatCost(heartbeat.totalCost)}
						</span>

						{/* Elapsed time */}
						<span className="text-xs text-vscode-descriptionForeground tabular-nums">
							{formatDuration(heartbeat.elapsedMs)}
						</span>

						{/* Progress bar (only for running/queued) */}
						{(heartbeat.state === BGWorkerState.Running || heartbeat.state === BGWorkerState.Queued) && (
							<div className="w-16 h-1.5 bg-vscode-input-background rounded-full overflow-hidden">
								<div
									className="h-full rounded-full transition-all duration-500"
									style={{ width: `${progressPercent}%`, backgroundColor: color }}
								/>
							</div>
						)}

						{/* Progress text */}
						<span className="text-xs text-vscode-descriptionForeground tabular-nums w-8 text-right">
							{Math.round(progressPercent)}%
						</span>
					</div>
				)}

				{/* TaskFlow Agent button — only show when worker belongs to a workflow DAG */}
				{heartbeat.workflowId && (
					<span
						className="codicon codicon-debug-alt text-vscode-icon-foreground flex-shrink-0 cursor-pointer hover:text-vscode-button-foreground"
						title={t("parallelTasks:heartbeats.openTaskFlow")}
						onClick={(e) => {
							e.stopPropagation()
							vscode.postMessage({ type: "openTaskFlow", workflowId: heartbeat.workflowId! })
						}}
					/>
				)}

				{/* Collapse indicator */}
				<span className="codicon codicon-chevron-down text-vscode-descriptionForeground flex-shrink-0" />
			</button>

			{/* Expanded details */}
			{!collapsed && (
				<div className="mx-[15px] mt-1 px-3 py-2 bg-vscode-editor-background/80 border border-vscode-panel-border rounded-b text-xs text-vscode-descriptionForeground space-y-1">
					{/* Current action */}
					{heartbeat.currentAction && (
						<div className="flex items-center gap-2">
							<span className="codicon codicon-debug-continue text-vscode-icon-foreground flex-shrink-0" />
							<span className="truncate">{t("parallelTasks:heartbeats.currentAction")}: {heartbeat.currentAction}</span>
						</div>
					)}

					{/* Tool call progress */}
					<div className="flex items-center gap-2">
						<span className="codicon codicon-terminal text-vscode-icon-foreground flex-shrink-0" />
						<span>
							{heartbeat.toolCallCount}/{heartbeat.maxToolCalls} {t("parallelTasks:heartbeats.toolCalls")}
						</span>
					</div>

					{/* State label */}
					<div className="flex items-center gap-2">
						<span
							className="w-1.5 h-1.5 rounded-full flex-shrink-0"
							style={{ backgroundColor: color }}
						/>
						<span>{t(`parallelTasks:states.${heartbeat.state}`)}</span>
					</div>

					{/* Task type badge */}
					{heartbeat.taskType && (
						<div className="flex items-center gap-2">
							<span className="codicon codicon-symbol-event text-vscode-icon-foreground flex-shrink-0" />
							<span className="px-1.5 py-0.5 rounded bg-vscode-badge-background text-vscode-badge-foreground text-[10px] font-medium">
								{t(`parallelTasks:taskTypes.${heartbeat.taskType}`)}
							</span>
						</div>
					)}

					{/* Worker ID */}
					<div className="flex items-center gap-2 opacity-60">
						<span className="codicon codicon-debug-alt text-vscode-icon-foreground flex-shrink-0" />
						<span className="font-mono">{heartbeat.workerId}</span>
					</div>
				</div>
			)}
		</div>
	)
}

/** Container that renders all active heartbeats, filtered by settings mode */
export const HeartbeatList: React.FC<{
	heartbeats: WorkerHeartbeat[]
	heartbeatMode?: "all" | "errors_only" | "none"
}> = ({ heartbeats, heartbeatMode }) => {
	const { t } = useAppTranslation()

	if (heartbeatMode === "none") return null

	// Filter by mode
	let filtered = heartbeats
	if (heartbeatMode === "errors_only") {
		filtered = heartbeats.filter(
			(h) => h.state === BGWorkerState.Failed || h.state === BGWorkerState.Paused,
		)
	}

	if (filtered.length === 0) return null

	return (
		<div className="space-y-1">
			{/* Section header */}
			<div className="mx-[15px] mt-3 mb-1 flex items-center gap-2 text-xs text-vscode-descriptionForeground">
				<span className="codicon codicon-zap text-vscode-icon-foreground" />
				<span>{t("parallelTasks:heartbeats.title")}</span>
			</div>

			{/* Heartbeat cards */}
			{filtered.map((hb) => (
				<WorkerHeartbeatCard key={hb.workerId} heartbeat={hb} />
			))}
		</div>
	)
}
