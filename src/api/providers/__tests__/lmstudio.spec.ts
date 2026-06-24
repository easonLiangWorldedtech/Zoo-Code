// Mock OpenAI client - must come before other imports
const mockCreate = vi.fn()
vi.mock("openai", () => {
	return {
		__esModule: true,
		default: vi.fn().mockImplementation(function () {
			return {
				chat: {
					completions: {
						create: mockCreate.mockImplementation(async (options) => {
							if (!options.stream) {
								return {
									id: "test-completion",
									choices: [
										{
											message: { role: "assistant", content: "Test response" },
											finish_reason: "stop",
											index: 0,
										},
									],
									usage: {
										prompt_tokens: 10,
										completion_tokens: 5,
										total_tokens: 15,
									},
								}
							}

							return {
								[Symbol.asyncIterator]: async function* () {
									yield {
										choices: [
											{
												delta: { content: "Test response" },
												index: 0,
											},
										],
										usage: null,
									}
									yield {
										choices: [
											{
												delta: {},
												index: 0,
											},
										],
										usage: {
											prompt_tokens: 10,
											completion_tokens: 5,
											total_tokens: 15,
										},
									}
								},
							}
						}),
					},
				},
			}
		}),
	}
})

import type { Anthropic } from "@anthropic-ai/sdk"

import { LmStudioHandler } from "../lm-studio"
import type { ApiHandlerOptions } from "../../../shared/api"

describe("LmStudioHandler", () => {
	let handler: LmStudioHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = {
			apiModelId: "local-model",
			lmStudioModelId: "local-model",
			lmStudioBaseUrl: "http://localhost:1234",
		}
		handler = new LmStudioHandler(mockOptions)
		mockCreate.mockClear()
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeInstanceOf(LmStudioHandler)
			expect(handler.getModel().id).toBe(mockOptions.lmStudioModelId)
		})

		it("should use default base URL if not provided", () => {
			const handlerWithoutUrl = new LmStudioHandler({
				apiModelId: "local-model",
				lmStudioModelId: "local-model",
			})
			expect(handlerWithoutUrl).toBeInstanceOf(LmStudioHandler)
		})
	})

	describe("createMessage", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: "Hello!",
			},
		]

		it("should handle streaming responses", async () => {
			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Test response")
		})

		it("should handle API errors", async () => {
			mockCreate.mockRejectedValueOnce(new Error("API Error"))

			const stream = handler.createMessage(systemPrompt, messages)

			await expect(async () => {
				for await (const _chunk of stream) {
					// Should not reach here
				}
			}).rejects.toThrow("Please check the LM Studio developer logs to debug what went wrong")
		})
	})

	describe("completePrompt", () => {
		it("should complete prompt successfully", async () => {
			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("Test response")
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: mockOptions.lmStudioModelId,
					messages: [{ role: "user", content: "Test prompt" }],
					temperature: 0,
					stream: false,
				},
				{},
			)
		})

		it("should handle API errors", async () => {
			mockCreate.mockRejectedValueOnce(new Error("API Error"))
			await expect(handler.completePrompt("Test prompt")).rejects.toThrow(
				"Please check the LM Studio developer logs to debug what went wrong",
			)
		})

		it("should handle empty response", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "" } }],
			})
			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("")
		})

		it("should pass abort signal through to client", async () => {
			const controller = new AbortController()
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})
			await handler.completePrompt("test prompt", { signal: controller.signal })
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({ signal: controller.signal }),
			)
		})

		it("should pass timeout through to client", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})
			await handler.completePrompt("test prompt", { timeoutMs: 5000 })
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({ timeout: 5000 }),
			)
		})

		it("should merge signal and timeoutMs together", async () => {
			const controller = new AbortController()
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})
			await handler.completePrompt("test prompt", { signal: controller.signal, timeoutMs: 10000 })
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({ signal: controller.signal, timeout: 10000 }),
			)
		})

		it("should work without options (backward compatible)", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})
			const result = await handler.completePrompt("test prompt")
			expect(result).toBe("response")
		})
	})

	describe("getModel", () => {
		it("should return model info", () => {
			const modelInfo = handler.getModel()
			expect(modelInfo.id).toBe(mockOptions.lmStudioModelId)
			expect(modelInfo.info).toBeDefined()
			expect(modelInfo.info.maxTokens).toBe(-1)
			expect(modelInfo.info.contextWindow).toBe(128_000)
		})
	})

	describe("speculative decoding", () => {
		it("should include draft_model in completePrompt when speculative decoding is enabled", async () => {
			const handlerWithSpeculative = new LmStudioHandler({
				apiModelId: "local-model",
				lmStudioModelId: "local-model",
				lmStudioBaseUrl: "http://localhost:1234",
				lmStudioSpeculativeDecodingEnabled: true,
				lmStudioDraftModelId: "draft-model",
			})

			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})

			await handlerWithSpeculative.completePrompt("test prompt")

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ draft_model: "draft-model" }), {})
		})

		it("should not include draft_model when speculative decoding is disabled", async () => {
			const handlerWithoutSpeculative = new LmStudioHandler({
				apiModelId: "local-model",
				lmStudioModelId: "local-model",
				lmStudioBaseUrl: "http://localhost:1234",
				lmStudioSpeculativeDecodingEnabled: false,
				lmStudioDraftModelId: "draft-model",
			})

			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})

			await handlerWithoutSpeculative.completePrompt("test prompt")

			// Verify draft_model is NOT in the params when speculative decoding is disabled
			const calledParams = mockCreate.mock.calls[0][0] as Record<string, unknown>
			expect(calledParams.model).toBe("local-model")
			expect(calledParams).not.toHaveProperty("draft_model")
		})

		it("should not include draft_model when draft model id is empty", async () => {
			const handlerEmptyDraft = new LmStudioHandler({
				apiModelId: "local-model",
				lmStudioModelId: "local-model",
				lmStudioBaseUrl: "http://localhost:1234",
				lmStudioSpeculativeDecodingEnabled: true,
				lmStudioDraftModelId: "",
			})

			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})

			await handlerEmptyDraft.completePrompt("test prompt")

			// Verify draft_model is NOT in the params when draft model id is empty
			const calledParamsEmpty = mockCreate.mock.calls[0][0] as Record<string, unknown>
			expect(calledParamsEmpty.model).toBe("local-model")
			expect(calledParamsEmpty).not.toHaveProperty("draft_model")
		})
	})
})
