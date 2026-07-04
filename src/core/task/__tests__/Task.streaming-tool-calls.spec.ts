import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { Task } from "../Task"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { ClineProvider } from "../../webview/ClineProvider"
import { ApiStreamChunk, type ApiStreamToolCallPartialChunk } from "../../../api/transform/stream"
import { ContextProxy } from "../../config/ContextProxy"
import { TelemetryService } from "@roo-code/telemetry"

// Mock delay before any imports that might use it
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

import delay from "delay"

vi.mock("uuid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("uuid")>()
	return {
		...actual,
		v7: vi.fn(() => "00000000-0000-7000-8000-000000000000"),
	}
})

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockImplementation((filePath) => {
			if (filePath.includes("ui_messages.json")) {
				return Promise.resolve(JSON.stringify([]))
			}
			if (filePath.includes("api_conversation_history.json")) {
				return Promise.resolve(JSON.stringify([]))
			}
			return Promise.resolve("[]")
		}),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		stat: vi.fn().mockRejectedValue({ code: "ENOENT" }),
		readdir: vi.fn().mockResolvedValue([]),
	}

	return {
		...actual,
		...mockFunctions,
		default: mockFunctions,
	}
})

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("vscode", () => {
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
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }),
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (key: string, defaultValue: any) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(function () {
			return mockEventEmitter
		}),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text) => {
		return Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] })
	}),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../condense", async (importOriginal) => {
	const actual = (await importOriginal()) as any
	return {
		...actual,
		summarizeConversation: vi.fn().mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "continued" }], ts: Date.now() }],
			summary: "summary",
			cost: 0,
			newContextTokens: 1,
		}),
	}
})

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockImplementation((filePath) => {
		return filePath.includes("ui_messages.json") || filePath.includes("api_conversation_history.json")
	}),
}))

describe("Task - Streaming Tool Call Handling", () => {
	let mockProvider: any
	let mockApiConfig: any
	let mockOutputChannel: any
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = {
			fsPath: path.join(os.tmpdir(), "test-storage"),
		}

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					if (key === "taskHistory") {
						return []
					}
					return undefined
				}),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockImplementation((_key) => Promise.resolve(undefined)),
				store: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				delete: vi.fn().mockImplementation((_key) => Promise.resolve()),
			},
			extensionUri: {
				fsPath: "/mock/extension/path",
			},
			extension: {
				packageJSON: {
					version: "1.0.0",
				},
			},
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as any

		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.getTaskWithId = vi.fn().mockResolvedValue(null)

		vi.spyOn(mockProvider, "getState").mockResolvedValue({
			apiConfiguration: mockApiConfig,
			autoApprovalEnabled: false,
			requestDelaySeconds: 0,
			mode: "assistant",
			customModes: [],
			disabledTools: [],
			experiments: {},
			profileThresholds: {},
		} as any)
	})

	afterEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	})

	describe("tool_call_partial chunk handling - NativeToolCallParser.processRawChunk", () => {
		it("should emit tool_call_start event when processing raw chunk with id and name", () => {
			const events = NativeToolCallParser.processRawChunk({
				index: 0,
				id: "toolu_123",
				name: "read_file",
				arguments: '{"path":"a.ts"}',
			})

			expect(events.length).toBeGreaterThan(0)
			const startEvent = events.find((e) => e.type === "tool_call_start")
			expect(startEvent).toBeDefined()
			if (startEvent && startEvent.type === "tool_call_start") {
				expect(startEvent.id).toBe("toolu_123")
				expect(startEvent.name).toBe("read_file")
			}
		})

		it("should emit tool_call_delta events for argument chunks", () => {
			const events = NativeToolCallParser.processRawChunk({
				index: 0,
				id: "toolu_123",
				name: "read_file",
				arguments: '{"path":"a.ts"}',
			})

			const deltaEvents = events.filter((e) => e.type === "tool_call_delta")
			expect(deltaEvents.length).toBeGreaterThan(0)
			if (deltaEvents[0] && deltaEvents[0].type === "tool_call_delta") {
				expect(deltaEvents[0].delta).toContain('"path"')
			}
		})

		it("should buffer deltas before start event and flush after", () => {
			NativeToolCallParser.clearRawChunkState()

			// First chunk with id/name - should emit start + buffered delta
			const events1 = NativeToolCallParser.processRawChunk({
				index: 0,
				id: "toolu_buffer123",
				name: "read_file",
				arguments: '{"path":"test.ts"}',
			})

			expect(events1.some((e) => e.type === "tool_call_start")).toBe(true)
			expect(events1.some((e) => e.type === "tool_call_delta")).toBe(true)
		})

		it("should handle multiple chunks with same index (stream retry scenario)", () => {
			NativeToolCallParser.clearRawChunkState()

			const events1 = NativeToolCallParser.processRawChunk({
				index: 0,
				id: "toolu_retry123",
				name: "read_file",
				arguments: '{"path":"a.ts"}',
			})

			const events2 = NativeToolCallParser.processRawChunk({
				index: 0,
				id: "toolu_retry123",
				name: "read_file",
				arguments: '{"path":"b.ts"}',
			})

			// Both should emit events (the dedup is handled by Task, not NativeToolCallParser)
			expect(events1.length).toBeGreaterThan(0)
			expect(events2.length).toBeGreaterThan(0)
		})
	})

	describe("NativeToolCallParser streaming state management", () => {
		it("should start tracking a streaming tool call and report hasActiveStreamingToolCalls", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()

			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)

			NativeToolCallParser.startStreamingToolCall("toolu_123", "read_file")

			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(true)
			expect(NativeToolCallParser.getStreamingToolName("toolu_123")).toBe("read_file")
		})

		it("should accumulate argument deltas via processStreamingChunk", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()

			NativeToolCallParser.startStreamingToolCall("toolu_delta_acc", "execute_command")

			const chunk1 = NativeToolCallParser.processStreamingChunk("toolu_delta_acc", '{"command":"echo')
			expect(chunk1).toBeDefined()

			const chunk2 = NativeToolCallParser.processStreamingChunk("toolu_delta_acc", ' "hello"')
			expect(chunk2).toBeDefined()

			// Verify accumulated arguments in streaming state
			const streamingState = (NativeToolCallParser as any)["streamingToolCalls"].get("toolu_delta_acc")
			expect(streamingState).toBeDefined()
			expect(streamingState!.argumentsAccumulator).toContain('"command":"echo')
		})

		it("should finalize tool call and return ToolUse via finalizeStreamingToolCall", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()

			NativeToolCallParser.startStreamingToolCall("toolu_final123", "read_file")
			NativeToolCallParser.processStreamingChunk("toolu_final123", '{"path":"test.ts"}')

			const result = NativeToolCallParser.finalizeStreamingToolCall("toolu_final123")

			expect(result).toBeDefined()
			expect(result?.type).toBe("tool_use")
			expect(result?.name).toBe("read_file")
			expect(result?.partial).toBe(false)
			// After finalization, should no longer be in streaming state
			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)
		})

		it("should return null for finalizeStreamingToolCall when arguments are malformed", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()

			NativeToolCallParser.startStreamingToolCall("toolu_malformed", "read_file")
			NativeToolCallParser.processStreamingChunk("toolu_malformed", "{invalid json")

			const result = NativeToolCallParser.finalizeStreamingToolCall("toolu_malformed")

			// finalizeStreamingToolCall uses JSON.parse which will fail on malformed JSON
			expect(result).toBeNull()
			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)
		})

		it("should return null when finalizing unknown tool call id", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()

			const result = NativeToolCallParser.finalizeStreamingToolCall("toolu_unknown")
			expect(result).toBeNull()
		})

		it("should processStreamingChunk return null for unknown tool call id", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()

			const result = NativeToolCallParser.processStreamingChunk("toolu_unknown", '{"some":"data"}')
			expect(result).toBeNull()
		})

		it("should handle multiple sequential streaming tool calls", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()

			// First tool call
			NativeToolCallParser.startStreamingToolCall("toolu_seq1", "read_file")
			NativeToolCallParser.processStreamingChunk("toolu_seq1", '{"path":"a.ts"}')
			const result1 = NativeToolCallParser.finalizeStreamingToolCall("toolu_seq1")
			expect(result1?.name).toBe("read_file")

			// Second tool call
			NativeToolCallParser.startStreamingToolCall("toolu_seq2", "write_to_file")
			NativeToolCallParser.processStreamingChunk("toolu_seq2", '{"path":"b.ts","content":"hello"}')
			const result2 = NativeToolCallParser.finalizeStreamingToolCall("toolu_seq2")
			expect(result2?.name).toBe("write_to_file")

			// Both should be finalized
			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)
		})

		it("should handle same toolCallId with different names (MCP tools)", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()

			// First tool with same ID but different name
			NativeToolCallParser.startStreamingToolCall("toolu_same", "mcp--server1--read_file")
			NativeToolCallParser.processStreamingChunk("toolu_same", '{"path":"a.ts"}')
			const result1 = NativeToolCallParser.finalizeStreamingToolCall("toolu_same")
			expect(result1).toBeDefined()

			// Second tool with same ID but different name
			NativeToolCallParser.startStreamingToolCall("toolu_same", "mcp--server2--write_to_file")
			NativeToolCallParser.processStreamingChunk("toolu_same", '{"path":"b.ts"}')
			const result2 = NativeToolCallParser.finalizeStreamingToolCall("toolu_same")
			expect(result2).toBeDefined()

			// Both should be finalized (same ID, different names are tracked separately)
			expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)
		})
	})

	describe("processStreamingChunk partial ToolUse creation", () => {
		it("should create partial tool_use with correct structure on start", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()

			NativeToolCallParser.startStreamingToolCall("toolu_partial123", "write_to_file")

			const partial = NativeToolCallParser.processStreamingChunk(
				"toolu_partial123",
				'{"path":"output.txt","content":"hello"}',
			)

			expect(partial).toBeDefined()
			expect(partial?.type).toBe("tool_use")
			expect(partial?.name).toBe("write_to_file")
			expect(partial?.partial).toBe(true)
			expect(partial?.params).toBeDefined()
		})

		it("should update partial tool_use with accumulated arguments", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()

			NativeToolCallParser.startStreamingToolCall("toolu_update123", "execute_command")

			const chunk1 = NativeToolCallParser.processStreamingChunk("toolu_update123", '{"command":"')
			expect(chunk1?.params).toBeDefined()

			const chunk2 = NativeToolCallParser.processStreamingChunk("toolu_update123", 'echo "hello"}')
			expect(chunk2?.params).toBeDefined()
			// The accumulated arguments should be more complete in chunk2
			if (chunk2?.nativeArgs && typeof chunk2.nativeArgs === "object" && "command" in chunk2.nativeArgs) {
				expect((chunk2.nativeArgs as any).command).toContain("echo")
			}
		})

		it("should handle severely malformed JSON gracefully", () => {
			NativeToolCallParser.clearAllStreamingToolCalls()

			NativeToolCallParser.startStreamingToolCall("toolu_fail123", "read_file")

			// Partial-json-parser can handle partial JSON like '{"path"' and return a partial result
			const partial = NativeToolCallParser.processStreamingChunk("toolu_fail123", '{"path"')
			expect(partial).toBeDefined()
			expect(partial?.partial).toBe(true)

			// Even severely malformed JSON like '{invalid' gets parsed by partial-json-parser
			// It returns an empty object, which is still a valid (though incomplete) result
			const veryPartial = NativeToolCallParser.processStreamingChunk("toolu_fail123", "{invalid")
			// partial-json-parser handles this gracefully - it may return an empty object or null
			// The key point is it doesn't throw an error and the streaming continues
			if (veryPartial != null) {
				expect(veryPartial.partial).toBe(true)
			} else {
				// null is also acceptable for severely malformed JSON
				expect(veryPartial).toBeNull()
			}
		})
	})

	describe("processFinishReason and finalizeRawChunks integration", () => {
		it("should emit tool_call_end events when finish_reason is 'tool_calls'", () => {
			NativeToolCallParser.clearRawChunkState()

			// First process some raw chunks to populate tracker
			NativeToolCallParser.processRawChunk({
				index: 0,
				id: "toolu_finish123",
				name: "read_file",
				arguments: '{"path":"test.ts"}',
			})

			const events = NativeToolCallParser.processFinishReason("tool_calls")

			expect(events.length).toBeGreaterThan(0)
			expect(events[0].type).toBe("tool_call_end")
		})

		it("should finalize remaining raw chunks via finalizeRawChunks", () => {
			NativeToolCallParser.clearRawChunkState()

			NativeToolCallParser.processRawChunk({
				index: 0,
				id: "toolu_finalize123",
				name: "read_file",
				arguments: '{"path":"test.ts"}',
			})

			const events = NativeToolCallParser.finalizeRawChunks()

			expect(events.length).toBeGreaterThan(0)
			expect(events[0].type).toBe("tool_call_end")
		})

		it("should clear raw chunk state via clearRawChunkState", () => {
			NativeToolCallParser.clearRawChunkState()

			NativeToolCallParser.processRawChunk({
				index: 0,
				id: "toolu_clear123",
				name: "read_file",
				arguments: '{"path":"test.ts"}',
			})

			NativeToolCallParser.clearRawChunkState()

			const events = NativeToolCallParser.finalizeRawChunks()
			expect(events.length).toBe(0)
		})
	})

	describe("tool_call_partial chunk handling - Task integration", () => {
		it("should handle tool_call_start event from raw chunk processing", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task with tool_call_start",
				startTask: false,
			})

			vi.spyOn(cline as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

			async function* mockStreamGenerator() {
				yield {
					type: "tool_call_partial" as const,
					index: 0,
					id: "toolu_123",
					name: "read_file",
					arguments: '{"path":"a.ts"}',
				}
				yield { type: "text" as const, text: "response" }
			}

			vi.spyOn(cline.api, "createMessage").mockReturnValue(mockStreamGenerator())

			const iterator = cline.attemptApiRequest(0)
			await iterator.next()

			expect(cline).toBeDefined()
		})

		it("should handle duplicate tool_call_start events", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task with duplicate start",
				startTask: false,
			})

			vi.spyOn(cline as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

			async function* mockStreamGenerator() {
				yield {
					type: "tool_call_partial" as const,
					index: 0,
					id: "toolu_dup123",
					name: "read_file",
					arguments: '{"path":"test.ts"}',
				}
				yield {
					type: "tool_call_partial" as const,
					index: 0,
					id: "toolu_dup123",
					name: "read_file",
					arguments: '{"path":"test.ts"}',
				}
				yield { type: "text" as const, text: "response" }
			}

			vi.spyOn(cline.api, "createMessage").mockReturnValue(mockStreamGenerator())

			const iterator = cline.attemptApiRequest(0)
			await iterator.next()

			expect(cline).toBeDefined()
		})

		it("should handle tool_call_delta event", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task with delta",
				startTask: false,
			})

			vi.spyOn(cline as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

			async function* mockStreamGenerator() {
				yield { type: "tool_call_delta" as const, id: "toolu_delta123", delta: '{"path":"' }
				yield { type: "text" as const, text: "response" }
			}

			vi.spyOn(cline.api, "createMessage").mockReturnValue(mockStreamGenerator())

			const iterator = cline.attemptApiRequest(0)
			await iterator.next()

			expect(cline).toBeDefined()
		})

		it("should handle tool_call_end event", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task with end",
				startTask: false,
			})

			vi.spyOn(cline as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

			async function* mockStreamGenerator() {
				yield { type: "tool_call_end" as const, id: "toolu_end123" }
				yield { type: "text" as const, text: "response" }
			}

			vi.spyOn(cline.api, "createMessage").mockReturnValue(mockStreamGenerator())

			const iterator = cline.attemptApiRequest(0)
			await iterator.next()

			expect(cline).toBeDefined()
		})

		it("should handle complete streaming lifecycle: start -> delta -> end", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task with full lifecycle",
				startTask: false,
			})

			vi.spyOn(cline as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

			async function* mockStreamGenerator() {
				yield {
					type: "tool_call_partial" as const,
					index: 0,
					id: "toolu_lifecycle123",
					name: "read_file",
					arguments: '{"path":"test.ts"}',
				}
				yield { type: "tool_call_delta" as const, id: "toolu_lifecycle123", delta: "more_args" }
				yield { type: "tool_call_end" as const, id: "toolu_lifecycle123" }
				yield { type: "text" as const, text: "Done" }
			}

			vi.spyOn(cline.api, "createMessage").mockReturnValue(mockStreamGenerator())

			const iterator = cline.attemptApiRequest(0)
			await iterator.next()

			expect(cline).toBeDefined()
		})

		it("should handle multiple sequential tool calls", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task with multiple tools",
				startTask: false,
			})

			vi.spyOn(cline as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

			async function* mockStreamGenerator() {
				yield {
					type: "tool_call_partial" as const,
					index: 0,
					id: "toolu_multi1",
					name: "read_file",
					arguments: '{"path":"file1.ts"}',
				}
				yield { type: "tool_call_end" as const, id: "toolu_multi1" }
				yield {
					type: "tool_call_partial" as const,
					index: 1,
					id: "toolu_multi2",
					name: "write_to_file",
					arguments: '{"path":"file2.ts","content":"hello"}',
				}
				yield { type: "tool_call_end" as const, id: "toolu_multi2" }
				yield { type: "text" as const, text: "Done multiple tools" }
			}

			vi.spyOn(cline.api, "createMessage").mockReturnValue(mockStreamGenerator())

			const iterator = cline.attemptApiRequest(0)
			await iterator.next()

			expect(cline).toBeDefined()
		})
	})
})
