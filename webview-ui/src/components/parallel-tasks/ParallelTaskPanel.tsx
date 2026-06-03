import React, { useCallback, useEffect, useState } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ParallelTaskType, BGWorkerState, type BGWorkerStateUpdate, type TaskFlowWorkflow } from "@roo-code/types"

/** State for a single worker as tracked by the webview */
interface WorkerInfo {
	id: string
	state: BGWorkerState
	description?: string
	taskType?: ParallelTaskType
	toolCallCount?: number
	currentTool?: string
}

/** TaskFlow workflow detail state (Phase 7d) */
interface WorkflowDetailState {
	workflow: TaskFlowWorkflow | null
	error?: string
	isLoading: boolean
}

const STATE_COLORS: Record<BGWorkerState, string> = {
	[BGWorkerState.Queued]: "#f0c040",
	[BGWorkerState.Running]: "#569cd6",
	[BGWorkerState.Paused]: "#dcdcaa",
	[BGWorkerState.Completed]: "#4ec9b0",
	[BGWorkerState.Failed]: "#f44747",
	[BGWorkerState.Cancelled]: "#808080",
}

const STATE_LABELS: Record<BGWorkerState, string> = {
	[BGWorkerState.Queued]: "Queued",
	[BGWorkerState.Running]: "Running",
	[BGWorkerState.Paused]: "Paused",
	[BGWorkerState.Completed]: "Completed",
	[BGWorkerState.Failed]: "Failed",
	[BGWorkerState.Cancelled]: "Cancelled",
}

export const ParallelTaskPanel: React.FC<{ selectedWorkflowId?: string }> = ({ selectedWorkflowId }) => {
	const { t } = useAppTranslation()
	const { parallelTaskEnabled, parallelTaskMaxConcurrent } = useExtensionState()

	const [workers, setWorkers] = useState<WorkerInfo[]>([])
	const [activeCount, setActiveCount] = useState(0)
	const [queuedCount, setQueuedCount] = useState(0)
	const [selectedWorkflow, setSelectedWorkflow] = useState<string | undefined>(undefined)

	// TaskFlow workflow detail state (Phase 7d)
	const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetailState>({
		workflow: null,
		error: undefined,
		isLoading: false,
	})

	// When a workflow ID is selected from the heartbeat card button (Phase 7d),
	// load that specific workflow in the panel
	useEffect(() => {
		if (selectedWorkflowId && selectedWorkflowId !== selectedWorkflow) {
			setSelectedWorkflow(selectedWorkflowId)
			// Post message to extension to fetch and display the workflow details
			vscode.postMessage({ type: "loadTaskFlow", workflowId: selectedWorkflowId })
		}
	}, [selectedWorkflowId, selectedWorkflow])

	// Listen for bgWorkerState messages from the extension host.
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			if (typeof event.data !== "object" || event.data === null) return
			const msg = event.data as { type?: string; bgWorkerUpdate?: BGWorkerStateUpdate }

			// Handle bgWorkerState updates
			if (msg.type === "bgWorkerState") {
				const update = msg.bgWorkerUpdate
				if (!update) return

				// Update aggregate counts
				if (update.activeWorkers != null) setActiveCount(update.activeWorkers)
				if (update.queuedTasks != null) setQueuedCount(update.queuedTasks)

				// Update individual worker state
				setWorkers((prev) => {
					const idx = prev.findIndex((w) => w.id === update.workerId)
					if (idx !== -1) {
						// Worker already known — update in place
						const updated = [...prev]
						updated[idx] = {
							id: update.workerId,
							state: update.state,
							description: update.description ?? prev[idx].description,
							taskType: update.taskType ?? prev[idx].taskType,
							toolCallCount: update.toolCallCount ?? prev[idx].toolCallCount,
							currentTool: update.currentTool ?? prev[idx].currentTool,
						}
						return updated
					} else {
						// New worker — add to list with full type
						const newWorker: WorkerInfo = { id: update.workerId, state: update.state }
						if (update.description) newWorker.description = update.description
						if (update.taskType) newWorker.taskType = update.taskType
						return [...prev, newWorker]
					}
				})

				// Remove completed/failed/cancelled workers after a delay to show final state
				if (
					update.state === BGWorkerState.Completed ||
					update.state === BGWorkerState.Failed ||
					update.state === BGWorkerState.Cancelled
				) {
					setTimeout(() => {
						setWorkers((prev) => prev.filter((w) => w.id !== update.workerId))
					}, 5000) // Keep completed workers visible for 5s
				}
			}

			// Handle TaskFlow workflow loading (Phase 7d)
			if (msg.type === "taskFlowLoaded") {
				const payload = event.data as { type: "taskFlowLoaded"; workflow?: TaskFlowWorkflow }
				setWorkflowDetail({
					workflow: payload.workflow ?? null,
					error: undefined,
					isLoading: false,
				})
			}

			if (msg.type === "taskFlowLoadError") {
				const payload = event.data as { type: "taskFlowLoadError"; error?: string }
				setWorkflowDetail({
					workflow: null,
					error: payload.error ?? "Failed to load workflow",
					isLoading: false,
				})
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	const handleCancelWorker = useCallback((workerId: string) => {
		vscode.postMessage({ type: "cancelParallelTask", taskId: workerId })
	}, [])

	const handleViewResult = useCallback((workerId: string) => {
		vscode.postMessage({ type: "viewParallelTaskResult", taskId: workerId })
	}, [])

	const isParallelEnabled = parallelTaskEnabled ?? false
	const maxConcurrent = parallelTaskMaxConcurrent ?? 8

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="px-4 py-2 border-b border-vscode-panel-border">
				<h2 className="text-sm font-semibold text-vscode-foreground">{t("parallelTasks:panel.title")}</h2>
				<p className="text-xs text-vscode-descriptionForeground mt-0.5">
					{isParallelEnabled
						? t("parallelTasks:panel.enabled", { maxConcurrent })
						: t("parallelTasks:panel.disabled")}
				</p>
			</div>

			{/* Stats bar */}
			<div className="px-4 py-2 flex items-center gap-4 border-b border-vscode-panel-border text-xs">
				<span className="text-vscode-descriptionForeground">
					{t("parallelTasks:panel.activeWorkers", { count: activeCount })}
				</span>
				{queuedCount > 0 && (
					<span className="text-vscode-descriptionForeground">
						· {t("parallelTasks:panel.queuedTasks", { count: queuedCount })}
					</span>
				)}
			</div>

			{/* Worker list */}
			<div className="flex-1 overflow-y-auto">
				{/* Workflow detail section (Phase 7d) — shown when a workflow is loaded */}
				{workflowDetail.workflow && (
					<div className="border-b border-vscode-panel-border bg-vscode-editor-background/40">
						<div className="px-4 py-2 flex items-center gap-2 text-xs text-vscode-descriptionForeground">
							<span className="codicon codicon-flow text-vscode-icon-foreground" />
							<span className="font-medium">{t("parallelTasks:panel.workflow")}</span>
						</div>
						<div className="px-4 pb-2 space-y-1">
							{/* Workflow name and status */}
							<div className="flex items-center gap-2 text-sm">
								<span className="text-vscode-foreground font-medium">{workflowDetail.workflow.name}</span>
								<span className={`text-xs px-1.5 py-0.5 rounded ${
									workflowDetail.workflow.status === "running" ? "bg-vscode-badge-background text-vscode-badge-foreground" :
									workflowDetail.workflow.status === "completed" ? "bg-[#4ec9b0]/20 text-[#4ec9b0]" :
									workflowDetail.workflow.status === "failed" ? "bg-[#f44747]/20 text-[#f44747]" :
									"bg-vscode-badge-background text-vscode-badge-foreground"
								}`}>
									{t(`parallelTasks:states.${workflowDetail.workflow.status}`)}
								</span>
							</div>

							{/* Node list */}
							<div className="space-y-0.5 mt-2">
								{workflowDetail.workflow.nodes.map((node) => (
									<div key={node.id} className="flex items-center gap-2 text-xs py-1">
										<span className={`w-2 h-2 rounded-full flex-shrink-0 ${
											node.status === "completed" ? "bg-[#4ec9b0]" :
											node.status === "running" ? "bg-[#569cd6] animate-pulse" :
											node.status === "failed" ? "bg-[#f44747]" :
											node.status === "paused" ? "bg-[#dcdcaa]" :
											node.status === "skipped" || node.status === "cancelled" ? "bg-[#808080]" :
											"bg-vscode-descriptionForeground/50"
										}`} />
										<span className="font-mono text-vscode-foreground">{node.id}</span>
										<span className="text-vscode-foreground truncate flex-1">{node.taskDescription}</span>
										<span className={`px-1 py-0.5 rounded text-[10px] ${
											node.status === "completed" ? "bg-[#4ec9b0]/20 text-[#4ec9b0]" :
											node.status === "running" ? "bg-[#569cd6]/20 text-[#569cd6]" :
											node.status === "failed" ? "bg-[#f44747]/20 text-[#f44747]" :
											"bg-vscode-badge-background/30 text-vscode-descriptionForeground"
										}`}>
											{node.status}
										</span>
									</div>
								))}
							</div>

							{/* Clear workflow button */}
							<button
								className="mt-2 text-xs text-vscode-button-secondaryForeground hover:bg-vscode-button-secondaryBackground px-2 py-1 rounded"
								onClick={() => setWorkflowDetail({ workflow: null, error: undefined, isLoading: false })}
							>
								{t("parallelTasks:panel.clearWorkflow")}
							</button>
						</div>
					</div>
				)}

				{/* Error message for failed workflow load */}
				{workflowDetail.error && !workflowDetail.workflow && (
					<div className="px-4 py-2 text-xs text-[#f44747] border-b border-vscode-panel-border">
						<span className="codicon codicon-error mr-1" />
						{workflowDetail.error}
					</div>
				)}

				{workers.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-full text-vscode-descriptionForeground gap-2">
						<span className="text-sm">{t("parallelTasks:panel.noWorkers")}</span>
						<span className="text-xs opacity-75">
							{isParallelEnabled ? t("parallelTasks:panel.startTaskHint") : ""}
						</span>
					</div>
				) : (
					<div className="divide-y divide-vscode-panel-border">
						{workers.map((worker) => (
							<WorkerRow key={worker.id} worker={worker} onCancel={handleCancelWorker} onViewResult={handleViewResult} t={t} />
						))}
					</div>
				)}
			</div>

			{/* Footer */}
			<div className="px-4 py-2 border-t border-vscode-panel-border text-xs text-vscode-descriptionForeground">
				{t("parallelTasks:panel.footer")}
			</div>
		</div>
	)
}

/** Single worker row in the panel */
const WorkerRow: React.FC<{
	worker: WorkerInfo
	onCancel: (id: string) => void
	onViewResult: (id: string) => void
	t: (key: string, params?: Record<string, unknown>) => string
}> = ({ worker, onCancel, onViewResult, t }) => {
	const color = STATE_COLORS[worker.state] ?? "#808080"
	const label = STATE_LABELS[worker.state] ?? "Unknown"

	// Get task type display name inline (avoids closure issues)
	const taskTypeDisplay = worker.taskType ? (t(`parallelTasks:taskTypes.${worker.taskType}`) ?? worker.taskType) : undefined

	return (
		<div className="flex items-center gap-3 px-4 py-2 hover:bg-vscode-list-hoverBackground">
			{/* Status dot */}
			<span
				className="w-2.5 h-2.5 rounded-full flex-shrink-0"
				style={{ backgroundColor: color }}
				title={label}
			/>

			{/* Worker info */}
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					<span className="text-sm text-vscode-foreground truncate">{worker.description ?? worker.id}</span>
					{taskTypeDisplay && (
						<span className="text-xs px-1.5 py-0.5 rounded bg-vscode-badge-background text-vscode-badge-foreground flex-shrink-0">
							{taskTypeDisplay}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2 mt-0.5">
					<span className="text-xs text-vscode-descriptionForeground">{label}</span>
					{worker.toolCallCount != null && (
						<span className="text-xs text-vscode-descriptionForeground">
							· {worker.toolCallCount} {t("parallelTasks:panel.toolCalls")}
						</span>
					)}
				</div>
			</div>

			{/* Actions */}
			<div className="flex items-center gap-1 flex-shrink-0">
				{worker.state === BGWorkerState.Running && (
					<button
						className="text-xs px-2 py-1 rounded hover:bg-vscode-button-secondaryBackground text-vscode-button-secondaryForeground"
						onClick={() => onCancel(worker.id)}
						title={t("parallelTasks:panel.cancel")}
					>
						{t("parallelTasks:panel.cancel")}
					</button>
				)}
				{(worker.state === BGWorkerState.Completed || worker.state === BGWorkerState.Failed) && (
					<button
						className="text-xs px-2 py-1 rounded hover:bg-vscode-button-secondaryBackground text-vscode-button-secondaryForeground"
						onClick={() => onViewResult(worker.id)}
						title={t("parallelTasks:panel.viewResult")}
					>
						{t("parallelTasks:panel.viewResult")}
					</button>
				)}
			</div>
		</div>
	)
}
