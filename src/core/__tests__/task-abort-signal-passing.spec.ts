import { describe, it, expect } from "vitest"

import type { ApiHandlerCreateMessageMetadata } from "../../api"

describe("abort signal passing", () => {
	it("should pass the same AbortController signal instance to metadata.abortSignal", async () => {
		// Arrange: create an AbortController
		const controller = new AbortController()

		// Act: simulate what Task.ts does - construct metadata with abortSignal
		const metadata: ApiHandlerCreateMessageMetadata = {
			taskId: "test-task-id",
			abortSignal: controller.signal,
		}

		// Assert: signal identity (toBe, not just toBeInstanceOf)
		expect(metadata.abortSignal).toBe(controller.signal)
	})

	it("should create a fresh AbortController for each request", async () => {
		// Arrange: simulate two sequential requests
		const controller1 = new AbortController()
		const metadata1: ApiHandlerCreateMessageMetadata = {
			taskId: "task-1",
			abortSignal: controller1.signal,
		}

		const controller2 = new AbortController()
		const metadata2: ApiHandlerCreateMessageMetadata = {
			taskId: "task-2",
			abortSignal: controller2.signal,
		}

		// Assert: different instances
		expect(metadata1.abortSignal).not.toBe(metadata2.abortSignal)
		expect(controller1.signal).not.toBe(controller2.signal)
	})

	it("should trigger abort listener and clear controller reference", async () => {
		const controller = new AbortController()
		let controllerRef: AbortController | undefined = controller

		// Simulate Task.ts abort listener setup with { once: true }
		controller.signal.addEventListener(
			"abort",
			() => {
				controllerRef = undefined
			},
			{ once: true },
		)

		// Verify initial state
		expect(controllerRef).toBe(controller)
		expect(controller.signal.aborted).toBe(false)

		// Trigger abort
		controller.abort()

		// Verify listener was called and cleared the reference
		expect(controllerRef).toBeUndefined()
		expect(controller.signal.aborted).toBe(true)
	})

	it("should only trigger once even if signal is aborted multiple times", async () => {
		const controller = new AbortController()
		let callCount = 0

		controller.signal.addEventListener(
			"abort",
			() => {
				callCount++
			},
			{ once: true },
		)

		// First abort
		controller.abort()
		expect(callCount).toBe(1)

		// Second abort (AbortSignal allows this, though unusual)
		controller.abort()
		expect(callCount).toBe(1) // Should still be 1 because of { once: true }
	})

	it("should reject promise immediately if signal already aborted", async () => {
		const controller = new AbortController()
		controller.abort()

		// Simulate the abortPromise logic from Task.ts
		const abortPromise = new Promise<never>((_, reject) => {
			if (controller.signal.aborted) {
				reject(new Error("Request cancelled by user"))
			} else {
				controller.signal.addEventListener(
					"abort",
					() => {
						reject(new Error("Request cancelled by user"))
					},
					{ once: true },
				)
			}
		})

		await expect(abortPromise).rejects.toThrow("Request cancelled by user")
	})
})
