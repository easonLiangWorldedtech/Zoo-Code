import { describe, it, expect, vi } from "vitest"
import { getUserAgent } from "../utils.js"

// Mock vscode module for ExtensionContext type
vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
	},
	env: {
		openExternal: vi.fn(),
		uriScheme: "vscode",
	},
}))

describe("getUserAgent", () => {
	it("should return 'Zoo-Code unknown' when no context is provided", () => {
		const result = getUserAgent()
		expect(result).toBe("Zoo-Code unknown")
	})

	it("should include extension version from context.packageJSON.version", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const mockContext: any = {
			extension: {
				packageJSON: {
					version: "3.66.0",
				},
			},
		}

		const result = getUserAgent(mockContext)
		expect(result).toBe("Zoo-Code 3.66.0")
	})

	it("should return 'unknown' when packageJSON.version is missing", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const mockContext: any = {
			extension: {
				packageJSON: {},
			},
		}

		const result = getUserAgent(mockContext)
		expect(result).toBe("Zoo-Code unknown")
	})

	it("should return 'unknown' when extension is undefined", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const mockContext: any = {}

		const result = getUserAgent(mockContext)
		expect(result).toBe("Zoo-Code unknown")
	})

	it("should return 'unknown' when packageJSON is undefined", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const mockContext: any = {
			extension: {},
		}

		const result = getUserAgent(mockContext)
		expect(result).toBe("Zoo-Code unknown")
	})
})
