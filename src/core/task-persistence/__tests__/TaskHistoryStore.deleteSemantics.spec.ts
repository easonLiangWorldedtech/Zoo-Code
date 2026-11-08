// pnpm --filter roo-cline test core/task-persistence/__tests__/TaskHistoryStore.deleteSemantics.spec.ts
//
// Best-effort deletion semantics for `delete()` and `deleteMany()`.
// Lock, unlink, and fs behavior stay real by default; individual tests force
// one lock or unlink failure through the wrappers below.

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryDeleteError, TaskHistoryStore } from "../TaskHistoryStore"
import { withFileLock } from "../../../utils/fileLock"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { readFileWithMissingRetry } from "../readFileWithMissingRetry"
import { safeWriteJson } from "../../../utils/safeWriteJson"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

// The default implementation stays the real one, so `safeWriteJson` writes
// and per-file locking behave exactly as in production unless a test forces
// a failure.
vi.mock("../../../utils/fileLock", async () => {
	const actual = await vi.importActual<typeof import("../../../utils/fileLock")>("../../../utils/fileLock")
	return { ...actual, withFileLock: vi.fn(actual.withFileLock) }
})

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, unlink: vi.fn(actual.unlink) }
})

const actualFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
const actualFileLock = await vi.importActual<typeof import("../../../utils/fileLock")>("../../../utils/fileLock")

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

function historyFilePath(storagePath: string, taskId: string): string {
	return path.join(storagePath, "tasks", taskId, GlobalFileNames.historyItem)
}

// The lock key is canonicalized through the parent directory, so the expected key is
// the canonical directory plus the basename rather than the path built from
// os.tmpdir(), which can be an 8.3 short path on the Windows runner.
async function canonicalKey(filePath: string): Promise<string> {
	return path.join(await actualFs.realpath(path.dirname(filePath)), path.basename(filePath))
}

function storeInternals(store: TaskHistoryStore): {
	cache: Map<string, HistoryItem>
	taskFileMtimes: Map<string, number>
} {
	return {
		cache: store["cache"],
		taskFileMtimes: store["taskFileMtimes"],
	}
}

describe("TaskHistoryStore best-effort deletion semantics", () => {
	let storagePath: string
	let stores: TaskHistoryStore[]
	let onWrite: ReturnType<typeof vi.fn>

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-delete-semantics-"))
		stores = []
		onWrite = vi.fn().mockResolvedValue(undefined)
		vi.mocked(withFileLock).mockClear()
		vi.mocked(withFileLock).mockImplementation(actualFileLock.withFileLock)
		vi.mocked(fs.unlink).mockImplementation(actualFs.unlink)
	})

	afterEach(async () => {
		for (const store of stores) {
			store.dispose()
		}
		await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {})
	})

	function createStore(): TaskHistoryStore {
		const store = new TaskHistoryStore(storagePath, {
			onWrite: onWrite as (items: HistoryItem[]) => Promise<void>,
		})
		stores.push(store)
		return store
	}

	it.each(["delete", "deleteMany"] as const)(
		"%s removes backups before deletion so readers and merges cannot resurrect history",
		async (operation) => {
			const store = createStore()
			await store.initialize()
			const history = makeHistoryItem({ id: "with-leftovers" })
			await store.upsert(history)
			const filePath = historyFilePath(storagePath, history.id)
			const dir = path.dirname(filePath)
			const backup = path.join(dir, `.${path.basename(filePath)}.bak_1_saved.tmp`)
			const replacement = path.join(dir, `.${path.basename(filePath)}.new_1_pending.tmp`)
			const unrelated = path.join(dir, ".other.json.bak_1_saved.tmp")
			await fs.writeFile(backup, JSON.stringify(history))
			await fs.writeFile(replacement, "{}")
			await fs.writeFile(unrelated, "keep")
			if (operation === "delete") await store.delete(history.id)
			else await store.deleteMany([history.id])

			await expect(readFileWithMissingRetry(filePath)).rejects.toMatchObject({ code: "ENOENT" })
			expect(await fs.readdir(dir)).toEqual([path.basename(unrelated)])
			await safeWriteJson(
				filePath,
				{},
				{
					merge: (existing) => {
						expect(existing).toBeNull()
						return { fresh: true }
					},
				},
			)
			expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ fresh: true })
		},
	)

	it.each(["delete", "deleteMany"] as const)(
		"%s preserves the canonical file if backup cleanup fails",
		async (operation) => {
			const store = createStore()
			await store.initialize()
			const history = makeHistoryItem({ id: "blocked-cleanup" })
			await store.upsert(history)
			const filePath = historyFilePath(storagePath, history.id)
			const backup = path.join(path.dirname(filePath), `.${path.basename(filePath)}.bak_1_saved.tmp`)
			await fs.writeFile(backup, JSON.stringify(history))
			vi.mocked(fs.unlink).mockImplementation(async (target) => {
				// Matched by basename, not by the whole path: the store re-derives the sibling path from
				// its own resolved and realpath'd directory, and on a Windows runner that spelling need
				// not be string-equal to the spelling this case created the file under. The basename of
				// a leftover is unique to this task file, so the injection still lands on exactly one
				// unlink and nothing else in the case can produce the EACCES.
				const backupName = path.basename(backup)
				if (path.basename(String(target)) === backupName) {
					throw Object.assign(new Error("Cleanup failed"), { code: "EACCES" })
				}
				return actualFs.unlink(target)
			})
			// The sweep of the interrupted-write siblings runs inside the same per-file lock as the
			// unlink, in the order jsonFileRecovery.deleteJsonFile uses, so a backup this store
			// cannot collect blocks the canonical unlink instead of leaving a resurrection source
			// beside a file the delete claimed to remove. Both files therefore survive, which is
			// main's guarantee, and the delete is reported as failed, which is this store's delete
			// contract: an item whose file is still on disk stays in the cache instead of being
			// contradicted by the next reconciliation.
			const attempt = operation === "delete" ? store.delete(history.id) : store.deleteMany([history.id])
			await expect(attempt).rejects.toThrow(TaskHistoryDeleteError)
			// An item whose file is still on disk stays in the cache: the delete did not finish.
			expect(store.get(history.id)?.id).toBe(history.id)
			expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(history)
			expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual(history)
		},
	)

	describe("delete()", () => {
		it("unlinks under the shared per-file lock, evicts cache and mtime, and writes through once", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "locked-delete" }))
			onWrite.mockClear()

			// The lock key is the resolved publish target, so the expected key is
			// captured through realpath before the delete: on Windows os.tmpdir()
			// can be an 8.3 short path (C:\Users\RUNNER~1) that realpath expands
			// to the long form, and the file is gone after the unlink.
			const lockKey = await fs.realpath(historyFilePath(storagePath, "locked-delete"))

			await expect(store.delete("locked-delete")).resolves.toBeUndefined()

			expect(vi.mocked(withFileLock)).toHaveBeenCalledWith(lockKey, expect.any(Function))
			await expect(fs.access(historyFilePath(storagePath, "locked-delete"))).rejects.toMatchObject({
				code: "ENOENT",
			})

			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("locked-delete")).toBe(false)
			expect(taskFileMtimes.has("locked-delete")).toBe(false)
			expect(store.get("locked-delete")).toBeUndefined()

			expect(onWrite).toHaveBeenCalledTimes(1)
			const writtenIds = (onWrite.mock.calls[0][0] as HistoryItem[]).map((item) => item.id)
			expect(writtenIds).not.toContain("locked-delete")
		})

		it("keeps the item and reports a lock acquisition failure instead of evicting it", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "lock-fail" }))
			onWrite.mockClear()

			// Snapshot what the store holds before the failing deletion so the test can
			// assert that nothing was evicted.
			const internals = storeInternals(store)
			const hadCache = internals.cache.has("lock-fail")
			const hadMtime = internals.taskFileMtimes.has("lock-fail")
			vi.mocked(withFileLock).mockRejectedValueOnce(new Error("lock acquisition timed out"))

			await expect(store.delete("lock-fail")).rejects.toThrow(TaskHistoryDeleteError)

			// The unlink never ran, so nothing was evicted and nothing was written through: the
			// store still matches the file on disk instead of reporting a deletion that
			// reconciliation would undo.
			await expect(fs.access(historyFilePath(storagePath, "lock-fail"))).resolves.toBeUndefined()
			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("lock-fail")).toBe(hadCache)
			expect(taskFileMtimes.has("lock-fail")).toBe(hadMtime)
			expect(store.get("lock-fail")).toBeDefined()
			expect(onWrite).not.toHaveBeenCalled()
		})

		it("names the directory-read stage when the sweep's readdir fails under the lock", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "readdir-fail" }))
			onWrite.mockClear()

			const internals = storeInternals(store)
			const hadCache = internals.cache.has("readdir-fail")
			const hadMtime = internals.taskFileMtimes.has("readdir-fail")
			// The lock itself succeeds here: only the sweep's directory read fails.
			const readdirSpy = vi
				.spyOn(fs, "readdir")
				.mockRejectedValueOnce(
					Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" }),
				)
			let rejection: unknown
			try {
				rejection = await store.delete("readdir-fail").catch((error: unknown) => error)
			} finally {
				readdirSpy.mockRestore()
			}

			expect(rejection).toBeInstanceOf(TaskHistoryDeleteError)
			// The stage that failed is the directory read. Calling it a lock failure would send the
			// reader looking for a lock that was held the whole time.
			expect(String((rejection as TaskHistoryDeleteError).reason)).toContain(
				"the containing directory could not be read (EACCES)",
			)
			await expect(fs.access(historyFilePath(storagePath, "readdir-fail"))).resolves.toBeUndefined()
			const after = storeInternals(store)
			expect(after.cache.has("readdir-fail")).toBe(hadCache)
			expect(after.taskFileMtimes.has("readdir-fail")).toBe(hadMtime)
			expect(store.get("readdir-fail")).toBeDefined()
			expect(onWrite).not.toHaveBeenCalled()
		})

		it("keeps the item when the lock fails, the named path is absent, and a recovery leftover remains", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "leftover-after-lock-fail" }))
			onWrite.mockClear()
			const taskPath = historyFilePath(storagePath, "leftover-after-lock-fail")
			const taskDir = path.dirname(taskPath)
			// A .bak_ sibling is the kind recoverInterruptedReplacement restores when the canonical
			// path is missing (jsonFileRecovery.ts:169-172), so this is the leftover that can bring the
			// task back after the delete claimed it was finished.
			const leftover = "." + GlobalFileNames.historyItem + ".bak_1_saved.tmp"
			await actualFs.writeFile(path.join(taskDir, leftover), "{}")
			const internals = storeInternals(store)
			const hadCache = internals.cache.has("leftover-after-lock-fail")
			const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (p: unknown) => {
				if (String(p) === taskPath) {
					throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
				}
				return await actualFs.lstat(String(p))
			})
			vi.mocked(withFileLock).mockRejectedValueOnce(
				Object.assign(new Error("EEXIST: file already exists, mkdir"), { code: "EEXIST" }),
			)
			let rejection: unknown
			try {
				rejection = await store.delete("leftover-after-lock-fail").catch((error: unknown) => error)
			} finally {
				lstatSpy.mockRestore()
			}

			expect(rejection).toBeInstanceOf(TaskHistoryDeleteError)
			expect(String((rejection as TaskHistoryDeleteError).reason)).toContain("can still be recovered")
			expect(storeInternals(store).cache.has("leftover-after-lock-fail")).toBe(hadCache)
			expect(store.get("leftover-after-lock-fail")).toBeDefined()
			await expect(actualFs.access(path.join(taskDir, leftover))).resolves.toBeUndefined()
		})

		it("keeps the item when the scan is empty but a live lock still stands", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "live-lock-empty-scan" }))
			onWrite.mockClear()
			const taskPath = historyFilePath(storagePath, "live-lock-empty-scan")
			const internals = storeInternals(store)
			const hadCache = internals.cache.has("live-lock-empty-scan")
			// A writer that holds the lock and has not staged anything yet leaves the named path
			// absent and the directory free of siblings, so an empty scan proves nothing about it.
			// The lock is the shape proper-lockfile makes - a directory beside the key - so the
			// retry refuses it for the reason production would: it is younger than the window.
			const lockKey = await canonicalKey(taskPath)
			const lockDir = lockKey + ".lock"
			await actualFs.mkdir(lockDir)
			const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (p: unknown) => {
				if (String(p) === taskPath) {
					throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
				}
				return await actualFs.lstat(String(p))
			})
			vi.mocked(withFileLock).mockRejectedValueOnce(
				Object.assign(new Error("EEXIST: file already exists, mkdir"), { code: "EEXIST" }),
			)
			let rejection: unknown
			try {
				rejection = await store.delete("live-lock-empty-scan").catch((error: unknown) => error)
			} finally {
				lstatSpy.mockRestore()
				await actualFs.rm(lockDir, { recursive: true, force: true })
			}
			expect(rejection).toBeInstanceOf(TaskHistoryDeleteError)
			expect(String((rejection as TaskHistoryDeleteError).reason)).toContain("blocked on the lock")
			expect(storeInternals(store).cache.has("live-lock-empty-scan")).toBe(hadCache)
			expect(store.get("live-lock-empty-scan")).toBeDefined()
			expect(onWrite).not.toHaveBeenCalled()
		})

		it("takes a lock older than the staleness window and certifies the deletion under it", async () => {
			// The other side of the same threshold. A writer that died leaves its lock directory
			// behind, and acquireFileLock passes LOCK_STALE_MS to proper-lockfile, which then
			// steals it: the retry is not a wait for a live writer, it is a test of whether one is
			// still holding on. The file is removed for real here, so the certification is the
			// filesystem's own answer, taken while the delete held the lock.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "stale-lock-certified" }))
			onWrite.mockClear()
			const taskPath = historyFilePath(storagePath, "stale-lock-certified")
			const lockKey = await canonicalKey(taskPath)
			const lockDir = lockKey + ".lock"
			await actualFs.mkdir(lockDir)
			// Older than the window the protocol passes, by well past its margin.
			const stale = new Date(Date.now() - actualFileLock.LOCK_STALE_MS - 9_000)
			await actualFs.utimes(lockDir, stale, stale)
			await actualFs.rm(taskPath)
			vi.mocked(withFileLock).mockRejectedValueOnce(
				Object.assign(new Error("EEXIST: file already exists, mkdir"), { code: "EEXIST" }),
			)
			await expect(store.delete("stale-lock-certified")).resolves.toBeUndefined()
			// The lock was stolen, the named path was absent under it and nothing recoverable sat
			// beside it, so the deletion is completed and the stolen lock is released again.
			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("stale-lock-certified")).toBe(false)
			expect(taskFileMtimes.has("stale-lock-certified")).toBe(false)
			expect(store.get("stale-lock-certified")).toBeUndefined()
			expect(onWrite).toHaveBeenCalledTimes(1)
			await expect(actualFs.stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" })
		})
		it("reports failure when the file comes back after the lock failed", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "came-back" }))
			onWrite.mockClear()
			const taskPath = historyFilePath(storagePath, "came-back")
			const internals = storeInternals(store)
			const hadCache = internals.cache.has("came-back")
			// A writer can publish and release the lock between the missing-file lstat and the scan,
			// so the file is back by the time the verdict would be reported: the first lstat sees it
			// absent and every later check sees the published file.
			let firstLstat = true
			const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (p: unknown) => {
				if (String(p) === taskPath && firstLstat) {
					firstLstat = false
					throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
				}
				return await actualFs.lstat(String(p))
			})
			vi.mocked(withFileLock).mockRejectedValueOnce(
				Object.assign(new Error("EEXIST: file already exists, mkdir"), { code: "EEXIST" }),
			)
			let rejection: unknown
			try {
				rejection = await store.delete("came-back").catch((error: unknown) => error)
			} finally {
				lstatSpy.mockRestore()
			}
			expect(rejection).toBeInstanceOf(TaskHistoryDeleteError)
			expect(String((rejection as TaskHistoryDeleteError).reason)).toContain(
				"the file came back after the lock failed",
			)
			expect(storeInternals(store).cache.has("came-back")).toBe(hadCache)
			expect(store.get("came-back")).toBeDefined()
			expect(onWrite).not.toHaveBeenCalled()
		})

		it("keeps the item and reports a non-ENOENT unlink failure, and a retry then deletes it", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "perm-fail" }))
			onWrite.mockClear()

			// Snapshot what the store holds before the failing deletion so the test can
			// assert that nothing was evicted.
			const internals = storeInternals(store)
			const hadCache = internals.cache.has("perm-fail")
			const hadMtime = internals.taskFileMtimes.has("perm-fail")
			vi.mocked(fs.unlink).mockRejectedValueOnce(
				Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" }),
			)

			await expect(store.delete("perm-fail")).rejects.toThrow(TaskHistoryDeleteError)

			// The file survived, so the item survived with it: no eviction, no write-through.
			await expect(fs.access(historyFilePath(storagePath, "perm-fail"))).resolves.toBeUndefined()
			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("perm-fail")).toBe(hadCache)
			expect(taskFileMtimes.has("perm-fail")).toBe(hadMtime)
			expect(onWrite).not.toHaveBeenCalled()

			// The per-file lock was released: a retry without the injected failure deletes the
			// file, evicts, and writes through once.
			await expect(store.delete("perm-fail")).resolves.toBeUndefined()
			await expect(fs.access(historyFilePath(storagePath, "perm-fail"))).rejects.toMatchObject({
				code: "ENOENT",
			})
			expect(cache.has("perm-fail")).toBe(false)
			expect(taskFileMtimes.has("perm-fail")).toBe(false)
			expect(onWrite).toHaveBeenCalledTimes(1)
		})

		it("treats a missing file as a completed deletion", async () => {
			const store = createStore()
			await store.initialize()
			onWrite.mockClear()

			await expect(store.delete("never-existed")).resolves.toBeUndefined()
			expect(store.get("never-existed")).toBeUndefined()
			expect(onWrite).toHaveBeenCalledTimes(1)
		})

		it("locks the resolved publish target while unlinking the path it was given", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "alias-del" }))
			const aliasPath = historyFilePath(storagePath, "alias-del")
			const referentPath = path.join(storagePath, "tasks", "alias-del", "referent-history.json")

			// Real symlinks are unavailable in this CI lane, so the alias is
			// simulated through realpath, as in the safeWriteJson lock test.
			// Only the file resolves through the alias; the directory is canonicalized by the
			// the real fs exactly as in production, so the key matches the canonical directory
			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockImplementation(async (target) =>
					target === aliasPath ? referentPath : actualFs.realpath(String(target)),
				)
			try {
				await expect(store.delete("alias-del")).resolves.toBeUndefined()
			} finally {
				realpathSpy.mockRestore()
			}

			// One lock for the underlying file, keyed by the referent; the unlink
			// still targets the path the store named.
			expect(vi.mocked(withFileLock)).toHaveBeenCalledWith(await canonicalKey(referentPath), expect.any(Function))
			// Assert the unlink target itself: locking the referent while unlinking the
			// referent instead of the alias would keep the dangling link in place.
			expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(aliasPath)
			expect(vi.mocked(fs.unlink)).not.toHaveBeenCalledWith(referentPath)
		})

		it("waits on the peer's lock at the referent when the link is dangling", async () => {
			// delete() must resolve the chain itself: resolvePublishTarget refuses a
			// dangling link, and the old code treated that rejection as "already deleted"
			// so the link was never removed.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "alias-dangling" }))
			const aliasPath = historyFilePath(storagePath, "alias-dangling")
			const referentPath = path.join(storagePath, "tasks", "alias-dangling", "referent-history.json")
			// Only the file resolves through the alias; the directory is canonicalized by the
			// the real fs exactly as in production, so the key matches the canonical directory
			const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
				if (target === aliasPath) throw enoent
				return actualFs.realpath(String(target))
			})
			const lstatSpy = vi
				.spyOn(fs, "lstat")
				.mockResolvedValue({ isSymbolicLink: () => true } as unknown as import("fs").Stats)
			const readlinkSpy = vi.spyOn(fs, "readlink").mockImplementation(async (p) => {
				if (p === aliasPath) return "referent-history.json"
				throw new Error("not a symbolic link")
			})
			try {
				await expect(store.delete("alias-dangling")).resolves.toBeUndefined()
			} finally {
				realpathSpy.mockRestore()
				lstatSpy.mockRestore()
				readlinkSpy.mockRestore()
			}

			expect(vi.mocked(withFileLock)).toHaveBeenCalledWith(await canonicalKey(referentPath), expect.any(Function))
			expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(aliasPath)
		})

		it("keeps the item when the lock key cannot be resolved, instead of calling it deleted", async () => {
			// The canonicalization inside resolveLockKey fails, so no lock key exists and no lock is
			// ever attempted. Whatever the errno says, this call has not touched the file, and the
			// item must stay in the store with a reason that names the stage that failed.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "alias-unresolvable" }))
			const aliasPath = historyFilePath(storagePath, "alias-unresolvable")
			const dirPath = path.dirname(aliasPath)
			// The unlink, lock and write-through mocks are shared across cases, and the upsert
			// above wrote through once, so clear them to make the assertions below about this delete.
			vi.mocked(fs.unlink).mockClear()
			vi.mocked(withFileLock).mockClear()
			onWrite.mockClear()
			// Not ENOENT: canonicalDirKey walks up to the nearest existing ancestor for a
			// missing directory, so "not there" is a key it can still compute. Any other failure says
			// nothing about the canonical form and is propagated, which is the resolution failure this
			// path has to report rather than read as a deletion.
			const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" })
			const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
				const targetPath = String(target)
				if (targetPath === aliasPath || targetPath === dirPath) throw eacces
				return actualFs.realpath(targetPath)
			})
			let rejection: unknown
			try {
				await store.delete("alias-unresolvable")
			} catch (error: unknown) {
				rejection = error
			} finally {
				realpathSpy.mockRestore()
			}

			expect(rejection).toBeInstanceOf(TaskHistoryDeleteError)
			// No lock key, so no lock and no unlink: nothing this call did can account for the file
			// being gone, and the reported reason has to say which stage failed.
			expect(vi.mocked(withFileLock)).not.toHaveBeenCalled()
			expect(fs.unlink).not.toHaveBeenCalled()
			expect((rejection as TaskHistoryDeleteError).reason).toContain("lock key could not be resolved")
			// The entry and its write-through state stay put: a later reconcile still sees the file.
			expect(storeInternals(store).cache.has("alias-unresolvable")).toBe(true)
			expect(onWrite).not.toHaveBeenCalled()
			expect((rejection as TaskHistoryDeleteError).taskIds).toEqual(["alias-unresolvable"])
		})

		it("does not treat an ENOENT from lock acquisition as a completed deletion", async () => {
			// proper-lockfile creates <key>.lock with mkdir and reports ENOENT when the directory
			// that would hold it is missing. That is a failure to take the lock, not a report about
			// the task file, so the named file has to be asked directly before anything is evicted.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "lock-enoent" }))
			vi.mocked(fs.unlink).mockClear()
			onWrite.mockClear()
			// Once, not for good: mockClear() does not reset implementations, and this test only needs
			// the next lock attempt to fail - a mock still rejecting would decide later tests for us.
			vi.mocked(withFileLock).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

			await expect(store.delete("lock-enoent")).rejects.toThrow(TaskHistoryDeleteError)

			expect(fs.unlink).not.toHaveBeenCalled()
			expect(storeInternals(store).cache.has("lock-enoent")).toBe(true)
			expect(onWrite).not.toHaveBeenCalled()
		})

		it("reports a lock failure as a completed deletion when the named file is itself gone", async () => {
			// file, so the file is asked directly - and here it really answers ENOENT. The answer
			// file, so the file is asked directly - and here it really answers ENOENT. The answer
			// comes from the filesystem rather than a mock, so the branch is reached the way
			// production reaches it: a task file that was already removed while the lock was lost.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "lock-fail-gone" }))
			onWrite.mockClear()
			await actualFs.rm(historyFilePath(storagePath, "lock-fail-gone"))
			vi.mocked(withFileLock).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

			await expect(store.delete("lock-fail-gone")).resolves.toBeUndefined()

			// and the index written through without it. A verdict that kept the item here would leave
			// and the index written through without it. A verdict that kept the item here would leave
			// an entry whose file can never be deleted again.
			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("lock-fail-gone")).toBe(false)
			expect(taskFileMtimes.has("lock-fail-gone")).toBe(false)
			expect(store.get("lock-fail-gone")).toBeUndefined()
			expect(onWrite).toHaveBeenCalledTimes(1)
			const writtenIds = (onWrite.mock.calls[0][0] as HistoryItem[]).map((item) => item.id)
			expect(writtenIds).not.toContain("lock-fail-gone")
		})

		it("reports the lock failure and the failed check when the named file cannot be stat'ed", async () => {
			// The third answer the check can give is neither "gone" nor "there": EACCES, a transport
			// error, an ENOTDIR on the way. Then nothing is known about the file, so the item stays
			// and the report has to carry both facts - which lock failed, and that the file could not
			// be checked to settle it. Reporting only the lock would read as a plain lock timeout and
			// send the next operator to look for a peer that never existed.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "lock-fail-uncheckable" }))
			onWrite.mockClear()
			vi.mocked(withFileLock).mockRejectedValueOnce(Object.assign(new Error("ELOCKED"), { code: "ELOCKED" }))
			const statError = Object.assign(new Error("EACCES"), { code: "EACCES" })
			// Spied rather than forced through the real filesystem: an unreadable directory is not
			// portable, and the branch is about the errno the check reports, not about how it got it.
			const lstatSpy = vi.spyOn(fs, "lstat").mockRejectedValue(statError)
			let rejection: unknown
			try {
				await store.delete("lock-fail-uncheckable")
			} catch (error: unknown) {
				rejection = error
			} finally {
				lstatSpy.mockRestore()
			}

			expect(rejection).toBeInstanceOf(TaskHistoryDeleteError)
			const deleteError = rejection as TaskHistoryDeleteError
			expect(deleteError.reason).toContain("the per-file lock could not be taken (ELOCKED)")
			expect(deleteError.reason).toContain("the file could not be checked (EACCES)")
			// The check's own error is the cause, not the lock's: it is the last thing that was known.
			expect(deleteError.cause).toBe(statError)
			expect(storeInternals(store).cache.has("lock-fail-uncheckable")).toBe(true)
			expect(store.get("lock-fail-uncheckable")).toBeDefined()
			expect(onWrite).not.toHaveBeenCalled()
		})
	})

	describe("reconcile()", () => {
		it("keeps a cached task live when its file is absent but the lock is held at the resolved referent", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "alias-live" }))
			const aliasPath = historyFilePath(storagePath, "alias-live")
			const referentPath = path.join(storagePath, "tasks", "alias-live", "referent-history.json")

			// Real symlinks are unavailable in this CI lane, so the alias is
			// simulated through realpath, as in the safeWriteJson lock test.
			// Only the file resolves through the alias; the directory is canonicalized by the
			// the real fs exactly as in production, so the key matches the canonical directory
			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockImplementation(async (target) =>
					target === aliasPath ? referentPath : actualFs.realpath(String(target)),
				)
			try {
				// The rename window: the referent is momentarily missing, so the cached
				// file cannot be stat'd while the peer holds the lock at the key it locks.
				await actualFs.rm(aliasPath, { force: true })
				await actualFs.writeFile(referentPath + ".lock", "")
				await store.reconcile()
			} finally {
				realpathSpy.mockRestore()
			}

			// The probe must look at the same key the writer locks, otherwise a live
			// task is evicted from the cache while its write is still in progress.
			expect(storeInternals(store).cache.has("alias-live")).toBe(true)
		})

		it("keeps a cached task live when the alias is dangling during the rename window", async () => {
			// resolvePublishTarget refuses a dangling link because a writer must not publish
			// through the link path, but this probe runs exactly in that window, so it reads
			// the link one level itself to find the lock the writer holds at the referent.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "dangling-live" }))
			const aliasPath = historyFilePath(storagePath, "dangling-live")
			const referentPath = path.join(storagePath, "tasks", "dangling-live", "referent-history.json")

			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			const lstatSpy = vi
				.spyOn(fs, "lstat")
				.mockResolvedValue({ isSymbolicLink: () => true } as unknown as import("fs").Stats)
			// A relative link target, so the probe must resolve it against the link's
			// directory rather than the process working directory.
			const readlinkSpy = vi.spyOn(fs, "readlink").mockImplementation(async (p) => {
				if (p === aliasPath) return "referent-history.json"
				throw new Error("not a symbolic link")
			})
			try {
				await actualFs.rm(aliasPath, { force: true })
				await actualFs.writeFile(referentPath + ".lock", "")
				await store.reconcile()
			} finally {
				realpathSpy.mockRestore()
				lstatSpy.mockRestore()
				readlinkSpy.mockRestore()
			}

			expect(storeInternals(store).cache.has("dangling-live")).toBe(true)
		})

		it("follows the whole link chain to the key the writer locked", async () => {
			// realpath resolves the whole chain, so it fails when the final referent is
			// momentarily renamed to its backup. The probe must walk the chain, not just
			// its first link, or it looks for a lock the writer never took.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "chain-live" }))
			const aliasPath = historyFilePath(storagePath, "chain-live")
			const dir = path.dirname(aliasPath)
			const referentPath = path.join(dir, "referent-history.json")
			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			const lstatSpy = vi
				.spyOn(fs, "lstat")
				.mockResolvedValue({ isSymbolicLink: () => true } as unknown as import("fs").Stats)
			const readlinkSpy = vi.spyOn(fs, "readlink").mockImplementation(async (p) => {
				if (p === aliasPath) return "nested-link.json"
				if (p === path.join(dir, "nested-link.json")) return "referent-history.json"
				throw new Error("not a symbolic link")
			})
			try {
				await actualFs.rm(aliasPath, { force: true })
				await actualFs.writeFile(referentPath + ".lock", "")
				await store.reconcile()
			} finally {
				realpathSpy.mockRestore()
				lstatSpy.mockRestore()
				readlinkSpy.mockRestore()
			}

			expect(storeInternals(store).cache.has("chain-live")).toBe(true)
		})

		it("probes the key the bounded walk actually reached on a long chain", async () => {
			// A chain longer than the hop limit: the walk stops at the limit, so the probe
			// must look at the key it reached, not at the far end of the chain.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "long-chain" }))
			const startPath = historyFilePath(storagePath, "long-chain")
			const dir = path.dirname(startPath)
			const hops = Array.from({ length: 9 }, (_, index) => path.join(dir, "h" + (index + 1) + ".json"))
			const reachedPath = hops[7]
			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			const lstatSpy = vi
				.spyOn(fs, "lstat")
				.mockResolvedValue({ isSymbolicLink: () => true } as unknown as import("fs").Stats)
			const readlinkSpy = vi.spyOn(fs, "readlink").mockImplementation(async (p) => {
				const index = [startPath, ...hops].indexOf(String(p))
				if (index === -1 || index === hops.length) throw new Error("not a symbolic link")
				return hops[index]
			})
			try {
				await actualFs.rm(startPath, { force: true })
				await actualFs.writeFile(reachedPath + ".lock", "")
				await store.reconcile()
			} finally {
				realpathSpy.mockRestore()
				lstatSpy.mockRestore()
				readlinkSpy.mockRestore()
			}

			expect(storeInternals(store).cache.has("long-chain")).toBe(true)
		})

		it("terminates on a link cycle instead of holding the store lock forever", async () => {
			// Two links that point at each other: every readlink succeeds, so an unbounded
			// walk would never release the store lock.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "cycle-live" }))
			const aPath = historyFilePath(storagePath, "cycle-live")
			const bPath = path.join(path.dirname(aPath), "b.json")
			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			const lstatSpy = vi
				.spyOn(fs, "lstat")
				.mockResolvedValue({ isSymbolicLink: () => true } as unknown as import("fs").Stats)
			const readlinkSpy = vi.spyOn(fs, "readlink").mockImplementation(async (p) => {
				if (p === aPath) return "b.json"
				// Point back to the real alias basename so the walk actually loops; returning
				// a name that is not the alias stops the walk after two hops and never reaches
				// the hop limit this test is about.
				if (p === bPath) return path.basename(aPath)
				throw new Error("not a symbolic link")
			})
			try {
				await actualFs.rm(aPath, { force: true })
				await store.reconcile()
				// Assert inside the try: mockRestore() clears the call counts, so checking after
				// the finally block would read zero. Eight hops means the walk looped on the
				// cycle instead of stopping at the first non-link.
				expect(readlinkSpy).toHaveBeenCalledTimes(8)
			} finally {
				realpathSpy.mockRestore()
				lstatSpy.mockRestore()
				readlinkSpy.mockRestore()
			}

			// The walk is bounded, so reconcile returned; the probe looked at the key it
			// reached after the bounded hops, found no lock there, and evicted the task.
			expect(storeInternals(store).cache.has("cycle-live")).toBe(false)
		})
	})

	describe("deleteMany()", () => {
		it("keeps the failed item, continues the batch, and reports the failure after one write-through", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "batch-a", ts: 1000 }))
			await store.upsert(makeHistoryItem({ id: "batch-b", ts: 2000 }))
			await store.upsert(makeHistoryItem({ id: "batch-c", ts: 3000 }))
			onWrite.mockClear()

			const internalsBefore = storeInternals(store)
			const hadCache = internalsBefore.cache.has("batch-b")
			const hadMtime = internalsBefore.taskFileMtimes.has("batch-b")
			vi.mocked(fs.unlink).mockImplementation(async (p) => {
				if (p === historyFilePath(storagePath, "batch-b")) {
					throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" })
				}
				return actualFs.unlink(p)
			})

			const failure = await store
				.deleteMany(["batch-a", "batch-b", "batch-c"])
				.then(() => null)
				.catch((error: unknown) => error)
			expect(failure).toBeInstanceOf(TaskHistoryDeleteError)
			expect((failure as TaskHistoryDeleteError).taskIds).toEqual(["batch-b"])

			// batch-b failed but the batch continued around it.
			await expect(fs.access(historyFilePath(storagePath, "batch-a"))).rejects.toMatchObject({ code: "ENOENT" })
			await expect(fs.access(historyFilePath(storagePath, "batch-b"))).resolves.toBeUndefined()
			await expect(fs.access(historyFilePath(storagePath, "batch-c"))).rejects.toMatchObject({ code: "ENOENT" })

			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("batch-a")).toBe(false)
			expect(cache.has("batch-b")).toBe(hadCache)
			expect(cache.has("batch-c")).toBe(false)
			expect(taskFileMtimes.has("batch-a")).toBe(false)
			expect(taskFileMtimes.has("batch-b")).toBe(hadMtime)
			expect(taskFileMtimes.has("batch-c")).toBe(false)
			expect(store.get("batch-b")).toBeDefined()

			// One write-through, after the whole batch, still carrying the item that survived.
			expect(onWrite).toHaveBeenCalledTimes(1)
			const writtenIds = (onWrite.mock.calls[0][0] as HistoryItem[]).map((item) => item.id)
			expect(writtenIds).toEqual(["batch-b"])
		})

		it("keeps the item whose lock failed, finishes the batch, and reports it", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "lock-a", ts: 1000 }))
			await store.upsert(makeHistoryItem({ id: "lock-b", ts: 2000 }))
			onWrite.mockClear()

			const internalsBefore = storeInternals(store)
			const hadCache = internalsBefore.cache.has("lock-a")
			const hadMtime = internalsBefore.taskFileMtimes.has("lock-a")
			vi.mocked(withFileLock).mockRejectedValueOnce(new Error("lock acquisition timed out"))

			const failure = await store
				.deleteMany(["lock-a", "lock-b"])
				.then(() => null)
				.catch((error: unknown) => error)
			expect(failure).toBeInstanceOf(TaskHistoryDeleteError)
			expect((failure as TaskHistoryDeleteError).taskIds).toEqual(["lock-a"])

			// The first item’s lock failed before its unlink; the second item still completed.
			await expect(fs.access(historyFilePath(storagePath, "lock-a"))).resolves.toBeUndefined()
			await expect(fs.access(historyFilePath(storagePath, "lock-b"))).rejects.toMatchObject({ code: "ENOENT" })

			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("lock-a")).toBe(hadCache)
			expect(cache.has("lock-b")).toBe(false)
			expect(taskFileMtimes.has("lock-a")).toBe(hadMtime)
			expect(taskFileMtimes.has("lock-b")).toBe(false)

			// The write-through reflects what actually happened: lock-b gone, lock-a kept.
			expect(onWrite).toHaveBeenCalledTimes(1)
			const writtenIds = (onWrite.mock.calls[0][0] as HistoryItem[]).map((item) => item.id)
			expect(writtenIds).toEqual(["lock-a"])
		})

		it("reports every id, keeps every entry and file, and skips the write-through when the whole batch failed", async () => {
			// deletedAny stays false when nothing was removed: the store must not write a state
			// it did not change, and every requested id has to be reported - a partial report
			// would let the caller forget ids that are still on disk.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "all-a", ts: 1000 }))
			await store.upsert(makeHistoryItem({ id: "all-b", ts: 2000 }))
			onWrite.mockClear()

			storeInternals(store).taskFileMtimes.set("all-a", 1000)
			storeInternals(store).taskFileMtimes.set("all-b", 2000)
			// One id fails at the lock, the other at the unlink: both outcomes count as
			// "not deleted", and neither may be treated as gone.
			vi.mocked(withFileLock).mockRejectedValueOnce(new Error("lock acquisition timed out"))
			vi.mocked(fs.unlink).mockRejectedValueOnce(
				Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }),
			)

			const failure = await store
				.deleteMany(["all-a", "all-b"])
				.then(() => null)
				.catch((error: unknown) => error)
			expect(failure).toBeInstanceOf(TaskHistoryDeleteError)
			expect((failure as TaskHistoryDeleteError).taskIds).toEqual(["all-a", "all-b"])

			const { cache, taskFileMtimes } = storeInternals(store)
			// storeInternals returns the live maps, so comparing them against 'before' compared
			// a map with itself and passed no matter what deleteMany did. A failed delete must
			// leave both ids in both maps, so assert that directly.
			// The cache is the store's own view: a failed delete must leave both ids in it.
			expect(cache.has("all-a")).toBe(true)
			expect(cache.has("all-b")).toBe(true)
			// taskFileMtimes is only populated by the reconcile path (external-change
			// detection), so a store that never reconciled has an empty map here - asserting
			// presence without seeding it would assert something that was never true. That is what
			// the two set() calls above the delete are for: they seed the map through the same
			// internals the store uses. What is asserted here is only that a failed delete left
			// that seeding alone.
			expect(taskFileMtimes.has("all-a")).toBe(true)
			expect(taskFileMtimes.has("all-b")).toBe(true)
			await expect(fs.access(historyFilePath(storagePath, "all-a"))).resolves.toBeUndefined()
			await expect(fs.access(historyFilePath(storagePath, "all-b"))).resolves.toBeUndefined()

			// Nothing was deleted, so nothing was written through.
			expect(onWrite).not.toHaveBeenCalled()
		})

		it("locks the resolved publish target for every item while unlinking the given paths", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "alias-batch", ts: 1000 }))
			const aliasPath = historyFilePath(storagePath, "alias-batch")
			const referentPath = path.join(storagePath, "tasks", "alias-batch", "referent-history.json")

			// Only the file resolves through the alias; the directory is canonicalized by the
			// the real fs exactly as in production, so the key matches the canonical directory
			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockImplementation(async (target) =>
					target === aliasPath ? referentPath : actualFs.realpath(String(target)),
				)
			try {
				await expect(store.deleteMany(["alias-batch"])).resolves.toBeUndefined()
			} finally {
				realpathSpy.mockRestore()
			}

			expect(vi.mocked(withFileLock)).toHaveBeenCalledWith(await canonicalKey(referentPath), expect.any(Function))
			expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(aliasPath)
		})
		it("reports a duplicate id only when its last attempt failed", async () => {
			// The batch's caller can hand the same id twice: the descendant walk in
			// ClineProvider.deleteTaskWithId has no visited set, so a child listed under two parents or
			// a cycle in childIds yields duplicates. The first attempt here fails at the lock and the
			// second completes the removal, so the batch has to report nothing: an id whose file this
			// batch deleted must not appear in the failure report, because its caller excludes reported
			// ids from the artifact cleanup and would leave the task directory behind.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "dup-deleted" }))
			onWrite.mockClear()
			vi.mocked(withFileLock).mockRejectedValueOnce(new Error("lock acquisition timed out"))

			await expect(store.deleteMany(["dup-deleted", "dup-deleted"])).resolves.toBeUndefined()

			await expect(fs.access(historyFilePath(storagePath, "dup-deleted"))).rejects.toMatchObject({
				code: "ENOENT",
			})
			expect(storeInternals(store).cache.has("dup-deleted")).toBe(false)
			expect(store.get("dup-deleted")).toBeUndefined()
			// One write-through for a batch that removed one file.
			expect(onWrite).toHaveBeenCalledTimes(1)
		})

		it("names a duplicate id once when every attempt of it failed", async () => {
			// Both attempts fail the same way: a live lock stands, the named path is absent, and the
			// retry inside the certification refuses it, so the deletion is blocked twice. The ids the
			// error carries are the list of tasks the caller must keep, and the reason string is what a
			// human reads: one id named once is enough to act on.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "dup-failed" }))
			onWrite.mockClear()
			const taskPath = historyFilePath(storagePath, "dup-failed")
			const lockDir = (await canonicalKey(taskPath)) + ".lock"
			// The lock directory proper-lockfile makes, kept young so the retry refuses it for the
			// reason production would.
			await actualFs.mkdir(lockDir)
			await actualFs.rm(taskPath)
			vi.mocked(withFileLock).mockImplementation(() =>
				Promise.reject(Object.assign(new Error("EEXIST: file already exists, mkdir"), { code: "EEXIST" })),
			)
			let failure: unknown
			try {
				failure = await store
					.deleteMany(["dup-failed", "dup-failed"])
					.then(() => null)
					.catch((error: unknown) => error)
			} finally {
				await actualFs.rm(lockDir, { recursive: true, force: true })
			}
			expect(failure).toBeInstanceOf(TaskHistoryDeleteError)
			expect((failure as TaskHistoryDeleteError).taskIds).toEqual(["dup-failed"])
			expect(String((failure as TaskHistoryDeleteError).reason).split("dup-failed:").length - 1).toBe(1)
			expect(storeInternals(store).cache.has("dup-failed")).toBe(true)
			expect(onWrite).not.toHaveBeenCalled()
		})
	})
})
