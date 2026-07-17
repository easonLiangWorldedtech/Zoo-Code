/**
 * Cross-instance lock for task history mutations.
 *
 * When multiple `ClineProvider` instances exist (e.g., parallel tabs or windows),
 * each has its own `TaskHistoryStore` with an independent in-process write lock.
 * This singleton lock serializes all `updateTaskHistory()` calls across instances
 * to prevent lost entries due to concurrent writes.
 *
 * The lock is a simple Promise chain — each operation waits for the previous one
 * to complete before starting. This guarantees that only one mutation sequence
 * runs at a time, eliminating race conditions between parallel tabs.
 */

export class TaskHistoryLock {
	private queue: Promise<unknown> = Promise.resolve()

	/**
	 * Acquires the lock and executes `fn` sequentially.
	 * Subsequent calls will wait for this one to finish.
	 */
	async withLock<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn, fn)
		this.queue = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}

	/**
	 * Resets the lock queue to a clean state.
	 * Useful for testing or when the provider is disposed.
	 */
	reset(): void {
		this.queue = Promise.resolve()
	}
}

// Singleton instance shared across all ClineProvider instances
export const taskHistoryLock = new TaskHistoryLock()
