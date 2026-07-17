import { TaskHistoryLock } from "../TaskHistoryLock"

describe("TaskHistoryLock", () => {
	it("serializes concurrent operations", async () => {
		const lock = new TaskHistoryLock()
		let activeCount = 0
		let maxActiveCount = 0
		const order: string[] = []

		const run = (id: string) =>
			lock.withLock(async () => {
				activeCount++
				maxActiveCount = Math.max(maxActiveCount, activeCount)
				order.push(`start:${id}`)
				await new Promise((resolve) => setTimeout(resolve, 5))
				order.push(`end:${id}`)
				activeCount--
				return id
			})

		const results = await Promise.all([run("a"), run("b"), run("c")])

		expect(results).toEqual(["a", "b", "c"])
		expect(maxActiveCount).toBe(1)
		expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"])
	})

	it("continues processing after a previous operation rejects", async () => {
		const lock = new TaskHistoryLock()
		const order: string[] = []

		const failed = lock.withLock(async () => {
			order.push("start:fail")
			throw new Error("simulated failure")
		})

		const succeeded = lock.withLock(async () => {
			order.push("start:success")
			return "ok"
		})

		await expect(failed).rejects.toThrow("simulated failure")
		await expect(succeeded).resolves.toBe("ok")
		expect(order).toEqual(["start:fail", "start:success"])
	})

	it("reset clears the queue for subsequent operations", async () => {
		const lock = new TaskHistoryLock()
		let releaseFirstOperation!: () => void
		const order: string[] = []

		const blocked = lock.withLock(
			() =>
				new Promise<string>((resolve) => {
					order.push("start:blocked")
					releaseFirstOperation = () => {
						order.push("end:blocked")
						resolve("blocked")
					}
				}),
		)

		lock.reset()

		const afterReset = await lock.withLock(async () => {
			order.push("after-reset")
			return "after-reset"
		})

		expect(afterReset).toBe("after-reset")
		expect(order).toEqual(["start:blocked", "after-reset"])

		releaseFirstOperation()
		await expect(blocked).resolves.toBe("blocked")
	})
})
