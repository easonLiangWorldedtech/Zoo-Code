import { describe, it, expect, vi, afterEach } from "vitest"
import { getClerkBaseUrl, getRooCodeApiUrl } from "../config.js"

describe("config", () => {
	afterEach(() => {
		vi.resetModules()
		delete process.env.CLERK_BASE_URL
		delete process.env.ROO_CODE_API_URL
	})

	describe("getClerkBaseUrl", () => {
		it("should return production URL when no env var is set", () => {
			expect(getClerkBaseUrl()).toBe("https://clerk.roocode.com")
		})

		it("should return custom URL from CLERK_BASE_URL env var", () => {
			process.env.CLERK_BASE_URL = "https://custom-clerk.example.com"
			expect(getClerkBaseUrl()).toBe("https://custom-clerk.example.com")
		})

		it("should fall back to production URL when CLERK_BASE_URL is empty string (falsy)", () => {
			process.env.CLERK_BASE_URL = ""
			expect(getClerkBaseUrl()).toBe("https://clerk.roocode.com")
		})
	})

	describe("getRooCodeApiUrl", () => {
		it("should return production URL when no env var is set", () => {
			expect(getRooCodeApiUrl()).toBe("https://app.roocode.com")
		})

		it("should return custom URL from ROO_CODE_API_URL env var", () => {
			process.env.ROO_CODE_API_URL = "https://custom-api.example.com"
			expect(getRooCodeApiUrl()).toBe("https://custom-api.example.com")
		})

		it("should fall back to production URL when ROO_CODE_API_URL is empty string (falsy)", () => {
			process.env.ROO_CODE_API_URL = ""
			expect(getRooCodeApiUrl()).toBe("https://app.roocode.com")
		})
	})
})
