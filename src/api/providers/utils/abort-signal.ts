export interface MergedAbortSignal {
	signal?: AbortSignal
	cleanup: () => void
}

/**
 * Merges a caller-provided AbortSignal with an optional request timeout.
 *
 * A positive timeout creates a request-local signal that aborts when either
 * the upstream signal or timeout fires. A zero or negative timeout means
 * "no timeout" and does not abort immediately.
 */
export function mergeAbortSignalAndTimeout(abortSignal?: AbortSignal, timeoutMs?: number): MergedAbortSignal {
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	let upstreamAbortListener: (() => void) | undefined

	if (abortSignal && timeoutMs !== undefined && timeoutMs > 0) {
		const controller = new AbortController()

		if (abortSignal.aborted) {
			controller.abort()
		} else {
			timeoutId = setTimeout(() => controller.abort(), timeoutMs)
			upstreamAbortListener = () => {
				clearTimeout(timeoutId)
				controller.abort()
			}
			abortSignal.addEventListener("abort", upstreamAbortListener, { once: true })
		}

		return {
			signal: controller.signal,
			cleanup: () => {
				clearTimeout(timeoutId)
				if (upstreamAbortListener) {
					abortSignal.removeEventListener("abort", upstreamAbortListener)
				}
			},
		}
	}

	if (abortSignal) {
		return { signal: abortSignal, cleanup: () => {} }
	}

	if (timeoutMs !== undefined && timeoutMs > 0) {
		return { signal: AbortSignal.timeout(timeoutMs), cleanup: () => {} }
	}

	return { cleanup: () => {} }
}
