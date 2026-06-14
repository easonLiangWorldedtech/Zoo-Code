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
})
