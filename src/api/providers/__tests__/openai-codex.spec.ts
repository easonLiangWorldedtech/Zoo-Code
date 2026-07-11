// npx vitest run api/providers/__tests__/openai-codex.spec.ts

// Mock TelemetryService before other imports
const mockCaptureException = vi.fn()

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: (...args: unknown[]) => mockCaptureException(...args),
		},
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"
import { OpenAiCodexHandler } from "../openai-codex"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"

describe("OpenAiCodexHandler.getModel", () => {
	it.each(["gpt-5.1", "gpt-5", "gpt-5.1-codex", "gpt-5-codex", "gpt-5-codex-mini", "gpt-5.3-codex-spark"])(
		"should return specified model when a valid model id is provided: %s",
		(apiModelId) => {
			const handler = new OpenAiCodexHandler({ apiModelId })
			const model = handler.getModel()

			expect(model.id).toBe(apiModelId)
			expect(model.info).toBeDefined()
			// Default reasoning effort for GPT-5 family
			expect(model.info.reasoningEffort).toBe("medium")
		},
	)

	it("should fall back to default model when an invalid model id is provided", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "not-a-real-model" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.6-sol")
		expect(model.info).toBeDefined()
	})

	it("should use Spark-specific limits and capabilities", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.3-codex-spark" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.3-codex-spark")
		expect(model.info.contextWindow).toBe(128000)
		expect(model.info.maxTokens).toBe(8192)
		expect(model.info.supportsImages).toBe(false)
	})

	it("should use GPT-5.4 Mini capabilities when selected", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.4-mini" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.4-mini")
		expect(model.info).toBeDefined()
	})
})

describe("OpenAiCodexHandler.createMessage", () => {
	it("should skip URL-sourced images in formatFullConversation (only base64 emits input_image)", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const capturedInput: any[] = []
		;(handler as any).client = {
			responses: {
				create: vitest.fn().mockImplementation(async (body: any) => {
					capturedInput.push(...(body.input ?? []))
					return {
						async *[Symbol.asyncIterator]() {
							yield {
								type: "response.completed",
								response: {
									id: "r1",
									status: "completed",
									output: [],
									usage: { input_tokens: 1, output_tokens: 1 },
								},
							}
						},
					}
				}),
			},
		}

		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Look at this:" },
					{ type: "image", source: { type: "url", url: "https://example.com/img.png" } as any },
				],
			},
		]

		const stream = handler.createMessage("system", messages)
		for await (const _ of stream) {
			// consume
		}

		// URL image is skipped; only the text input_text block should be present
		const userMsg = capturedInput.find((item: any) => item.role === "user")
		expect(userMsg?.content).toEqual([{ type: "input_text", text: "Look at this:" }])
		expect(JSON.stringify(capturedInput)).not.toContain("input_image")
	})

	it("should emit input_image for base64 images in formatFullConversation", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const capturedInput: any[] = []
		;(handler as any).client = {
			responses: {
				create: vitest.fn().mockImplementation(async (body: any) => {
					capturedInput.push(...(body.input ?? []))
					return {
						async *[Symbol.asyncIterator]() {
							yield {
								type: "response.completed",
								response: {
									id: "r1",
									status: "completed",
									output: [],
									usage: { input_tokens: 1, output_tokens: 1 },
								},
							}
						},
					}
				}),
			},
		}

		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Look at this:" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
				],
			},
		]

		const stream = handler.createMessage("system", messages)
		for await (const _ of stream) {
			// consume
		}

		const userMsg = capturedInput.find((item: any) => item.role === "user")
		expect(userMsg?.content).toContainEqual({
			type: "input_image",
			image_url: "data:image/png;base64,abc123",
		})
	})
})

describe("OpenAiCodexHandler.completePrompt", () => {
	it("should call fetch with correct request body and return text response", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					output: [
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: "Hello world" }],
						},
					],
				}),
			text: () => Promise.resolve(""),
		})

		global.fetch = mockFetch

		const result = await handler.completePrompt("test prompt")

		expect(result).toBe("Hello world")
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/responses"),
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer test-token",
					originator: "zoo-code",
				}),
				body: expect.stringContaining('"model":"gpt-5.1-codex"'),
			}),
		)
	})

	it("should treat timeoutMs=0 as no timeout", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockFetch = vi.fn().mockImplementation(async (url: string, options: any) => {
			return {
				ok: true,
				json: () =>
					Promise.resolve({
						output: [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "response" }],
							},
						],
					}),
				text: () => Promise.resolve(""),
			}
		})

		global.fetch = mockFetch

		await handler.completePrompt("test prompt", { timeoutMs: 0 })

		expect(mockFetch).toHaveBeenCalled()
		const fetchOptions = (mockFetch as any).mock.calls[0][1]
		expect(fetchOptions.signal).toBeDefined()
		expect(fetchOptions.signal.aborted).toBe(false)
	})

	it("should merge abortSignal with local controller", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockFetch = vi.fn().mockImplementation(async (url: string, options: any) => {
			return {
				ok: true,
				json: () =>
					Promise.resolve({
						output: [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "response" }],
							},
						],
					}),
				text: () => Promise.resolve(""),
			}
		})

		global.fetch = mockFetch

		const controller = new AbortController()
		const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
		controller.abort()
		await promise

		expect(mockFetch).toHaveBeenCalled()
		const fetchOptions = (mockFetch as any).mock.calls[0][1]
		expect(fetchOptions.signal).toBeDefined()
		expect(fetchOptions.signal.aborted).toBe(true)
	})

	it("should merge abortSignal and timeoutMs together", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockFetch = vi.fn().mockImplementation(async (url: string, options: any) => {
			return {
				ok: true,
				json: () =>
					Promise.resolve({
						output: [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "response" }],
							},
						],
					}),
				text: () => Promise.resolve(""),
			}
		})

		global.fetch = mockFetch

		const controller = new AbortController()
		const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 5000 })
		controller.abort()
		await promise

		expect(mockFetch).toHaveBeenCalled()
		const fetchOptions = (mockFetch as any).mock.calls[0][1]
		expect(fetchOptions.signal).toBeDefined()
		expect(fetchOptions.signal.aborted).toBe(true)
	})

	it("should return empty string when no output text found", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					output: [{ type: "message", role: "assistant", content: [] }],
				}),
			text: () => Promise.resolve(""),
		})

		global.fetch = mockFetch

		const result = await handler.completePrompt("test prompt")

		expect(result).toBe("")
	})

	it("should handle responseData.text fallback", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ text: "fallback response" }),
			text: () => Promise.resolve(""),
		})

		global.fetch = mockFetch

		const result = await handler.completePrompt("test prompt")

		expect(result).toBe("fallback response")
	})

	it("should throw error when not authenticated", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue(null as any)
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const controller = new AbortController()
		await expect(handler.completePrompt("test prompt", { abortSignal: controller.signal })).rejects.toThrow()
	})

	it("should throw error when fetch returns non-ok response", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			text: () => Promise.resolve("Unauthorized"),
		})

		global.fetch = mockFetch

		const controller = new AbortController()
		await expect(handler.completePrompt("test prompt", { abortSignal: controller.signal })).rejects.toThrow()
	})

	it("should include reasoning config when model has reasoning effort", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1" })

		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					output: [
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: "response" }],
						},
					],
				}),
			text: () => Promise.resolve(""),
		})

		global.fetch = mockFetch

		await handler.completePrompt("test prompt")

		expect(mockFetch).toHaveBeenCalled()
		const fetchOptions = (mockFetch as any).mock.calls[0][1]
		const requestBody = JSON.parse(fetchOptions.body)
		expect(requestBody.include).toContain("reasoning.encrypted_content")
		expect(requestBody.reasoning).toBeDefined()
		expect(requestBody.reasoning.effort).toBe("medium")
	})

	it("should include ChatGPT-Account-Id header when accountId is available", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_12345")

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					output: [
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: "response" }],
						},
					],
				}),
			text: () => Promise.resolve(""),
		})

		global.fetch = mockFetch

		await handler.completePrompt("test prompt")

		expect(mockFetch).toHaveBeenCalled()
		const fetchOptions = (mockFetch as any).mock.calls[0][1]
		expect(fetchOptions.headers["ChatGPT-Account-Id"]).toBe("acct_12345")
	})

	it("should work without accountId when not available", async () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.1-codex" })

		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue(null as any)

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					output: [
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: "response" }],
						},
					],
				}),
			text: () => Promise.resolve(""),
		})

		global.fetch = mockFetch

		await handler.completePrompt("test prompt")

		expect(mockFetch).toHaveBeenCalled()
		const fetchOptions = (mockFetch as any).mock.calls[0][1]
		expect(fetchOptions.headers["ChatGPT-Account-Id"]).toBeUndefined()
	})
})
