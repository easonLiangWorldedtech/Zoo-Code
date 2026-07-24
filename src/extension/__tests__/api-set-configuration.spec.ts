import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { type RooCodeSettings } from "@roo-code/types"
import { ClineProvider } from "../../core/webview/ClineProvider"

vi.mock("vscode")
vi.mock("../../core/webview/ClineProvider")

describe("API - setConfiguration", () => {
	let api: API
	let mockOutputChannel: vscode.OutputChannel
	let mockProvider: ClineProvider
	let contextValues: RooCodeSettings
	let viewLocalState: { apiConfiguration?: RooCodeSettings }
	let mockContextProxySetValues: ReturnType<typeof vi.fn<(values: RooCodeSettings) => Promise<void>>>
	let mockProviderSetValues: ReturnType<typeof vi.fn<(values: RooCodeSettings) => Promise<void>>>
	let mockSaveConfig: ReturnType<typeof vi.fn<(name: string, values: RooCodeSettings) => Promise<string>>>
	let mockPostStateToWebview: ReturnType<typeof vi.fn<() => Promise<void>>>

	beforeEach(() => {
		mockOutputChannel = {
			appendLine: vi.fn(),
		} as unknown as vscode.OutputChannel

		contextValues = {
			currentApiConfigName: "default",
			apiProvider: "deepseek",
			deepSeekBaseUrl: "http://localhost:3000/deepseek",
			apiModelId: "deepseek-v4-pro",
		}

		viewLocalState = {
			apiConfiguration: {
				apiProvider: "openrouter",
				openRouterBaseUrl: "http://localhost:3000/openrouter",
				openRouterModelId: "openrouter/old-model",
			},
		}

		mockContextProxySetValues = vi.fn().mockImplementation(async (values: RooCodeSettings) => {
			contextValues = {
				...contextValues,
				...values,
			}
		})

		mockProviderSetValues = vi
			.fn<(values: RooCodeSettings) => Promise<void>>()
			.mockImplementation(async (values: RooCodeSettings) => {
				await mockContextProxySetValues(values)
				viewLocalState.apiConfiguration = values
			})

		mockSaveConfig = vi
			.fn<(name: string, values: RooCodeSettings) => Promise<string>>()
			.mockResolvedValue("test-id")
		mockPostStateToWebview = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

		mockProvider = {
			context: {} as vscode.ExtensionContext,
			contextProxy: {
				setValues: mockContextProxySetValues,
			},
			providerSettingsManager: {
				saveConfig: mockSaveConfig,
			},
			setValues: mockProviderSetValues,
			postStateToWebview: mockPostStateToWebview,
			getState: vi.fn().mockImplementation(async () => ({
				apiConfiguration: {
					...contextValues,
					...viewLocalState.apiConfiguration,
				},
			})),
			on: vi.fn(),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			viewLaunched: true,
		} as unknown as ClineProvider

		api = new API(mockOutputChannel, mockProvider)
	})

	it("syncs sidebar provider view-local API configuration so getState reflects the new provider", async () => {
		const newConfiguration: RooCodeSettings = {
			currentApiConfigName: "deepseek-v4-pro",
			apiProvider: "deepseek",
			deepSeekBaseUrl: "http://localhost:3000/deepseek",
			apiModelId: "deepseek-v4-pro",
		}

		await api.setConfiguration(newConfiguration)

		const state = await mockProvider.getState()

		expect(state.apiConfiguration.apiProvider).toBe("deepseek")
		expect(state.apiConfiguration.deepSeekBaseUrl).toBe("http://localhost:3000/deepseek")
		expect(mockProviderSetValues).toHaveBeenCalledWith(newConfiguration)
		expect(mockSaveConfig).toHaveBeenCalledWith("deepseek-v4-pro", newConfiguration)
		expect(mockPostStateToWebview).toHaveBeenCalled()
	})
})
