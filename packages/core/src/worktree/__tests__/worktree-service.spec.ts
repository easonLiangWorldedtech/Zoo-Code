import * as path from "path"

// Mock child_process BEFORE importing WorktreeService so that promisify(exec) and
// promisify(execFile) capture the mocked versions at module load time.
vi.mock("child_process", () => {
	const exec = vi.fn()
	const execFile = vi.fn()
	return { exec, execFile }
})

import type { Worktree } from "../types.js"
import { WorktreeService } from "../worktree-service.js"

describe("WorktreeService", () => {
	describe("normalizePath", () => {
		let service: WorktreeService

		beforeEach(() => {
			service = new WorktreeService()
		})

		const callNormalizePath = (service: WorktreeService, p: string): string => {
			// @ts-expect-error - accessing private method for testing
			return service.normalizePath(p)
		}

		it("should normalize paths with trailing slashes", () => {
			const result = callNormalizePath(service, "/home/user/project/")
			expect(result).toBe(path.normalize("/home/user/project"))
		})

		it("should normalize paths with multiple trailing slashes", () => {
			const result = callNormalizePath(service, "/home/user/project///")
			expect(result).toBe(path.normalize("/home/user/project"))
		})

		it("should preserve root path /", () => {
			const result = callNormalizePath(service, "/")
			expect(result).toBe(path.sep)
		})

		it("should handle paths without trailing slashes", () => {
			const result = callNormalizePath(service, "/home/user/project")
			expect(result).toBe(path.normalize("/home/user/project"))
		})

		it("should handle relative paths", () => {
			const result = callNormalizePath(service, "./some/path/")
			expect(result).toBe(path.normalize("./some/path"))
		})

		it("should handle empty string", () => {
			const result = callNormalizePath(service, "")
			expect(result).toBe(".")
		})

		it("should handle Windows-style paths on non-Windows", () => {
			const result = callNormalizePath(service, "C:\\Users\\test\\project")
			expect(result).toBeTruthy()
		})
	})

	describe("parseWorktreeOutput", () => {
		let service: WorktreeService

		beforeEach(() => {
			service = new WorktreeService()
		})

		const callParseWorktreeOutput = (service: WorktreeService, output: string, currentCwd: string): Worktree[] => {
			// @ts-expect-error - accessing private method for testing
			return service.parseWorktreeOutput(output, currentCwd)
		}

		it("should parse porcelain output correctly", () => {
			const output = `worktree /home/user/repo
HEAD abc123def456
branch refs/heads/main

worktree /home/user/repo-feature
HEAD def456abc123
branch refs/heads/feature/test
`
			const result = callParseWorktreeOutput(service, output, "/home/user/repo")

			expect(result).toHaveLength(2)
			expect(result[0]).toMatchObject({
				path: "/home/user/repo",
				branch: "main",
				commitHash: "abc123def456",
				isCurrent: true,
			})
			expect(result[1]).toMatchObject({
				path: "/home/user/repo-feature",
				branch: "feature/test",
				commitHash: "def456abc123",
				isCurrent: false,
			})
		})

		it("should handle detached HEAD worktrees", () => {
			const output = `worktree /home/user/repo-detached
HEAD abc123def456
detached
`
			const result = callParseWorktreeOutput(service, output, "/home/user/other")

			expect(result).toHaveLength(1)
			expect(result[0]).toMatchObject({
				path: "/home/user/repo-detached",
				isDetached: true,
				branch: "",
			})
		})

		it("should handle locked worktrees with reason", () => {
			const output = `worktree /home/user/repo-locked
HEAD abc123def456
branch refs/heads/locked-branch
locked some reason here
`
			const result = callParseWorktreeOutput(service, output, "/home/user/other")

			expect(result).toHaveLength(1)
			expect(result[0]).toMatchObject({
				isLocked: true,
				lockReason: "some reason here",
			})
		})

		it("should handle bare worktrees", () => {
			const output = `worktree /home/user/repo.git
bare
`
			const result = callParseWorktreeOutput(service, output, "/home/user/other")

			expect(result).toHaveLength(1)
			expect(result[0]).toMatchObject({
				path: "/home/user/repo.git",
				isBare: true,
			})
		})

		it("should handle empty output", () => {
			const result = callParseWorktreeOutput(service, "", "/home/user/other")
			expect(result).toHaveLength(0)
		})

		it("should handle whitespace-only output", () => {
			const result = callParseWorktreeOutput(service, "   \n\n  ", "/home/user/other")
			expect(result).toHaveLength(0)
		})

		it("should parse worktrees with no branch field", () => {
			const output = `worktree /home/user/repo-no-branch
HEAD abc123def456
`
			const result = callParseWorktreeOutput(service, output, "/home/user/other")
			expect(result).toHaveLength(1)
			expect(result[0]).toMatchObject({
				path: "/home/user/repo-no-branch",
				branch: "",
			})
		})

		it("should parse worktrees with locked reason field", () => {
			const output = `worktree /home/user/repo-locked2
HEAD abc123def456
branch refs/heads/test
locked another reason
`
			const result = callParseWorktreeOutput(service, output, "/home/user/other")
			expect(result).toHaveLength(1)
			expect(result[0]).toMatchObject({
				isLocked: true,
				lockReason: "another reason",
			})
		})

		it("should handle multiple worktrees with mixed states", () => {
			const output = `worktree /home/user/repo-main
HEAD abc123def456
branch refs/heads/main

worktree /home/user/repo-detached-2
HEAD def456abc789
detached

worktree /home/user/repo-locked-3
HEAD 789abc123def
branch refs/heads/locked-branch
locked lock reason
`
			const result = callParseWorktreeOutput(service, output, "/home/user/repo-main")
			expect(result).toHaveLength(3)
			expect(result[0]).toMatchObject({ isCurrent: true, branch: "main" })
			expect(result[1]).toMatchObject({ isDetached: true, branch: "" })
			expect(result[2]).toMatchObject({ isLocked: true, lockReason: "lock reason" })
		})

		it("should handle Windows-style paths in worktree output", () => {
			const output = `worktree C:\\Users\\test\\repo
HEAD abc123def456
branch refs/heads/main
`
			const result = callParseWorktreeOutput(service, output, "C:\\Users\\test\\repo")
			expect(result).toHaveLength(1)
			expect(result[0]).toMatchObject({
				path: "C:\\Users\\test\\repo",
				branch: "main",
			})
		})

		it("should handle worktree with trailing whitespace in fields", () => {
			const output = `worktree /home/user/repo  
HEAD abc123def456 
branch refs/heads/main 
`
			const result = callParseWorktreeOutput(service, output, "/home/user/repo")
			expect(result).toHaveLength(1)
			expect(result[0]).toMatchObject({
				path: "/home/user/repo",
				commitHash: "abc123def456",
				branch: "main",
			})
		})

		it("should handle worktree with only whitespace between entries", () => {
			const output = `worktree /home/user/repo1
HEAD abc123

   
   
worktree /home/user/repo2
DEF456
branch refs/heads/test
`
			const result = callParseWorktreeOutput(service, output, "/home/user/repo1")
			expect(result).toHaveLength(2)
		})
	})
})
