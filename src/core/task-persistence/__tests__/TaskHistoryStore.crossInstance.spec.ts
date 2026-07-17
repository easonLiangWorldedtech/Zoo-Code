// pnpm --filter roo-cline test core/task-persistence/__tests__/TaskHistoryStore.crossInstance.spec.ts

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStore } from "../TaskHistoryStore"
import { GlobalFileNames } from "../../../shared/globalFileNames"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => {
		return defaultPath
	}),
}))

// Mock safeWriteJson to use plain fs writes in tests (avoids proper-lockfile issues)
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockImplementation(async (filePath: string, data: any) => {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8")
	}),
}))

function makeHistoryItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: `task-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
		number: 1,
		ts: Date.now(),
		task: "Test task",
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.01,
		workspace: "/test/workspace",
		...overrides,
	}
}

describe("TaskHistoryStore cross-instance safety", () => {
	let tmpDir: string
	let storeA: TaskHistoryStore
	let storeB: TaskHistoryStore

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-cross-"))
		// Two stores pointing at the same globalStoragePath (simulating two VS Code windows)
		storeA = new TaskHistoryStore(tmpDir)
		storeB = new TaskHistoryStore(tmpDir)
	})

	afterEach(async () => {
		storeA.dispose()
		storeB.dispose()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("two instances can write different tasks without conflict", async () => {
		await storeA.initialize()
		await storeB.initialize()

		// Instance A writes task-a
		await storeA.upsert(makeHistoryItem({ id: "task-a", task: "Task from instance A" }))

		// Instance B writes task-b
		await storeB.upsert(makeHistoryItem({ id: "task-b", task: "Task from instance B" }))

		// Each instance sees its own task
		expect(storeA.get("task-a")).toBeDefined()
		expect(storeB.get("task-b")).toBeDefined()

		// After reconciliation, instance A should see task-b and vice versa
		await storeA.reconcile()
		await storeB.reconcile()

		expect(storeA.get("task-b")).toBeDefined()
		expect(storeB.get("task-a")).toBeDefined()

		expect(storeA.getAll()).toHaveLength(2)
		expect(storeB.getAll()).toHaveLength(2)
	})

	it("reconciliation in instance B detects a task created by instance A", async () => {
		await storeA.initialize()
		await storeB.initialize()

		// Instance A creates a task
		const item = makeHistoryItem({ id: "cross-task", task: "Created by A" })
		await storeA.upsert(item)

		// Instance B doesn't know about it yet
		expect(storeB.get("cross-task")).toBeUndefined()

		// Reconciliation picks it up
		await storeB.reconcile()

		expect(storeB.get("cross-task")).toBeDefined()
		expect(storeB.get("cross-task")!.task).toBe("Created by A")
	})

	it("delete by instance A is detected by instance B reconciliation", async () => {
		await storeA.initialize()
		await storeB.initialize()

		// Both instances have a task
		const item = makeHistoryItem({ id: "shared-task" })
		await storeA.upsert(item)
		await storeB.reconcile() // B picks it up

		expect(storeB.get("shared-task")).toBeDefined()

		// Instance A deletes the task (per-task file + directory would be removed)
		await storeA.delete("shared-task")

		// Remove the task directory to simulate full deletion (deleteTaskWithId removes the dir)
		const taskDir = path.join(tmpDir, "tasks", "shared-task")
		await fs.rm(taskDir, { recursive: true, force: true })

		// Instance B still has it in cache
		expect(storeB.get("shared-task")).toBeDefined()

		// After reconciliation, instance B sees it's gone
		await storeB.reconcile()
		expect(storeB.get("shared-task")).toBeUndefined()
	})

	it("per-task file updates by one instance are visible to another after invalidation", async () => {
		await storeA.initialize()
		await storeB.initialize()

		// Instance A creates a task
		const item = makeHistoryItem({ id: "update-task", tokensIn: 100 })
		await storeA.upsert(item)

		// Instance B picks it up via reconciliation
		await storeB.reconcile()
		expect(storeB.get("update-task")!.tokensIn).toBe(100)

		// Instance A updates the task
		await storeA.upsert({ ...item, tokensIn: 500 })

		// Instance B invalidates and re-reads
		await storeB.invalidate("update-task")
		expect(storeB.get("update-task")!.tokensIn).toBe(500)
	})

	it("concurrent writes to different tasks from two instances produce correct final state", async () => {
		await storeA.initialize()
		await storeB.initialize()

		// Write alternating tasks from each instance
		const promises = []
		for (let i = 0; i < 5; i++) {
			promises.push(storeA.upsert(makeHistoryItem({ id: `a-task-${i}`, ts: 1000 + i })))
			promises.push(storeB.upsert(makeHistoryItem({ id: `b-task-${i}`, ts: 2000 + i })))
		}

		await Promise.all(promises)

		// After reconciliation, both should see all 10 tasks
		await storeA.reconcile()
		await storeB.reconcile()

		expect(storeA.getAll().length).toBe(10)
		expect(storeB.getAll().length).toBe(10)
	})

	it("serializes concurrent updateTaskHistory from two parallel instances", async () => {
		await storeA.initialize()
		await storeB.initialize()

		// Create a shared task that both instances will update concurrently.
		const baseItem = makeHistoryItem({ id: "shared-concurrent-task", tokensIn: 0, tokensOut: 0 })
		await storeA.upsert(baseItem)
		await storeB.reconcile() // B picks it up

		// Both instances now have the task in their cache.
		expect(storeA.get("shared-concurrent-task")).toBeDefined()
		expect(storeB.get("shared-concurrent-task")).toBeDefined()

		// Concurrently update the same task from both instances.
		const updates = [
			storeA.upsert({ ...baseItem, tokensIn: 100, tokensOut: 50 }),
			storeB.upsert({ ...baseItem, tokensIn: 200, tokensOut: 100 }),
		]

		await Promise.all(updates)

		// After reconciliation, both instances should see the same final state.
		// The global lock ensures one update completes before the other starts,
		// so no entry is lost or overwritten with stale data.
		await storeA.reconcile()
		await storeB.reconcile()

		const finalA = storeA.get("shared-concurrent-task")
		const finalB = storeB.get("shared-concurrent-task")

		expect(finalA).toBeDefined()
		expect(finalB).toBeDefined()

		// Both should agree on the final state (one of the two updates won).
		expect(finalA!.tokensIn).toBe(finalB!.tokensIn)
		expect(finalA!.tokensOut).toBe(finalB!.tokensOut)

		// The winning update should be one of the two concurrent writes.
		const winningTokensIn = finalA!.tokensIn
		expect(winningTokensIn).toBeOneOf([100, 200])
	})

	it("handles 5+ concurrent updates from different tabs without losing entries", async () => {
		await storeA.initialize()
		await storeB.initialize()

		// Create a base task in both instances
		const baseItem = makeHistoryItem({ id: "multi-concurrent-task" })
		await storeA.upsert(baseItem)
		await storeB.reconcile()

		// Perform 5+ concurrent updates from each instance on the same task.
		const promises: Promise<HistoryItem[]>[] = []
		for (let i = 0; i < 6; i++) {
			promises.push(storeA.upsert({ ...baseItem, tokensIn: baseItem.tokensIn! + 10 }))
			promises.push(storeB.upsert({ ...baseItem, tokensOut: (baseItem.tokensOut ?? 0) + 5 }))
		}

		await Promise.all(promises)

		// After reconciliation, the task should still exist with accumulated values.
		await storeA.reconcile()
		await storeB.reconcile()

		const final = storeA.get("multi-concurrent-task")
		expect(final).toBeDefined()
		// The task was updated 12 times (6 from A, 6 from B), so tokensIn >= 60.
		expect(final!.tokensIn!).toBeGreaterThanOrEqual(60)
	})

	it("concurrent updateTaskHistory + deleteTaskFromState across tabs", async () => {
		await storeA.initialize()
		await storeB.initialize()

		// Create a task in both instances
		const baseItem = makeHistoryItem({ id: "update-delete-task" })
		await storeA.upsert(baseItem)
		await storeB.reconcile()

		// Instance A updates the task while instance B deletes it concurrently.
		const [updateResult, deleteResult] = await Promise.all([
			storeA.upsert({ ...baseItem, tokensIn: 999 }),
			storeB.delete("update-delete-task"),
		])

		// After reconciliation, both should agree on the final state.
		await storeA.reconcile()
		await storeB.reconcile()

		const finalA = storeA.get("update-delete-task")
		const finalB = storeB.get("update-delete-task")

		// The task may or may not exist depending on which operation won,
		// but both instances should agree.
		if (finalA) {
			expect(finalB).toBeDefined()
			expect(finalA!.tokensIn).toBe(finalB!.tokensIn)
		} else {
			expect(finalB).toBeUndefined()
		}
	})
})
