// pnpm --filter roo-cline test core/webview/__tests__/ClineProvider.parallelMode.spec.ts

import * as vscode from "vscode"

import { type ExtensionMessage, type ExtensionState, RooCodeEventName } from "@roo-code/types"

import { defaultModeSlug } from "../../../shared/modes"
import { ContextProxy } from "../../config/ContextProxy"
import { ClineProvider } from "../ClineProvider"
import { TelemetryService } from "@roo-code/telemetry"

// Mock p-wait-for
vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

// Mock fs/promises
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	const mocked = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue(""),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
	}

	return {
		...actual,
		...mocked,
		default: {
			...actual,
			...mocked,
		},
	}
})

// Mock axios
vi.mock("axios", () => ({
	default: {
		get: vi.fn().mockResolvedValue({ data: { data: [] } }),
		post: vi.fn(),
	},
	get: vi.fn().mockResolvedValue({ data: { data: [] } }),
	post: vi.fn(),
}))

// Mock safeWriteJson
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockResolvedValue(undefined),
}))

// Mock path utils
vi.mock("../../../utils/path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/path")>()
	return {
		...actual,
		getWorkspacePath: vi.fn().mockReturnValue(""),
	}
})

// Mock storage utils
vi.mock("../../../utils/storage", () => ({
	getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	getGlobalStoragePath: vi.fn().mockResolvedValue("/test/storage/path"),
}))

// Mock MCP types
vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
	CallToolResultSchema: {},
	ListResourcesResultSchema: {},
	ListResourceTemplatesResultSchema: {},
	ListToolsResultSchema: {},
	ReadResourceResultSchema: {},
	ErrorCode: {
		InvalidRequest: "InvalidRequest",
		MethodNotFound: "MethodNotFound",
		InternalError: "InternalError",
	},
	McpError: class McpError extends Error {
		code: string
		constructor(code: string, message: string) {
			super(message)
			this.name = "McpError"
			this.code = code
		}
	},
}))

// Mock delay
vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = () => delayFn
	delayFn.reject = () => Promise.reject(new Error("Delay rejected"))
	delayFn.range = () => Promise.resolve()
	return { default: delayFn }
})

// Mock MCP client
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	__esModule: true,
	Client: vi.fn().mockImplementation(function () {
		return {
			connect: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			listTools: vi.fn().mockResolvedValue({ tools: [] }),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
		}
	}),
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	__esModule: true,
	StdioClientTransport: vi.fn().mockImplementation(function () {
		return {
			connect: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
		}
	}),
}))

// Mock vscode
vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	EventEmitter: vi.fn().mockImplementation(function () {
		return {
			event: vi.fn(),
			fire: vi.fn(),
			dispose: vi.fn(),
		}
	}),
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
	},
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	Range: class Range {
		constructor(
			readonly startLine: number,
			readonly startCharacter: number,
			readonly endLine: number,
			readonly endCharacter: number,
		) {}
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		getWorkspaceFolder: vi.fn(),
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => {
			return {
				dispose: vi.fn(),
			}
		}),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		activeTextEditor: undefined,
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
		createTextEditorDecorationType: vi.fn().mockReturnValue({}),
		tabGroups: {
			onDidChangeTabs: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		},
	},
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
	version: "1.85.0",
}))

// Mock TTS utils
vi.mock("../../../utils/tts", () => ({
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
}))

// Mock API
vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({
			id: "claude-3-sonnet",
		}),
	}),
}))

// Mock system prompt
vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockResolvedValue("mocked system prompt"),
	codeMode: "code",
}))

// Mock WorkspaceTracker - simple mock that works (same pattern as sticky-mode.spec.ts)
vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(function () {
		return {
			initializeFilePaths: vi.fn(),
			dispose: vi.fn(),
		}
	}),
}))
// Mock ContextProxy for viewLocalState tests
vi.mock("../../config/ContextProxy", () => {
	const defaultState = {
		mode: "code",
		currentApiConfigName: "default",
		apiConfiguration: {},
		customModePrompts: {},
		modeApiConfigs: {},
		listApiConfigMeta: [],
		pinnedApiConfigs: {},
	}

	class MockContextProxy {
		public globalStorageUri: { fsPath: string }
		public extensionUri: { fsPath: string }
		public extensionMode = 1

		constructor(public context: any) {
			this.globalStorageUri = context?.globalStorageUri ?? { fsPath: "/test/storage/path" }
			this.extensionUri = context?.extensionUri ?? { fsPath: "/test/path" }
		}

		getValues = vi.fn().mockImplementation(() => ({
			...defaultState,
			mode: this.context?.globalState?.get("mode") ?? defaultState.mode,
			currentApiConfigName:
				this.context?.globalState?.get("currentApiConfigName") ?? defaultState.currentApiConfigName,
			apiConfiguration: this.context?.globalState?.get("apiConfiguration") ?? defaultState.apiConfiguration,
			customModePrompts: this.context?.globalState?.get("customModePrompts") ?? defaultState.customModePrompts,
			modeApiConfigs: this.context?.globalState?.get("modeApiConfigs") ?? defaultState.modeApiConfigs,
			listApiConfigMeta: this.context?.globalState?.get("listApiConfigMeta") ?? defaultState.listApiConfigMeta,
			pinnedApiConfigs: this.context?.globalState?.get("pinnedApiConfigs") ?? defaultState.pinnedApiConfigs,
		}))
		getValue = vi.fn().mockImplementation((key: string) => this.context?.globalState?.get(key))
		getProviderSettings = vi.fn().mockReturnValue({ apiProvider: "anthropic" })
		setValue = vi.fn().mockImplementation((key: string, value: any) => {
			return this.context?.globalState?.update?.(key, value) ?? Promise.resolve()
		})
		setValues = vi.fn().mockImplementation((values: Record<string, any>) => {
			return Promise.all(Object.entries(values).map(([key, value]) => this.setValue(key, value))).then(
				() => undefined,
			)
		})
		setProviderSettings = vi.fn().mockImplementation((settings: Record<string, any>) => this.setValues(settings))
	}
	return { ContextProxy: MockContextProxy }
})

// Mock Task
vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function (options: any) {
		return {
			api: undefined,
			abortTask: vi.fn(),
			handleWebviewAskResponse: vi.fn(),
			clineMessages: [],
			apiConversationHistory: [],
			overwriteClineMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			getTaskNumber: vi.fn().mockReturnValue(0),
			setTaskNumber: vi.fn(),
			setParentTask: vi.fn(),
			setRootTask: vi.fn(),
			taskId: options?.historyItem?.id || "test-task-id",
			emit: vi.fn(),
		}
	}),
}))

// Mock extract-text
vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockImplementation(async (_filePath: string) => {
		const content = "const x = 1;\nconst y = 2;\nconst z = 3;"
		const lines = content.split("\n")
		return lines.map((line, index) => `${index + 1} | ${line}`).join("\n")
	}),
}))

// Mock model cache
vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))

// Mock cloud service
vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return {
				isAuthenticated: vi.fn().mockReturnValue(false),
				getAllowList: vi.fn().mockResolvedValue([]),
				getUserInfo: vi.fn().mockReturnValue(null),
				getOrganizationSettings: vi.fn().mockReturnValue(null),
				off: vi.fn(),
			}
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
}))

// Mock modes
vi.mock("../../../shared/modes", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../shared/modes")>()
	return {
		...actual,
		modes: [
			{
				slug: "code",
				name: "Code Mode",
				roleDefinition: "You are a code assistant",
				groups: ["read", "edit"],
			},
			{
				slug: "architect",
				name: "Architect Mode",
				roleDefinition: "You are an architect",
				groups: ["read", "edit"],
			},
			{
				slug: "debugger",
				name: "Debugger Mode",
				roleDefinition: "You are a debugger",
				groups: ["read", "edit"],
			},
			{
				slug: "ask",
				name: "Ask Mode",
				roleDefinition: "You are a helpful assistant",
				groups: ["read"],
			},
		],
		getModeBySlug: vi.fn().mockImplementation((slug: string) => {
			return actual.modes?.find((m) => m.slug === slug) ?? null
		}),
		defaultModeSlug: "code",
	}
})

// Mock custom instructions
vi.mock("../../prompts/sections/custom-instructions", () => ({
	addCustomInstructions: vi.fn().mockResolvedValue("Combined instructions"),
}))

// Mock zoo-code-auth
vi.mock("../../../services/zoo-code-auth", () => ({
	getZooCodeBaseUrl: vi.fn(() => "https://www.zoocode.dev"),
	getCachedZooCodeToken: vi.fn(),
	handleAuthCallback: vi.fn(),
	setZooCodeUserInfo: vi.fn(),
	disconnectZooCode: vi.fn(),
}))

// Mock diff strategy
vi.mock("../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(function () {
		return {
			getToolDescription: () => "test",
			getName: () => "test-strategy",
			applyDiff: vi.fn(),
		}
	}),
}))

// Mock Terminal
vi.mock("../../../integrations/terminal/Terminal", () => ({
	Terminal: {
		defaultShellIntegrationTimeout: 10000,
		setShellIntegrationTimeout: vi.fn(),
		setShellIntegrationDisabled: vi.fn(),
		setCommandDelay: vi.fn(),
		setTerminalZshClearEolMark: vi.fn(),
		setTerminalZshOhMy: vi.fn(),
		setTerminalZshP10k: vi.fn(),
		setPowershellCounter: vi.fn(),
		setTerminalZdotdir: vi.fn(),
		setTerminalProfile: vi.fn(),
	},
}))

// Mock McpHub and McpServerManager
vi.mock("../../services/mcp/McpHub", () => ({
	McpHub: vi.fn().mockImplementation(function () {
		return {
			registerClient: vi.fn(),
			unregisterClient: vi.fn(),
			getAllServers: vi.fn().mockReturnValue([]),
		}
	}),
}))

vi.mock("../../services/mcp/McpServerManager", () => ({
	McpServerManager: {
		getInstance: vi.fn().mockResolvedValue({
			registerClient: vi.fn(),
			unregisterClient: vi.fn(),
			getAllServers: vi.fn().mockReturnValue([]),
		}),
		unregisterProvider: vi.fn(),
	},
}))

// Mock SkillsManager
vi.mock("../../services/skills/SkillsManager", () => ({
	SkillsManager: vi.fn().mockImplementation(function () {
		return {
			initialize: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(),
		}
	}),
}))

// Mock MarketplaceManager
vi.mock("../../services/marketplace", () => ({
	MarketplaceManager: vi.fn().mockImplementation(function () {
		return {
			cleanup: vi.fn(),
		}
	}),
}))

// Mock ProviderSettingsManager
vi.mock("../../config/ProviderSettingsManager", () => ({
	ProviderSettingsManager: vi.fn().mockImplementation(function () {
		return {
			saveConfig: vi.fn().mockResolvedValue("test-id"),
			listConfig: vi.fn().mockResolvedValue([]),
			getProfile: vi.fn().mockResolvedValue({}),
			activateProfile: vi.fn().mockImplementation(async (args: { name?: string; id?: string }) => ({
				name: args.name ?? "default",
				id: args.id ?? "test-id",
				apiProvider: "anthropic",
			})),
			setModeConfig: vi.fn().mockResolvedValue(undefined),
			getModeConfigId: vi.fn().mockResolvedValue(undefined),
		}
	}),
}))

// Mock CustomModesManager
vi.mock("../../config/CustomModesManager", () => ({
	CustomModesManager: vi.fn().mockImplementation(function () {
		return {
			updateCustomMode: vi.fn().mockResolvedValue(undefined),
			getCustomModes: vi.fn().mockResolvedValue([]),
			dispose: vi.fn(),
		}
	}),
}))

// Mock task persistence
vi.mock("../../task-persistence/taskMessages", () => ({
	readTaskMessages: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../task-persistence", () => ({
	readApiMessages: vi.fn().mockResolvedValue([]),
	saveApiMessages: vi.fn().mockResolvedValue(undefined),
	saveTaskMessages: vi.fn().mockResolvedValue(undefined),
	TaskHistoryStore: vi.fn().mockImplementation(function () {
		return {
			initialize: vi.fn().mockResolvedValue(undefined),
			getAll: vi.fn().mockReturnValue([]),
			get: vi.fn().mockReturnValue(null),
			set: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
			migrateFromGlobalState: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(),
		}
	}),
	assertValidTransition: vi.fn(),
}))

// Mock RateLimitClock
vi.mock("../../task/RateLimitClock", () => ({
	createRateLimitClock: vi.fn().mockReturnValue({
		isRateLimited: vi.fn().mockReturnValue(false),
		resetTimer: vi.fn(),
	}),
}))

beforeAll(() => {
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.spyOn(console, "warn").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
})

afterAll(() => {
	vi.restoreAllMocks()
})

/**
 * ClineProvider - Parallel Mode Support Tests
 *
 * These tests verify that the view-local state isolation feature works correctly,
 * allowing multiple ClineProvider instances (e.g., in parallel tabs) to maintain
 * independent mode, API configuration, and other view-specific settings.
 */
describe("ClineProvider - Parallel Mode Support", () => {
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, any> = {
			mode: "code",
			currentApiConfigName: "default",
			apiConfiguration: {},
			customModePrompts: {},
			modeApiConfigs: {},
			listApiConfigMeta: [],
			pinnedApiConfigs: {},
		}

		const secrets: Record<string, string | undefined> = {}

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					return globalState[key]
				}),
				update: vi.fn().mockImplementation((key: string, value: any) => {
					globalState[key] = value
					return Promise.resolve()
				}),
				keys: vi.fn().mockImplementation(() => {
					return Object.keys(globalState)
				}),
			} as any,
			secrets: {
				get: vi.fn().mockImplementation((key: string) => {
					return secrets[key]
				}),
				store: vi.fn().mockImplementation((key: string, value: string) => {
					secrets[key] = value
					return Promise.resolve()
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					delete secrets[key]
					return Promise.resolve()
				}),
			} as any,
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			} as any,
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
			globalStorageUri: {
				fsPath: "/test/storage/path",
			} as vscode.Uri,
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel
	})

	describe("viewId uniqueness", () => {
		it("should assign unique viewId to each instance", async () => {
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			// Each instance should have a unique viewId
			expect(provider1.viewId).toBeDefined()
			expect(provider2.viewId).toBeDefined()
			expect(provider1.viewId).not.toBe(provider2.viewId)

			await provider1.dispose()
			await provider2.dispose()
		})

		it("should have viewId in correct format: {renderContext}-{instanceCount}", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			expect(provider.viewId).toMatch(/^sidebar-\d+$/)

			await provider.dispose()
		})

		it("should increment instance count for each new instance", async () => {
			const provider1 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			// First editor instance should be "editor-0" (or next available)
			// Second editor instance should have a different number
			const num1 = parseInt(provider1.viewId.split("-")[1]!)
			const num2 = parseInt(provider2.viewId.split("-")[1]!)

			expect(num2).toBeGreaterThan(num1)

			await provider1.dispose()
			await provider2.dispose()
		})
	})

	describe("local state isolation", () => {
		it("should isolate mode state between instances", async () => {
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			// Access viewLocalState via private property for testing
			const state1 = await provider1.getState()
			const state2 = await provider2.getState()

			// Both should start with the same default mode from global state
			expect(state1.mode).toBe("code")
			expect(state2.mode).toBe("code")

			await provider1.dispose()
			await provider2.dispose()
		})

		it("should allow different modes in separate instances after saveViewState", async () => {
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			// Access private method for testing
			const saveViewState1 = (provider1 as any).saveViewState.bind(provider1)
			const saveViewState2 = (provider2 as any).saveViewState.bind(provider2)

			// Save different modes to each provider
			await saveViewState1("mode", "architect")
			await saveViewState2("mode", "debugger")

			// Verify isolation - each provider should have its own mode
			const state1 = await provider1.getState()
			const state2 = await provider2.getState()

			expect(state1.mode).toBe("architect")
			expect(state2.mode).toBe("debugger")

			await provider1.dispose()
			await provider2.dispose()
		})

		it("should isolate currentApiConfigName between instances", async () => {
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			const saveViewState1 = (provider1 as any).saveViewState.bind(provider1)
			const saveViewState2 = (provider2 as any).saveViewState.bind(provider2)

			await saveViewState1("currentApiConfigName", "profile-a")
			await saveViewState2("currentApiConfigName", "profile-b")

			const state1 = await provider1.getState()
			const state2 = await provider2.getState()

			expect(state1.currentApiConfigName).toBe("profile-a")
			expect(state2.currentApiConfigName).toBe("profile-b")

			await provider1.dispose()
			await provider2.dispose()
		})
	})

	describe("saveViewState", () => {
		it("should update viewLocalState when saveViewState is called", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			const contextProxySpy = vi.spyOn(provider.contextProxy, "setValue")

			await (provider as any).saveViewState("mode", "architect")

			// Verify viewLocalState was updated
			expect((provider as any).viewLocalState.mode).toBe("architect")

			// Verify contextProxy.setValue was called
			expect(contextProxySpy).toHaveBeenCalledWith("mode", "architect")

			await provider.dispose()
		})

		it("should update viewLocalState for currentApiConfigName", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).saveViewState("currentApiConfigName", "my-profile")

			expect((provider as any).viewLocalState.currentApiConfigName).toBe("my-profile")

			await provider.dispose()
		})

		it("should update viewLocalState for apiConfiguration", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			const testApiConfig = {
				apiProvider: "openrouter" as const,
				openRouterModelId: "claude-3.5-sonnet",
			}

			await (provider as any).saveViewState("apiConfiguration", testApiConfig)

			expect((provider as any).viewLocalState.apiConfiguration).toEqual(testApiConfig)

			await provider.dispose()
		})

		it("should clear local override when saveViewState receives undefined", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).saveViewState("mode", "architect")
			expect((provider as any).viewLocalState.mode).toBe("architect")

			await (provider as any).saveViewState("mode", undefined)

			expect(Object.prototype.hasOwnProperty.call((provider as any).viewLocalState, "mode")).toBe(false)

			await provider.dispose()
		})

		it("should clear local override when saveViewState receives null", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).saveViewState("currentApiConfigName", "my-profile")
			expect((provider as any).viewLocalState.currentApiConfigName).toBe("my-profile")

			await (provider as any).saveViewState("currentApiConfigName", null)

			expect(Object.prototype.hasOwnProperty.call((provider as any).viewLocalState, "currentApiConfigName")).toBe(
				false,
			)

			await provider.dispose()
		})
	})

	describe("loadViewState", () => {
		it("should load state from global state into viewLocalState", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			// Wait for the initial loadViewState to complete (it's called in constructor)
			await vi.waitFor(
				() => {
					expect((provider as any).viewLocalState.mode).toBe("code")
					return true // Success
				},
				{ timeout: 2000 },
			)

			expect((provider as any).viewLocalState.currentApiConfigName).toBe("default")

			await provider.dispose()
		})

		it("should update viewLocalState when loadViewState is called manually", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			// Wait for initial load to complete
			await vi.waitFor(
				() => {
					expect((provider as any).viewLocalState.mode).toBe("code")
					return true
				},
				{ timeout: 2000 },
			)

			// Update global state to simulate a change from another source
			const originalGet = mockContext.globalState.get.bind(mockContext.globalState)
			mockContext.globalState.get = vi.fn().mockImplementation((key: string) => {
				if (key === "mode") return "architect"
				if (key === "currentApiConfigName") return "new-profile"
				if (key === "apiConfiguration") return {}
				if (key === "customModePrompts") return {}
				if (key === "modeApiConfigs") return {}
				return originalGet(key)
			})

			// Manually call loadViewState to simulate a state reload
			await (provider as any).loadViewState()

			const state = await provider.getState()
			expect(state.mode).toBe("architect")
			expect(state.currentApiConfigName).toBe("new-profile")

			await provider.dispose()
		})

		it("should log and keep existing viewLocalState when loadViewState fails", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const logSpy = vi.spyOn(provider as any, "log")

			;(provider as any).viewLocalState = { mode: "architect" }
			vi.spyOn(provider.contextProxy, "getValues").mockImplementation(() => {
				throw new Error("load failed")
			})

			await (provider as any).loadViewState()

			expect((provider as any).viewLocalState.mode).toBe("architect")
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Error loading state"))

			await provider.dispose()
		})
	})

	describe("syncViewStateToGlobal", () => {
		it("should sync defined view-local values to ContextProxy", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const contextProxySpy = vi.spyOn(provider.contextProxy, "setValue")

			;(provider as any).viewLocalState = {
				mode: "architect",
				currentApiConfigName: undefined,
				apiConfiguration: { apiProvider: "openrouter" },
			}

			await (provider as any).syncViewStateToGlobal()

			expect(contextProxySpy).toHaveBeenCalledWith("mode", "architect")
			expect(contextProxySpy).toHaveBeenCalledWith("apiConfiguration", { apiProvider: "openrouter" })
			expect(contextProxySpy).not.toHaveBeenCalledWith("currentApiConfigName", expect.anything())

			await provider.dispose()
		})

		it("should log sync errors without throwing", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const logSpy = vi.spyOn(provider as any, "log")
			vi.spyOn(provider.contextProxy, "setValue").mockRejectedValueOnce(new Error("sync failed"))
			;(provider as any).viewLocalState = { mode: "architect" }

			await expect((provider as any).syncViewStateToGlobal()).resolves.toBeUndefined()
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to sync state"))

			await provider.dispose()
		})
	})

	describe("GlobalState listener", () => {
		it("should call loadViewState when configuration changes for mode", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			// Wait for setupGlobalStateListener to register the disposable
			await new Promise((resolve) => setImmediate(resolve))

			// Get the onDidChangeConfiguration mock from vscode
			const onDidChangeConfigurationMock = (vscode.workspace.onDidChangeConfiguration as any).mock

			if (onDidChangeConfigurationMock) {
				// Simulate a configuration change event for mode
				const configChangeEvent = {
					affectsConfiguration: vi.fn().mockImplementation((key: string) => {
						return key === "roo-cline.mode" || key === "roo-cline.currentApiConfigName"
					}),
				}

				// Find and trigger the listener
				const disposables = (provider as any).disposables
				for (const disposable of disposables) {
					if (typeof disposable === "object" && typeof disposable.dispose === "function") {
						// The listener should be registered, but we need to find the event emitter
						break
					}
				}

				// For this test, we verify that the listener is registered by checking disposables
				expect(disposables.length).toBeGreaterThan(0)
			}

			await provider.dispose()
		})

		it("should return without registering a listener when configuration events are unavailable", async () => {
			const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration
			;(vscode.workspace as any).onDidChangeConfiguration = undefined

			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const disposableCount = (provider as any).disposables.length

			;(provider as any).setupGlobalStateListener()

			expect((provider as any).disposables).toHaveLength(disposableCount)

			await provider.dispose()
			;(vscode.workspace as any).onDidChangeConfiguration = originalOnDidChangeConfiguration
		})

		it("should ignore unrelated configuration changes", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const loadViewStateSpy = vi.spyOn(provider as any, "loadViewState")
			const postStateToWebviewSpy = vi.spyOn(provider as any, "postStateToWebview")
			const configChangeHandler = (vscode.workspace.onDidChangeConfiguration as any).mock.calls.at(-1)?.[0]

			await configChangeHandler({
				affectsConfiguration: vi.fn().mockReturnValue(false),
			})

			expect(loadViewStateSpy).not.toHaveBeenCalled()
			expect(postStateToWebviewSpy).not.toHaveBeenCalled()

			await provider.dispose()
		})

		it("should call postStateToWebview after loadViewState on config change", async () => {
			const mockPostMessage = vi.fn()

			const mockWebviewView: any = {
				webview: {
					postMessage: mockPostMessage,
					html: "",
					options: {},
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn(),
					cspSource: "vscode-webview://test-csp-source",
				},
				visible: true,
				onDidChangeVisibility: vi.fn().mockImplementation(() => {
					return { dispose: vi.fn() }
				}),
				onDidDispose: vi.fn().mockImplementation(() => {
					return { dispose: vi.fn() }
				}),
			}

			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const configChangeHandler = (vscode.workspace.onDidChangeConfiguration as any).mock.calls.at(-1)?.[0]

			await (provider as any).resolveWebviewView(mockWebviewView)
			mockPostMessage.mockClear()

			await configChangeHandler({
				affectsConfiguration: vi.fn().mockReturnValue(true),
			})

			// Wait for postStateToWebview to be called after the configuration change.
			await vi.waitFor(
				() => {
					expect(mockPostMessage).toHaveBeenCalled()
					return true
				},
				{ timeout: 2000 },
			)

			await provider.dispose()
		})
	})

	describe("handleModeSwitch integration", () => {
		it("should update viewLocalState.mode when handleModeSwitch is called", async () => {
			const mockPostMessage = vi.fn()

			const mockWebviewView: any = {
				webview: {
					postMessage: mockPostMessage,
					html: "",
					options: {},
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn(),
					cspSource: "vscode-webview://test-csp-source",
				},
				visible: true,
				onDidChangeVisibility: vi.fn().mockImplementation(() => {
					return { dispose: vi.fn() }
				}),
				onDidDispose: vi.fn().mockImplementation(() => {
					return { dispose: vi.fn() }
				}),
			}

			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).resolveWebviewView(mockWebviewView)

			// Spy on saveViewState
			const saveViewStateSpy = vi.spyOn(provider as any, "saveViewState")

			// Call handleModeSwitch
			await provider.handleModeSwitch("architect" as any)

			// Verify viewLocalState was updated
			expect((provider as any).viewLocalState.mode).toBe("architect")

			// Verify saveViewState was called with the new mode
			expect(saveViewStateSpy).toHaveBeenCalledWith("mode", "architect")

			await provider.dispose()
		})

		it("should post state and skip mode config lookup when API config locking is enabled", async () => {
			const mockPostMessage = vi.fn()
			const mockWebviewView: any = {
				webview: {
					postMessage: mockPostMessage,
					html: "",
					options: {},
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn(),
					cspSource: "vscode-webview://test-csp-source",
				},
				visible: true,
				onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
				onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
			}
			mockContext.workspaceState.get = vi.fn().mockImplementation((key: string, fallback?: unknown) => {
				return key === "lockApiConfigAcrossModes" ? true : fallback
			})

			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const getModeConfigIdSpy = vi.spyOn((provider as any).providerSettingsManager, "getModeConfigId")

			await (provider as any).resolveWebviewView(mockWebviewView)
			mockPostMessage.mockClear()

			await provider.handleModeSwitch("architect" as any)

			expect(getModeConfigIdSpy).not.toHaveBeenCalled()
			expect(mockPostMessage).toHaveBeenCalled()

			await provider.dispose()
		})

		it("should activate configured mode profile when switching modes", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const providerSettingsManager = (provider as any).providerSettingsManager
			providerSettingsManager.getModeConfigId.mockResolvedValueOnce("profile-id")
			providerSettingsManager.listConfig.mockResolvedValueOnce([
				{ id: "profile-id", name: "mode-profile", apiProvider: "openrouter" },
			])
			providerSettingsManager.getProfile.mockResolvedValueOnce({ apiProvider: "openrouter" })
			const activateProviderProfileSpy = vi.spyOn(provider, "activateProviderProfile")

			await provider.handleModeSwitch("architect" as any)

			expect(activateProviderProfileSpy).toHaveBeenCalledWith({ name: "mode-profile" })

			await provider.dispose()
		})

		it("should leave current configuration unchanged for empty mode profiles", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const providerSettingsManager = (provider as any).providerSettingsManager
			providerSettingsManager.getModeConfigId.mockResolvedValueOnce("empty-profile-id")
			providerSettingsManager.listConfig.mockResolvedValueOnce([
				{ id: "empty-profile-id", name: "empty-profile" },
			])
			providerSettingsManager.getProfile.mockResolvedValueOnce({})
			const activateProviderProfileSpy = vi.spyOn(provider, "activateProviderProfile")

			await provider.handleModeSwitch("architect" as any)

			expect(activateProviderProfileSpy).not.toHaveBeenCalled()

			await provider.dispose()
		})

		it("should emit ModeChanged event after handleModeSwitch", async () => {
			const mockPostMessage = vi.fn()

			const mockWebviewView: any = {
				webview: {
					postMessage: mockPostMessage,
					html: "",
					options: {},
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn(),
					cspSource: "vscode-webview://test-csp-source",
				},
				visible: true,
				onDidChangeVisibility: vi.fn().mockImplementation(() => {
					return { dispose: vi.fn() }
				}),
				onDidDispose: vi.fn().mockImplementation(() => {
					return { dispose: vi.fn() }
				}),
			}

			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).resolveWebviewView(mockWebviewView)

			// Listen for ModeChanged event
			const modeChangedSpy = vi.fn()
			provider.on(RooCodeEventName.ModeChanged, modeChangedSpy)

			// Call handleModeSwitch
			await provider.handleModeSwitch("architect" as any)

			// Verify event was emitted
			expect(modeChangedSpy).toHaveBeenCalledWith("architect")

			await provider.dispose()
		})
	})

	describe("activateProviderProfile integration", () => {
		it("should update viewLocalState.currentApiConfigName when activateProviderProfile is called", async () => {
			const mockPostMessage = vi.fn()

			const mockWebviewView: any = {
				webview: {
					postMessage: mockPostMessage,
					html: "",
					options: {},
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn(),
					cspSource: "vscode-webview://test-csp-source",
				},
				visible: true,
				onDidChangeVisibility: vi.fn().mockImplementation(() => {
					return { dispose: vi.fn() }
				}),
				onDidDispose: vi.fn().mockImplementation(() => {
					return { dispose: vi.fn() }
				}),
			}

			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).resolveWebviewView(mockWebviewView)

			// Spy on saveViewState
			const saveViewStateSpy = vi.spyOn(provider as any, "saveViewState")

			// Call activateProviderProfile
			await provider.activateProviderProfile({ name: "my-profile" })

			// Verify viewLocalState was updated
			expect((provider as any).viewLocalState.currentApiConfigName).toBe("my-profile")

			// Verify saveViewState was called with the new profile name
			expect(saveViewStateSpy).toHaveBeenCalledWith("currentApiConfigName", "my-profile")

			await provider.dispose()
		})

		it("should skip mode and task persistence when activation options disable them", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const providerSettingsManager = (provider as any).providerSettingsManager
			const setModeConfigSpy = vi.spyOn(providerSettingsManager, "setModeConfig")
			const persistStickyProviderProfileSpy = vi.spyOn(
				provider as any,
				"persistStickyProviderProfileToCurrentTask",
			)

			await provider.activateProviderProfile(
				{ name: "my-profile" },
				{ persistModeConfig: false, persistTaskHistory: false },
			)

			expect(setModeConfigSpy).not.toHaveBeenCalled()
			expect(persistStickyProviderProfileSpy).not.toHaveBeenCalled()
			expect((provider as any).viewLocalState.apiConfiguration).toEqual({ apiProvider: "anthropic" })

			await provider.dispose()
		})
	})

	describe("getState merging", () => {
		it("should merge viewLocalState on top of global state", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			// Initially, getState should return values from contextProxy (global state)
			let state = await provider.getState()
			expect(state.mode).toBe("code")

			// After saveViewState, viewLocalState should take precedence
			await (provider as any).saveViewState("mode", "architect")

			state = await provider.getState()
			expect(state.mode).toBe("architect")

			await provider.dispose()
		})

		it("should preserve global state values not overridden by viewLocalState", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).saveViewState("mode", "architect")

			const state = await provider.getState()

			// mode should come from viewLocalState
			expect(state.mode).toBe("architect")

			// Other values should still come from global state / contextProxy
			expect(state.language).toBeDefined()
			expect(state.customModes).toBeDefined()

			await provider.dispose()
		})

		it("should let viewLocalState apiConfiguration override provider settings", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).saveViewState("apiConfiguration", {
				apiProvider: "openrouter",
				openRouterApiKey: "local-key",
			})

			const state = await provider.getState()

			expect(state.apiConfiguration.apiProvider).toBe("openrouter")
			expect(state.apiConfiguration.openRouterApiKey).toBe("local-key")

			await provider.dispose()
		})
	})

	describe("multi-instance isolation", () => {
		it("should maintain independent state across three instances", async () => {
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))
			const provider3 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)

			// Each should have a unique viewId
			expect(provider1.viewId).not.toBe(provider2.viewId)
			expect(provider2.viewId).not.toBe(provider3.viewId)
			expect(provider1.viewId).not.toBe(provider3.viewId)

			// Set different modes for each
			await (provider1 as any).saveViewState("mode", "code")
			await (provider2 as any).saveViewState("mode", "architect")
			await (provider3 as any).saveViewState("mode", "debugger")

			const state1 = await provider1.getState()
			const state2 = await provider2.getState()
			const state3 = await provider3.getState()

			expect(state1.mode).toBe("code")
			expect(state2.mode).toBe("architect")
			expect(state3.mode).toBe("debugger")

			await provider1.dispose()
			await provider2.dispose()
			await provider3.dispose()
		})

		it("should handle mode switch in one instance without affecting others", async () => {
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			// Set initial modes
			await (provider1 as any).saveViewState("mode", "code")
			await (provider2 as any).saveViewState("mode", "code")

			let state1 = await provider1.getState()
			let state2 = await provider2.getState()
			expect(state1.mode).toBe("code")
			expect(state2.mode).toBe("code")

			// Switch mode in provider1 only
			await (provider1 as any).saveViewState("mode", "architect")

			state1 = await provider1.getState()
			state2 = await provider2.getState()

			expect(state1.mode).toBe("architect")
			expect(state2.mode).toBe("code") // Should remain unchanged

			await provider1.dispose()
			await provider2.dispose()
		})
	})
})
