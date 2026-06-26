// npx vitest run src/api/providers/__tests__/gemini-abort-signal.spec.ts

const mockCaptureException = vitest.fn()

vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: (...args: unknown[]) => mockCaptureException(...args),
		},
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"
import { GeminiHandler } from "../gemini"

const GEMINI_MODEL_NAME = "gemini-2.0-flash-exp"

describe("GeminiHandler abort signal", () => {
	let handler: GeminiHandler

	beforeEach(() => {
		mockCaptureException.mockClear()

		const mockGenerateContentStream = vitest.fn()
		const mockGenerateContent = vitest.fn()

		handler = new GeminiHandler({
			apiKey: "test-key",
			apiModelId: GEMINI_MODEL_NAME,
			geminiApiKey: "test-key",
		})

		handler["client"] = {
			models: {
				generateContentStream: mockGenerateContentStream,
				generateContent: mockGenerateContent,
			},
		} as any
	})

	describe("createMessage", () => {
		const mockMessages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there!" },
		]
		const systemPrompt = "You are a helpful assistant"

		it("should forward abortSignal inside config for streaming", async () => {
			const controller = new AbortController()
			;(handler["client"].models.generateContentStream as any).mockResolvedValue({
				[Symbol.asyncIterator]: async function* () {
					yield { text: "response" }
					yield { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }
				},
			})

			const stream = handler.createMessage(systemPrompt, mockMessages, {
				taskId: "test",
				abortSignal: controller.signal,
			})
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(handler["client"].models.generateContentStream).toHaveBeenCalledWith(
				expect.objectContaining({
					model: GEMINI_MODEL_NAME,
					config: expect.objectContaining({
						abortSignal: controller.signal,
					}),
				}),
			)
		})

		it("should work without abortSignal", async () => {
			;(handler["client"].models.generateContentStream as any).mockResolvedValue({
				[Symbol.asyncIterator]: async function* () {
					yield { text: "response" }
					yield { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }
				},
			})

			const stream = handler.createMessage(systemPrompt, mockMessages, { taskId: "test" })
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			// Without abortSignal, config should not have abortSignal property
			const callArgs = (handler["client"].models.generateContentStream as any).mock.calls[0][0]
			expect(callArgs.config.abortSignal).toBeUndefined()
		})
	})

	describe("completePrompt", () => {
		it("should pass abort signal through to client via httpOptions", async () => {
			const controller = new AbortController()
			;(handler["client"].models.generateContent as any).mockResolvedValue({ text: "response" })
			await handler.completePrompt("test prompt", { abortSignal: controller.signal })
			expect(handler["client"].models.generateContent).toHaveBeenCalledWith({
				model: GEMINI_MODEL_NAME,
				contents: [{ role: "user", parts: [{ text: "test prompt" }] }],
				config: {
					httpOptions: { signal: controller.signal },
					temperature: 1,
				},
			})
		})

		it("should work without options (backward compatible)", async () => {
			;(handler["client"].models.generateContent as any).mockResolvedValue({ text: "response" })
			const result = await handler.completePrompt("test prompt")
			expect(result).toBe("response")
		})
	})
})
