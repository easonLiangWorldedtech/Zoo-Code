import type { SkillsManager } from "../../services/skills/SkillsManager"

/**
 * Loads Roo Code skills matching a worker's task type and injects them into the system prompt.
 * Extracted from BGWorker for testability and reusability (v5).
 */
export class BGWorkerSkillLoader {
	private skillsManager: SkillsManager | undefined
	private skillInstructions = ""

	constructor(skillsManager: SkillsManager | undefined) {
		this.skillsManager = skillsManager
	}

	/**
	 * Load Roo Code skills matching the worker's task type.
	 * Returns the skill instructions string to prepend to the system prompt, or empty string if no skills found.
	 */
	async load(taskType: string | undefined, mode: string): Promise<string> {
		if (!this.skillsManager) return ""

		try {
			// Try to find a skill that matches this task type
			const skillName = `parallel-task-${taskType ?? "general"}`

			const skillContent = await this.skillsManager.getSkillContent(skillName, mode)

			if (skillContent && skillContent.instructions?.trim()) {
				this.skillInstructions = `## Skill: ${skillContent.name}\n\n${skillContent.instructions}`
				return this.skillInstructions
			}
		} catch (error) {
			console.warn(`[BGWorkerSkillLoader] Failed to load skill for task type ${taskType}:`, error)
		}

		// Fallback: try generic "background-worker" skill
		try {
			const fallback = await this.skillsManager.getSkillContent("background-worker", mode)
			if (fallback?.instructions?.trim()) {
				this.skillInstructions = `## Skill: ${fallback.name}\n\n${fallback.instructions}`
				return this.skillInstructions
			}
		} catch {
			// No fallback skill found — return empty string, worker uses generic system prompt
		}

		return ""
	}

	/** Get the loaded skill instructions (for testing/debugging) */
	getInstructions(): string {
		return this.skillInstructions
	}
}
