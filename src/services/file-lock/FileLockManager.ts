/**
 * FileLockManager — Advisory file locking for parallel task coordination.
 *
 * Prevents concurrent writes to the same file by maintaining an in-memory
 * lock table. Uses a simple Map-based approach (no external dependencies).
 *
 * Adapted from Roo-Code PR #12351 pattern, not copied verbatim.
 */

import EventEmitter from "events"

/** Lock entry — tracks which task holds a file lock and when it was acquired */
interface FileLockEntry {
    taskId: string
    acquiredAt: number
}

/** Conflict info returned by getLockConflict */
export interface FileLockConflict {
    filePath: string
    holderTaskId: string
    acquiredAt: number
}

/**
 * Advisory file lock manager for parallel task coordination.
 * Uses plain EventEmitter (no generics) to match Zoo Code conventions.
 */
export class FileLockManager extends EventEmitter {
    /** In-memory lock table: filePath → FileLockEntry */
    private locks = new Map<string, FileLockEntry>()

    /** Lock timeout in ms — default 5 minutes (advisory, not enforced by OS) */
    private readonly LOCK_TIMEOUT_MS = 300_000

    constructor() {
        super()
    }

    /**
     * Acquire an advisory lock on a file for the given task.
     * @returns true if lock acquired, false if already held by another task
     */
    acquireLock(taskId: string, filePath: string): boolean {
        const existing = this.locks.get(filePath)

        // Check if lock is expired (stale lock cleanup)
        if (existing && Date.now() - existing.acquiredAt > this.LOCK_TIMEOUT_MS) {
            console.warn(`[FileLockManager] Expired lock on "${filePath}" by task ${existing.taskId}, replacing`)
            this.locks.set(filePath, { taskId, acquiredAt: Date.now() })
            return true
        }

        // If held by same task, allow re-acquire (idempotent)
        if (existing && existing.taskId === taskId) {
            // Update timestamp on re-acquire
            this.locks.set(filePath, { taskId, acquiredAt: Date.now() })
            return true
        }

        // Held by another task — conflict
        if (existing) {
            return false
        }

        // No existing lock — acquire it
        this.locks.set(filePath, { taskId, acquiredAt: Date.now() })
        this.emit("lockAcquired", filePath, taskId)
        return true
    }

    /**
     * Release a specific file lock for the given task.
     * @returns true if lock was released, false if not held by this task or already released
     */
    releaseLock(taskId: string, filePath: string): boolean {
        const existing = this.locks.get(filePath)

        if (!existing || existing.taskId !== taskId) {
            return false
        }

        this.locks.delete(filePath)
        this.emit("lockReleased", filePath, taskId)
        return true
    }

    /**
     * Release all locks held by a task (called on task disposal).
     */
    releaseAllLocks(taskId: string): number {
        let released = 0
        for (const [filePath, entry] of this.locks.entries()) {
            if (entry.taskId === taskId) {
                this.locks.delete(filePath)
                this.emit("lockReleased", filePath, taskId)
                released++
            }
        }
        return released
    }

    /**
     * Check if a file is locked by another task.
     * @returns conflict info if locked, null otherwise
     */
    getLockConflict(filePath: string): FileLockConflict | null {
        const entry = this.locks.get(filePath)
        if (!entry) return null

        // Clean up expired locks
        if (Date.now() - entry.acquiredAt > this.LOCK_TIMEOUT_MS) {
            this.locks.delete(filePath)
            return null
        }

        return {
            filePath,
            holderTaskId: entry.taskId,
            acquiredAt: entry.acquiredAt,
        }
    }

    /**
     * Get the task ID that holds a lock on a file.
     * @returns taskId if locked, null otherwise
     */
    getLockHolder(filePath: string): string | null {
        const entry = this.locks.get(filePath)
        if (!entry) return null

        // Clean up expired locks
        if (Date.now() - entry.acquiredAt > this.LOCK_TIMEOUT_MS) {
            this.locks.delete(filePath)
            return null
        }

        return entry.taskId
    }

    /**
     * Get all file paths locked by a task.
     */
    getTaskLocks(taskId: string): string[] {
        const result: string[] = []
        for (const [filePath, entry] of this.locks.entries()) {
            if (entry.taskId === taskId) {
                result.push(filePath)
            }
        }
        return result
    }

    /**
     * Resolve a file lock conflict — either the holder releases or a new task takes over.
     * @returns true if resolved, false if still conflicted
     */
    resolveConflict(
        filePath: string,
        options: { releasingTaskId?: string; acquiringTaskId?: string },
    ): boolean {
        const existing = this.locks.get(filePath)

        if (!existing) return true // No conflict to resolve

        // If the releasing task holds the lock, release it
        if (options.releasingTaskId && existing.taskId === options.releasingTaskId) {
            this.locks.delete(filePath)
            this.emit("lockReleased", filePath, existing.taskId)
            return true
        }

        // If a new task is acquiring and the old lock is expired, replace it
        if (options.acquiringTaskId && Date.now() - existing.acquiredAt > this.LOCK_TIMEOUT_MS) {
            this.locks.set(filePath, { taskId: options.acquiringTaskId, acquiredAt: Date.now() })
            return true
        }

        // Still conflicted — another task holds the lock and it's not expired
        return false
    }

    /**
     * Clear all locks (for testing or shutdown).
     */
    clearAllLocks(): void {
        this.locks.clear()
    }

    /**
     * Get total number of active locks.
     */
    getLockCount(): number {
        return this.locks.size
    }

    /**
     * Clean up expired locks (advisory timeout).
     * @returns number of locks cleaned up
     */
    cleanupExpiredLocks(): number {
        const now = Date.now()
        let cleaned = 0

        for (const [filePath, entry] of this.locks.entries()) {
            if (now - entry.acquiredAt > this.LOCK_TIMEOUT_MS) {
                this.locks.delete(filePath)
                this.emit("lockExpired", filePath, entry.taskId)
                cleaned++
            }
        }

        return cleaned
    }
}
