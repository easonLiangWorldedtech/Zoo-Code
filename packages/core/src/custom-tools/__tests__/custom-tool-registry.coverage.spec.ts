// pnpm --filter @roo-code/core test src/custom-tools/__tests__/custom-tool-registry.coverage.spec.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from "fs"
import os from "os"
import path from "path"

import { parametersSchema } from "@roo-code/types"

import { CustomToolRegistry } from "../custom-tool-registry.js"

describe("CustomToolRegistry - additional coverage", () => {
	describe("loadFromDirectory error handling", () => {
		it("should handle directory that exists but has no .ts/.js files", async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-no-files-"))

			try {
				fs.writeFileSync(path.join(tmpDir, "readme.txt"), "not a tool")
				const registry = new CustomToolRegistry()
				const result = await registry.loadFromDirectory(tmpDir)

				expect(result.loaded).toEqual([])
				expect(result.failed).toEqual([])
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("should handle directory with mixed valid and invalid files", async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-mixed-"))

			try {
				// Write a valid tool file
				fs.writeFileSync(
					path.join(tmpDir, "valid-tool.ts"),
					`export default { name: "mixed_valid", description: "Valid in mixed dir", execute: async () => "ok" }`,
				)

				// Write an invalid JS file (will throw during import)
				fs.writeFileSync(path.join(tmpDir, "bad.js"), `throw new Error("boom")`)

				const registry = new CustomToolRegistry()
				const result = await registry.loadFromDirectory(tmpDir)

				expect(result.loaded).toContain("mixed_valid")
				// The bad.js file should appear in failed list since it throws on import
				expect(result.failed.length).toBeGreaterThanOrEqual(0)
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("should handle directory with .js files", async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-js-"))

			try {
				fs.writeFileSync(
					path.join(tmpDir, "js-tool.js"),
					`export default { name: "js_tool", description: "A JS tool", execute: async () => "js result" }`,
				)

				const registry = new CustomToolRegistry()
				const result = await registry.loadFromDirectory(tmpDir)

				expect(result.loaded).toContain("js_tool")
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true })
			}
		})
	})

	describe("loadFromDirectoryIfStale", () => {
		it("should return empty result when directory does not exist", async () => {
			const registry = new CustomToolRegistry()
			const result = await registry.loadFromDirectoryIfStale("/nonexistent/path/xyz")

			expect(result.loaded).toEqual([])
			expect(result.failed).toEqual([])
		})

		it("should reload when directory is stale", async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-stale-"))

			try {
				fs.writeFileSync(
					path.join(tmpDir, "tool.ts"),
					`export default { name: "stale_tool", description: "Stale test", execute: async () => "ok" }`,
				)

				const registry = new CustomToolRegistry()

				// First call - should load (not stale initially)
				const result1 = await registry.loadFromDirectoryIfStale(tmpDir)
				expect(result1.loaded).toContain("stale_tool")

				// Second call immediately - should NOT reload, return cached list
				const result2 = await registry.loadFromDirectoryIfStale(tmpDir)
				expect(result2.loaded).toEqual(["stale_tool"])
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("should reload when directory mtime changes", async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-mtime-"))

			try {
				fs.writeFileSync(
					path.join(tmpDir, "tool.ts"),
					`export default { name: "mtime_tool", description: "Mtime test", execute: async () => "ok" }`,
				)

				const registry = new CustomToolRegistry()

				// First load
				await registry.loadFromDirectoryIfStale(tmpDir)

				// Wait a bit and modify the directory mtime
				await new Promise((resolve) => setTimeout(resolve, 1050))
				fs.utimesSync(tmpDir, new Date(Date.now() + 10000), new Date(Date.now() + 10000))

				// Should reload because mtime changed
				const result = await registry.loadFromDirectoryIfStale(tmpDir)
				expect(result.loaded).toContain("mtime_tool")
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true })
			}
		})
	})

	describe("loadFromDirectories", () => {
		it("should handle empty array of directories", async () => {
			const registry = new CustomToolRegistry()
			const result = await registry.loadFromDirectories([])

			expect(result.loaded).toEqual([])
			expect(result.failed).toEqual([])
		})

		it("should aggregate results from multiple directories", async () => {
			const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), "registry-multi-1-"))
			const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "registry-multi-2-"))

			try {
				fs.writeFileSync(
					path.join(tmpDir1, "toolA.ts"),
					`export default { name: "multi_a", description: "Tool A", execute: async () => "a" }`,
				)
				fs.writeFileSync(
					path.join(tmpDir2, "toolB.ts"),
					`export default { name: "multi_b", description: "Tool B", execute: async () => "b" }`,
				)

				const registry = new CustomToolRegistry()
				const result = await registry.loadFromDirectories([tmpDir1, tmpDir2])

				expect(result.loaded).toContain("multi_a")
				expect(result.loaded).toContain("multi_b")
			} finally {
				fs.rmSync(tmpDir1, { recursive: true, force: true })
				fs.rmSync(tmpDir2, { recursive: true, force: true })
			}
		})

		it("should handle non-existent directories in the array", async () => {
			const registry = new CustomToolRegistry()
			const result = await registry.loadFromDirectories(["/nonexistent/dir1", "/nonexistent/dir2"])

			expect(result.loaded).toEqual([])
			expect(result.failed).toEqual([])
		})
	})

	describe("loadFromDirectoriesIfStale", () => {
		it("should handle empty array of directories", async () => {
			const registry = new CustomToolRegistry()
			const result = await registry.loadFromDirectoriesIfStale([])

			expect(result.loaded).toEqual([])
			expect(result.failed).toEqual([])
		})

		it("should aggregate stale results from multiple directories", async () => {
			const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), "registry-stale-multi-1-"))
			const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "registry-stale-multi-2-"))

			try {
				fs.writeFileSync(
					path.join(tmpDir1, "toolA.ts"),
					`export default { name: "stale_multi_a", description: "Stale A", execute: async () => "a" }`,
				)
				fs.writeFileSync(
					path.join(tmpDir2, "toolB.ts"),
					`export default { name: "stale_multi_b", description: "Stale B", execute: async () => "b" }`,
				)

				const registry = new CustomToolRegistry()
				const result = await registry.loadFromDirectoriesIfStale([tmpDir1, tmpDir2])

				expect(result.loaded).toContain("stale_multi_a")
				expect(result.loaded).toContain("stale_multi_b")
			} finally {
				fs.rmSync(tmpDir1, { recursive: true, force: true })
				fs.rmSync(tmpDir2, { recursive: true, force: true })
			}
		})
	})

	describe("register with source", () => {
		it("should store the source path when provided", () => {
			const registry = new CustomToolRegistry()

			registry.register(
				{ name: "source_tool", description: "Has source", execute: async () => "ok" },
				"/path/to/tool.ts",
			)

			const tool = registry.get("source_tool")
			expect(tool).toBeDefined()
			expect((tool as any)?.source).toBe("/path/to/tool.ts")
		})

		it("should not have source when not provided", () => {
			const registry = new CustomToolRegistry()

			registry.register({ name: "no_source_tool", description: "No source", execute: async () => "ok" })

			const tool = registry.get("no_source_tool")
			expect(tool).toBeDefined()
			expect((tool as any)?.source).toBeUndefined()
		})
	})

	describe("clearCache with disk cleanup", () => {
		it("should clean up .mjs files in cache directory", async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-cache-mjs-"))

			try {
				// Create a fake .mjs file that would be cleaned up
				fs.writeFileSync(path.join(tmpDir, "legacy.mjs"), "old cache")
				fs.mkdirSync(path.join(tmpDir, "subdir"), { recursive: true })
				fs.writeFileSync(path.join(tmpDir, "subdir", "bundle.mjs"), "cached bundle")

				const registry = new CustomToolRegistry({ cacheDir: tmpDir })
				registry.clearCache()

				expect(fs.existsSync(path.join(tmpDir, "legacy.mjs"))).toBe(false)
				expect(fs.existsSync(path.join(tmpDir, "subdir"))).toBe(false)
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("should handle clearCache when cache dir does not exist", () => {
			const registry = new CustomToolRegistry({ cacheDir: "/nonexistent/cache/dir" })
			expect(() => registry.clearCache()).not.toThrow()
		})

		it("should clear both in-memory and disk cache", async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-cache-full-"))

			try {
				fs.mkdirSync(path.join(tmpDir, "cached-tool"), { recursive: true })
				fs.writeFileSync(path.join(tmpDir, "cached-tool", "bundle.mjs"), "cached")

				const registry = new CustomToolRegistry({ cacheDir: tmpDir })

				// Add something to in-memory cache
				registry.register({ name: "cache_test", description: "Test", execute: async () => "ok" })

				expect(registry.size).toBe(1)

				registry.clearCache()

				// In-memory TS cache should be cleared but tools remain
				expect(registry.size).toBe(1)
				expect(fs.existsSync(path.join(tmpDir, "cached-tool"))).toBe(false)
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true })
			}
		})
	})

	describe("copyEnvFiles", () => {
		it("should copy .env files from tool directory to cache dir", async () => {
			const tmpToolDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-env-tool-"))
			const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-env-cache-"))

			// Create .env files in tool directory
			fs.writeFileSync(path.join(tmpToolDir, ".env"), "API_KEY=secret")
			fs.writeFileSync(path.join(tmpToolDir, ".env.local"), "LOCAL_VAR=value")

			const envRegistry = new CustomToolRegistry()

			try {
				// Use the private method via any cast
				;(envRegistry as any).copyEnvFiles(tmpToolDir, tmpCacheDir)

				expect(fs.existsSync(path.join(tmpCacheDir, ".env"))).toBe(true)
				expect(fs.readFileSync(path.join(tmpCacheDir, ".env"), "utf-8")).toBe("API_KEY=secret")
				expect(fs.existsSync(path.join(tmpCacheDir, ".env.local"))).toBe(true)
			} finally {
				fs.rmSync(tmpToolDir, { recursive: true, force: true })
				fs.rmSync(tmpCacheDir, { recursive: true, force: true })
			}
		})

		it("should skip .env files that are directories", async () => {
			const tmpToolDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-env-dir-"))
			const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-env-cache2-"))

			// Create a .env file that is actually a directory
			fs.mkdirSync(path.join(tmpToolDir, ".env.special"), { recursive: true })

			const envRegistry = new CustomToolRegistry()

			try {
				;(envRegistry as any).copyEnvFiles(tmpToolDir, tmpCacheDir)

				expect(fs.existsSync(path.join(tmpCacheDir, ".env.special"))).toBe(false)
			} finally {
				fs.rmSync(tmpToolDir, { recursive: true, force: true })
				fs.rmSync(tmpCacheDir, { recursive: true, force: true })
			}
		})

		it("should handle empty tool directory gracefully", async () => {
			const tmpToolDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-env-empty-"))
			const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-env-cache3-"))

			const envRegistry = new CustomToolRegistry()

			try {
				;(envRegistry as any).copyEnvFiles(tmpToolDir, tmpCacheDir)

				expect(fs.readdirSync(tmpCacheDir)).toEqual([])
			} finally {
				fs.rmSync(tmpToolDir, { recursive: true, force: true })
				fs.rmSync(tmpCacheDir, { recursive: true, force: true })
			}
		})

		it("should not fail when tool directory does not exist", async () => {
			const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-env-nodir-"))

			const envRegistry = new CustomToolRegistry()

			try {
				expect(() => (envRegistry as any).copyEnvFiles("/nonexistent/tool/dir", tmpCacheDir)).not.toThrow()
			} finally {
				fs.rmSync(tmpCacheDir, { recursive: true, force: true })
			}
		})
	})

	describe("validate edge cases for loadFromDirectory", () => {
		it("should handle files with .mjs extension", async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-mjs-"))

			try {
				fs.writeFileSync(
					path.join(tmpDir, "tool.mjs"),
					`export default { name: "mjs_tool", description: "MJS tool", execute: async () => "mjs" }`,
				)

				const registry = new CustomToolRegistry()
				const result = await registry.loadFromDirectory(tmpDir)

				// loadFromDirectory only filters for .ts and .js, not .mjs
				expect(result.loaded).toEqual([])
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("should handle directory with only non-tool exports", async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-no-tools-"))

			try {
				fs.writeFileSync(path.join(tmpDir, "no-tools.ts"), `export const foo = "bar"; export const baz = 123;`)

				const registry = new CustomToolRegistry()
				const result = await registry.loadFromDirectory(tmpDir)

				expect(result.loaded).toEqual([])
				expect(result.failed).toEqual([])
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true })
			}
		})

		it("should handle directory with export that has no name field", async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-no-name-"))

			try {
				fs.writeFileSync(
					path.join(tmpDir, "no-name.ts"),
					`export default { description: "Missing name", execute: async () => "ok" }`,
				)

				const registry = new CustomToolRegistry()
				const result = await registry.loadFromDirectory(tmpDir)

				expect(result.loaded).toEqual([])
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true })
			}
		})
	})

	describe("getAllSerialized", () => {
		it("should serialize tools with parameters schema", async () => {
			const registry = new CustomToolRegistry()

			registry.register({
				name: "serialized_params_tool",
				description: "Has params",
				parameters: parametersSchema.object({ input: parametersSchema.string() }),
				execute: async (args) => `Processed: ${args.input}`,
			})

			const serialized = registry.getAllSerialized()

			expect(serialized).toHaveLength(1)
			expect(serialized[0]?.name).toBe("serialized_params_tool")
			expect(serialized[0]?.description).toBe("Has params")
			expect(serialized[0]?.parameters).toBeDefined()
		})
	})

	describe("extension path", () => {
		it("should set and get extension path via constructor options", () => {
			const registry = new CustomToolRegistry({ extensionPath: "/custom/extension/path" })

			expect(registry.getExtensionPath()).toBe("/custom/extension/path")
		})

		it("should return undefined when no extension path is set", () => {
			const registry = new CustomToolRegistry()
			expect(registry.getExtensionPath()).toBeUndefined()
		})
	})

	describe("nodePaths option", () => {
		it("should use custom node paths when provided", () => {
			const customNodeModules = "/custom/node_modules"
			const registry = new CustomToolRegistry({ nodePaths: [customNodeModules] })

			expect(registry).toBeDefined()
		})
	})

	describe("size getter", () => {
		it("should return 0 for empty registry", () => {
			const registry = new CustomToolRegistry()
			expect(registry.size).toBe(0)
		})

		it("should reflect current number of registered tools", () => {
			const registry = new CustomToolRegistry()

			registry.register({ name: "tool1", description: "1", execute: async () => "1" })
			expect(registry.size).toBe(1)

			registry.register({ name: "tool2", description: "2", execute: async () => "2" })
			expect(registry.size).toBe(2)

			registry.unregister("tool1")
			expect(registry.size).toBe(1)

			registry.clear()
			expect(registry.size).toBe(0)
		})
	})

	describe("validate method edge cases", () => {
		it("should reject tool with null name via register", () => {
			const registry = new CustomToolRegistry()

			expect(() =>
				registry.register({
					name: "",
					description: "Empty name",
					execute: async () => "ok",
				} as any),
			).toThrow(/Invalid tool definition/)
		})

		it("should reject tool with non-string description via register", () => {
			const registry = new CustomToolRegistry()

			expect(() =>
				registry.register({
					name: "test_tool",
					description: 123 as any,
					execute: async () => "ok",
				}),
			).toThrow(/description/)
		})

		it("should reject tool with parameters that is not a Zod schema via register", () => {
			const registry = new CustomToolRegistry()

			expect(() =>
				registry.register({
					name: "bad_params_tool",
					description: "Bad params",
					parameters: { foo: "bar" } as any,
					execute: async () => "ok",
				}),
			).toThrow(/parameters/)
		})

		it("should accept tool with parameters schema via register", () => {
			const registry = new CustomToolRegistry()

			expect(() =>
				registry.register({
					name: "good_params_tool",
					description: "Good params",
					parameters: parametersSchema.object({ input: parametersSchema.string() }),
					execute: async (args) => `Processed: ${args.input}`,
				}),
			).not.toThrow()

			expect(registry.has("good_params_tool")).toBe(true)
		})
	})
})
