import { HTMLAttributes, useCallback, useState } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox, VSCodeDropdown } from "@vscode/webview-ui-toolkit/react"
import { vscode } from "@/utils/vscode"
import { Button, Input, Slider } from "@/components/ui"

import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ParallelTaskType, type BGWorkerConfig } from "@roo-code/types"

// Generic setter for parallel task settings — these fields live on GlobalSettings/RooCodeSettings, not ExtensionStateContextType
type ParallelTaskSettingSetter = (key: string, value: unknown) => void

const TASK_TYPES: { value: ParallelTaskType; labelKey: string }[] = [
	{ value: ParallelTaskType.Search, labelKey: "settings:parallelTasks.taskTypes.search" },
	{ value: ParallelTaskType.Doc, labelKey: "settings:parallelTasks.taskTypes.doc" },
	{ value: ParallelTaskType.Commit, labelKey: "settings:parallelTasks.taskTypes.commit" },
	{ value: ParallelTaskType.Code, labelKey: "settings:parallelTasks.taskTypes.code" },
	{ value: ParallelTaskType.Debug, labelKey: "settings:parallelTasks.taskTypes.debug" },
	{ value: ParallelTaskType.General, labelKey: "settings:parallelTasks.taskTypes.general" },
]

const PROVIDER_OPTIONS = ["openai", "anthropic", "google", "lmstudio", "ollama", "vscode-lm"] as const

type ParallelTaskSettingsProps = HTMLAttributes<HTMLDivElement> & {
	setCachedStateField: (field: string, value: unknown) => void
}

export const ParallelTaskSettings = ({ setCachedStateField, ...props }: ParallelTaskSettingsProps) => {
	const { t } = useAppTranslation()
	const { parallelTaskEnabled, parallelTaskMaxConcurrent, workerHeartbeatSettings, parallelTaskDagVisualizationLevel } = useExtensionState()

	const [enabled, setEnabled] = useState(parallelTaskEnabled ?? false)
	const [maxConcurrent, setMaxConcurrent] = useState(parallelTaskMaxConcurrent ?? 8)
	const [heartbeatMode, setHeartbeatMode] = useState(workerHeartbeatSettings?.mode ?? "all")
	const [heartbeatInterval, setHeartbeatInterval] = useState(workerHeartbeatSettings?.updateIntervalSeconds ?? 30)
	const [dagVizLevel, setDagVizLevel] = useState(parallelTaskDagVisualizationLevel ?? ("graph" as "simple" | "graph" | "interactive"))

	// ── DAG Visualization Level Handler (Phase 7j) ────────────────────────────────
	const handleDagVizLevelChange = useCallback((level: "simple" | "graph" | "interactive") => {
		setDagVizLevel(level)
		setCachedStateField("parallelTaskDagVisualizationLevel", level as any)
		vscode.postMessage({ type: "updateSettings", updatedSettings: { parallelTaskDagVisualizationLevel: level } })
	}, [setCachedStateField])

	// Per-task-type settings state (defaults from plan)
	const [taskTypeSettings, setTaskTypeSettings] = useState<Record<string, Partial<BGWorkerConfig & { provider: string; modelId: string }>>>(() => {
		const defaults: Record<string, Partial<BGWorkerConfig & { provider: string; modelId: string }>> = {}
		for (const tt of TASK_TYPES) {
			defaults[tt.value] = {
				provider: "", // empty = inherit from main task
				modelId: "",
			}
		}
		return defaults
	})

	const handleEnabledChange = useCallback((checked: boolean) => {
		setEnabled(checked)
		setCachedStateField("parallelTaskEnabled", checked)
		vscode.postMessage({ type: "updateSettings", updatedSettings: { parallelTaskEnabled: checked } })
	}, [setCachedStateField])

	const handleMaxConcurrentChange = useCallback((value: number[]) => {
		const v = value[0]
		setMaxConcurrent(v)
		setCachedStateField("parallelTaskMaxConcurrent", v)
		vscode.postMessage({ type: "updateSettings", updatedSettings: { parallelTaskMaxConcurrent: v } })
	}, [setCachedStateField])

	const handleProviderChange = useCallback((taskType: ParallelTaskType, provider: string) => {
		setTaskTypeSettings(prev => ({ ...prev, [taskType]: { ...prev[taskType], provider } }))
		const key = `parallelTaskMode${capitalize(taskType)}Provider` as const
		setCachedStateField(key as any, provider || undefined)
		vscode.postMessage({ type: "updateSettings", updatedSettings: { [key]: provider || undefined } })
	}, [setCachedStateField])

	const handleModelChange = useCallback((taskType: ParallelTaskType, modelId: string) => {
		setTaskTypeSettings(prev => ({ ...prev, [taskType]: { ...prev[taskType], modelId } }))
		const key = `parallelTaskMode${capitalize(taskType)}ModelId` as const
		setCachedStateField(key as any, modelId || undefined)
		vscode.postMessage({ type: "updateSettings", updatedSettings: { [key]: modelId || undefined } })
	}, [setCachedStateField])

	const handleAutoApproveChange = useCallback((taskType: ParallelTaskType, permission: string, checked: boolean) => {
		const key = `parallelTaskAutoApprove${capitalize(taskType)}${capitalize(permission)}` as const
		setCachedStateField(key as any, checked)
		vscode.postMessage({ type: "updateSettings", updatedSettings: { [key]: checked } })
	}, [setCachedStateField])

	const handleLimitChange = useCallback((taskType: ParallelTaskType, limitType: string, value: number | undefined) => {
		if (value === 0 || value === undefined) return
		const key = `parallelTaskMax${capitalize(limitType)}${capitalize(taskType)}` as const
		setCachedStateField(key as any, value)
		vscode.postMessage({ type: "updateSettings", updatedSettings: { [key]: value } })
	}, [setCachedStateField])

	const handleHeartbeatModeChange = useCallback((mode: "all" | "errors_only" | "none") => {
		setHeartbeatMode(mode)
		vscode.postMessage({ type: "updateSettings", updatedSettings: { workerHeartbeatSettings: { ...workerHeartbeatSettings, mode } } })
	}, [setCachedStateField, workerHeartbeatSettings])

	const handleHeartbeatIntervalChange = useCallback((value: number[]) => {
		const v = value[0]
		setHeartbeatInterval(v)
		vscode.postMessage({ type: "updateSettings", updatedSettings: { workerHeartbeatSettings: { ...workerHeartbeatSettings, updateIntervalSeconds: v } } })
	}, [setCachedStateField, workerHeartbeatSettings])

	return (
		<div {...props}>
			<SectionHeader description={t("settings:parallelTasks.description")}>{t("settings:sections.parallelTasks")}</SectionHeader>

			<Section>
				{/* ENABLE TOGGLE */}
				<SearchableSetting settingId="parallel-tasks-enabled" section="parallelTasks" label={t("settings:parallelTasks.enabled.label")}>
					<VSCodeCheckbox
						checked={enabled}
						onChange={(e: any) => handleEnabledChange(e.target.checked)}
						data-testid="parallel-tasks-enabled-checkbox">
						<span className="font-medium">{t("settings:parallelTasks.enabled.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:parallelTasks.enabled.description")}
					</div>
				</SearchableSetting>

				{/* MAX CONCURRENT WORKERS */}
				<SearchableSetting settingId="parallel-tasks-max-concurrent" section="parallelTasks" label={t("settings:parallelTasks.maxConcurrent.label")}>
					<div className="flex items-center gap-2">
						<Slider
							min={1}
							max={16}
							step={1}
							value={[maxConcurrent]}
							onValueChange={handleMaxConcurrentChange}
							data-testid="parallel-tasks-max-concurrent-slider"
						/>
						<span className="w-8 text-center">{maxConcurrent}</span>
					</div>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:parallelTasks.maxConcurrent.description")}
					</div>
				</SearchableSetting>

				{/* HEARTBEAT SETTINGS */}
				<SectionHeader description={t("settings:parallelTasks.heartbeatSettings.description")}>
					{t("settings:parallelTasks.heartbeatSettings.title")}
				</SectionHeader>

				<div className="space-y-4 pl-3 border-l-2 border-vscode-button-background">
					{/* Heartbeat Mode */}
					<SearchableSetting settingId="parallel-tasks-heartbeat-mode" section="parallelTasks" label={t("settings:parallelTasks.heartbeatSettings.mode.label")}>
						<VSCodeDropdown
							value={heartbeatMode}
							onChange={(e: any) => handleHeartbeatModeChange(e.target.value as "all" | "errors_only" | "none")}
							data-testid="parallel-tasks-heartbeat-mode-dropdown"
							className="w-48">
							<option value="all">{t("settings:parallelTasks.heartbeatSettings.mode.all")}</option>
							<option value="errors_only">{t("settings:parallelTasks.heartbeatSettings.mode.errorsOnly")}</option>
							<option value="none">{t("settings:parallelTasks.heartbeatSettings.mode.none")}</option>
						</VSCodeDropdown>
					</SearchableSetting>

					{/* Heartbeat Interval */}
					<SearchableSetting settingId="parallel-tasks-heartbeat-interval" section="parallelTasks" label={t("settings:parallelTasks.heartbeatSettings.interval.label")}>
						<div className="flex items-center gap-2">
							<Slider
								min={10}
								max={60}
								step={5}
								value={[heartbeatInterval]}
								onValueChange={handleHeartbeatIntervalChange}
								data-testid="parallel-tasks-heartbeat-interval-slider"
							/>
							<span className="w-12 text-center">{heartbeatInterval}s</span>
						</div>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							{t("settings:parallelTasks.heartbeatSettings.interval.description")}
						</div>
					</SearchableSetting>
				</div>

				{/* DAG VISUALIZATION LEVEL (Phase 7j) */}
				<SectionHeader description={t("settings:parallelTasks.dagViz.description")}>
					{t("settings:parallelTasks.dagViz.title")}
				</SectionHeader>

				<div className="space-y-4 pl-3 border-l-2 border-vscode-button-background">
					<SearchableSetting settingId="parallel-tasks-dag-viz-level" section="parallelTasks" label={t("settings:parallelTasks.dagViz.level.label")}>
						<VSCodeDropdown
							value={dagVizLevel}
							onChange={(e: any) => handleDagVizLevelChange(e.target.value as "simple" | "graph" | "interactive")}
							data-testid="parallel-tasks-dag-viz-level-dropdown"
							className="w-48">
							<option value="simple">{t("settings:parallelTasks.dagViz.level.simple")}</option>
							<option value="graph">{t("settings:parallelTasks.dagViz.level.graph")}</option>
							<option value="interactive">{t("settings:parallelTasks.dagViz.level.interactive")}</option>
						</VSCodeDropdown>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							{t("settings:parallelTasks.dagViz.level.description")}
						</div>
					</SearchableSetting>
				</div>

				{/* TASK TYPE → MODEL MAPPING */}
				<SectionHeader description={t("settings:parallelTasks.modeMapping.description")}>
					{t("settings:parallelTasks.modeMapping.title")}
				</SectionHeader>

				<div className="space-y-4 pl-3 border-l-2 border-vscode-button-background">
					{TASK_TYPES.map((tt) => (
						<div key={tt.value} className="flex items-center gap-3 py-1">
							<span className="w-20 font-medium">{t(tt.labelKey)}</span>
							<VSCodeDropdown
								value={taskTypeSettings[tt.value]?.provider ?? ""}
								onChange={(e: any) => handleProviderChange(tt.value, e.target.value)}
								data-testid={`parallel-task-${tt.value}-provider`}
								className="grow">
								<option value="" disabled>{t("settings:parallelTasks.modeMapping.inherit")}</option>
								{PROVIDER_OPTIONS.map((p) => (
									<option key={p} value={p}>{p}</option>
								))}
							</VSCodeDropdown>
							<Input
								value={taskTypeSettings[tt.value]?.modelId ?? ""}
								onChange={(e: any) => handleModelChange(tt.value, e.target.value)}
								placeholder={t("settings:parallelTasks.modeMapping.modelPlaceholder")}
								className="w-48"
								data-testid={`parallel-task-${tt.value}-model`}
							/>
						</div>
					))}
				</div>

				{/* AUTO-APPROVE PER TASK TYPE */}
				<SectionHeader description={t("settings:parallelTasks.autoApprove.description")}>
					{t("settings:parallelTasks.autoApprove.title")}
				</SectionHeader>

				<div className="space-y-4 pl-3 border-l-2 border-vscode-button-background">
					{/* Search auto-approve */}
					<AutoApproveRow taskType={ParallelTaskType.Search} onToggle={handleAutoApproveChange} />
					{/* Doc auto-approve */}
					<AutoApproveRow taskType={ParallelTaskType.Doc} onToggle={handleAutoApproveChange} />
					{/* Commit auto-approve */}
					<AutoApproveRow taskType={ParallelTaskType.Commit} onToggle={handleAutoApproveChange} />
				</div>

				{/* LIMITS PER TASK TYPE */}
				<SectionHeader description={t("settings:parallelTasks.limits.description")}>
					{t("settings:parallelTasks.limits.title")}
				</SectionHeader>

				<div className="space-y-4 pl-3 border-l-2 border-vscode-button-background">
					{/* Max Tool Calls */}
					<LimitRow taskType={ParallelTaskType.Search} limitType="ToolCalls" defaultVal={20} onLimitChange={handleLimitChange} />
					<LimitRow taskType={ParallelTaskType.Doc} limitType="ToolCalls" defaultVal={30} onLimitChange={handleLimitChange} />
					<LimitRow taskType={ParallelTaskType.Commit} limitType="ToolCalls" defaultVal={10} onLimitChange={handleLimitChange} />

					{/* Max Cost */}
					<LimitRow taskType={ParallelTaskType.Search} limitType="Cost" defaultVal={2.00} step={0.50} onLimitChange={handleLimitChange} />
					<LimitRow taskType={ParallelTaskType.Doc} limitType="Cost" defaultVal={3.00} step={0.50} onLimitChange={handleLimitChange} />
					<LimitRow taskType={ParallelTaskType.Commit} limitType="Cost" defaultVal={1.00} step={0.50} onLimitChange={handleLimitChange} />

					{/* Max Tokens */}
					<LimitRow taskType={ParallelTaskType.Search} limitType="Tokens" defaultVal={16000} step={4000} onLimitChange={handleLimitChange} />
					<LimitRow taskType={ParallelTaskType.Doc} limitType="Tokens" defaultVal={32000} step={8000} onLimitChange={handleLimitChange} />
					<LimitRow taskType={ParallelTaskType.Commit} limitType="Tokens" defaultVal={16000} step={4000} onLimitChange={handleLimitChange} />

					{/* Context Retention */}
					<ContextRetentionRow taskType={ParallelTaskType.Search} defaultValue="minimal" onChange={(v) => {
						const key = "parallelTaskContextRetentionSearch" as const
						setCachedStateField(key, v)
						vscode.postMessage({ type: "updateSettings", updatedSettings: { [key]: v } })
					}} />
					<ContextRetentionRow taskType={ParallelTaskType.Doc} defaultValue="moderate" onChange={(v) => {
						const key = "parallelTaskContextRetentionDoc" as const
						setCachedStateField(key, v)
						vscode.postMessage({ type: "updateSettings", updatedSettings: { [key]: v } })
					}} />
					<ContextRetentionRow taskType={ParallelTaskType.Commit} defaultValue="minimal" onChange={(v) => {
						const key = "parallelTaskContextRetentionCommit" as const
						setCachedStateField(key, v)
						vscode.postMessage({ type: "updateSettings", updatedSettings: { [key]: v } })
					}} />

					{/* Notification Mode */}
					<NotificationModeRow taskType={ParallelTaskType.Search} defaultValue="errors_only" onChange={(v) => {
						const key = "parallelTaskNotificationModeSearch" as const
						setCachedStateField(key, v)
						vscode.postMessage({ type: "updateSettings", updatedSettings: { [key]: v } })
					}} />
					<NotificationModeRow taskType={ParallelTaskType.Doc} defaultValue="errors_only" onChange={(v) => {
						const key = "parallelTaskNotificationModeDoc" as const
						setCachedStateField(key, v)
						vscode.postMessage({ type: "updateSettings", updatedSettings: { [key]: v } })
					}} />
					<NotificationModeRow taskType={ParallelTaskType.Commit} defaultValue="errors_only" onChange={(v) => {
						const key = "parallelTaskNotificationModeCommit" as const
						setCachedStateField(key, v)
						vscode.postMessage({ type: "updateSettings", updatedSettings: { [key]: v } })
					}} />
				</div>

				{/* AUTO-DETECT (Phase 2+) */}
				<SearchableSetting settingId="parallel-tasks-auto-detect" section="parallelTasks" label={t("settings:parallelTasks.autoDetect.label")}>
					<VSCodeCheckbox checked={false} onChange={() => {}} data-testid="parallel-tasks-auto-detect-checkbox">
						<span className="font-medium">{t("settings:parallelTasks.autoDetect.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:parallelTasks.autoDetect.description")}
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}

/** Auto-approve checkbox row for a single task type */
function AutoApproveRow({ taskType, onToggle }: { taskType: ParallelTaskType; onToggle: (tt: ParallelTaskType, perm: string, checked: boolean) => void }) {
	const { t } = useAppTranslation()

	return (
		<div className="flex items-center gap-3 py-1">
			<span className="w-20 font-medium">{t(`settings:parallelTasks.taskTypes.${taskType}`)}</span>
			{(["readFiles", "writeFiles", "executeCommands", "browserActions"] as const).map((perm) => (
				<VSCodeCheckbox
					key={perm}
					onChange={(e: any) => onToggle(taskType, perm, e.target.checked)}
					data-testid={`parallel-task-${taskType}-autoapprove-${perm}`}>
					<span className="text-sm">{t(`settings:parallelTasks.autoApprove.permissions.${perm}`)}</span>
				</VSCodeCheckbox>
			))}
		</div>
	)
}

/** Limit input row for a single task type */
function LimitRow({
	taskType,
	limitType,
	defaultVal,
	step = 1,
	onLimitChange,
}: {
	taskType: ParallelTaskType
	limitType: "ToolCalls" | "Cost" | "Tokens"
	defaultVal: number
	step?: number
	onLimitChange: (tt: ParallelTaskType, lt: string, val: number | undefined) => void
}) {
	const { t } = useAppTranslation()
	const [value, setValue] = useState<string>(String(defaultVal))

	const handleChange = (val: string) => {
		setValue(val)
		const num = parseFloat(val)
		if (!isNaN(num) && num > 0) {
			onLimitChange(taskType, limitType, num)
		} else if (val === "") {
			onLimitChange(taskType, limitType, undefined)
		}
	}

	const unit = limitType === "Cost" ? "$" : limitType === "Tokens" ? "" : ""
	const displayValue = limitType === "Cost" ? `$${value}` : value

	return (
		<div className="flex items-center gap-3 py-1">
			<span className="w-20 font-medium">{t(`settings:parallelTasks.taskTypes.${taskType}`)}</span>
			<Input
				value={displayValue}
				onChange={(e: any) => handleChange(e.target.value)}
				placeholder={`${defaultVal}`}
				className="w-32"
				data-testid={`parallel-task-${taskType}-${limitType}-limit`}
			/>
			<span className="text-vscode-descriptionForeground text-sm w-16">{unit}</span>
		</div>
	)
}

/** Context retention dropdown row */
function ContextRetentionRow({ taskType, defaultValue, onChange }: { taskType: ParallelTaskType; defaultValue: string; onChange: (v: "minimal" | "moderate" | "full") => void }) {
	const { t } = useAppTranslation()

	return (
		<div className="flex items-center gap-3 py-1">
			<span className="w-20 font-medium">{t(`settings:parallelTasks.taskTypes.${taskType}`)}</span>
			<VSCodeDropdown
				value={defaultValue}
				onChange={(e: any) => onChange(e.target.value as "minimal" | "moderate" | "full")}
				data-testid={`parallel-task-${taskType}-context-retention`}
				className="w-40">
				<option value="minimal">{t("settings:parallelTasks.contextRetention.minimal")}</option>
				<option value="moderate">{t("settings:parallelTasks.contextRetention.moderate")}</option>
				<option value="full">{t("settings:parallelTasks.contextRetention.full")}</option>
			</VSCodeDropdown>
		</div>
	)
}

/** Notification mode dropdown row */
function NotificationModeRow({ taskType, defaultValue, onChange }: { taskType: ParallelTaskType; defaultValue: string; onChange: (v: "all" | "errors_only" | "none") => void }) {
	const { t } = useAppTranslation()

	return (
		<div className="flex items-center gap-3 py-1">
			<span className="w-20 font-medium">{t(`settings:parallelTasks.taskTypes.${taskType}`)}</span>
			<VSCodeDropdown
				value={defaultValue}
				onChange={(e: any) => onChange(e.target.value as "all" | "errors_only" | "none")}
				data-testid={`parallel-task-${taskType}-notification-mode`}
				className="w-40">
				<option value="all">{t("settings:parallelTasks.notificationMode.all")}</option>
				<option value="errors_only">{t("settings:parallelTasks.notificationMode.errorsOnly")}</option>
				<option value="none">{t("settings:parallelTasks.notificationMode.none")}</option>
			</VSCodeDropdown>
		</div>
	)
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1)
}
