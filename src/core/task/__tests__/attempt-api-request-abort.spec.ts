// Tests for attemptApiRequest abort signal coverage (PR #615)

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ProviderSettings } from "@roo-code/types"
import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import * as vscode from "vscode"

// Reuse the same mocks from Task.spec.ts to avoid duplication and missing properties
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("vscode", () => {
	// Copy the full vscode mock from the main Task.spec.ts
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [{ uri: { fsPath: "/mock/workspace/path" }, name: "mock-workspace", index: 0 }],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: { stat: vi.fn().mockResolvedValue({ type: 1 }) },
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (_: string, d: any) => d })),
		},
		env: { uriScheme: "vscode", language: "en" },
		EventEmitter: vi.fn().mockImplementation(() => mockEventEmitter),
		Disposable: { from: vi.fn() },
		TabInputText: vi.fn(),
	}
})

// Minimal other mocks needed
vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))
vi.mock("../../ignore/RooIgnoreController")

describe("attemptApiRequest abort signal", () => {
	let mockProvider: any
	let mockApiConfig: ProviderSettings

	beforeEach(() => {
		const storageUri = { fsPath: "/tmp/test-storage" }

		const mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((key: any) => (key === "taskHistory" ? [] : undefined)),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		mockProvider = new ClineProvider(
			mockExtensionContext,
			{
				appendLine: vi.fn(),
				append: vi.fn(),
				clear: vi.fn(),
				show: vi.fn(),
				hide: vi.fn(),
				dispose: vi.fn(),
			} as any,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as any

		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		} as ProviderSettings
	})

	it("sets up AbortController and cleans it up on abort", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})

		// Mock createMessage to return a never-resolving iterator (so we can abort it)
		vi.spyOn(task.api, "createMessage").mockImplementation(
			() =>
				({
					[Symbol.asyncIterator]: () => ({
						async next() {
							return new Promise(() => {}) // never resolves
						},
					}),
				}) as any,
		)

		const gen = (task as any).attemptApiRequest(0)

		expect(task.currentRequestAbortController).toBeInstanceOf(AbortController)

		// Trigger abort
		task.currentRequestAbortController!.abort()

		expect(task.currentRequestAbortController).toBeUndefined()
		expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("AbortSignal triggered for current request"))

		consoleLogSpy.mockRestore()
		gen.return?.()
	})

	it("rejects immediately if signal is already aborted", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const controller = new AbortController()
		controller.abort()

		vi.spyOn(task.api, "createMessage").mockImplementation(
			() =>
				({
					[Symbol.asyncIterator]: () => ({ async next() {} }),
				}) as any,
		)

		task.currentRequestAbortController = controller

		const gen = (task as any).attemptApiRequest(0)
		await expect(gen.next()).rejects.toThrow("Request cancelled by user")

		expect(task.currentRequestAbortController).toBeUndefined()
	})

	it("rejects via Promise.race when aborted during first chunk wait", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		vi.spyOn(task.api, "createMessage").mockImplementation(
			() =>
				({
					[Symbol.asyncIterator]: () => ({
						async next() {
							await new Promise((r) => setTimeout(r, 100))
							return { value: { type: "text", text: "ok" } }
						},
					}),
				}) as any,
		)

		const gen = (task as any).attemptApiRequest(0)

		// Abort right after controller is created
		setTimeout(() => {
			task.currentRequestAbortController?.abort()
		}, 10)

		await expect(gen.next()).rejects.toThrow("Request cancelled by user")
		expect(task.currentRequestAbortController).toBeUndefined()
	})
})
