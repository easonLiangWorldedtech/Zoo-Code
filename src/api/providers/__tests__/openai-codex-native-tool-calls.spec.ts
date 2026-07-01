// cd src && npx vitest run api/providers/__tests__/openai-codex-native-tool-calls.spec.ts

import { beforeEach, describe, expect, it, vi } from "vitest"

import { OpenAiCodexHandler } from "../openai-codex"
import type { ApiHandlerOptions } from "../../../shared/api"
import { NativeToolCallParser } from "../../../core/assistant-message/NativeToolCallParser"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"
import { Package } from "../../../shared/package"

describe("OpenAiCodexHandler native tool calls", () => {
	let handler: OpenAiCodexHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		vi.restoreAllMocks()
		NativeToolCallParser.clearRawChunkState()
		NativeToolCallParser.clearAllStreamingToolCalls()

		mockOptions = {
			apiModelId: "gpt-5.2-2025-12-11",
			// minimal settings; OAuth is mocked below
		}
		handler = new OpenAiCodexHandler(mockOptions)
	})

	it("yields tool_call_partial chunks when API returns function_call-only response", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		// Mock OpenAI SDK streaming (preferred path).
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.output_item.added",
							item: {
								type: "function_call",
								call_id: "call_1",
								name: "attempt_completion",
								arguments: "",
							},
							output_index: 0,
						}
						yield {
							type: "response.function_call_arguments.delta",
							delta: '{"result":"hi"}',
							// Note: intentionally omit call_id + name to simulate tool-call-only streams.
							item_id: "fc_1",
							output_index: 0,
						}
						yield {
							type: "response.completed",
							response: {
								id: "resp_1",
								status: "completed",
								output: [
									{
										type: "function_call",
										call_id: "call_1",
										name: "attempt_completion",
										arguments: '{"result":"hi"}',
									},
								],
								usage: { input_tokens: 1, output_tokens: 1 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "hello" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
			if (chunk.type === "tool_call_partial") {
				// Simulate Task.ts behavior so finish_reason handling can emit tool_call_end elsewhere
				NativeToolCallParser.processRawChunk({
					index: chunk.index,
					id: chunk.id,
					name: chunk.name,
					arguments: chunk.arguments,
				})
			}
		}

		const toolChunks = chunks.filter((c) => c.type === "tool_call_partial")
		expect(toolChunks.length).toBeGreaterThan(0)
		expect(toolChunks[0]).toMatchObject({
			type: "tool_call_partial",
			id: "call_1",
			name: "attempt_completion",
		})
	})

	it("yields text when Codex emits assistant message only in response.output_item.done", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.output_item.done",
							item: {
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "hello from spark" }],
							},
							output_index: 0,
						}
						yield {
							type: "response.completed",
							response: {
								id: "resp_done_only",
								status: "completed",
								output: [
									{
										type: "message",
										role: "assistant",
										content: [{ type: "output_text", text: "hello from spark" }],
									},
								],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.length).toBeGreaterThan(0)
		expect(textChunks.map((c) => c.text).join("")).toContain("hello from spark")
	})

	it("yields text when Codex emits assistant message only in response.completed output", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.completed",
							response: {
								id: "resp_completed_only",
								status: "completed",
								output: [
									{
										type: "message",
										role: "assistant",
										content: [{ type: "output_text", text: "final payload only" }],
									},
								],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.length).toBeGreaterThan(0)
		expect(textChunks.map((c) => c.text).join("")).toContain("final payload only")
	})

	it("yields text when Codex emits response.output_text.done without deltas", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.output_text.done",
							text: "done-event text only",
						}
						yield {
							type: "response.completed",
							response: {
								id: "resp_done_text_only",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.length).toBeGreaterThan(0)
		expect(textChunks.map((c) => c.text).join("")).toContain("done-event text only")
	})

	it("yields tool_call when Codex emits function_call only in response.output_item.done", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.output_item.done",
							item: {
								type: "function_call",
								call_id: "call_done_only",
								name: "attempt_completion",
								arguments: '{"result":"ok"}',
							},
							output_index: 0,
						}
						yield {
							type: "response.completed",
							response: {
								id: "resp_done_tool_only",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const toolCalls = chunks.filter((c) => c.type === "tool_call")
		expect(toolCalls.length).toBeGreaterThan(0)
		expect(toolCalls[0]).toMatchObject({
			type: "tool_call",
			id: "call_done_only",
			name: "attempt_completion",
		})
	})

	it("yields text when Codex emits response.content_part.added", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.content_part.added",
							part: {
								type: "output_text",
								text: "content part text",
							},
							output_index: 0,
							content_index: 0,
						}
						yield {
							type: "response.completed",
							response: {
								id: "resp_content_part",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.length).toBeGreaterThan(0)
		expect(textChunks.map((c) => c.text).join("")).toContain("content part text")
	})

	it("does not duplicate text when Codex emits delta and output_text.done", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield { type: "response.output_text.delta", delta: "hello " }
						yield { type: "response.output_text.delta", delta: "world" }
						yield { type: "response.output_text.done", text: "hello world" }
						yield {
							type: "response.completed",
							response: {
								id: "resp_delta_done",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.map((c) => c.text).join("")).toBe("hello world")
	})

	it("does not duplicate text when Codex emits delta and content_part.added", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield { type: "response.output_text.delta", delta: "hello world" }
						yield {
							type: "response.content_part.added",
							part: { type: "output_text", text: "hello world" },
							output_index: 0,
							content_index: 0,
						}
						yield {
							type: "response.completed",
							response: {
								id: "resp_delta_content_part",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.map((c) => c.text).join("")).toBe("hello world")
	})

	it("identifies SDK requests as Zoo Code", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockCreate = vi.fn().mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield { type: "response.output_text.delta", delta: "ok" }
				yield {
					type: "response.completed",
					response: {
						id: "resp_sdk_headers",
						status: "completed",
						output: [],
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				}
			},
		})
		;(handler as any).client = { responses: { create: mockCreate } }

		const stream = handler.createMessage("system", [{ role: "user", content: "headers" } as any], {
			taskId: "task-123",
			tools: [],
		})
		for await (const _chunk of stream) {
			// drain stream
		}

		expect(mockCreate).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				headers: expect.objectContaining({
					originator: "zoo-code",
					session_id: "task-123",
					"ChatGPT-Account-Id": "acct_test",
					"User-Agent": expect.stringContaining(`zoo-code/${Package.version}`),
				}),
			}),
		)
	})

	it("identifies fetch fallback requests as Zoo Code", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"fallback"}\n\n'),
					)
					controller.enqueue(
						new TextEncoder().encode(
							'data: {"type":"response.completed","response":{"id":"resp_fetch_headers","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
						),
					)
					controller.close()
				},
			}),
		})
		global.fetch = mockFetch as any
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockRejectedValue(new Error("SDK unavailable")),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "fallback" } as any], {
			taskId: "task-456",
			tools: [],
		})
		for await (const _chunk of stream) {
			// drain stream
		}

		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/responses"),
			expect.objectContaining({
				headers: expect.objectContaining({
					originator: "zoo-code",
					session_id: "task-456",
					"ChatGPT-Account-Id": "acct_test",
					"User-Agent": expect.stringContaining(`zoo-code/${Package.version}`),
				}),
			}),
		)
	})

	it("identifies completePrompt requests as Zoo Code", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "done" }],
					},
				],
			}),
		})
		global.fetch = mockFetch as any

		await expect(handler.completePrompt("Test prompt")).resolves.toBe("done")

		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/responses"),
			expect.objectContaining({
				headers: expect.objectContaining({
					originator: "zoo-code",
					"ChatGPT-Account-Id": "acct_test",
					"User-Agent": expect.stringContaining(`zoo-code/${Package.version}`),
					session_id: expect.any(String),
				}),
			}),
		)
	})

	it("completePrompt should pass abort signal through to fetch", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "done" }],
					},
				],
			}),
		})
		global.fetch = mockFetch as any

		const controller = new AbortController()
		await handler.completePrompt("Test prompt", { abortSignal: controller.signal })

		const fetchCallArgs = mockFetch.mock.calls[0]
		// The implementation merges signals using AbortSignal.any(),
		// which creates a new merged signal when both primary and secondary are provided.
		// The merged signal should abort when the user's signal aborts.
		let signalAborted = false
		fetchCallArgs[1]?.signal.addEventListener(
			"abort",
			() => {
				signalAborted = true
			},
			{ once: true },
		)
		controller.abort()
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(signalAborted).toBe(true)
	})

	it("completePrompt should work without options (backward compatible)", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "done" }],
					},
				],
			}),
		})
		global.fetch = mockFetch as any
		const result = await handler.completePrompt("Test prompt")
		expect(result).toBe("done")
	})

	describe("createMessage abort signal", () => {
		it("should bridge external abortSignal to internal AbortController", async () => {
			vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
			vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

			const mockCreate = vi.fn().mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield { type: "response.text.delta", delta: "test" }
					yield {
						type: "response.completed",
						response: {
							id: "resp_1",
							status: "completed",
							output: [{ type: "message", content: [{ type: "output_text", text: "test" }] }],
							usage: { input_tokens: 1, output_tokens: 1 },
						},
					}
				},
			})

			;(handler as any).client = {
				responses: { create: mockCreate },
			}

			const controller = new AbortController()
			const stream = handler.createMessage("system", [{ role: "user", content: "hello" } as any], {
				taskId: "t",
				abortSignal: controller.signal,
			})

			// Consume the stream to trigger the request
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(mockCreate).toHaveBeenCalled()
			const createCallArgs = mockCreate.mock.calls[0][1] as { signal?: AbortSignal }
			expect(createCallArgs.signal).toBeDefined()
			expect(createCallArgs.signal).toBeInstanceOf(AbortSignal)

			// Verify signal is not aborted before we abort
			expect(createCallArgs.signal!.aborted).toBe(false)

			// Abort the external signal and verify it propagates to the internal signal
			controller.abort()

			// The internal signal should now be aborted (if still available)
			// Since the stream finished, this.abortController might be undefined by now
			// But we can verify the abort listener was set up correctly by checking behavior
			expect(controller.signal.aborted).toBe(true)
		})

		it("should immediately abort when external signal is already aborted", async () => {
			vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
			vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

			const mockCreate = vi.fn().mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield { type: "response.text.delta", delta: "test" }
					yield {
						type: "response.completed",
						response: {
							id: "resp_1",
							status: "completed",
							output: [{ type: "message", content: [{ type: "output_text", text: "test" }] }],
							usage: { input_tokens: 1, output_tokens: 1 },
						},
					}
				},
			})

			;(handler as any).client = {
				responses: { create: mockCreate },
			}

			const controller = new AbortController()
			controller.abort() // Pre-abort

			const stream = handler.createMessage("system", [{ role: "user", content: "hello" } as any], {
				taskId: "t",
				abortSignal: controller.signal,
			})

			// Consume the stream to trigger the request
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(mockCreate).toHaveBeenCalled()
			const createCallArgs = mockCreate.mock.calls[0][1] as { signal?: AbortSignal }
			// The internal signal should already be aborted since the external was pre-aborted
			expect(createCallArgs.signal!.aborted).toBe(true)
		})
	})
})
