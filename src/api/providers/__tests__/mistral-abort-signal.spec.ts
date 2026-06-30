// npx vitest run src/api/providers/__tests__/mistral-abort-signal.spec.ts

const mockCaptureException = vi.hoisted(() => vi.fn())
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: mockCaptureException,
		},
	},
}))

// Mock Mistral client
const mockCreate = vi.fn()
const mockComplete = vi.fn()
vi.mock("@mistralai/mistralai", () => ({
	Mistral: vi.fn().mockImplementation(function () {
		return {
			chat: {
				stream: mockCreate.mockImplementation(async (_options) => {
					const stream = {
						[Symbol.asyncIterator]: async function* () {
							yield {
								data: {
									choices: [{ delta: { content: "Test response" }, index: 0 }],
								},
							}
						},
					}
					return stream
				}),
				complete: mockComplete.mockImplementation(async (_options) => ({
					choices: [{ message: { content: "Test response" } }],
				})),
			},
		}
	}),
}))

import type { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"
import { MistralHandler } from "../mistral"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { ApiHandlerCreateMessageMetadata } from "../../index"

describe("MistralHandler abort signal", () => {
	let handler: MistralHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = {
			apiModelId: "codestral-latest",
			mistralApiKey: "test-api-key",
			includeMaxTokens: true,
			modelTemperature: 0,
		}
		handler = new MistralHandler(mockOptions)
		mockCreate.mockClear()
		mockComplete.mockClear()
		mockCaptureException.mockClear()
	})

	describe("createMessage streaming", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: [{ type: "text", text: "Hello!" }] },
		]

		it("should forward abortSignal to fetchOptions for streaming", async () => {
			const controller = new AbortController()
			const metadata: ApiHandlerCreateMessageMetadata = { taskId: "test-task", abortSignal: controller.signal }

			await handler.createMessage(systemPrompt, messages, metadata).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: mockOptions.apiModelId,
					fetchOptions: { signal: controller.signal },
				}),
			)
		})

		it("should work without abortSignal", async () => {
			const metadata: ApiHandlerCreateMessageMetadata = { taskId: "test-task" }

			await handler.createMessage(systemPrompt, messages, metadata).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: mockOptions.apiModelId,
				}),
			)
			// fetchOptions should be undefined when no abortSignal
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.fetchOptions).toBeUndefined()
		})

		it("should forward abortSignal with tools", async () => {
			const controller = new AbortController()
			const mockTools: OpenAI.Chat.ChatCompletionTool[] = [
				{
					type: "function",
					function: {
						name: "test_tool",
						description: "A test tool",
						parameters: { type: "object", properties: {} },
					},
				},
			]
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "test-task",
				tools: mockTools,
				abortSignal: controller.signal,
			}

			await handler.createMessage(systemPrompt, messages, metadata).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: mockOptions.apiModelId,
					tools: expect.any(Array),
					fetchOptions: { signal: controller.signal },
				}),
			)
		})
	})

	describe("completePrompt non-streaming", () => {
		it("should pass abort signal through to client", async () => {
			const controller = new AbortController()
			mockComplete.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})
			await handler.completePrompt("test prompt", { abortSignal: controller.signal })
			expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {
				fetchOptions: { signal: controller.signal },
			})
		})

		it("should work without options (backward compatible)", async () => {
			mockComplete.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})
			const result = await handler.completePrompt("test prompt")
			expect(result).toBe("response")
			expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), undefined)
		})

		it("should pass both signal and timeoutMs", async () => {
			const controller = new AbortController()
			mockComplete.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})
			await handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 5000 })
			expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {
				fetchOptions: { signal: controller.signal },
				timeoutMs: 5000,
			})
		})
	})
})
