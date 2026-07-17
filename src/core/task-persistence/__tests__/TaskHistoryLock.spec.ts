import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { fork, type ChildProcess } from "child_process"

import { TaskHistoryLock } from "../TaskHistoryLock"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

const waitForMessage = (child: ChildProcess, expected: string): Promise<void> =>
	new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.off("message", onMessage)
			reject(new Error(`Timed out waiting for child process message: ${expected}`))
		}, 5000)

		const onMessage = (message: unknown) => {
			if (message === expected) {
				clearTimeout(timeout)
				child.off("message", onMessage)
				resolve()
			}
		}

		child.on("message", onMessage)
	})

describe("TaskHistoryLock", () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-lock-"))
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("serializes concurrent operations", async () => {
		const lock = new TaskHistoryLock()
		let activeCount = 0
		let maxActiveCount = 0
		const order: string[] = []

		const run = (id: string) =>
			lock.withLock(tmpDir, async () => {
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
		expect(order).toHaveLength(6)
		for (const id of ["a", "b", "c"]) {
			expect(order).toContain(`start:${id}`)
			expect(order).toContain(`end:${id}`)
			expect(order.indexOf(`start:${id}`)).toBeLessThan(order.indexOf(`end:${id}`))
		}
	})

	it("continues processing after a previous operation rejects", async () => {
		const lock = new TaskHistoryLock()
		const order: string[] = []

		const failed = lock.withLock(tmpDir, async () => {
			order.push("start:fail")
			throw new Error("simulated failure")
		})

		const succeeded = lock.withLock(tmpDir, async () => {
			order.push("start:success")
			return "ok"
		})

		await expect(failed).rejects.toThrow("simulated failure")
		await expect(succeeded).resolves.toBe("ok")
		expect(order).toEqual(["start:fail", "start:success"])
	})

	it("waits for an independent process holding the same lock file", async () => {
		const lock = new TaskHistoryLock()
		const lockFilePath = await lock.getLockFilePath(tmpDir)
		const childScriptPath = path.join(tmpDir, "hold-history-lock.cjs")
		await fs.writeFile(
			childScriptPath,
			`
const lockfile = require("proper-lockfile")

let release

async function main() {
	release = await lockfile.lock(process.argv[2], {
		stale: 31000,
		update: 10000,
		realpath: false,
	})
	process.send?.("locked")
}

process.on("message", async (message) => {
	if (message === "release") {
		await release?.()
		process.send?.("released")
		process.exit(0)
	}
})

main().catch((error) => {
	process.send?.({ error: error instanceof Error ? error.message : String(error) })
	process.exit(1)
})
`,
			"utf8",
		)

		const child = fork(childScriptPath, [lockFilePath], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
		try {
			await waitForMessage(child, "locked")

			let enteredCriticalSection = false
			const blocked = lock.withLock(tmpDir, async () => {
				enteredCriticalSection = true
				return "acquired"
			})

			await new Promise((resolve) => setTimeout(resolve, 100))
			expect(enteredCriticalSection).toBe(false)

			child.send("release")
			await waitForMessage(child, "released")
			await expect(blocked).resolves.toBe("acquired")
			expect(enteredCriticalSection).toBe(true)
		} finally {
			if (!child.killed) {
				child.kill()
			}
		}
	})

	it("reset is a no-op for file-based locking", () => {
		const lock = new TaskHistoryLock()
		expect(() => lock.reset()).not.toThrow()
	})
})
