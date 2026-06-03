// npx vitest run src/services/file-lock/__tests__/FileLockManager.test.ts

import { FileLockManager } from "../FileLockManager"

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("FileLockManager", () => {
    let manager: FileLockManager

    beforeEach(() => {
        manager = new FileLockManager()
    })

    afterEach(() => {
        manager.clearAllLocks()
        manager.removeAllListeners()
    })

    // ─── acquireLock ──────────────────────────────────────────────────────────

    describe("acquireLock", () => {
        it("returns true and acquires lock when file is not locked", () => {
            const result = manager.acquireLock("task-1", "/path/to/file.ts")
            expect(result).toBe(true)
        })

        it("returns false when file is already locked by another task", () => {
            manager.acquireLock("task-1", "/path/to/file.ts")
            const result = manager.acquireLock("task-2", "/path/to/file.ts")
            expect(result).toBe(false)
        })

        it("allows re-acquire by same task (idempotent)", () => {
            manager.acquireLock("task-1", "/path/to/file.ts")
            const result = manager.acquireLock("task-1", "/path/to/file.ts")
            expect(result).toBe(true)
        })

        it("emits lockAcquired event on successful acquisition", () => {
            let emittedPath: string | undefined
            let emittedTaskId: string | undefined
            manager.on("lockAcquired" as any, (path: string, taskId: string) => {
                emittedPath = path
                emittedTaskId = taskId
            })

            manager.acquireLock("task-1", "/path/to/file.ts")

            expect(emittedPath).toBe("/path/to/file.ts")
            expect(emittedTaskId).toBe("task-1")
        })

        it("updates timestamp on re-acquire by same task", () => {
            const filePath = "/path/to/file.ts"
            manager.acquireLock("task-1", filePath)

            // Wait a bit and re-acquire
            const beforeTime = Date.now()
            manager.acquireLock("task-1", filePath)
            const afterTime = Date.now()

            const conflict = manager.getLockConflict(filePath)!
            expect(conflict.acquiredAt).toBeGreaterThanOrEqual(beforeTime)
            expect(conflict.acquiredAt).toBeLessThanOrEqual(afterTime)
        })

        it("replaces expired lock from another task", () => {
            // Manually set an old lock entry to simulate expiration
            manager["locks"].set("/path/to/file.ts", { taskId: "task-1", acquiredAt: Date.now() - 400_000 })

            const result = manager.acquireLock("task-2", "/path/to/file.ts")
            expect(result).toBe(true) // Should replace expired lock
        })
    })

    // ─── releaseLock ──────────────────────────────────────────────────────────

    describe("releaseLock", () => {
        it("returns true and releases lock when task holds the lock", () => {
            manager.acquireLock("task-1", "/path/to/file.ts")
            const result = manager.releaseLock("task-1", "/path/to/file.ts")
            expect(result).toBe(true)
        })

        it("returns false when another task tries to release", () => {
            manager.acquireLock("task-1", "/path/to/file.ts")
            const result = manager.releaseLock("task-2", "/path/to/file.ts")
            expect(result).toBe(false)
        })

        it("returns false when lock is already released", () => {
            manager.acquireLock("task-1", "/path/to/file.ts")
            manager.releaseLock("task-1", "/path/to/file.ts")
            const result = manager.releaseLock("task-1", "/path/to/file.ts")
            expect(result).toBe(false)
        })

        it("emits lockReleased event on successful release", () => {
            let emittedPath: string | undefined
            let emittedTaskId: string | undefined
            manager.on("lockReleased" as any, (path: string, taskId: string) => {
                emittedPath = path
                emittedTaskId = taskId
            })

            manager.acquireLock("task-1", "/path/to/file.ts")
            manager.releaseLock("task-1", "/path/to/file.ts")

            expect(emittedPath).toBe("/path/to/file.ts")
            expect(emittedTaskId).toBe("task-1")
        })

        it("allows another task to acquire after release", () => {
            manager.acquireLock("task-1", "/path/to/file.ts")
            manager.releaseLock("task-1", "/path/to/file.ts")

            const result = manager.acquireLock("task-2", "/path/to/file.ts")
            expect(result).toBe(true)
        })
    })

    // ─── releaseAllLocks ──────────────────────────────────────────────────────

    describe("releaseAllLocks", () => {
        it("releases all locks held by a task", () => {
            manager.acquireLock("task-1", "/path/to/file1.ts")
            manager.acquireLock("task-1", "/path/to/file2.ts")
            manager.acquireLock("task-1", "/path/to/file3.ts")

            const released = manager.releaseAllLocks("task-1")
            expect(released).toBe(3)
        })

        it("only releases locks for the specified task", () => {
            manager.acquireLock("task-1", "/path/to/file1.ts")
            manager.acquireLock("task-2", "/path/to/file2.ts")
            manager.acquireLock("task-1", "/path/to/file3.ts")

            const released = manager.releaseAllLocks("task-1")
            expect(released).toBe(2)
            // task-2's lock should still be there
            expect(manager.getLockHolder("/path/to/file2.ts")).toBe("task-2")
        })

        it("returns 0 when task holds no locks", () => {
            const released = manager.releaseAllLocks("nonexistent")
            expect(released).toBe(0)
        })

        it("emits lockReleased for each released lock", () => {
            let releaseCount = 0
            manager.on("lockReleased" as any, () => { releaseCount++ })

            manager.acquireLock("task-1", "/path/to/file1.ts")
            manager.acquireLock("task-1", "/path/to/file2.ts")

            manager.releaseAllLocks("task-1")
            expect(releaseCount).toBe(2)
        })
    })

    // ─── getLockConflict / getLockHolder ──────────────────────────────────────

    describe("getLockConflict", () => {
        it("returns null when file is not locked", () => {
            const conflict = manager.getLockConflict("/path/to/file.ts")
            expect(conflict).toBeNull()
        })

        it("returns conflict info when file is locked by another task", () => {
            manager.acquireLock("task-1", "/path/to/file.ts")
            const conflict = manager.getLockConflict("/path/to/file.ts")

            expect(conflict).not.toBeNull()
            expect(conflict!.filePath).toBe("/path/to/file.ts")
            expect(conflict!.holderTaskId).toBe("task-1")
        })

        it("returns null for expired locks", () => {
            manager["locks"].set("/path/to/file.ts", { taskId: "task-1", acquiredAt: Date.now() - 400_000 })
            const conflict = manager.getLockConflict("/path/to/file.ts")
            expect(conflict).toBeNull()
        })

        it("cleans up expired lock from map", () => {
            manager["locks"].set("/path/to/file.ts", { taskId: "task-1", acquiredAt: Date.now() - 400_000 })
            manager.getLockConflict("/path/to/file.ts")
            expect(manager["locks"].has("/path/to/file.ts")).toBe(false)
        })
    })

    describe("getLockHolder", () => {
        it("returns taskId when file is locked", () => {
            manager.acquireLock("task-1", "/path/to/file.ts")
            const holder = manager.getLockHolder("/path/to/file.ts")
            expect(holder).toBe("task-1")
        })

        it("returns null when file is not locked", () => {
            const holder = manager.getLockHolder("/path/to/file.ts")
            expect(holder).toBeNull()
        })

        it("returns null for expired locks", () => {
            manager["locks"].set("/path/to/file.ts", { taskId: "task-1", acquiredAt: Date.now() - 400_000 })
            const holder = manager.getLockHolder("/path/to/file.ts")
            expect(holder).toBeNull()
        })
    })

    // ─── getTaskLocks ─────────────────────────────────────────────────────────

    describe("getTaskLocks", () => {
        it("returns all file paths locked by a task", () => {
            manager.acquireLock("task-1", "/path/to/file1.ts")
            manager.acquireLock("task-1", "/path/to/file2.ts")
            manager.acquireLock("task-2", "/path/to/file3.ts")

            const locks = manager.getTaskLocks("task-1")
            expect(locks).toContain("/path/to/file1.ts")
            expect(locks).toContain("/path/to/file2.ts")
            expect(locks).not.toContain("/path/to/file3.ts")
        })

        it("returns empty array when task holds no locks", () => {
            const locks = manager.getTaskLocks("nonexistent")
            expect(locks).toEqual([])
        })
    })

    // ─── resolveConflict ──────────────────────────────────────────────────────

    describe("resolveConflict", () => {
        it("returns true when no conflict exists", () => {
            const result = manager.resolveConflict("/path/to/file.ts", {})
            expect(result).toBe(true)
        })

        it("releases lock when releasingTaskId matches holder", () => {
            manager.acquireLock("task-1", "/path/to/file.ts")
            const result = manager.resolveConflict("/path/to/file.ts", { releasingTaskId: "task-1" })
            expect(result).toBe(true)
            expect(manager.getLockHolder("/path/to/file.ts")).toBeNull()
        })

        it("returns false when another task holds the lock and no release specified", () => {
            manager.acquireLock("task-1", "/path/to/file.ts")
            const result = manager.resolveConflict("/path/to/file.ts", {})
            expect(result).toBe(false)
        })

        it("replaces expired lock with new acquiring task", () => {
            manager["locks"].set("/path/to/file.ts", { taskId: "task-1", acquiredAt: Date.now() - 400_000 })
            const result = manager.resolveConflict("/path/to/file.ts", { acquiringTaskId: "task-2" })
            expect(result).toBe(true)
            expect(manager.getLockHolder("/path/to/file.ts")).toBe("task-2")
        })

        it("emits lockReleased when releasing task matches holder", () => {
            let released = false
            manager.on("lockReleased" as any, () => { released = true })

            manager.acquireLock("task-1", "/path/to/file.ts")
            manager.resolveConflict("/path/to/file.ts", { releasingTaskId: "task-1" })
            expect(released).toBe(true)
        })
    })

    // ─── clearAllLocks / getLockCount / cleanupExpiredLocks ────────────────────

    describe("clearAllLocks", () => {
        it("removes all locks regardless of task", () => {
            manager.acquireLock("task-1", "/path/to/file1.ts")
            manager.acquireLock("task-2", "/path/to/file2.ts")

            manager.clearAllLocks()
            expect(manager.getLockCount()).toBe(0)
        })
    })

    describe("getLockCount", () => {
        it("returns number of active locks", () => {
            expect(manager.getLockCount()).toBe(0)

            manager.acquireLock("task-1", "/path/to/file1.ts")
            manager.acquireLock("task-1", "/path/to/file2.ts")
            expect(manager.getLockCount()).toBe(2)
        })
    })

    describe("cleanupExpiredLocks", () => {
        it("removes expired locks and returns count", () => {
            // Set up mix of fresh and expired locks
            manager.acquireLock("task-1", "/path/to/fresh.ts")
            manager["locks"].set("/path/to/expired.ts", { taskId: "task-2", acquiredAt: Date.now() - 400_000 })

            const cleaned = manager.cleanupExpiredLocks()
            expect(cleaned).toBe(1)
            expect(manager.getLockCount()).toBe(1) // Only fresh remains
        })

        it("emits lockExpired event for each cleaned lock", () => {
            let expiredCount = 0
            manager.on("lockExpired" as any, () => { expiredCount++ })

            manager["locks"].set("/path/to/expired.ts", { taskId: "task-1", acquiredAt: Date.now() - 400_000 })
            manager.cleanupExpiredLocks()

            expect(expiredCount).toBe(1)
        })

        it("returns 0 when no locks are expired", () => {
            manager.acquireLock("task-1", "/path/to/file.ts")
            const cleaned = manager.cleanupExpiredLocks()
            expect(cleaned).toBe(0)
        })
    })

    // ─── EventEmitter usage (plain, no generics — matches Zoo Code convention) ─

    describe("EventEmitter pattern", () => {
        it("uses plain string event names without generics", () => {
            let lockAcquired = false
            manager.on("lockAcquired" as any, () => { lockAcquired = true })

            manager.acquireLock("task-1", "/path/to/file.ts")
            expect(lockAcquired).toBe(true)
        })

        it("supports multiple listeners for same event", () => {
            let count1 = 0
            let count2 = 0
            manager.on("lockReleased" as any, () => { count1++ })
            manager.on("lockReleased" as any, () => { count2++ })

            manager.acquireLock("task-1", "/path/to/file.ts")
            manager.releaseLock("task-1", "/path/to/file.ts")

            expect(count1).toBe(1)
            expect(count2).toBe(1)
        })
    })

    // ─── Edge cases ───────────────────────────────────────────────────────────

    describe("edge cases", () => {
        it("handles empty filePath string", () => {
            const result = manager.acquireLock("task-1", "")
            expect(result).toBe(true)
        })

        it("handles same file locked by multiple tasks sequentially", () => {
            // task-1 acquires, releases, then task-2 acquires
            manager.acquireLock("task-1", "/path/to/file.ts")
            manager.releaseLock("task-1", "/path/to/file.ts")
            const result = manager.acquireLock("task-2", "/path/to/file.ts")
            expect(result).toBe(true)
        })

        it("handles rapid acquire/release cycles", () => {
            for (let i = 0; i < 100; i++) {
                const taskId = `task-${i % 3}`
                manager.acquireLock(taskId, `/path/to/file.ts`)
                manager.releaseLock(taskId, "/path/to/file.ts")
            }
            expect(manager.getLockCount()).toBe(0)
        })

        it("handles many different files concurrently", () => {
            for (let i = 0; i < 50; i++) {
                manager.acquireLock(`task-${i % 5}`, `/path/to/file${i}.ts`)
            }
            expect(manager.getLockCount()).toBe(50)

            // Release all from task-0
            const released = manager.releaseAllLocks("task-0")
            expect(released).toBe(10) // 50 files / 5 tasks = 10 per task
        })
    })
})
