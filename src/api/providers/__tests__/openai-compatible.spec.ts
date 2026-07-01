// npx vitest run api/providers/__tests__/openai-compatible-completeprompt.spec.ts

import type { ModelInfo } from "@roo-code/types"

import { BaseOpenAiCompatibleProvider } from "../base-openai-compatible-provider"

// Create a concrete test implementation of the abstract base class
class TestOpenAiCompatibleProvider extends BaseOpenAiCompatibleProvider<"test-model"> {
	constructor(apiKey: string) {
		const testModels: Record<"test-model", ModelInfo> = {
			"test-model": {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0.5,
				outputPrice: 1.5,
			},
		}

		super({
			providerName: "TestProvider",
			baseURL: "https://test.example.com/v1",
			defaultProviderModelId: "test-model",
			providerModels: testModels,
			apiKey,
		})
	}
}

describe("BaseOpenAiCompatibleProvider completePrompt", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should return message content from successful response", async () => {
		const handler = new TestOpenAiCompatibleProvider("test-api-key")

		const mockCreate = vi.fn().mockResolvedValue({
			choices: [{ message: { content: "response" } }],
		})

		handler["client"].chat.completions.create = mockCreate

		const result = await handler.completePrompt("test prompt")

		expect(result).toBe("response")
	})

	it("should pass abortSignal through to client", async () => {
		const handler = new TestOpenAiCompatibleProvider("test-api-key")

		const mockCreate = vi.fn().mockResolvedValue({
			choices: [{ message: { content: "response" } }],
		})

		handler["client"].chat.completions.create = mockCreate

		const controller = new AbortController()
		await handler.completePrompt("test prompt", { abortSignal: controller.signal })

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: "test-model" }),
			expect.objectContaining({ signal: controller.signal }),
		)
	})

	it("should pass timeoutMs through to client as timeout", async () => {
		const handler = new TestOpenAiCompatibleProvider("test-api-key")

		const mockCreate = vi.fn().mockResolvedValue({
			choices: [{ message: { content: "response" } }],
		})

		handler["client"].chat.completions.create = mockCreate

		await handler.completePrompt("test prompt", { timeoutMs: 5000 })

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: "test-model" }),
			expect.objectContaining({ timeout: 5000 }),
		)
	})

	it("should pass both signal and timeout when both are provided", async () => {
		const handler = new TestOpenAiCompatibleProvider("test-api-key")

		const mockCreate = vi.fn().mockResolvedValue({
			choices: [{ message: { content: "response" } }],
		})

		handler["client"].chat.completions.create = mockCreate

		const controller = new AbortController()
		await handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 5000 })

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: "test-model" }),
			expect.objectContaining({ signal: controller.signal, timeout: 5000 }),
		)
	})

	it("should work without options (backward compatible)", async () => {
		const handler = new TestOpenAiCompatibleProvider("test-api-key")

		const mockCreate = vi.fn().mockResolvedValue({
			choices: [{ message: { content: "response" } }],
		})

		handler["client"].chat.completions.create = mockCreate

		const result = await handler.completePrompt("test prompt")

		expect(result).toBe("response")
		expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }), {})
	})

	it("should return empty string when no content in response", async () => {
		const handler = new TestOpenAiCompatibleProvider("test-api-key")

		const mockCreate = vi.fn().mockResolvedValue({
			choices: [{ message: { content: null } }],
		})

		handler["client"].chat.completions.create = mockCreate

		const result = await handler.completePrompt("test prompt")

		expect(result).toBe("")
	})

	it("should return empty string when choices is empty", async () => {
		const handler = new TestOpenAiCompatibleProvider("test-api-key")

		const mockCreate = vi.fn().mockResolvedValue({
			choices: [],
		})

		handler["client"].chat.completions.create = mockCreate

		const result = await handler.completePrompt("test prompt")

		expect(result).toBe("")
	})

	it("should pass timeoutMs=0 as valid value", async () => {
		const handler = new TestOpenAiCompatibleProvider("test-api-key")

		const mockCreate = vi.fn().mockResolvedValue({
			choices: [{ message: { content: "response" } }],
		})

		handler["client"].chat.completions.create = mockCreate

		await handler.completePrompt("test prompt", { timeoutMs: 0 })

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: "test-model" }),
			expect.objectContaining({ timeout: 0 }),
		)
	})

	it("should handle timeoutMs=0 without abortSignal", async () => {
		const handler = new TestOpenAiCompatibleProvider("test-api-key")

		const mockCreate = vi.fn().mockResolvedValue({
			choices: [{ message: { content: "response" } }],
		})

		handler["client"].chat.completions.create = mockCreate

		await handler.completePrompt("test prompt", { timeoutMs: 0 })

		expect(mockCreate).toHaveBeenCalled()
		const callArgs = mockCreate.mock.calls[0][1]
		expect(callArgs?.timeout).toBe(0)
		expect(callArgs?.signal).toBeUndefined()
	})

	it("should handle timeoutMs=-1 as valid value", async () => {
		const handler = new TestOpenAiCompatibleProvider("test-api-key")

		const mockCreate = vi.fn().mockResolvedValue({
			choices: [{ message: { content: "response" } }],
		})

		handler["client"].chat.completions.create = mockCreate

		await handler.completePrompt("test prompt", { timeoutMs: -1 })

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: "test-model" }),
			expect.objectContaining({ timeout: -1 }),
		)
	})

	it("should throw handled error when API call fails", async () => {
		const handler = new TestOpenAiCompatibleProvider("test-api-key")

		const mockCreate = vi.fn().mockRejectedValue(new Error("Network error"))

		handler["client"].chat.completions.create = mockCreate

		await expect(handler.completePrompt("test prompt")).rejects.toThrow("Network error")
	})
})
