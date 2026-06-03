// npx vitest run src/core/parallel/__tests__/BGWorkerSkillLoader.test.ts

import { describe, it, expect } from "vitest"
import { BGWorkerSkillLoader } from "../BGWorkerSkillLoader"

// ─── Mock SkillsManager ──────────────────────────────────────────────────────

interface MockSkillContent {
    name: string
    instructions: string
}

interface MockSkillsManager {
    getSkillContent: (name: string, mode?: string) => Promise<MockSkillContent | null>
}

function createMockSkillsManager(
    responses: Record<string, MockSkillContent | null>,
): MockSkillsManager {
    return {
        getSkillContent: async (name: string): Promise<MockSkillContent | null> => {
            // Simulate slight delay like real filesystem access
            await new Promise((resolve) => setTimeout(resolve, 1))
            return responses[name] ?? null
        },
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BGWorkerSkillLoader", () => {
    describe("load()", () => {
        it("returns skill instructions when matching task-type-specific skill exists", async () => {
            const mockManager = createMockSkillsManager({
                "parallel-task-search": {
                    name: "parallel-task-search",
                    instructions: "Search workers should use ripgrep for file searches.",
                },
            })

            const loader = new BGWorkerSkillLoader(mockManager as any)
            const result = await loader.load("search", "code")

            expect(result).toBe(
                "## Skill: parallel-task-search\n\nSearch workers should use ripgrep for file searches.",
            )
        })

        it("returns skill instructions when matching doc task-type-specific skill exists", async () => {
            const mockManager = createMockSkillsManager({
                "parallel-task-doc": {
                    name: "parallel-task-doc",
                    instructions: "Doc workers should write clear, structured documentation.",
                },
            })

            const loader = new BGWorkerSkillLoader(mockManager as any)
            const result = await loader.load("doc", "code")

            expect(result).toBe(
                "## Skill: parallel-task-doc\n\nDoc workers should write clear, structured documentation.",
            )
        })

        it("falls back to background-worker skill when task-type-specific skill is missing", async () => {
            const mockManager = createMockSkillsManager({
                // No parallel-task-search, but has fallback
                "background-worker": {
                    name: "background-worker",
                    instructions: "General background worker guidelines.",
                },
            })

            const loader = new BGWorkerSkillLoader(mockManager as any)
            const result = await loader.load("search", "code")

            expect(result).toBe(
                "## Skill: background-worker\n\nGeneral background worker guidelines.",
            )
        })

        it("returns empty string when no skills are available", async () => {
            const mockManager = createMockSkillsManager({})

            const loader = new BGWorkerSkillLoader(mockManager as any)
            const result = await loader.load("search", "code")

            expect(result).toBe("")
        })

        it("returns empty string when skills manager is undefined", async () => {
            const loader = new BGWorkerSkillLoader(undefined)
            const result = await loader.load("search", "code")

            expect(result).toBe("")
        })

        it("handles skill with empty instructions (treats as missing)", async () => {
            const mockManager = createMockSkillsManager({
                "parallel-task-search": {
                    name: "parallel-task-search",
                    instructions: "",
                },
                "background-worker": {
                    name: "background-worker",
                    instructions: "Fallback worker guidelines.",
                },
            })

            const loader = new BGWorkerSkillLoader(mockManager as any)
            const result = await loader.load("search", "code")

            // Should fall through to background-worker since search skill has empty instructions
            expect(result).toBe(
                "## Skill: background-worker\n\nFallback worker guidelines.",
            )
        })

        it("handles malformed SKILL.md (no instructions field)", async () => {
            const mockManager = createMockSkillsManager({
                "parallel-task-search": {
                    name: "parallel-task-search",
                    // No instructions field — simulates malformed skill file
                } as any,
                "background-worker": {
                    name: "background-worker",
                    instructions: "Fallback worker guidelines.",
                },
            })

            const loader = new BGWorkerSkillLoader(mockManager as any)
            const result = await loader.load("search", "code")

            // Should fall through to background-worker since search skill has no instructions
            expect(result).toBe(
                "## Skill: background-worker\n\nFallback worker guidelines.",
            )
        })

        it("handles error during skill loading (throws exception)", async () => {
            const mockManager = createMockSkillsManager({})
            // Override to throw on first call
            ;(mockManager as any).getSkillContent = async (name: string) => {
                if (name === "parallel-task-search") {
                    throw new Error("File read error")
                }
                return null
            }

            const loader = new BGWorkerSkillLoader(mockManager as any)
            // Should not throw — errors are caught and logged
            const result = await loader.load("search", "code")

            expect(result).toBe("")
        })

        it("handles error during fallback skill loading", async () => {
            const mockManager = createMockSkillsManager({})
            ;(mockManager as any).getSkillContent = async (name: string) => {
                throw new Error("All skills failed")
            }

            const loader = new BGWorkerSkillLoader(mockManager as any)
            const result = await loader.load("search", "code")

            expect(result).toBe("")
        })

        it("uses 'general' when taskType is undefined", async () => {
            const mockManager = createMockSkillsManager({
                "parallel-task-general": {
                    name: "parallel-task-general",
                    instructions: "General worker guidelines.",
                },
            })

            const loader = new BGWorkerSkillLoader(mockManager as any)
            const result = await loader.load(undefined, "code")

            expect(result).toBe(
                "## Skill: parallel-task-general\n\nGeneral worker guidelines.",
            )
        })

        it("passes mode to getSkillContent", async () => {
            let capturedMode: string | undefined
            const mockManager = createMockSkillsManager({})
            ;(mockManager as any).getSkillContent = async (name: string, mode?: string) => {
                capturedMode = mode
                return null
            }

            const loader = new BGWorkerSkillLoader(mockManager as any)
            await loader.load("search", "debug")

            expect(capturedMode).toBe("debug")
        })

        it("getInstructions() returns loaded instructions for debugging", async () => {
            const mockManager = createMockSkillsManager({
                "parallel-task-search": {
                    name: "parallel-task-search",
                    instructions: "Search workers should use ripgrep.",
                },
            })

            const loader = new BGWorkerSkillLoader(mockManager as any)
            await loader.load("search", "code")

            expect(loader.getInstructions()).toBe(
                "## Skill: parallel-task-search\n\nSearch workers should use ripgrep.",
            )
        })

        it("getInstructions() returns empty string when no skill loaded", async () => {
            const mockManager = createMockSkillsManager({})
            const loader = new BGWorkerSkillLoader(mockManager as any)
            await loader.load("search", "code")

            expect(loader.getInstructions()).toBe("")
        })
    })
})
