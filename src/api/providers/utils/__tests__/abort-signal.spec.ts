import { mergeAbortSignalAndTimeout, throwIfAborted } from "../abort-signal"

describe("mergeAbortSignalAndTimeout", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("returns the original signal when only abortSignal is provided", () => {
		const controller = new AbortController()

		const result = mergeAbortSignalAndTimeout(controller.signal)

		expect(result.signal).toBe(controller.signal)
	})

	it("does not create a signal for zero or negative timeout without abortSignal", () => {
		expect(mergeAbortSignalAndTimeout(undefined, 0).signal).toBeUndefined()
		expect(mergeAbortSignalAndTimeout(undefined, -1).signal).toBeUndefined()
	})

	it("creates a timeout signal only for positive timeoutMs", () => {
		const result = mergeAbortSignalAndTimeout(undefined, 1000)

		expect(result.signal).toBeInstanceOf(AbortSignal)
		expect(result.signal?.aborted).toBe(false)
	})

	it("creates a merged signal that aborts when upstream aborts", () => {
		const controller = new AbortController()
		const result = mergeAbortSignalAndTimeout(controller.signal, 1000)

		expect(result.signal).toBeInstanceOf(AbortSignal)
		expect(result.signal).not.toBe(controller.signal)
		expect(result.signal?.aborted).toBe(false)

		controller.abort()

		expect(result.signal?.aborted).toBe(true)
	})

	it("creates a merged signal that aborts on timeout", () => {
		vi.useFakeTimers()
		const controller = new AbortController()
		const result = mergeAbortSignalAndTimeout(controller.signal, 1000)

		expect(result.signal?.aborted).toBe(false)

		vi.advanceTimersByTime(1000)

		expect(result.signal?.aborted).toBe(true)
	})

	it("cleans up the upstream abort listener", () => {
		const controller = new AbortController()
		const addSpy = vi.spyOn(controller.signal, "addEventListener")
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener")

		const result = mergeAbortSignalAndTimeout(controller.signal, 1000)
		result.cleanup()

		expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true })
		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function))
	})
})

describe("throwIfAborted", () => {
	it("does nothing when signal is undefined or active", () => {
		const controller = new AbortController()

		expect(() => throwIfAborted()).not.toThrow()
		expect(() => throwIfAborted(controller.signal)).not.toThrow()
	})

	it("throws AbortError when signal is already aborted", () => {
		const controller = new AbortController()
		controller.abort()

		expect(() => throwIfAborted(controller.signal)).toThrow("This operation was aborted")
		try {
			throwIfAborted(controller.signal)
		} catch (error) {
			expect((error as Error).name).toBe("AbortError")
		}
	})
})
