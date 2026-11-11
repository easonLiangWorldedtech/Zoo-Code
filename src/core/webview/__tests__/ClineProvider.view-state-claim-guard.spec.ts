import { WebviewFocusTracker } from "../WebviewFocusTracker"
// pnpm --dir src exec vitest run core/webview/__tests__/ClineProvider.view-state-claim-guard.spec.ts

import * as vscode from "vscode"
import { makeCompositeDisposable } from "../../../test-utils/vscode"

import { TelemetryService } from "@roo-code/telemetry"

import { ContextProxy } from "../../config/ContextProxy"
import { ClineProvider } from "../ClineProvider"

// Mock setup
vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(""),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/storage", () => ({
	getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	getGlobalStoragePath: vi.fn().mockResolvedValue("/test/storage/path"),
}))

vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = delayFn
	delayFn.reject = delayFn
	delayFn.range = delayFn
	return { default: delayFn }
})

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Disposable: { from: (...subscriptions: vscode.Disposable[]) => makeCompositeDisposable(...subscriptions) },
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => {
			return {
				dispose: vi.fn(),
			}
		}),
	},
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
	},
	extensions: {
		all: [],
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
	version: "1.85.0",
}))

vi.mock("../../../utils/tts", () => ({
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(),
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => {
	return {
		default: vi.fn().mockImplementation(function () {
			return {
				initializeFilePaths: vi.fn(),
				dispose: vi.fn(),
			}
		}),
	}
})

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(() => ({
		taskId: "mock-task-id",
		instanceId: "mock-instance-id",
		abortTask: vi.fn().mockResolvedValue(undefined),
		emit: vi.fn(),
	})),
}))

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return {
				isAuthenticated: vi.fn().mockReturnValue(false),
				off: vi.fn(),
			}
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
}))

vi.mock("../../../integrations/theme/getTheme", () => ({
	getTheme: vi.fn().mockResolvedValue({ kind: "dark" }),
}))

vi.mock("../webviewMessageHandler", () => ({
	webviewMessageHandler: vi.fn().mockResolvedValue(undefined),
}))

/** An emitter-backed vscode.Event that also reports how many listeners are installed. */

describe("ClineProvider - view-state claim guard", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, unknown> = {
			mode: "code",
			currentApiConfigName: "test-config",
		}

		const secrets: Record<string, string | undefined> = {}

		// Structural double providing only the storage members ClineProvider and ContextProxy read.
		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" },
			globalState: {
				get: vi.fn().mockImplementation((key: string) => globalState[key]),
				update: vi.fn().mockImplementation((key: string, value: unknown) => {
					globalState[key] = value
					return Promise.resolve()
				}),
				keys: vi.fn().mockImplementation(() => Object.keys(globalState)),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => secrets[key]),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					secrets[key] = value
					return Promise.resolve()
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					delete secrets[key]
					return Promise.resolve()
				}),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
			globalStorageUri: {
				fsPath: "/test/storage/path",
			},
		} as unknown as vscode.ExtensionContext

		// Structural double providing only the logging members ClineProvider calls.
		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)
	})

	afterEach(async () => {
		await provider.dispose()
	})

	// A second live instance, built the same way the harness builds the first, so the claim guard has a claimant to find.
	const makeOther = () =>
		new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)

	const ID = "view-state-claim-guard-case-1"
	const EXACT = "v".repeat(64)
	const TOO_LONG = "v".repeat(65)

	test("a non-string view state id is refused with an explicit empty claim", async () => {
		const result = await provider.setViewStateId(undefined)
		expect(result).toEqual({ adopted: false, claim: "none" })
	})

	test("re-registering the id this view already holds adopts nothing and claims nothing", async () => {
		const first = await provider.setViewStateId(ID)
		expect(first.adopted).toBe(true)
		const again = await provider.setViewStateId(ID)
		expect(again).toEqual({ adopted: false, claim: "none" })
	})

	// The claim field reports what a registration delivered to the renderer and reads none for a quiet adoption, so the guard branches are separated by adopted rather than by claim.
	test("the length guard cuts off above 64 characters and not at the boundary", async () => {
		const boundary = await provider.setViewStateId(EXACT)
		const over = await provider.setViewStateId(TOO_LONG)
		expect(over).toEqual({ adopted: false, claim: "none" })
		expect(boundary.adopted).toBe(true)
	})

	test("a live second instance holding the id is found as the claimant", async () => {
		const other = makeOther()
		await other.setViewStateId(ID)
		const contested = await provider.setViewStateId(ID)
		expect(contested).toEqual({ adopted: false, claim: "none" })
		await other.dispose()
	})

	test("an unheld id takes the adoption path rather than the claimant refusal", async () => {
		const uncontested = await provider.setViewStateId("unheld-view-state-id-for-claim-guard")
		expect(uncontested.adopted).toBe(true)
	})

	test("the claimant refusal names the id and the live view that holds it", async () => {
		const other = makeOther()
		const appended: string[] = []
		mockOutputChannel.appendLine = (value?: string) => {
			appended.push(String(value))
		}
		await other.setViewStateId("shared-claimed-view-state-id")
		await provider.setViewStateId("shared-claimed-view-state-id")
		expect(appended.some((line: string) => line.includes("already claimed by live view"))).toBe(true)
		expect(appended.some((line: string) => line.includes("shared-claimed-view-state-id"))).toBe(true)
		await other.dispose()
	})
	test("a live second instance holding a different id does not block this registration", async () => {
		// Negative control for the claimant search at ClineProvider.ts line 1198. Stryker reports a
		// surviving ConditionalExpression there with replacement true, which makes any other live
		// provider count as the claimant regardless of which id it holds. The guard must refuse only
		// the id that other instance actually holds, so an unrelated live instance must not turn a
		// free id into a refusal.
		const other = makeOther()
		await other.setViewStateId("unrelated-view-state-id")
		const mine = await provider.setViewStateId("guard-different-id-case")
		expect(mine.adopted).toBe(true)
		expect(mine).not.toEqual({ adopted: false, claim: "none" })
		await other.dispose()
	})
})
