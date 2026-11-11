import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { execFile } from "child_process"

import { resolveRealPath } from "../../utils/WorkspacePathResolver"

/**
 * Options for safeWriteText atomic text publish primitive.
 */
export interface SafeWriteTextOptions {
	/**
	 * Platform override for testing.  When omitted the real process.platform
	 * value is used.  Set to "win32" or "linux" / "darwin" from tests so that
	 * both branches are reachable without needing a real Windows runner.
	 */
	platform?: string

	/**
	 * Custom execFile runner for testing (e.g. vi.fn).  When omitted the real
	 * child_process.execFile is used.
	 */
	execFileRunner?: typeof execFile

	/**
	 * Pre-written temp path to use for the commit phase.  When provided,
	 * safeWriteText skips creating its own staging file and uses this path
	 * instead (it still fsyncs before rename).  Useful when a caller has
	 * already written data to a temp file via a custom stream.
	 */
	tempPath?: string

	/**
	 * Authorized publish root. When set, a requested path that resolves lexically
	 * inside this root must also publish inside it: a symlink or dangling link whose
	 * referent escapes the root is rejected before anything is created or written,
	 * so an approval that covered the inside path can never be spent on an outside
	 * target. Requested paths that are themselves outside the root are not
	 * constrained here - the caller's own approval flow governs those.
	 */
	authorizedRoot?: string
}

// -- helpers ---------------------------------------------------------------

/** Generate a unique temp file name in the given directory. */
function _tempName(dir: string, prefix: string): string {
	return path.join(dir, "." + prefix + "_" + Date.now() + "_" + Math.random().toString(36).substring(2) + ".tmp")
}

/** Sharing errors that clear on their own when the target is held open. */
const _TRANSIENT_RENAME_CODES = ["EPERM", "EACCES", "EBUSY"]
// Bounded so a permanently locked target still fails fast: 5 retries back off to
// 320ms, for a worst case of ~620ms added to a save.
const _RENAME_RETRY_ATTEMPTS = 5
const _RENAME_RETRY_BASE_MS = 20

/** Error raised when the staging path cannot be trusted. */
class UnsafeStagingDirectoryError extends Error {
	constructor(stagingPath: string, reason: string) {
		super(`Refusing to stage in ${stagingPath}: ${reason}`)
		this.name = "UnsafeStagingDirectoryError"
	}
}

/**
 * Raised when the commit rename landed but the parent-directory fsync failed.
 * The new content is in place; what is unconfirmed is that the directory entry
 * survives a crash, so callers must not treat the publish as durable.
 */
/**
 * The target exists but its DACL could not be captured, so publishing would replace its security
 * descriptor with inherited permissions and no record would exist to restore it from. Thrown
 * before the commit rename; the target is left untouched.
 */
export class DaclCaptureError extends Error {
	constructor(
		public readonly targetPath: string,
		public readonly dumpPath: string,
	) {
		super(
			`safeWriteText: refusing to publish ${targetPath}: its DACL could not be captured (no icacls dump was written at ${dumpPath}). No change was made to the target.`,
		)
		this.name = "DaclCaptureError"
	}
}

export class PublishNotDurableError extends Error {
	constructor(targetPath: string, reason: string) {
		super(`Published ${targetPath} but could not confirm it is durable: ${reason}`)
		this.name = "PublishNotDurableError"
	}
}

/**
 * The content is committed but a captured DACL could not be put back on it, so the file at the
 * target answers to different access rights than the one it replaced. Raised after the commit
 * rename, so the content is at the target.
 *
 * A host that cannot restore DACLs at all (icacls /restore exits 1300 because the process lacks
 * the backup/restore privilege) is treated as a logged host limitation instead: the content is
 * committed and no retry can fix the capability, so failing every overwrite there would break
 * ordinary saves without changing the outcome. Only restore failures that a retry or a caller
 * could address are raised as this error.
 */
export class DaclRestoreError extends Error {
	constructor(
		public readonly targetPath: string,
		public readonly causeError: unknown,
		reason: string = "its saved access rights could not be restored",
	) {
		super(`safeWriteText: content committed at ${targetPath}, but ${reason}`)
		this.name = "DaclRestoreError"
	}
}

/**
 * True when the atomic rename already committed the content even though the publish reported
 * an error: the directory entry is not confirmed durable, or the saved DACL could not be put
 * back. Callers must treat the write as committed (update their in-memory state and never retry
 * the content), while still surfacing the unconfirmed durability/access-rights condition.
 */
export function isPublishCommittedError(error: unknown): error is PublishNotDurableError | DaclRestoreError {
	return error instanceof PublishNotDurableError || error instanceof DaclRestoreError
}

function _errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as { code?: string }).code
		: undefined
}

/** Create a private per-write staging sub-directory inside *dir*. The name is
 * generated here, the way the temp file inside it is named, so concurrent writes
 * never collide on their temp names and never release a directory another write
 * is still using. */
function _stagingDir(dir: string): string {
	// A shared fixed name is a path the workspace controls: mkdirSync with
	// recursive:true accepts an existing entry of that name without creating
	// anything, so a committed .file-safety-staging symlink would have the chmod
	// below repair the permissions of a directory outside the workspace and put
	// the staged file in it. A name this call generated cannot be pre-planted.
	const sd = path.join(dir, ".file-safety-staging_" + Date.now() + "_" + Math.random().toString(36).substring(2))
	// The name is this call's, the entry at it still has to be checked: a colliding
	// or swapped-in path would stage - and then publish - outside the target
	// directory. Anything that is not a real directory owned by this process is
	// rejected instead of used.
	let preExisted = false
	try {
		const existing = fsSync.lstatSync(sd)
		preExisted = true
		if (!existing.isDirectory()) {
			throw new UnsafeStagingDirectoryError(sd, "it exists and is not a directory")
		}
	} catch (error: unknown) {
		if (error instanceof UnsafeStagingDirectoryError) throw error
		if (_errorCode(error) !== "ENOENT") throw error
	}
	// A directory this call created but never hands to the caller would sit in the user's
	// target directory forever - the caller never receives the path, so nothing else can
	// clean it up. A pre-existing staging directory is left alone: it may belong to a
	// concurrent write.
	function _abandonIfCreated(): void {
		if (!preExisted) {
			try {
				fsSync.rmdirSync(sd)
			} catch {
				// not empty or already gone: there is nothing else this call can do
			}
		}
	}
	// mode:0o700 protects a freshly created staging dir; the best-effort chmod
	// repairs a pre-existing one (mkdirSync with recursive:true never chmods an
	// existing directory), so staged temp files are never group/world readable.
	fsSync.mkdirSync(sd, { recursive: true, mode: 0o700 })
	// Re-check after the create: the path can be swapped for a symlink between the
	// check above and mkdirSync.
	let created: fsSync.Stats
	try {
		created = fsSync.lstatSync(sd)
	} catch (error: unknown) {
		// The directory exists at this point and this call may have just created it. Letting the
		// probe error propagate would strand it: the caller never receives the path, so nothing
		// else can remove it. Abandon first, then rethrow the original error.
		_abandonIfCreated()
		throw error
	}
	if (!created.isDirectory()) {
		_abandonIfCreated()
		throw new UnsafeStagingDirectoryError(sd, "it was replaced by a non-directory")
	}
	if (typeof process.getuid === "function" && created.uid !== process.getuid()) {
		_abandonIfCreated()
		throw new UnsafeStagingDirectoryError(sd, "it is not owned by this process")
	}
	try {
		fsSync.chmodSync(sd, 0o700)
	} catch {
		// best-effort: chmod denied or unavailable; a fresh dir was still
		// created with the requested mode
	}
	return sd
}

/**
 * fsync a file descriptor so its data is durable before the atomic rename.
 *
 * The async fsync form runs the same syscall on libuv's thread pool instead of blocking the
 * extension host event loop (this is also what FileHandle.sync() uses internally). The staging
 * write and fchmod stay synchronous because they are bounded and need the descriptor the sync
 * open produced; only the durability barrier - the part the review measured at ~7 ms - is moved
 * off the event loop. Any fsync error still rejects the publish before the rename.
 */
function _fsyncFile(fd: number): Promise<void> {
	return new Promise((resolve, reject) => {
		fsSync.fsync(fd, (error) => (error ? reject(error) : resolve()))
	})
}

/**
 * Keep the existing target's group on the staged file before it is published.
 *
 * The commit is a rename, so the published inode is a new one: it takes the process's
 * primary group (or the directory's gid when the directory is setgid). A shared 0o664
 * file owned by group `devs` would therefore lose group write access for every member
 * whose primary group is not `devs`, even though the fchmod below restores the mode - the
 * mode fix exists precisely to stop that regression, so the group has to survive too.
 *
 * Best-effort: fchown only succeeds when this process belongs to that group, which is the
 * case that matters; anywhere else the mode fix still stands. It runs BEFORE fchmod
 * because chown can clear the setgid bits that chmod has just set. Windows carries no
 * POSIX gid to preserve - its identity is the DACL, handled by the save/restore steps.
 */
function _applyTargetOwnership(fd: number, gid: number | undefined, platform: string): void {
	if (platform === "win32" || typeof gid !== "number") {
		return
	}
	try {
		fsSync.fchownSync(fd, -1, gid)
	} catch {
		// Not a member of the target's group: keep the mode preservation and move on.
	}
}

/** Save the DACL of *srcPath* to a dump file on Windows.
 * Returns true when a usable dump exists; false otherwise.
 * Never throws - a false return means no usable dump was produced, which the caller treats
 * as "the security descriptor cannot be preserved" and fails closed before publishing. */
async function _saveDaclWindows(srcPath: string, dumpPath: string, execFileRunner?: typeof execFile): Promise<boolean> {
	const runner = execFileRunner ?? execFile
	try {
		await new Promise<void>((resolve, reject) => {
			// No /T: with a file path, /T makes icacls walk the whole directory tree and save every
			// file that shares the name (a save of <root>\package.json also walks node_modules),
			// and the matching /restore then rewrites the DACL of every one of those files rather
			// than only the target's. An inaccessible subdirectory can also make /save exit
			// non-zero, leaving the fail-closed check to depend on a dump that may not contain the
			// target's own entry.
			runner("icacls", [srcPath, "/save", dumpPath], { windowsHide: true }, (err) =>
				err ? reject(err) : resolve(),
			)
		})
		return _dumpIsUsable(dumpPath)
	} catch {
		// icacls can exit non-zero while still writing a usable dump (measured on a normal host), so
		// judge the capture by the artifact, not only by the exit code: a non-empty dump is a capture.
		try {
			return _dumpIsUsable(dumpPath)
		} catch {
			return false
		}
	}
}

// A DACL dump is only usable if it is actually there, is a regular file, and has bytes in it.
// Both the success and the failure callback have to be judged by this: icacls can exit 0 without
// writing anything (measured on a host where the target's owner differs from the caller), and a
// zero-byte dump restores nothing - so trusting the exit code alone would let the commit rename
// destroy a security descriptor that was never captured.
function _dumpIsUsable(dumpPath: string): boolean {
	try {
		const st = fsSync.statSync(dumpPath)
		return st.isFile() && st.size > 0
	} catch {
		return false
	}
}

/** Restore a DACL dump onto *dirPath* on Windows.
 * `restored` reports whether icacls succeeded; the caller decides whether a lost DACL is
 * tolerable. `privilegeUnavailable` separates the one failure that will never fix itself
 * from a transient one: on a non-elevated host /restore always exits 1300 (measured), so
 * retrying it on every later write costs three process spawns per write for a DACL that
 * cannot be restored. A transient failure must not disable preservation for the process. */
async function _restoreDaclWindows(
	dirPath: string,
	dumpPath: string,
	execFileRunner?: typeof execFile,
): Promise<{ restored: boolean; privilegeUnavailable: boolean }> {
	const runner = execFileRunner ?? execFile
	try {
		await new Promise<void>((resolve, reject) => {
			runner("icacls", [dirPath, "/restore", dumpPath], { windowsHide: true }, (err) =>
				err ? reject(err) : resolve(),
			)
		})
		return { restored: true, privilegeUnavailable: false }
	} catch (error: unknown) {
		// execFile reports a non-zero exit as an error carrying that exit code.
		const code =
			error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
		return { restored: false, privilegeUnavailable: code === _ICACLS_PRIVILEGE_EXIT_CODE }
	}
}

// Set once a restore has failed with the missing-privilege exit code: from then on the
// process skips the save/restore pair instead of paying for it on every write and warning
// about the same host limitation each time. Skipping the pair is a cost decision only: it
// must not change what a publish reports. A later write that replaces an existing target
// still loses that target's descriptor, so step 2b records it and the call reports the
// condition instead of resolving quietly. The reason is logged once, when the memo is set.
let daclRestorePrivilegeUnavailable = false

// icacls exit code for "a required privilege is not held by the client".
const _ICACLS_PRIVILEGE_EXIT_CODE = 1300

// -- public API ------------------------------------------------------------

/**
 * Atomic text publish primitive.
 *
 * 1. Write content to a temp file in a private per-write staging subdir
 *    (same volume -> atomic rename guaranteed).
 * 2. fsync the temp file, then close it.
 * 3. win32 only: if target exists save its DACL dump BEFORE the commit rename.
 * 4. Atomic rename temp -> target.
 * 5. win32 only: restore DACL onto the directory AFTER commit rename.
 * 6. On success: unlink DACL dump.
 * 7. On failure: clean up temp + dump (the target was never moved).
 */

/**
 * Resolve the publish target: the symlink referent when the given path is an
 * existing symlink, the path itself otherwise. A dangling symlink is followed to
 * its referent too (renaming onto the link path would replace the link), and only
 * a path that neither exists nor is a link falls back to the given path. Any other
 * resolution error (EACCES, EIO, ELOOP, ...) propagates so a broken or unreadable
 * symlink is never written through its link path. Callers that stage a temp file
 * themselves must stage it beside the resolved path: the commit is a rename onto
 * the referent, and a rename across filesystems fails with EXDEV.
 */
export async function resolvePublishTarget(
	absoluteFilePath: string,
	visitedLinks: Set<string> = new Set(),
): Promise<string> {
	try {
		return await fs.realpath(absoluteFilePath)
	} catch (error: unknown) {
		if (_errorCode(error) !== "ENOENT") throw error
		// realpath reports ENOENT for a dangling symlink as well as for a missing path.
		// Renaming onto the link path would replace the link with a regular file, so follow
		// the link text to its referent instead; a link cycle surfaces as ELOOP and still
		// propagates, so the recursion is bounded.
		// Only ENOENT means "there is nothing here that could be a link". Any other lstat error
		// (EACCES, EIO, ...) must propagate: treating "could not inspect" as "not a link" would let
		// a write land on the link path and replace the link, which is exactly what this resolver
		// exists to prevent - and the doc comment above already promises that it propagates.
		let link: Awaited<ReturnType<typeof fs.lstat>> | null = null
		try {
			link = await fs.lstat(absoluteFilePath)
		} catch (statError: unknown) {
			if (_errorCode(statError) !== "ENOENT") {
				throw statError
			}
		}
		if (link?.isSymbolicLink()) {
			const linkText = await fs.readlink(absoluteFilePath)
			if (visitedLinks.has(absoluteFilePath)) {
				const loopError = new Error(`Symlink loop while resolving publish target ${absoluteFilePath}`)
				;(loopError as NodeJS.ErrnoException).code = "ELOOP"
				throw loopError
			}
			visitedLinks.add(absoluteFilePath)
			return resolvePublishTarget(path.resolve(path.dirname(absoluteFilePath), linkText), visitedLinks)
		}
		return absoluteFilePath
	}
}

/** Lexical containment: true when target sits at or under root. */
function _isWithinRoot(root: string, target: string): boolean {
	const rel = path.relative(root, target)
	// A leading ".." is an escape only as a full segment: a sibling entry
	// may legitimately be named "..config", and path.relative reports it bare.
	return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
}

/**
 * Canonicalize a path that may not exist yet: resolve the nearest existing
 * ancestor and re-append the missing tail. A dangling final component under
 * a symlinked parent directory would otherwise look inside the root
 * lexically while the write lands wherever the parent link points.
 */
async function _realpathNearestExisting(targetPath: string): Promise<string> {
	// Same walk as WorkspacePathResolver.resolveRealPath, with case folding off: the result is
	// compared against the authorized root and used for publish decisions, so the on-disk case
	// must be preserved and a non-ENOENT error must fail closed (both provided by the helper).
	return resolveRealPath(targetPath, { caseFold: false })
}
/**
 * Refuse a publish whose retained target escaped the caller's authorized root
 * while the requested path sat inside it: the tool layer approved the inside
 * path, so an escape here (a symlink or dangling link pointing outside the
 * workspace) would land bytes the approval never covered outside the root, and
 * the parent-directory mkdir below would happily create the outside parent
 * first. A requested path that is itself outside the root is left alone - the
 * caller's own approval flow covers outside-root writes, and this primitive has
 * no opinion about a root it was not asked to enforce.
 */
export async function assertPublishWithinAuthorizedRoot(
	authorizedRoot: string,
	requestedPath: string,
	targetPath: string,
): Promise<void> {
	let root: string
	try {
		root = await fs.realpath(authorizedRoot)
	} catch (error: unknown) {
		// ENOENT falls back to the lexical root: the root may be created by this
		// very write's mkdir below. Any other inspection error propagates rather
		// than silently skipping the boundary.
		if (_errorCode(error) !== "ENOENT") {
			throw error
		}
		root = path.resolve(authorizedRoot)
	}
	// A workspace opened through a symlink (e.g. /tmp/ws -> /private/tmp/ws)
	// makes every inside path look outside the canonicalized root, which
	// would skip the check exactly where it matters. Match both the canonical
	// and the lexical root: an inside request is one that sits under either,
	// and an inside target is one that sits under either.
	const lexicalRoot = path.resolve(authorizedRoot)
	const roots = lexicalRoot === root ? [root] : [root, lexicalRoot]
	const requestedInside = roots.some((candidate) => _isWithinRoot(candidate, requestedPath))
	// The retained target may still sit under a symlinked parent directory:
	// resolve the nearest existing ancestor so the inside test sees where the
	// bytes actually land, not just where the name lexically sits.
	const effectiveTarget = await _realpathNearestExisting(targetPath)
	const targetInside = roots.some((candidate) => _isWithinRoot(candidate, effectiveTarget))
	if (requestedInside && !targetInside) {
		throw new Error(
			`safeWriteText: refusing to publish ${targetPath}: the requested path ${requestedPath} is inside the authorized root ${root} but the resolved publish target is not. Nothing was written.`,
		)
	}
}

export async function safeWriteText(filePath: string, content: string, options?: SafeWriteTextOptions): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)

	// Resolve the symlink referent (see resolvePublishTarget).
	const targetPath = await resolvePublishTarget(absoluteFilePath)

	// Enforce the caller's authorized root before anything is created or written
	// (the mkdir below can otherwise materialize an outside parent first).
	if (options?.authorizedRoot !== undefined) {
		await assertPublishWithinAuthorizedRoot(options.authorizedRoot, absoluteFilePath, targetPath)
	}

	const dirPath = path.dirname(targetPath)

	// Ensure parent directory exists (mirrors safeWriteJson behaviour).
	await fs.mkdir(dirPath, { recursive: true })
	await fs.access(dirPath)

	// Create the staging directory only when we generate the temp file there;
	// callers supplying their own tempPath (e.g. safeWriteJson) must not be left
	// with an empty .file-safety-staging directory behind.
	const stagingDir = options?.tempPath ? null : _stagingDir(dirPath)
	const tempPath = options?.tempPath ?? _tempName(stagingDir ?? dirPath, "safeWriteText")

	// The staging sub-directory only exists to hold this write's temp file, so it is
	// removed once the write is over. rmdir fails with ENOTEMPTY while another write
	// still stages here, which is exactly the concurrency guard wanted.
	async function _releaseStagingDir(): Promise<void> {
		if (stagingDir === null) return
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await fs.rmdir(stagingDir)
				return
			} catch (error: unknown) {
				const code = _errorCode(error)
				// ENOENT: another writer already removed it. ENOTEMPTY: a concurrent write is still
				// staging here, which is the concurrency guard this directory exists for. Both are
				// benign - no retry, no warning.
				if (code === "ENOENT" || code === "ENOTEMPTY") return
				// Anything else (EBUSY, EPERM, EACCES, ...) is transient here: retry once, then
				// surface the retained directory. A leftover staging directory is acceptable, an
				// invisible one is not.
				if (attempt === 1) {
					console.warn(
						`safeWriteText: staging directory release failed: ${stagingDir} (${code ?? String(error)})`,
					)
				}
			}
		}
	}

	// Set when the commit landed but its durability could not be confirmed. The
	// content is in place, so there is nothing to roll back, but the caller must
	// not be told the publish is durable.
	let durabilityError: unknown = null
	// Set when the commit landed but the saved DACL could not be put back on the published file.
	// The content is in place, so there is nothing to roll back, but the caller must not observe a
	// success whose access rights changed.
	let daclRestoreError: DaclRestoreError | null = null
	let daclDumpPath: string | null = null // tracked for cleanup in finally
	let daclSaved = false // restore step runs only when the save succeeded

	const platform = options?.platform ?? process.platform

	try {
		// -- Step 1: write content to staging temp file -------------------
		if (!options?.tempPath) {
			// Preserve the existing target's permissions: the staging file must
			// not be published wider than the file it replaces (a 0o600 target
			// must not become 0o644 through the atomic rename).
			let targetMode = 0o644 // default for a fresh target
			let targetGid: number | undefined
			let targetExists = false
			try {
				const targetStats = fsSync.statSync(targetPath)
				targetMode = targetStats.mode & 0o777
				targetGid = targetStats.gid
				targetExists = true
			} catch (error: unknown) {
				// Only a genuinely absent target may take the default mode. Any other
				// stat failure leaves the real mode unknown, and publishing with the
				// default could widen a restrictive file, so the write does not proceed.
				if (_errorCode(error) !== "ENOENT") throw error
			}
			let fd: number
			try {
				fd = fsSync.openSync(tempPath, "w", targetMode)
			} catch (error: unknown) {
				// The staging directory belongs to this write alone, but its release is
				// best-effort and retried, so a lingering release can still race this open.
				// Recreate the same path - a fresh random name would not contain tempPath,
				// the reopen would fail again on a real filesystem, and the new directory
				// would be orphaned - and verify it is a real directory before reopening.
				// Any other errno, or a second ENOENT, is a real failure.
				if (_errorCode(error) !== "ENOENT" || stagingDir === null) throw error
				fsSync.mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
				if (!fsSync.lstatSync(stagingDir).isDirectory()) {
					throw new UnsafeStagingDirectoryError(stagingDir, "it exists and is not a directory")
				}
				fd = fsSync.openSync(tempPath, "w", targetMode)
			}
			// The creation mode handed to openSync is masked by the process umask: an existing
			// 0o664 target would be published as 0o644 and a shared repository would lose group
			// write access on every save. Apply the exact target mode on the descriptor, which is
			// also what the caller-staged branch below does.
			try {
				if (targetExists) {
					_applyTargetOwnership(fd, targetGid, platform)
					fsSync.fchmodSync(fd, targetMode)
				}
				// Loop until every byte is written: writeSync can report a short
				// (partial) write, and publishing a truncated staging file would
				// commit corrupt content.
				const buffer = Buffer.from(content, "utf8")
				let offset = 0
				while (offset < buffer.length) {
					offset += fsSync.writeSync(fd, buffer, offset, buffer.length - offset)
				}
				await _fsyncFile(fd)
			} finally {
				fsSync.closeSync(fd)
			}
		} else {
			// Preserve the existing target's mode (CWE-732): the caller-staged
			// temp carries its own creation mode, and publishing it as-is would
			// widen a restrictive target (e.g. 0o600 -> 0o644) through rename.
			// The mode is applied with fchmodSync on the open fd (AFTER openSync):
			// chmodSync on the path before the open would make a read-only target
			// (0o400/0o444) fail openSync(tempPath, "r+") with EACCES.
			let targetMode: number | null = null
			let targetGid: number | undefined
			try {
				const targetStats = fsSync.statSync(targetPath)
				targetMode = targetStats.mode & 0o777
				targetGid = targetStats.gid
			} catch (error: unknown) {
				// As above: an unknown target mode must not be replaced by the temp's
				// own creation mode, which can be wider than the target's.
				if (_errorCode(error) !== "ENOENT") throw error
			}
			const fd = fsSync.openSync(tempPath, "r+")
			try {
				if (targetMode !== null) {
					_applyTargetOwnership(fd, targetGid, platform)
					fsSync.fchmodSync(fd, targetMode)
				}
				await _fsyncFile(fd)
			} finally {
				fsSync.closeSync(fd)
			}
		}

		// -- Step 2 (win32): save DACL BEFORE the commit rename -----------
		// Once a restore has proven this host cannot restore at all, saving a dump it cannot
		// apply is three process spawns per write for nothing, so the pair is skipped. The
		// skip is decided here, not in step 5, because the save is the expensive half.
		if (platform === "win32" && !daclRestorePrivilegeUnavailable) {
			try {
				await fs.access(targetPath) // target exists?
				// Unique per call: two concurrent writes to the same target must not share one dump,
				// where one call can unlink or overwrite the file the other is still using. Kept in the
				// target directory, not the staging dir, so a write that never stages a temp file still
				// leaves no extra directory behind.
				daclDumpPath = _tempName(dirPath, "safeWriteText.acl.tmp")
				const saved = await _saveDaclWindows(targetPath, daclDumpPath, options?.execFileRunner)
				if (!saved) {
					// Fail closed. Publishing without a captured DACL replaces the target's security
					// descriptor with whatever the parent directory inherits, and no later step can put the
					// original back. icacls /save does not need the backup/restore privileges that /restore
					// does (measured: /restore exits 1300 un-elevated), so refusing here does not break
					// ordinary hosts - it removes the exposure instead of accepting it. The staging file,
					// the dump is cleaned by the rollback below.
					daclSaved = false
					// This throw leaves the try/finally that owns cleanup, so release the artifacts here:
					// the staged file and the (unusable) dump must not be orphaned. Removal is retried once
					// and a retained path is reported rather than suppressed.
					const abortArtifacts: Array<string | null> = [
						daclDumpPath,
						options?.tempPath ? null : tempPath, // a caller-supplied temp belongs to the caller
					]
					for (const artifact of abortArtifacts) {
						if (!artifact) {
							continue
						}
						let removed = false
						for (let attempt = 0; attempt < 2 && !removed; attempt++) {
							try {
								await fs.unlink(artifact)
								removed = true
							} catch {
								// retry once, then report
							}
						}
						if (!removed) {
							console.warn(
								`safeWriteText: aborted before publishing and could not remove ${artifact}; it is retained and must be cleaned up out of band.`,
							)
						}
					}
					throw new DaclCaptureError(targetPath, daclDumpPath)
				} else {
					daclSaved = true
				}
			} catch (err: unknown) {
				if (err instanceof DaclCaptureError) {
					// Not an access probe failure: the target exists and its DACL could not be captured.
					throw err
				}

				// Only ENOENT means "there is no target, so there is no DACL to preserve". EACCES or any
				// other probe error says nothing about the target's security descriptor, and publishing
				// over a target we could not inspect would replace it without a captured DACL.
				const probeCode =
					err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined
				if (probeCode !== "ENOENT") {
					throw err
				}
				daclDumpPath = null
			}
		}

		try {
			// -- Step 3: atomic rename temp -> target ---------------------
			// On Windows the rename can be rejected while another process holds the
			// target without FILE_SHARE_DELETE. The previous fs.writeFile path tolerated
			// that, so retry a bounded number of times before failing.
			for (let attempt = 0; ; attempt++) {
				try {
					await fs.rename(tempPath, targetPath)
					break
				} catch (error: unknown) {
					const transient =
						platform === "win32" &&
						attempt < _RENAME_RETRY_ATTEMPTS &&
						_TRANSIENT_RENAME_CODES.includes(_errorCode(error) ?? "")
					if (!transient) throw error
					await new Promise((resolve) => setTimeout(resolve, _RENAME_RETRY_BASE_MS * 2 ** attempt))
				}
			}

			// -- Step 4b (POSIX): fsync the parent directory so the directory entry
			// changed by the commit rename is durable, not just the file content.
			if (platform !== "win32") {
				try {
					const dirFd = fsSync.openSync(dirPath, "r")
					try {
						await _fsyncFile(dirFd)
					} finally {
						fsSync.closeSync(dirFd)
					}
				} catch (error: unknown) {
					// The rename committed, so the content is in place and there is nothing to
					// roll back, but the directory entry is not confirmed durable. Record it so
					// the call fails and the publish is reported as not durable.
					durabilityError = error
				}
			}

			// -- Step 5 (win32): restore DACL AFTER commit rename ---------
			if (platform === "win32" && daclSaved && daclDumpPath !== null) {
				const restoredDir = path.dirname(targetPath)
				let attempt = await _restoreDaclWindows(restoredDir, daclDumpPath, options?.execFileRunner)
				if (!attempt.restored && !attempt.privilegeUnavailable) {
					// One retry, and only for a failure that could be transient: icacls can fail
					// while another process still holds the just-renamed file open. A host without
					// the privilege fails identically every time, so retrying it is pure cost.
					attempt = await _restoreDaclWindows(restoredDir, daclDumpPath, options?.execFileRunner)
				}
				if (!attempt.restored) {
					// A host without the backup/restore privilege cannot do better: no retry
					// grants a privilege mid-process, and the content is already committed. Warn
					// once, memo the limitation, and let the publish succeed - failing every
					// overwrite on such a host would break ordinary saves without changing the
					// access rights. Non-privilege restore failures stay errors: those are the
					// failures a caller or a later retry could actually address.
					if (attempt.privilegeUnavailable) {
						if (!daclRestorePrivilegeUnavailable) {
							daclRestorePrivilegeUnavailable = true
							console.warn(
								"safeWriteText: this host cannot restore DACLs (icacls /restore reports a missing privilege); the published content keeps the access rights inherited from its directory, and later writes in this process skip saving and restoring them.",
							)
						}
					} else {
						// The content is committed, but the published file answers to a different
						// DACL than the one that was saved, and nothing here verified an equivalent
						// restrictive ACL on the replacement. Reported as an error rather than a
						// warning: a publish that changed who can read the file must not look like
						// an ordinary successful save. Thrown after the rollback handler below - the
						// content is committed, so this is not a failure to roll back.
						daclRestoreError = new DaclRestoreError(targetPath, null)
					}
				}
			}
		} finally {
			// Unlink DACL dump regardless of success/failure in this span.
			if (daclDumpPath !== null) {
				try {
					await fs.unlink(daclDumpPath)
				} catch {
					// One bounded retry, then surface the path: an icacls dump left next to the
					// settings file is a readable copy of its ACL, so an invisible orphan is worse
					// than a visible one.
					try {
						await fs.unlink(daclDumpPath)
					} catch (cleanupError: unknown) {
						console.warn(
							`safeWriteText: the DACL dump at ${daclDumpPath} could not be removed (${String(cleanupError)}); it is left in place.`,
						)
					}
				}
			}
		}

		// tempPath is now the committed file; no cleanup needed.
	} catch (originalError: unknown) {
		// -- Rollback / cleanup on failure ----------------------------------
		// Always clean up the staging temp file on failure. A single swallowed unlink is not enough:
		// a transient EBUSY/EPERM would silently leave the temp inside the staging directory, and nothing
		// would ever report the retained path. Bounded retry, same shape as the DACL cleanup.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await fs.unlink(tempPath)
				break
			} catch (cleanupError: unknown) {
				const code = _errorCode(cleanupError)
				if (code === "ENOENT") {
					break
				}
				if (attempt === 1) {
					console.warn(
						`safeWriteText: staging temp release failed: ${tempPath} (${code ?? String(cleanupError)})`,
					)
				}
			}
		}

		if (daclDumpPath !== null) {
			await fs.unlink(daclDumpPath).catch(() => {})
		}

		await _releaseStagingDir()

		throw originalError
	}

	await _releaseStagingDir()

	// Raised outside the rollback handler on purpose: the content is committed, so
	// this is not a failure to roll back.
	if (durabilityError !== null) {
		const reason = durabilityError instanceof Error ? durabilityError.message : String(durabilityError)
		throw new PublishNotDurableError(targetPath, reason)
	}

	// Raised outside the rollback handler for the same reason as PublishNotDurableError: the
	// content is committed, so this is not a failure to roll back. A restore
	// failure therefore reaches the caller as its own error: no caller can observe success for a
	// publish whose DACL was not restored.
	if (daclRestoreError !== null) {
		throw daclRestoreError
	}
}

// -- atomic publish contract, exported under its own name; identifiers renamed in code positions only, string literals and the durability import block untouched --
import { getErrorCode } from "../../utils/errorCode"

export interface SafeWriteTextAtomicOptions {
	/**
	 *
	 * When true, keep a durable copy of the previous content at a sibling
	 * safeWriteTextAtomic.bak_* file for the duration of the write: the target is copied
	 * before the commit rename and the copy is removed after it. The copy is never
	 * a rollback source - nothing is restored on failure, because the copy never
	 * displaced the target: before the commit the target still holds its previous
	 * content, and after it the target holds the new content and this call removes
	 * the copy. A removal that fails AFTER the commit reports OrphanedPublishedBackupError
	 * and leaves the new content at the target: nothing is rolled back, because rolling back
	 * would replace published bytes with an older copy the caller never asked to restore. A
	 * removal that fails after a write that never committed reports
	 * OrphanedBackupAfterFailedWriteError, whose contentPublished says which of the two
	 * happened. When false (default) the atomic rename simply replaces the target --
	 * crash-safe window is zero.
	 */
	backup?: boolean

	/**
	 * Platform override for testing.  When omitted the real process.platform
	 * value is used.  Set to "win32" or "linux" / "darwin" from tests so that
	 * both branches are reachable without needing a real Windows runner.
	 */
	platform?: string

	/**
	 * Custom execFile runner for testing (e.g. vi.fn).  When omitted the real
	 * child_process.execFile is used.
	 */
	execFileRunner?: typeof execFile

	/**
	 * Pre-written temp path to use for the commit phase.  When provided,
	 * safeWriteTextAtomic skips creating its own staging file and uses this path
	 * instead (it still fsyncs before rename).  Useful when a caller has
	 * already written data to a temp file via a custom stream.
	 */
	tempPath?: string

	/**
	 * Commit only if the target name does NOT exist at commit time.
	 * rename(2) has no no-replace form - it silently displaces a target that another
	 * writer created after the caller's absence check - so the commit is done with
	 * link(2) instead, which fails EEXIST for an existing name (and does not follow a
	 * symlink placed at that name). A conditional create therefore cannot overwrite a
	 * file it never saw.
	 */
	failIfExist?: boolean

	/**
	 * The publish target the caller already authorized.
	 * A caller that checks workspace containment and then calls this primitive resolves
	 * the path twice: once for its own decision and once here. If a link is swapped in
	 * between the two, the decision was about a different file than the one published.
	 * Passing the authorized value makes that drift fatal instead of silent.
	 */
	expectedResolvedPath?: string

	/**
	 * The directories the caller walked when it authorized this target, with the
	 * (dev, ino) identity each had at that moment.
	 *
	 * expectedResolvedPath pins the NAME this write publishes; it cannot see a parent
	 * directory being replaced by a link between the caller's containment check and the
	 * commit. Re-checking the ancestor identities immediately before the commit makes a
	 * swapped parent fatal too: the publish then aborts instead of writing through the new
	 * link. Node has no descriptor-relative rename, so a swap that lands after this check
	 * and before the rename is not eliminable here - it narrows the window to the commit
	 * itself rather than the whole guard.
	 * The identity check is paired with a realpath comparison: moving a directory
	 * preserves (dev, ino), and replacing its old name with a symlink to the moved
	 * location keeps stat() matching while sending the commit to the new location.
	 * The name must still resolve to the location it was authorized against - the
	 * recorded resolvedPath when the caller walked a symlink alias, and dir itself
	 * when it recorded a plain spelling - not merely to the same inode.
	 */
	expectedAncestorIdentities?: DirectoryIdentity[]
	/**
	 * A post-commit step failed while the content this call published stayed readable: either the staged name
	 * could not be removed after a no-replace commit, or the win32 DACL restore failed. The write
	 * resolves in both cases - failing it would report a failure for bytes the caller can now read
	 * back - and the residue is reported here instead of dropped. Kinds are spelled inline rather
	 * than exported: no production caller selects on them today, and an export whose only reader
	 * is a spec is dead API. Omitting the callback means this call chose not to hear: the residue is
	 * still where it was and the write still resolves, so the absence of a report is not evidence
	 * that there was none.
	 */
	onPostCommitWarning?: (warning: {
		kind: "staging-link-orphan" | "dacl-restore-failed"
		path: string
		cause: unknown
	}) => void
}

/** One directory's on-disk identity, read with bigint stats so NTFS 64-bit values survive. */
export type DirectoryIdentity = {
	dir: string
	dev: bigint
	ino: bigint
	/**
	 * Where `dir` resolved to when this identity was taken (its realpath).
	 *
	 * A caller that authorized a chain running THROUGH a symlink alias records the alias
	 * spelling as `dir`; that alias's realpath legitimately differs from `dir` while nothing
	 * moved, so comparing the current realpath against `dir` alone refuses a write whose
	 * ancestry never changed. The pre-commit revalidation compares against this value when it
	 * is present, and against `dir` when it is not.
	 */
	resolvedPath?: string
}

/**
 * The backup copy could not be created AND the partial copy could not be removed.
 * The write failed either way, but the leftover is a copy of the previous content that
 * is still on disk: its path travels on the error so the caller can remove it, instead
 * of the cleanup silently discarding the only reference to it.
 */
export class OrphanedBackupError extends Error {
	readonly orphanedBackupPath: string
	readonly originalError: unknown
	readonly cleanupError: unknown
	constructor(backupPath: string, targetPath: string, cause: unknown, cleanupError: unknown) {
		super(_orphanedBackupMessage(targetPath, backupPath, cause, cleanupError), { cause })
		this.name = "OrphanedBackupError"
		this.orphanedBackupPath = backupPath
		this.originalError = cause
		this.cleanupError = cleanupError
	}
}

/**
 * The write committed and the content is published, but the pre-write backup could not be
 * removed after two attempts (a transient handle - antivirus scanner, indexer - usually
 * causes this). Returning success would hide a stale copy of the previous content that
 * only a recovery tool can find, so the path travels on this error instead.
 */
export class OrphanedPublishedBackupError extends Error {
	readonly publishedPath: string
	readonly orphanedBackupPath: string
	readonly cleanupError: unknown

	constructor(targetPath: string, backupPath: string, cleanupError: unknown) {
		const reason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
		super(
			`safeWriteText: the content was published at ${targetPath}, but the pre-write copy at ${backupPath} ` +
				`could not be removed (${reason}). The copy is still on disk and should be removed by the caller or a recovery tool.`,
			{ cause: cleanupError },
		)
		this.name = "OrphanedPublishedBackupError"
		this.publishedPath = targetPath
		this.orphanedBackupPath = backupPath
		this.cleanupError = cleanupError
	}
}

/**
 * A write that is already failing left its complete backup copy on disk because removing it
 * failed twice. Reported separately from OrphanedPublishedBackupError, which says the write
 * SUCCEEDED and only the copy is leftover: here the write's own failure is the primary fact
 * and is kept as originalError (and as this error's cause), cleanupError says why the copy is
 * still there, and contentPublished says which of the two meanings the leftover has - a stale
 * copy beside published content, or a duplicate of the content the target still holds.
 */
export class OrphanedBackupAfterFailedWriteError extends Error {
	readonly targetPath: string
	readonly orphanedBackupPath: string
	readonly originalError: unknown
	readonly cleanupError: unknown
	readonly contentPublished: boolean

	constructor(
		targetPath: string,
		backupPath: string,
		cause: unknown,
		cleanupError: unknown,
		contentPublished: boolean,
	) {
		const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
		super(
			`safeWriteText: the write to ${targetPath} failed (${reason(cause)}), and the backup copy at ${backupPath} ` +
				`could not be removed (${reason(cleanupError)}). The copy of the previous content is still on disk; ` +
				(contentPublished
					? `the target holds the new content, so the copy is stale and must be removed.`
					: `the target still holds the previous content, so the copy duplicates it and must be removed.`),
			{ cause },
		)
		this.name = "OrphanedBackupAfterFailedWriteError"
		this.targetPath = targetPath
		this.orphanedBackupPath = backupPath
		this.originalError = cause
		this.cleanupError = cleanupError
		this.contentPublished = contentPublished
	}
}

function _orphanedBackupMessage(targetPath: string, backupPath: string, cause: unknown, cleanupError: unknown): string {
	const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
	return (
		`safeWriteText: could not create the backup of ${targetPath} (${reason(cause)}), and the ` +
		`partial copy at ${backupPath} could not be removed (${reason(cleanupError)}). The copy is ` +
		`still on disk and must be deleted.`
	)
}

/**
 * A caller-supplied staging path that is not a file this write may publish: it
 * sits outside the target's directory (so the commit rename would cross
 * filesystems) or is not a regular file. Rejecting it before any write keeps the
 * target from being replaced by whatever the path points at.
 */
export class StagingPathError extends Error {
	readonly stagingPath: string

	constructor(message: string, stagingPath: string) {
		super(message)
		this.name = "StagingPathError"
		this.stagingPath = stagingPath
	}
}

/**
 * The commit succeeded - a rename, or a hard link under failIfExist - but the parent-directory fsync did not, so the
 * directory entry is not known to be durable. The content is at the target; the
 * caller cannot assume it survives a crash. Reported as its own error so a
 * successful return never claims durability the filesystem did not grant.
 */
export class PostCommitDurabilityError extends Error {
	readonly targetPath: string

	constructor(targetPath: string, cause: unknown, copiedTargetFsync = false) {
		super(
			copiedTargetFsync
				? "The exclusive copy committed but the copied target could not be fsynced -- the content is at the target path reported on this error, and it may not survive a crash on a volume without hard links."
				: "The commit published the content but the parent directory could not be fsynced -- the content is at the target path reported on this error, and the directory entry may not be durable.",
			{ cause },
		)
		this.name = "PostCommitDurabilityError"
		this.targetPath = targetPath
	}
}

/**
 * The target exists but its access rights could not be inspected or saved, so publishing would
 * replace it with a file that inherits different rights. On Windows the publish is refused before
 * anything is committed: a save that silently widened who can read the file is not a save the
 * caller can trust, and nothing has been published yet, so the target still holds its content.
 * causeError carries the platform failure behind the refusal - the access check
 * error or the icacls error - so a caller can tell a command that ran and refused
 * from one that could not be started at all; it is the runner's own error, not a
 * summary of it.
 */
export class DaclInspectionError extends Error {
	constructor(
		readonly targetPath: string,
		readonly phase: "inspect" | "save",
		readonly causeError: unknown,
	) {
		const detail = phase === "save" ? "its DACL could not be saved" : "its access rights could not be checked"
		super(`safeWriteText: refusing to publish over ${targetPath} because ${detail}`)
		this.name = "DaclInspectionError"
	}
}

/**
 * A conditional create (failIfExist) found a target at commit time. The write is
 * refused without touching it: whatever is at the path was created by someone else
 * and stays exactly as it is.
 */
export class TargetExistsError extends Error {
	readonly targetPath: string
	constructor(targetPath: string) {
		super(`A file already exists at ${targetPath} -- the no-replace commit refused it.`)
		this.name = "TargetExistsError"
		this.targetPath = targetPath
	}
}

/**
 * A conditional create (failIfExist) found that the volume hosting the target has
 * no atomic no-replace primitive: link(2) reported that hard links do not exist
 * here, and publishing by copy would put bytes at the final name that readers can
 * observe mid-copy. Nothing is published - the write fails closed so a retry on a
 * capable volume (or a caller that accepts non-atomic publication) decides.
 */
export class UnsupportedFilesystemError extends Error {
	readonly targetPath: string
	constructor(targetPath: string, cause: unknown) {
		super(
			`Filesystem hosting ${targetPath} has no atomic no-replace commit primitive -- the guarded create refused to publish by copy.`,
			{ cause },
		)
		this.name = "UnsupportedFilesystemError"
		this.targetPath = targetPath
	}
}

/**
 * The path resolved to something other than the target the caller authorized.
 * Nothing is staged or published: a link swapped in after the caller's containment
 * check would otherwise send the write to a file that check never covered.
 */
export class TargetMovedError extends Error {
	readonly authorizedPath: string
	readonly resolvedPath: string
	constructor(authorizedPath: string, resolvedPath: string) {
		super(
			`The write was authorized for ${authorizedPath}, but that path now resolves to ${resolvedPath} -- nothing was published.`,
		)
		this.name = "TargetMovedError"
		this.authorizedPath = authorizedPath
		this.resolvedPath = resolvedPath
	}
}

/**
 * A directory the caller walked on its way to the authorized target is no longer the
 * directory it was: it was removed, replaced, or turned into a link to somewhere else.
 * Publishing through it would act on a decision that was never made about the file now
 * reachable there, so the commit is aborted.
 */
export class AncestorReplacedError extends Error {
	readonly directory: string
	constructor(directory: string, reason: string) {
		super(`A directory on the authorized path (${directory}) ${reason} -- nothing was published.`)
		this.name = "AncestorReplacedError"
		this.directory = directory
	}
}
/**
 * The target name does not hold the file this write staged.
 *
 * A third party replaced the staging file between the staging checks and link(2), so the name now
 * published is bytes this write never staged. Nothing is removed: after the link both names may
 * belong to somebody else, and an unlink by pathname can take away an entry this write does not
 * own. The two identities travel on the error because the only useful next step is comparing them.
 */
export class PublishedEntryMismatchError extends Error {
	readonly targetPath: string
	constructor(targetPath: string, publishedIdentity: string, stagedIdentity: string) {
		super(
			`The published entry (${targetPath}) is not the staged file (published ${publishedIdentity}, staged ${stagedIdentity}); both names were left in place.`,
		)
		this.name = "PublishedEntryMismatchError"
		this.targetPath = targetPath
	}
}
// -- helpers ---------------------------------------------------------------

/**
 * Reject an unauthorized parent BEFORE mkdir walks through it.
 *
 * mkdir(recursive:true) follows whatever parent chain the name currently resolves to, and the
 * step 2b revalidation below runs after it, so a parent swapped for a link to outside the
 * authorized chain gets created through before anything compares identities. Only an ancestor that
 * is already present is compared: an ENOENT here is a directory this call is about to create, not a
 * containment violation, and the recorded identity for it cannot be checked against nothing. Step
 * 2b stays in place: it is what catches a swap in the window between this check and the commit.
 */
async function _preflightAncestors(identities: DirectoryIdentity[] | undefined): Promise<void> {
	if (!identities) {
		return
	}
	for (const expected of identities) {
		const current = await fs.stat(expected.dir, { bigint: true }).catch((error: unknown) => {
			if (getErrorCode(error) === "ENOENT") {
				return null
			}
			throw error
		})
		if (current !== null && (current.dev !== expected.dev || current.ino !== expected.ino)) {
			throw new AncestorReplacedError(expected.dir, "is no longer the directory that was authorized")
		}
	}
}

/** fsync one directory so the entry it holds (a rename, or a newly created child) is durable. */
function _syncDirectory(dir: string): void {
	const dirFd = fsSync.openSync(dir, "r")
	try {
		fsSync.fsyncSync(dirFd)
	} finally {
		fsSync.closeSync(dirFd)
	}
}

/**
 * The directories *mkdir(recursive:true)* had to create for *dirPath*, outermost first.
 *
 * Node reports the outermost component it created - or nothing when the path already existed -
 * and that answer is the whole input, so no extra stat is needed to learn what appeared. The
 * commit rename only makes the entry INSIDE the immediate parent durable, and every newly
 * created directory is itself an entry in its own parent, so step 4b fsyncs this chain (deepest
 * first, after the immediate parent) and then the directory that first links it into the tree;
 * otherwise a crash can drop an ancestor and with it the published file.
 *
 * On Windows the reported path carries the extended-length namespace marker, which is stripped
 * so the chain compares in the spelling the write itself works in. An answer that is not on
 * this path yields nothing, rather than syncing directories this write cannot place.
 */
function _createdAncestorChain(createdRoot: string | undefined, dirPath: string): string[] {
	if (typeof createdRoot !== "string") return []
	const namespacePrefix = "\\\\?\\"
	const unprefixed = createdRoot.startsWith(namespacePrefix) ? createdRoot.slice(namespacePrefix.length) : createdRoot
	const root = path.resolve(unprefixed)
	const chain: string[] = []
	let cursor = dirPath
	for (;;) {
		chain.push(cursor)
		if (cursor === root) return chain.reverse()
		const parent = path.dirname(cursor)
		if (parent === cursor) return []
		cursor = parent
	}
}

/** Generate a unique temp file name in the given directory. */
function _atomicTempName(dir: string, prefix: string): string {
	return path.join(dir, "." + prefix + "_" + Date.now() + "_" + Math.random().toString(36).substring(2) + ".tmp")
}

/** Create a private per-write staging sub-directory inside *dir*. The name is
 * unique per write, so concurrent writes never collide on their temp names and
 * never remove a staging directory another write is still using: with one shared
 * name, one write's best-effort rmdir could delete the directory another write
 * had just created but not yet opened, failing its openSync with ENOENT. */
function _atomicStagingDir(dir: string): string {
	const sd = path.join(dir, ".file-safety-staging_" + Date.now() + "_" + Math.random().toString(36).substring(2))
	// mode:0o700 protects a freshly created staging dir; the best-effort chmod
	// repairs a pre-existing one (mkdirSync with recursive:true never chmods an
	// existing directory), so staged temp files are never group/world readable.
	fsSync.mkdirSync(sd, { recursive: true, mode: 0o700 })
	try {
		fsSync.chmodSync(sd, 0o700)
	} catch {
		// best-effort: chmod denied or unavailable; a fresh dir was still
		// created with the requested mode
	}
	return sd
}

/** Save the DACL of *srcPath* to a dump file on Windows.
 * Returns null when the dump was written - the caller keeps it and restores it onto the
 * committed file at step 5 - and returns the runner's error when it was not, because the
 * caller refuses the publish in that case and has to be able to say which failure it is
 * refusing: "icacls ran and failed" and "icacls could not be started at all" are different
 * facts to act on. Never throws. */
async function _atomicSaveDaclWindows(
	srcPath: string,
	dumpPath: string,
	execFileRunner?: typeof execFile,
): Promise<unknown> {
	const runner = execFileRunner ?? execFile
	try {
		await new Promise<void>((resolve, reject) => {
			runner("icacls", [srcPath, "/save", dumpPath, "/T"], { windowsHide: true }, (err) =>
				err ? reject(err) : resolve(),
			)
		})
		return null
	} catch (error: unknown) {
		return error
	}
}
/** Restore a DACL dump onto *dirPath* on Windows.
 *
 * Best-effort: the content is already committed, so a failed restore does not fail the write. The
 * failure is RETURNED rather than swallowed, because the caller is the only party that can do
 * something about a directory whose ACL did not come back, and a swallowed error never reaches it. */
async function _atomicRestoreDaclWindows(
	dirPath: string,
	dumpPath: string,
	execFileRunner?: typeof execFile,
): Promise<unknown | null> {
	const runner = execFileRunner ?? execFile
	try {
		await new Promise<void>((resolve, reject) => {
			runner("icacls", [dirPath, "/restore", dumpPath], { windowsHide: true }, (err) =>
				err ? reject(err) : resolve(),
			)
		})
		return null
	} catch (error: unknown) {
		// best-effort: content already committed, so the caller is told rather than the write failed
		return error
	}
}

// -- public API ------------------------------------------------------------

/**
 * Resolve the publish target: the symlink referent when the given path is an
 * existing symlink, the path itself otherwise. Only ENOENT (target absent yet)
 * may fall back to the given path; any other resolution error (EACCES, EIO, ...)
 * propagates so a broken or unreadable symlink is never written through its
 * link path. Callers that stage a temp file themselves must stage it beside
 * the resolved path: the commit is a rename onto the referent, and a rename
 * across filesystems fails with EXDEV.
 */
export async function resolveAtomicPublishTarget(absoluteFilePath: string): Promise<string> {
	return fs.realpath(absoluteFilePath).catch(async (error: unknown) => {
		if (getErrorCode(error) !== "ENOENT") throw error
		// ENOENT also covers a dangling symlink, which must never be written through.
		// Only a lstat that also reports the path as absent may fall back to the
		// given path; a real lstat failure (EACCES, EIO) says nothing about whether
		// the path is a link, so falling back would write through a link we were
		// simply not allowed to inspect.
		const linkStat = await fs.lstat(absoluteFilePath).catch((lstatError: unknown) => {
			if (getErrorCode(lstatError) === "ENOENT") return undefined
			throw lstatError
		})
		if (linkStat?.isSymbolicLink()) throw error
		return await canonicalizeNearestAncestor(absoluteFilePath)
	})
}

/**
 * Canonicalize the parent directory and re-join the basename. fs.realpath
 * canonicalizes every component, including a symlinked ancestor directory or a
 * Windows 8.3 short name, so a lock key must be canonical even when the file
 * itself is not there yet -- otherwise the key for one file depends on whether
 * the file exists when the key is computed, and two writers take two locks.
 */

async function canonicalDirKey(absoluteFilePath: string): Promise<string> {
	const dirPath = path.dirname(absoluteFilePath)
	// Walk up to the nearest ancestor that EXISTS, canonicalize that, and re-join the
	// components that are not there yet. Falling back to the unresolved spelling of the
	// whole parent - what a single realpath(...).catch(() => dirPath) used to do - makes
	// the key depend on whether the directory happens to exist: a writer whose parent is
	// already there canonicalizes through a symlinked ancestor (or a short name) while a
	// writer racing to create the same directory gets the literal spelling, so the two
	// take different locks for one file and a read-modify-write loses one side.
	// A realpath failure that is not "not there yet" says nothing about the canonical
	// form, so it is propagated rather than papered over with a key that may be wrong.
	let cursor = dirPath
	const missing: string[] = []
	for (;;) {
		const canonical = await fs.realpath(cursor).catch((error: unknown) => {
			if (getErrorCode(error) === "ENOENT") return undefined
			throw error
		})
		if (canonical !== undefined) {
			return path.join(canonical, ...missing.reverse(), path.basename(absoluteFilePath))
		}
		missing.push(path.basename(cursor))
		const parent = path.dirname(cursor)
		if (parent === cursor) {
			// Every component up to the root is missing: there is nothing to canonicalize
			// against, and the literal path is the only key left.
			return path.join(dirPath, path.basename(absoluteFilePath))
		}
		cursor = parent
	}
}

/**
 * Canonicalize the nearest EXISTING ancestor and re-append the missing components.
 * The guard hands back a pin produced exactly this way (guardedWrite#realpathNearest),
 * so an absent target has to resolve identically here: a lexical fallback differs from
 * that pin whenever an ancestor is a symlink, and the create would then abort with
 * TargetMovedError even though nothing moved.
 */
/**
 * The directory's canonical spelling when the filesystem can report one.
 * canonicalizeNearestAncestor goes through fs.realpath, which rewrites a Windows 8.3 short
 * name and a directory alias to the directory's own form -- the form resolvePublishTarget
 * already put targetPath in. A canonicalization that reports nothing (an inspection
 * failure, or a stub that answers nothing) falls back to the spelling it was given, so a
 * caller that compares two of these accepts more than a lexical comparison would and never
 * less.
 */
async function canonicalSpellingOf(directory: string): Promise<string> {
	const canonical: string | undefined = await canonicalizeNearestAncestor(directory).catch(() => undefined)
	return canonical === undefined || canonical.length === 0 ? directory : canonical
}
async function canonicalizeNearestAncestor(absoluteFilePath: string): Promise<string> {
	const missing: string[] = []
	let cursor = absoluteFilePath
	for (;;) {
		try {
			const realPath = await fs.realpath(cursor)
			return missing.length > 0 ? path.join(realPath, ...missing.reverse()) : realPath
		} catch (error: unknown) {
			const code = getErrorCode(error)
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				// A real inspection failure (EACCES, EIO) says nothing about the path's
				// identity. Returning a lexical key here would silently canonicalize a
				// different path than the guard's pin, so fail closed instead.
				throw error
			}
			const parent = path.dirname(cursor)
			if (parent === cursor) return absoluteFilePath
			missing.push(path.basename(cursor))
			cursor = parent
		}
	}
}

/**
 * Lock key for a publish target: the symlink referent when the path is an
 * existing symlink, the path itself otherwise. Unlike resolveAtomicPublishTarget this
 * tolerates a dangling link, because the lock key has to be computable while a
 * peer writer is mid-commit (backup mode renames the referent away and back).
 * The walk is bounded so a two-link cycle terminates, and every key it returns is
 * canonicalized through canonicalDirKey.
 */
export async function resolveLockKey(absoluteFilePath: string): Promise<string> {
	try {
		return await canonicalDirKey(await resolveAtomicPublishTarget(absoluteFilePath))
	} catch {
		// A real readlink throws for anything that is not a link, so a normal chain
		// ends the walk. Two links that point at each other never would, so the
		// walk is bounded and callers use the key they actually reached.
		let key = absoluteFilePath
		for (let depth = 0; depth < 8; depth++) {
			const target = await fs.readlink(key).catch(() => undefined)
			if (target === undefined) return await canonicalDirKey(key)
			key = await canonicalDirKey(path.resolve(path.dirname(key), target))
		}
		return await canonicalDirKey(key)
	}
}

// A stat result reports the identity of the file it was taken from, but a filesystem double that
// returns a bare object reports no dev and no ino at all. Reading such a result as an identity would
// turn the double's own gap into a mismatch this write reports, so an identity is recorded only when
// both halves were actually reported. On a real filesystem both halves are always present; the null
// this can return keeps the guard silent instead of inventing a reference out of a gap.
function usableDescriptorIdentity(stats: { dev: unknown; ino: unknown }): { dev: bigint; ino: bigint } | null {
	if (typeof stats.dev === "bigint" && typeof stats.ino === "bigint") {
		return { dev: stats.dev, ino: stats.ino }
	}
	return null
}

export async function safeWriteTextAtomic(
	filePath: string,
	content: string | Uint8Array,
	options?: SafeWriteTextAtomicOptions,
): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)

	// Resolve the symlink referent (see resolvePublishTarget).
	const targetPath = await resolveAtomicPublishTarget(absoluteFilePath)

	// The caller authorized a specific resolved path; publishing at a different one
	// would act on a decision that was never made about this file.
	if (options?.expectedResolvedPath && path.resolve(options.expectedResolvedPath) !== targetPath) {
		throw new TargetMovedError(options.expectedResolvedPath, targetPath)
	}

	const dirPath = path.dirname(targetPath)

	// Ensure parent directory exists (mirrors safeWriteJson behaviour). What mkdir reports it
	// created feeds step 4b's fsync of the ancestors this write introduced; see
	// _createdAncestorChain.
	await _preflightAncestors(options?.expectedAncestorIdentities)
	const createdAncestors = _createdAncestorChain(await fs.mkdir(dirPath, { recursive: true }), dirPath)
	await fs.access(dirPath)

	// Create the staging directory only when we generate the temp file there;
	// callers supplying their own tempPath (e.g. safeWriteJson) must not be left
	// with an empty .file-safety-staging directory behind. Track the directory this
	// write created so its cleanup removes its own directory, not a shared one.
	let stagingDir: string | null = null
	let tempPath: string
	// Whether the commit rename has consumed the staging file. Cleanup is allowed to unlink
	// the staging path only while this write still owns it: after the rename the name belongs to
	// whatever is filed under it next, and a caller-supplied staging name is reused by the next
	// write to the same target.
	let stagingCommitted = false
	// The identity of a caller-supplied staging file, taken by lstat when it was validated. The
	// staging path is re-opened by name further below, so the entry behind the name can be swapped
	// between that validation and the open; the open's own descriptor identity is compared
	// against this value before anything touches the file.
	let stagingIdentity: { dev: bigint; ino: bigint } | null = null
	// The identity this write's OWN descriptor reported for the staging file, captured while that
	// descriptor was open. The commit below publishes whatever the staging NAME holds at the instant
	// link(2) or rename(2) runs, so an identity read back from the name afterwards agrees with
	// itself across a substitution that already happened. An identity taken from the descriptor this
	// write opened cannot agree with anything but the file it wrote, and that is what the published
	// entry is compared against after the commit, on either commit path.
	let stagedIdentity: { dev: bigint; ino: bigint } | null = null
	if (options?.tempPath) {
		// A caller-supplied staging file is only safe when it is the file this
		// write is staging, not an arbitrary path. Two properties are checked:
		// it must sit beside the resolved target (a rename across filesystems
		// fails with EXDEV, and a path elsewhere lets a caller publish an
		// unrelated file onto the target), and it must be a regular file rather
		// than a link — renaming a link over the target publishes whatever the
		// link points at, which is the same trust problem as writing through a
		// dangling symlink in resolvePublishTarget.
		const supplied = path.resolve(options.tempPath)
		// The target side of this comparison is already canonical: targetPath came from
		// resolveAtomicPublishTarget, which runs fs.realpath, and fs.realpath rewrites a directory
		// alias and a Windows 8.3 short name to the directory's own form. On a GitHub Windows
		// runner %TEMP% expands to the short form (...\RUNNER~1\...) while fs.realpath reports
		// the long one (...\runneradmin\...), so a caller that staged beside its target from
		// os.tmpdir() held one directory under two spellings and this guard refused it: the
		// four cases in safeWriteTextAtomic.stagingIdentity.spec.ts failed on platform-unit-test
		// (windows-latest) while the same suites passed on ubuntu-latest, whose tmpdir is
		// already canonical. Canonicalize the supplied side the way the target side was
		// canonicalized before comparing them, as the identity checks below do.
		const stagingDirCanonical = await canonicalSpellingOf(path.dirname(supplied))
		const targetDirCanonical = await canonicalSpellingOf(dirPath)
		if (stagingDirCanonical !== targetDirCanonical) {
			throw new StagingPathError(
				`Staging file must sit in the target's directory (${dirPath}), got ${supplied}`,
				supplied,
			)
		}
		// BigInt stats: on NTFS/ReFS the file identity can exceed Number.MAX_SAFE_INTEGER, and
		// a rounded number makes two different files look identical (rejecting a valid staging
		// file) or hides a real alias.
		const stagingStat = await fs.lstat(supplied, { bigint: true })
		if (stagingStat.isSymbolicLink() || !stagingStat.isFile()) {
			throw new StagingPathError(
				`Staging file must be a regular file, not ${stagingStat.isSymbolicLink() ? "a symlink" : "another file type"}`,
				supplied,
			)
		}
		// A staging path that is the target would be unlinked by the failure handler
		// while it still holds the only copy of the content, so a failed write would
		// delete the file it was meant to protect. Compare identities, not spellings:
		// an alias of the target is the same hazard.
		// Only a missing target may be skipped: an EACCES/ELOOP/ENOTDIR here means the
		// identity comparison could not be made, and treating that as "no target" would let a
		// staging alias reach the commit and let cleanup delete the file it was meant to
		// protect.
		const targetStat = await fs.lstat(targetPath, { bigint: true }).catch((error: unknown) => {
			if (getErrorCode(error) !== "ENOENT") {
				throw new StagingPathError("Staging file could not be compared with the target", supplied)
			}
			return null
		})
		if (
			targetStat &&
			typeof stagingStat.ino === "bigint" &&
			typeof targetStat.ino === "bigint" &&
			stagingStat.ino === targetStat.ino &&
			stagingStat.dev === targetStat.dev
		) {
			throw new StagingPathError("Staging file must not be the target itself", supplied)
		}
		stagingIdentity = { dev: stagingStat.dev, ino: stagingStat.ino }
		// The caller's own path is used as given; only the check is canonical.
		tempPath = options.tempPath
	} else {
		stagingDir = _atomicStagingDir(dirPath)
		tempPath = _atomicTempName(stagingDir, "safeWriteText")
	}

	let backupPath: string | null = null
	let releaseBackupOnSuccess = false
	// True only when this write's own seed open created the backup file. A name that already
	// existed is not this write's file, and the failure path below must not unlink it.
	let backupSeeded = false
	// Set once the target access check in step 3 below has found a target there. It is what
	// separates the one ENOENT this write may answer by publishing without a backup - the
	// target not being there at all - from an ENOENT raised while seeding the backup after
	// the target was found.
	let backupTargetFound = false
	// Non-null only when the win32 step-2 block saved a successful DACL dump:
	// it gates the step-5 restore and is tracked for the cleanup unlinks.
	let daclDumpPath: string | null = null

	try {
		// -- Step 1: write content to staging temp file -------------------
		if (!options?.tempPath) {
			// Preserve the existing target's permissions: the staging file must
			// not be published wider than the file it replaces (a 0o600 target
			// must not become 0o644 through the atomic rename).
			// Encode before opening the staging file: an encoding Node cannot
			// represent must not leave a half-written temp file behind.
			// A string is encoded as UTF-8; bytes handed in by the caller (the
			// extension host encodes a document with VS Code's own codec, which
			// covers the legacy code pages Node cannot represent) are published
			// unchanged.
			const buffer = Buffer.from(content)
			let targetMode = 0o644 // default for a fresh target
			let targetExists = false
			try {
				targetMode = fsSync.statSync(targetPath).mode & 0o777
				targetExists = true
			} catch (error: unknown) {
				if (getErrorCode(error) !== "ENOENT") throw error
				// target does not exist yet - keep the default
			}
			// openSync's creation mode is narrowed by the process umask, so an
			// existing 0o664 target would be published as 0o644 through the
			// rename. Apply the existing target's exact mode on the fd, as the
			// caller-staged branch does; a fresh target keeps the default mode.
			const fd = fsSync.openSync(tempPath, "w", targetMode)
			try {
				// Take the identity of the file this descriptor opened, before anything is written through it.
				// The name can be swapped after this point and the commit would then publish a different file;
				// the post-commit comparison needs the identity of the file this write actually wrote into.
				const opened = fsSync.fstatSync(fd, { bigint: true })
				stagedIdentity = usableDescriptorIdentity(opened)
				if (targetExists) {
					fsSync.fchmodSync(fd, targetMode)
				}
				// Loop until every byte is written: writeSync can report a short
				// (partial) write, and publishing a truncated staging file would
				// commit corrupt content.
				// A zero return is not a short write - it means the descriptor made no progress -
				// and it is handled below rather than looped on.
				let offset = 0
				while (offset < buffer.length) {
					const written = fsSync.writeSync(fd, buffer, offset, buffer.length - offset)
					if (written === 0) {
						// Not a short write: the descriptor made no progress at all, so looping again
						// would hold the fd and the event loop forever without ever reaching fsyncSync
						// or the commit. The finally below closes the fd and the outer cleanup removes
						// the staged file, so a stalled write strands neither.
						throw new Error(
							`safeWriteText: write of ${tempPath} stalled after ${offset} of ${buffer.length} bytes`,
						)
					}
					offset += written
				}
				fsSync.fsyncSync(fd)
			} finally {
				fsSync.closeSync(fd)
			}
		} else {
			// Preserve the existing target's mode (CWE-732): the caller-staged
			// temp carries its own creation mode, and publishing it as-is would
			// widen a restrictive target (e.g. 0o600 -> 0o644) through rename.
			// The mode is applied with fchmodSync on the open fd (AFTER openSync):
			// chmodSync on the path before the open would make a read-only target
			// (0o400/0o444) fail openSync(tempPath, "r+") with EACCES.
			let targetMode: number | null = null
			try {
				targetMode = fsSync.statSync(targetPath).mode & 0o777
			} catch (error: unknown) {
				if (getErrorCode(error) !== "ENOENT") throw error
				// target does not exist yet - keep the temp's default mode
			}
			const fd = fsSync.openSync(tempPath, "r+")
			try {
				// The name was authorized by lstat and is re-opened here by string, so the entry behind it may
				// have been replaced in between. Compare the descriptor's own identity with the one that
				// was authorized and refuse before fchmodSync or fsyncSync acts on whatever the name
				// holds now.
				const opened = fsSync.fstatSync(fd, { bigint: true })
				if (
					stagingIdentity !== null &&
					(opened.dev !== stagingIdentity.dev || opened.ino !== stagingIdentity.ino)
				) {
					throw new StagingPathError("Staging file was replaced between validation and open", tempPath)
				}
				// From here the reference for the post-commit comparison is this descriptor's own identity:
				// the file this write holds open and is about to fsync, whatever the staging name points at later.
				stagedIdentity = usableDescriptorIdentity(opened)
				if (targetMode !== null) {
					fsSync.fchmodSync(fd, targetMode)
				}
				fsSync.fsyncSync(fd)
			} finally {
				fsSync.closeSync(fd)
			}
		}

		// -- Step 2 (win32): save DACL BEFORE backup rename ---------------
		const platform = options?.platform ?? process.platform
		if (platform === "win32") {
			let accessError: unknown = null
			try {
				await fs.access(targetPath) // target exists?
			} catch (error: unknown) {
				accessError = error
			}
			if (accessError === null) {
				const dumpPath = _atomicTempName(dirPath, "safeWriteText.acl")
				const saveFailure = await _atomicSaveDaclWindows(targetPath, dumpPath, options?.execFileRunner)
				if (saveFailure === null) {
					// Only a successfully saved dump may be restored onto the
					// committed file (step 5).
					daclDumpPath = dumpPath
				} else {
					// A failed icacls may have left a partial dump behind;
					// remove it now (best-effort) so no partial dump survives and
					// no later step can restore from it.
					await fs.unlink(dumpPath).catch(() => {})
					// The target exists and its DACL could not be captured, so the commit rename
					// would replace it with a file that inherits different access rights, and nothing
					// here can verify an equivalent restrictive ACL on that replacement. The publish is
					// refused instead of warned about: a save that silently changed who can read the
					// file is not a save the caller can trust. Nothing is committed yet, so the target
					// still holds its content, and this throw lands in the handler at the bottom of
					// this try - the one place that removes the staged file and this write's own
					// staging directory - so a refused publish strands neither.
					// The runner's error travels with the refusal: the phase already says which check
					// refused, and without the error a caller cannot tell a failed icacls from an
					// icacls that could not be started at all.
					throw new DaclInspectionError(targetPath, "save", saveFailure)
				}
			} else if (getErrorCode(accessError) !== "ENOENT") {
				// Not "absent": the target is there but its access rights could not be read
				// (EACCES, ...), so publishing would replace a file whose rights this call never
				// learned. Same rule as the failed save above: refuse before anything is committed.
				throw new DaclInspectionError(targetPath, "inspect", accessError)
			}
		}

		try {
			// -- Step 2b: re-validate the authorized ancestry before committing --
			// The caller decided containment by walking this directory chain. A parent
			// swapped for a link to outside that chain would send the commit somewhere the
			// caller never authorized, even though expectedResolvedPath still matches (the
			// name is unchanged). Compare each recorded identity now, before anything is
			// moved into place.
			if (options?.expectedAncestorIdentities) {
				for (const expected of options.expectedAncestorIdentities) {
					const current = await fs.stat(expected.dir, { bigint: true }).catch((error: unknown) => {
						if (getErrorCode(error) === "ENOENT") {
							throw new AncestorReplacedError(expected.dir, "no longer exists")
						}
						throw error
					})
					if (current.dev !== expected.dev || current.ino !== expected.ino) {
						throw new AncestorReplacedError(expected.dir, "is no longer the directory that was authorized")
					}
					// A move preserves dev+ino, so the identity check above passes for a
					// directory that was relocated and whose old name was replaced by a
					// symlink to the moved location - stat follows that link. The commit
					// below takes path strings and would follow it too, publishing at the
					// moved location outside the chain the caller walked. Require that the
					// authorized name still resolves to the very location it named.
					// Only a vanished name is a containment violation. A transient EACCES
					// or EIO would otherwise be reported as a replaced ancestor, pointing
					// the user at a security problem that is not there - mirror the stat
					// call above, which maps only ENOENT and rethrows the rest.
					const resolvedDir = await fs.realpath(expected.dir).catch((error: unknown) => {
						const code = getErrorCode(error)
						if (code === "ENOENT" || code === "ENOTDIR") {
							return undefined
						}
						throw error
					})
					// The location the caller authorized. A recorded resolvedPath is the spelling the
					// caller walked - an alias ancestor resolves to something else by definition, and a
					// stable alias must pass here; the (dev, ino) check above is what catches the alias
					// being re-pointed. Without a resolvedPath the authorized name is the lexical dir.
					const authorizedLocation = expected.resolvedPath
						? path.resolve(expected.resolvedPath)
						: path.resolve(expected.dir)
					if (resolvedDir === undefined || path.resolve(resolvedDir) !== authorizedLocation) {
						throw new AncestorReplacedError(expected.dir, "no longer resolves to the authorized location")
					}
				}
			}

			// -- Step 3 (backup:true): durable copy target -> backup ----
			if (options?.backup) {
				try {
					await fs.access(targetPath)
					backupTargetFound = true
					backupPath = _atomicTempName(dirPath, "safeWriteText.bak")
					// Copy, never move. Renaming the target away leaves the canonical path absent for
					// the whole commit window: readers see a missing file, and a concurrent
					// writer can create a new target that a later rollback would destroy. A copy
					// keeps the target present, so the step 4 rename is the only change to the
					// canonical path. The copy is flushed so the retained content survives a crash.
					try {
						// Create the destination BEFORE any content exists at it, with the mode fixed
						// at open time. fs.copyFile picks the destination mode itself (the platform
						// creation mask subject to umask on some platforms, the source's mode - or its
						// read-only attribute - on others), so letting it create the file would either
						// leave a restrictive target's bytes briefly readable to others, or leave the
						// copy unwritable so the fsync open below fails with EACCES. open() ignores its
						// mode argument for an existing file, so this 0o600 survives the copy on POSIX;
						// the chmod afterwards is what clears a copied read-only attribute on Windows
						// and keeps a backup of a permissive file private.
						const seedFd = fsSync.openSync(backupPath, "wx", 0o600)
						// The name is ours from the moment the exclusive open succeeds, so the failure
						// path may remove it even when the close below reports an error.
						backupSeeded = true
						// Single close, no retry: on POSIX close(2) can release the descriptor before it
						// reports an error (and leaves its state unspecified after EINTR), so a second
						// close could release a descriptor some other operation has meanwhile reused.
						// The failure propagates; backupPath is already recorded, so the outer cleanup
						// removes the seeded file instead of leaving it beside the target.
						fsSync.closeSync(seedFd)
						await fs.copyFile(targetPath, backupPath)
						await fs.chmod(backupPath, 0o600)
						// "r+" not "r": fsync on a read-only handle is EPERM on Windows, and the same
						// flag the staged temp file uses above.
						const backupFd = fsSync.openSync(backupPath, "r+")
						try {
							fsSync.fsyncSync(backupFd)
						} finally {
							fsSync.closeSync(backupFd)
						}
					} catch (backupError: unknown) {
						// A partial backup must not outlive this attempt: it is not a complete copy
						// of anything, and once the write fails nothing else removes it. The unlink is
						// retried once (Windows reports EPERM for a file whose handle has not been
						// released yet); if it still fails the path is carried on the thrown error
						// instead of being dropped where no caller can act on it.
						const orphanPath = backupPath
						let backupCleanupError: unknown = null
						if (backupSeeded) {
							for (let attempt = 0; attempt < 2; attempt++) {
								try {
									await fs.unlink(orphanPath)
									backupCleanupError = null
									break
								} catch (cleanupError: unknown) {
									if (getErrorCode(cleanupError) === "ENOENT") {
										// Already gone: that is exactly the outcome the cleanup wanted, so stop
										// rather than unlinking the same path a second time.
										backupCleanupError = null
										break
									}
									backupCleanupError = cleanupError
								}
							}
						}
						backupPath = null
						// When the seed open never succeeded - an EEXIST on a name another writer owns, or a
						// failure before anything existed at it - there is nothing here to remove: an entry
						// this write did not create is not this write's orphan, and unlinking it would take
						// away somebody else's backup on the way out. backupCleanupError stays null, so the
						// original failure below is what the caller sees.
						if (backupCleanupError !== null) {
							throw new OrphanedBackupError(orphanPath, targetPath, backupError, backupCleanupError)
						}
						throw backupError
					}
					releaseBackupOnSuccess = true
				} catch (err: unknown) {
					// Only the access check above may be answered by a missing target: with nothing at
					// the target there was no backup to make. An ENOENT from the seed block - the copy
					// gone before copyFile, or a chmod on a backup that vanished after it - says the
					// durability this call asked for could not be made, and publishing would drop the
					// backup the caller requested; that block has already removed its own partial copy
					// and reported an unremovable one, so the failure is propagated, not swallowed.
					if (getErrorCode(err) !== "ENOENT" || backupTargetFound) throw err
				}
			}

			// -- Step 4: atomic commit temp -> target ---------------------
			if (options?.failIfExist) {
				// No-replace commit: link(2) fails EEXIST when the name already exists,
				// where a rename would silently displace whatever a non-participating
				// writer put there after the caller checked. The staged copy is removed
				// once the name points at it.
				try {
					await fs.link(tempPath, targetPath)
				} catch (error: unknown) {
					const code = getErrorCode(error)
					if (code === "EEXIST") {
						throw new TargetExistsError(targetPath)
					}
					// FAT32/exFAT volumes and some SMB/network mounts have no hard links, where
					// link(2) fails EPERM/ENOTSUP/ENOSYS. The fallback this replaces published by
					// an exclusive copy directly at the final name, but a copy is not atomic:
					// readers can observe a partial file, and a crash or an EIO mid-copy leaves
					// damaged bytes under the final name with the 'already exists' verdict on
					// retry. No atomic no-replace primitive exists on those volumes, so the
					// guarded create fails closed - nothing is published and the caller learns
					// the volume cannot honor the contract.
					if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS") {
						throw error
					}
					throw new UnsupportedFilesystemError(targetPath, error)
				}
			} else {
				await fs.rename(tempPath, targetPath)
			}

			// Marked as soon as the commit has consumed the staging name, on both paths: the rename
			// consumed it, and on the link path the target now holds the inode this write staged.
			// Everything below is a post-commit step - the identity comparison, the removal of the
			// staged name, the warnings, the fsyncs and the DACL restore - and none of them, including
			// a caller callback that throws, may leave the failure handler free to unlink a staging
			// name whose content is already published.
			stagingCommitted = true

			// The reference is the identity this write's own descriptor reported before the commit, not a
			// re-stat of the staging name. A no-replace commit links whatever entry the name holds at that
			// instant, and a replace commit moves whatever the name holds and leaves no second name behind,
			// so two names read after the commit can only prove that they agree now, which a substitution
			// completed BEFORE the commit answers by agreeing on the substituted inode. Against the
			// descriptor's identity a mismatch says the published entry is not the file this write staged
			// and fsynced, on either commit path: that is the detection half of what issue #2391 carries
			// for a commit that leaves no second name. Nothing is removed on a mismatch - the entry under
			// the target is not this write's to remove, and the staging name may be the only path to a
			// file another process owns, which is the ownership half of the same issue. The null test keeps the check
			// silent when the descriptor reported no identity at all, which is what a filesystem double answers with
			// when its fstat stand-in returns a bare object; a real filesystem always reports both halves. The
			// both-names comparison inside the failIfExist branch below still covers the no-replace path in that
			// case, exactly as it did before this check was added.
			if (stagedIdentity !== null) {
				const publishedNow = await fs.stat(targetPath, { bigint: true })
				if (publishedNow.dev !== stagedIdentity.dev || publishedNow.ino !== stagedIdentity.ino) {
					throw new PublishedEntryMismatchError(
						targetPath,
						`${publishedNow.dev}:${publishedNow.ino}`,
						`${stagedIdentity.dev}:${stagedIdentity.ino}`,
					)
				}
			}
			if (options?.failIfExist) {
				// Both names should now be one inode. They diverge when the entry under either name is
				// replaced after the commit, and the published name then holds bytes this write never
				// staged. A substitution completed BEFORE the link is not detectable from here: link(2)
				// links whatever entry the staging name holds at that moment, so both stats report the
				// substituted inode and the comparison passes. Checked after the link because link(2) is
				// the first point at which the target name exists, and a check of either name before it
				// cannot see what landed at the other. Neither name is removed on a mismatch and the
				// commit marker above is already set, so the
				// cleanup below cannot unlink a name that may belong to another process. The ordinary
				// rename path cannot be verified this way: rename(2) moves the staged inode itself and
				// leaves no second name to compare, and a re-stat of the target proves only that the
				// rename took effect, not that the staging file was still ours when it did. Issue
				// #2391 is where that gap is carried; what it must prove is how a commit that leaves
				// no second name detects a staging substitution before publication and how its cleanup
				// avoids removing an entry it does not own. This unit does not claim that answer.
				const [stagedNow, publishedNow] = await Promise.all([
					fs.stat(tempPath, { bigint: true }),
					fs.stat(targetPath, { bigint: true }),
				])
				if (stagedNow.dev !== publishedNow.dev || stagedNow.ino !== publishedNow.ino) {
					throw new PublishedEntryMismatchError(
						targetPath,
						`${publishedNow.dev}:${publishedNow.ino}`,
						`${stagedNow.dev}:${stagedNow.ino}`,
					)
				}
				// The target name is published at this point; the staged name is only a second
				// link to the same inode (or a copy of it). Removal is best-effort: on Windows
				// an antivirus handle can make unlink fail with EBUSY/EPERM after the content
				// is already visible, and the write must not be reported as failed for content
				// the caller can now read back. The residue is named on the warning channel rather
				// than dropped, because a caller that keeps its own staging name needs to learn the
				// orphan is still there.
				const stagingResidue = await fs.unlink(tempPath).catch((error: unknown) => error)
				if (stagingResidue !== undefined) {
					options?.onPostCommitWarning?.({
						kind: "staging-link-orphan",
						path: tempPath,
						cause: stagingResidue,
					})
				}
			}

			// -- Step 4b (POSIX): fsync the parent directory so the directory entry
			// changed by the commit rename is durable, not just the file content.
			if (platform !== "win32") {
				try {
					_syncDirectory(dirPath)
					// The rename above made the entry INSIDE dirPath durable. A parent this call had to
					// create is itself an entry in its own parent, so syncing only the immediate parent
					// leaves the newer ancestors unsynced and a crash can remove the chain - taking the
					// published file with it. Sync deepest-first, ending with the pre-existing directory
					// that holds the outermost new entry.
					for (let i = createdAncestors.length - 2; i >= 0; i--) {
						_syncDirectory(createdAncestors[i])
					}
					if (createdAncestors.length > 0) {
						_syncDirectory(path.dirname(createdAncestors[0]))
					}
				} catch (error: unknown) {
					// The content rename committed, but the directory entry that
					// points at it is not known to be durable. Reporting success
					// here would let a caller believe the write survives a crash,
					// so the failure is surfaced as its own error: the caller can
					// still find the content at the target, it just cannot rely on
					// the directory entry having reached the disk.
					throw new PostCommitDurabilityError(targetPath, error)
				}
			}

			// -- Step 5 (win32): restore DACL AFTER commit rename ---------
			// daclDumpPath is non-null only when the win32 step-2 block saved a
			// successful dump, so this gate is closed on every other platform
			// and on every failed save.
			if (daclDumpPath !== null) {
				const restoredDir = path.dirname(targetPath)
				const restoreFailure = await _atomicRestoreDaclWindows(
					restoredDir,
					daclDumpPath,
					options?.execFileRunner,
				)
				if (restoreFailure !== null) {
					options?.onPostCommitWarning?.({
						kind: "dacl-restore-failed",
						path: restoredDir,
						cause: restoreFailure,
					})
				}
			}

			// -- Step 6 (backup:true): delete backup on success -----------
			if (releaseBackupOnSuccess && backupPath) {
				const orphanedBackupPath = backupPath
				let backupCleanupError: unknown = null
				// A transient handle (antivirus scanner, indexer) can block the first unlink
				// on Windows; one retry usually clears it.
				for (let attempt = 0; attempt < 2; attempt++) {
					try {
						await fs.unlink(orphanedBackupPath)
						backupCleanupError = null
						break
					} catch (cleanupError: unknown) {
						if (getErrorCode(cleanupError) === "ENOENT") {
							backupCleanupError = null
							break
						}
						backupCleanupError = cleanupError
					}
				}
				backupPath = null
				if (backupCleanupError !== null) {
					// The content is published: reporting success here would abandon a stale
					// copy of the previous content, so the failure travels as its own error.
					throw new OrphanedPublishedBackupError(targetPath, orphanedBackupPath, backupCleanupError)
				}
			}
		} finally {
			// Unlink DACL dump regardless of success/failure in this span.
			if (daclDumpPath !== null) {
				await fs.unlink(daclDumpPath).catch(() => {})
			}
		}

		// tempPath is now the committed file; no cleanup needed.

		// Best-effort: remove the now-empty staging directory. Self-staged
		// writes only, and only this write's own directory: a per-write directory
		// cannot be the one another concurrent write is still using. A failure must
		// never un-commit a published file, so the removal swallows all errors.
		if (stagingDir) {
			await fs.rmdir(stagingDir).catch(() => {})
		}
	} catch (originalError: unknown) {
		// The backup is a copy, never a restore source: whether the failure happened before
		// or after the commit rename, the copy is removed below so no stale duplicate of the
		// previous content survives next to the target.
		// Set when a backup copy this write made could not be removed; reported at the end of
		// this catch so the staging cleanup above is not skipped for a cleanup failure.
		let pendingBackupError: OrphanedBackupAfterFailedWriteError | null = null
		if (backupPath && releaseBackupOnSuccess) {
			// Nothing to restore: the backup is a copy, so the target still holds whatever
			// the commit left there - before the commit that is the pre-write content, and
			// after it the published content. Either way the copy has served its purpose
			// and must not be left beside the target where no caller can find it.
			let removalError: unknown = null
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					await fs.unlink(backupPath)
					removalError = null
					break
				} catch (error: unknown) {
					if (getErrorCode(error) === "ENOENT") {
						// Already gone: that is exactly the outcome this cleanup wanted.
						removalError = null
						break
					}
					// Retry once: Windows reports EPERM for a file whose handle has not been
					// released yet, which is the same failure the success-path cleanup retries.
					removalError = error
				}
			}
			if (removalError !== null) {
				// The copy of the previous content is still on disk and only this function knew
				// where. Reporting it is what keeps the original error the primary fact while
				// leaving the leftover findable; swallowing the removal left both unreported.
				// Constructed, not thrown yet: the staging cleanup below has to run first, so
				// the leftover is reported once this catch has finished what it can do about the
				// write's own mess.
				pendingBackupError = new OrphanedBackupAfterFailedWriteError(
					targetPath,
					backupPath,
					originalError,
					removalError,
					stagingCommitted,
				)
			}
			backupPath = null
		}
		if (!stagingCommitted) {
			try {
				await fs.unlink(tempPath).catch(() => {})
			} catch {
				// cleanup failure is non-fatal
			}
		}

		// A failed self-staged write must not leave its staging directory behind.
		// Only the directory this write created, and only after its temp file is
		// gone, so the directory is empty and the removal stays best-effort.
		if (stagingDir) {
			await fs.rmdir(stagingDir).catch(() => {})
		}

		if (daclDumpPath !== null) {
			await fs.unlink(daclDumpPath).catch(() => {})
		}

		if (pendingBackupError) {
			// The write's own failure is still the primary fact - it travels on this error as
			// originalError and as its cause - and the copy of the previous content now has a
			// path a caller can act on instead of being unreported.
			throw pendingBackupError
		}
		throw originalError
	}
}
