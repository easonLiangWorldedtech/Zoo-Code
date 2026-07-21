/* eslint-disable @typescript-eslint/no-explicit-any */

// pnpm --filter @roo-code/telemetry test src/__tests__/TelemetryService.test.ts

import { TelemetryEventName, type TelemetryPropertiesProvider, type TelemetrySetting } from "@roo-code/types"
import { ZodError } from "zod"

import { TelemetryService } from "../TelemetryService"

describe("TelemetryService", () => {
	let mockClient: any

	beforeEach(() => {
		mockClient = {
			setProvider: vi.fn(),
			updateTelemetryState: vi.fn(),
			capture: vi.fn(),
			captureException: vi.fn(),
			isTelemetryEnabled: vi.fn().mockReturnValue(true),
			shutdown: vi.fn(),
		}
	})

	describe("constructor", () => {
		it("should initialize with the provided clients array", () => {
			const service = new TelemetryService([mockClient])
			expect(service).toBeDefined()
		})

		it("should start with an empty clients array when none provided", () => {
			const service = new TelemetryService([])
			expect(service).toBeDefined()
		})
	})

	describe("register", () => {
		it("should add a client to the internal list", () => {
			const service = new TelemetryService([mockClient])
			const secondClient: any = { setProvider: vi.fn(), isTelemetryEnabled: vi.fn() }

			service.register(secondClient)

			expect((service as any).clients.length).toBe(2)
		})

		it("should work when starting with empty clients", () => {
			const service = new TelemetryService([])
			const client: any = { setProvider: vi.fn(), isTelemetryEnabled: vi.fn() }

			service.register(client)

			expect((service as any).clients.length).toBe(1)
		})
	})

	describe("setProvider", () => {
		it("should call setProvider on all clients when ready", () => {
			const mockProvider: TelemetryPropertiesProvider = {
				getTelemetryProperties: vi.fn().mockResolvedValue({ appVersion: "1.0.0" }),
			}

			const service = new TelemetryService([mockClient])
			service.setProvider(mockProvider)

			expect(mockClient.setProvider).toHaveBeenCalledWith(mockProvider)
		})

		it("should not call setProvider when no clients registered", () => {
			const mockProvider: TelemetryPropertiesProvider = {
				getTelemetryProperties: vi.fn().mockResolvedValue({}),
			}

			const service = new TelemetryService([])
			service.setProvider(mockProvider)

			expect(mockClient.setProvider).not.toHaveBeenCalled()
		})
	})

	describe("updateTelemetryState", () => {
		it("should call updateTelemetryState on all clients when ready", () => {
			const service = new TelemetryService([mockClient])
			service.updateTelemetryState(true)

			expect(mockClient.updateTelemetryState).toHaveBeenCalledWith(true)
		})

		it("should not call updateTelemetryState when no clients registered", () => {
			const service = new TelemetryService([])
			service.updateTelemetryState(true)

			expect(mockClient.updateTelemetryState).not.toHaveBeenCalled()
		})

		it("should pass false to disable telemetry", () => {
			const service = new TelemetryService([mockClient])
			service.updateTelemetryState(false)

			expect(mockClient.updateTelemetryState).toHaveBeenCalledWith(false)
		})
	})

	describe("captureEvent", () => {
		it("should call capture on all clients with event name and properties", () => {
			const service = new TelemetryService([mockClient])
			service.captureEvent(TelemetryEventName.TASK_CREATED, { taskId: "123" })

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TASK_CREATED,
				properties: { taskId: "123" },
			})
		})

		it("should call capture with undefined properties when not provided", () => {
			const service = new TelemetryService([mockClient])
			service.captureEvent(TelemetryEventName.MODE_SWITCH)

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.MODE_SWITCH,
				properties: undefined,
			})
		})

		it("should not call capture when no clients registered", () => {
			const service = new TelemetryService([])
			service.captureEvent(TelemetryEventName.TASK_CREATED, {})

			expect(mockClient.capture).not.toHaveBeenCalled()
		})
	})

	describe("captureException", () => {
		it("should call captureException on all clients", () => {
			const service = new TelemetryService([mockClient])
			const error = new Error("test error")

			service.captureException(error, { extra: "data" })

			expect(mockClient.captureException).toHaveBeenCalledWith(error, { extra: "data" })
		})

		it("should call captureException without additional properties", () => {
			const service = new TelemetryService([mockClient])
			const error = new Error("test error")

			service.captureException(error)

			expect(mockClient.captureException).toHaveBeenCalledWith(error, undefined)
		})

		it("should not call captureException when no clients registered", () => {
			const service = new TelemetryService([])
			const error = new Error("test error")

			service.captureException(error)

			expect(mockClient.captureException).not.toHaveBeenCalled()
		})
	})

	describe("captureTaskCreated", () => {
		it("should capture TASK_CREATED event with taskId", () => {
			const service = new TelemetryService([mockClient])
			service.captureTaskCreated("task-123")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TASK_CREATED,
				properties: { taskId: "task-123" },
			})
		})
	})

	describe("captureTaskRestarted", () => {
		it("should capture TASK_RESTARTED event with taskId", () => {
			const service = new TelemetryService([mockClient])
			service.captureTaskRestarted("task-123")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TASK_RESTARTED,
				properties: { taskId: "task-123" },
			})
		})
	})

	describe("captureTaskCompleted", () => {
		it("should capture TASK_COMPLETED event with taskId", () => {
			const service = new TelemetryService([mockClient])
			service.captureTaskCompleted("task-123")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TASK_COMPLETED,
				properties: { taskId: "task-123" },
			})
		})
	})

	describe("captureConversationMessage", () => {
		it("should capture TASK_CONVERSATION_MESSAGE with source user", () => {
			const service = new TelemetryService([mockClient])
			service.captureConversationMessage("task-123", "user")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TASK_CONVERSATION_MESSAGE,
				properties: { taskId: "task-123", source: "user" },
			})
		})

		it("should capture TASK_CONVERSATION_MESSAGE with source assistant", () => {
			const service = new TelemetryService([mockClient])
			service.captureConversationMessage("task-123", "assistant")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TASK_CONVERSATION_MESSAGE,
				properties: { taskId: "task-123", source: "assistant" },
			})
		})
	})

	describe("captureLlmCompletion", () => {
		it("should capture LLM_COMPLETION event with all properties", () => {
			const service = new TelemetryService([mockClient])
			service.captureLlmCompletion("task-123", {
				inputTokens: 100,
				outputTokens: 50,
				cacheWriteTokens: 10,
				cacheReadTokens: 5,
				cost: 0.01,
			})

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.LLM_COMPLETION,
				properties: {
					taskId: "task-123",
					inputTokens: 100,
					outputTokens: 50,
					cacheWriteTokens: 10,
					cacheReadTokens: 5,
					cost: 0.01,
				},
			})
		})

		it("should capture LLM_COMPLETION without optional cost", () => {
			const service = new TelemetryService([mockClient])
			service.captureLlmCompletion("task-123", {
				inputTokens: 100,
				outputTokens: 50,
				cacheWriteTokens: 10,
				cacheReadTokens: 5,
			})

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.LLM_COMPLETION,
				properties: {
					taskId: "task-123",
					inputTokens: 100,
					outputTokens: 50,
					cacheWriteTokens: 10,
					cacheReadTokens: 5,
					cost: undefined,
				},
			})
		})
	})

	describe("captureModeSwitch", () => {
		it("should capture MODE_SWITCH event with taskId and newMode", () => {
			const service = new TelemetryService([mockClient])
			service.captureModeSwitch("task-123", "code")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.MODE_SWITCH,
				properties: { taskId: "task-123", newMode: "code" },
			})
		})
	})

	describe("captureToolUsage", () => {
		it("should capture TOOL_USED event with taskId and tool name", () => {
			const service = new TelemetryService([mockClient])
			service.captureToolUsage("task-123", "Write")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TOOL_USED,
				properties: { taskId: "task-123", tool: "Write" },
			})
		})
	})

	describe("captureCheckpointCreated", () => {
		it("should capture CHECKPOINT_CREATED event with taskId", () => {
			const service = new TelemetryService([mockClient])
			service.captureCheckpointCreated("task-123")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.CHECKPOINT_CREATED,
				properties: { taskId: "task-123" },
			})
		})
	})

	describe("captureCheckpointDiffed", () => {
		it("should capture CHECKPOINT_DIFFED event with taskId", () => {
			const service = new TelemetryService([mockClient])
			service.captureCheckpointDiffed("task-123")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.CHECKPOINT_DIFFED,
				properties: { taskId: "task-123" },
			})
		})
	})

	describe("captureCheckpointRestored", () => {
		it("should capture CHECKPOINT_RESTORED event with taskId", () => {
			const service = new TelemetryService([mockClient])
			service.captureCheckpointRestored("task-123")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.CHECKPOINT_RESTORED,
				properties: { taskId: "task-123" },
			})
		})
	})

	describe("captureContextCondensed", () => {
		it("should capture CONTEXT_CONDENSED with isAutomaticTrigger true and custom prompt", () => {
			const service = new TelemetryService([mockClient])
			service.captureContextCondensed("task-123", true, true)

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.CONTEXT_CONDENSED,
				properties: { taskId: "task-123", isAutomaticTrigger: true, usedCustomPrompt: true },
			})
		})

		it("should capture CONTEXT_CONDENSED without custom prompt when undefined", () => {
			const service = new TelemetryService([mockClient])
			service.captureContextCondensed("task-123", false)

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.CONTEXT_CONDENSED,
				properties: { taskId: "task-123", isAutomaticTrigger: false },
			})
		})

		it("should capture CONTEXT_CONDENSED with usedCustomPrompt false", () => {
			const service = new TelemetryService([mockClient])
			service.captureContextCondensed("task-123", true, false)

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.CONTEXT_CONDENSED,
				properties: { taskId: "task-123", isAutomaticTrigger: true, usedCustomPrompt: false },
			})
		})
	})

	describe("captureSlidingWindowTruncation", () => {
		it("should capture SLIDING_WINDOW_TRUNCATION event with taskId", () => {
			const service = new TelemetryService([mockClient])
			service.captureSlidingWindowTruncation("task-123")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.SLIDING_WINDOW_TRUNCATION,
				properties: { taskId: "task-123" },
			})
		})
	})

	describe("captureCodeActionUsed", () => {
		it("should capture CODE_ACTION_USED event with actionType", () => {
			const service = new TelemetryService([mockClient])
			service.captureCodeActionUsed("insert")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.CODE_ACTION_USED,
				properties: { actionType: "insert" },
			})
		})
	})

	describe("capturePromptEnhanced", () => {
		it("should capture PROMPT_ENHANCED event with taskId when provided", () => {
			const service = new TelemetryService([mockClient])
			service.capturePromptEnhanced("task-123")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.PROMPT_ENHANCED,
				properties: { taskId: "task-123" },
			})
		})

		it("should capture PROMPT_ENHANCED without taskId when not provided", () => {
			const service = new TelemetryService([mockClient])
			service.capturePromptEnhanced()

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.PROMPT_ENHANCED,
				properties: {},
			})
		})
	})

	describe("captureSchemaValidationError", () => {
		it("should capture SCHEMA_VALIDATION_ERROR with schema name and error format", () => {
			const service = new TelemetryService([mockClient])
			const zodError = new ZodError([])

			service.captureSchemaValidationError({ schemaName: "test-schema", error: zodError })

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.SCHEMA_VALIDATION_ERROR,
				properties: { schemaName: "test-schema", error: zodError.format() },
			})
		})
	})

	describe("captureDiffApplicationError", () => {
		it("should capture DIFF_APPLICATION_ERROR with taskId and consecutiveMistakeCount", () => {
			const service = new TelemetryService([mockClient])
			service.captureDiffApplicationError("task-123", 3)

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.DIFF_APPLICATION_ERROR,
				properties: { taskId: "task-123", consecutiveMistakeCount: 3 },
			})
		})
	})

	describe("captureShellIntegrationError", () => {
		it("should capture SHELL_INTEGRATION_ERROR with taskId", () => {
			const service = new TelemetryService([mockClient])
			service.captureShellIntegrationError("task-123")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.SHELL_INTEGRATION_ERROR,
				properties: { taskId: "task-123" },
			})
		})
	})

	describe("captureConsecutiveMistakeError", () => {
		it("should capture CONSECUTIVE_MISTAKE_ERROR with taskId", () => {
			const service = new TelemetryService([mockClient])
			service.captureConsecutiveMistakeError("task-123")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.CONSECUTIVE_MISTAKE_ERROR,
				properties: { taskId: "task-123" },
			})
		})
	})

	describe("captureTabShown", () => {
		it("should capture TAB_SHOWN event with tab name", () => {
			const service = new TelemetryService([mockClient])
			service.captureTabShown("explorer")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TAB_SHOWN,
				properties: { tab: "explorer" },
			})
		})
	})

	describe("captureModeSettingChanged", () => {
		it("should capture MODE_SETTINGS_CHANGED event with setting name", () => {
			const service = new TelemetryService([mockClient])
			service.captureModeSettingChanged("maxConcurrentRequests")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.MODE_SETTINGS_CHANGED,
				properties: { settingName: "maxConcurrentRequests" },
			})
		})
	})

	describe("captureCustomModeCreated", () => {
		it("should capture CUSTOM_MODE_CREATED event with modeSlug and modeName", () => {
			const service = new TelemetryService([mockClient])
			service.captureCustomModeCreated("my-mode", "My Custom Mode")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.CUSTOM_MODE_CREATED,
				properties: { modeSlug: "my-mode", modeName: "My Custom Mode" },
			})
		})
	})

	describe("captureMarketplaceItemInstalled", () => {
		it("should capture MARKETPLACE_ITEM_INSTALLED with all parameters", () => {
			const service = new TelemetryService([mockClient])
			service.captureMarketplaceItemInstalled("item-123", "mode", "My Mode", "project", { hasParameters: true })

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.MARKETPLACE_ITEM_INSTALLED,
				properties: {
					itemId: "item-123",
					itemType: "mode",
					itemName: "My Mode",
					target: "project",
					hasParameters: true,
				},
			})
		})

		it("should capture MARKETPLACE_ITEM_INSTALLED without additional properties", () => {
			const service = new TelemetryService([mockClient])
			service.captureMarketplaceItemInstalled("item-123", "mcp", "My MCP", "global")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.MARKETPLACE_ITEM_INSTALLED,
				properties: {
					itemId: "item-123",
					itemType: "mcp",
					itemName: "My MCP",
					target: "global",
				},
			})
		})

		it("should capture MARKETPLACE_ITEM_INSTALLED with null properties", () => {
			const service = new TelemetryService([mockClient])
			service.captureMarketplaceItemInstalled("item-123", "mode", "My Mode", "project", null as any)

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.MARKETPLACE_ITEM_INSTALLED,
				properties: {
					itemId: "item-123",
					itemType: "mode",
					itemName: "My Mode",
					target: "project",
				},
			})
		})
	})

	describe("captureMarketplaceItemRemoved", () => {
		it("should capture MARKETPLACE_ITEM_REMOVED with all parameters", () => {
			const service = new TelemetryService([mockClient])
			service.captureMarketplaceItemRemoved("item-123", "mode", "My Mode", "project")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.MARKETPLACE_ITEM_REMOVED,
				properties: {
					itemId: "item-123",
					itemType: "mode",
					itemName: "My Mode",
					target: "project",
				},
			})
		})
	})

	describe("captureTitleButtonClicked", () => {
		it("should capture TITLE_BUTTON_CLICKED event with button name", () => {
			const service = new TelemetryService([mockClient])
			service.captureTitleButtonClicked("copy")

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TITLE_BUTTON_CLICKED,
				properties: { button: "copy" },
			})
		})
	})

	describe("captureTelemetrySettingsChanged", () => {
		it("should capture TELEMETRY_SETTINGS_CHANGED with previous and new settings", () => {
			const service = new TelemetryService([mockClient])
			service.captureTelemetrySettingsChanged("all" as TelemetrySetting, "off" as TelemetrySetting)

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TELEMETRY_SETTINGS_CHANGED,
				properties: { previousSetting: "all", newSetting: "off" },
			})
		})
	})

	describe("isTelemetryEnabled", () => {
		it("should return true when clients exist and at least one reports enabled", () => {
			const service = new TelemetryService([mockClient])
			expect(service.isTelemetryEnabled()).toBe(true)
		})

		it("should return false when no clients registered", () => {
			const service = new TelemetryService([])
			expect(service.isTelemetryEnabled()).toBe(false)
		})

		it("should return false when all clients report disabled", () => {
			const mockClientDisabled: any = { isTelemetryEnabled: vi.fn().mockReturnValue(false) }
			const service = new TelemetryService([mockClientDisabled])
			expect(service.isTelemetryEnabled()).toBe(false)
		})

		it("should return true when at least one client reports enabled among multiple", () => {
			const mockClient1: any = { isTelemetryEnabled: vi.fn().mockReturnValue(false) }
			const mockClient2: any = { isTelemetryEnabled: vi.fn().mockReturnValue(true) }
			const service = new TelemetryService([mockClient1, mockClient2])
			expect(service.isTelemetryEnabled()).toBe(true)
		})
	})

	describe("shutdown", () => {
		it("should call shutdown on all clients when ready", async () => {
			const service = new TelemetryService([mockClient])
			await service.shutdown()

			expect(mockClient.shutdown).toHaveBeenCalled()
		})

		it("should not call shutdown when no clients registered", async () => {
			const service = new TelemetryService([])
			await service.shutdown()

			expect(mockClient.shutdown).not.toHaveBeenCalled()
		})
	})

	describe("createInstance (singleton)", () => {
		beforeEach(() => {
			// Reset singleton state
			;(TelemetryService as any)._instance = null
		})

		it("should create a new instance", () => {
			const service = TelemetryService.createInstance([mockClient])
			expect(service).toBeInstanceOf(TelemetryService)
		})

		it("should throw when creating a second instance without resetting", () => {
			TelemetryService.createInstance([mockClient])

			expect(() => TelemetryService.createInstance([mockClient])).toThrow(
				"TelemetryService instance already created",
			)
		})

		it("should create with empty clients by default", () => {
			const service = TelemetryService.createInstance()
			expect(service).toBeInstanceOf(TelemetryService)
		})
	})

	describe("instance (getter)", () => {
		beforeEach(() => {
			;(TelemetryService as any)._instance = null
		})

		it("should throw when no instance exists", () => {
			expect(() => TelemetryService.instance).toThrow("TelemetryService not initialized")
		})

		it("should return the existing instance after createInstance", () => {
			const service = TelemetryService.createInstance([mockClient])
			expect(TelemetryService.instance).toBe(service)
		})
	})

	describe("hasInstance", () => {
		beforeEach(() => {
			;(TelemetryService as any)._instance = null
		})

		it("should return false when no instance exists", () => {
			expect(TelemetryService.hasInstance()).toBe(false)
		})

		it("should return true after createInstance", () => {
			TelemetryService.createInstance([mockClient])
			expect(TelemetryService.hasInstance()).toBe(true)
		})
	})
})
