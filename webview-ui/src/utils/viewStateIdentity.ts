const STORAGE_KEY = "zooViewStateIdentity"

export interface ViewStateIdentity {
	/** The durable per-view key this webview asks the host to bind its selections to. */
	viewStateId: string
	/** The host-minted claim that governs that key, echoed back on launch. Never minted here. */
	viewStateClaim?: string
}

/** A key that will not collide with another view's slot, available on every webview runtime. */
function mintViewId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID()
	}
	return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

function read(): ViewStateIdentity | undefined {
	try {
		const raw = localStorage.getItem(STORAGE_KEY)
		if (!raw) {
			return undefined
		}
		const parsed: unknown = JSON.parse(raw)
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as ViewStateIdentity).viewStateId !== "string" ||
			!(parsed as ViewStateIdentity).viewStateId
		) {
			return undefined
		}
		const { viewStateId, viewStateClaim } = parsed as ViewStateIdentity
		return typeof viewStateClaim === "string" && viewStateClaim ? { viewStateId, viewStateClaim } : { viewStateId }
	} catch {
		// A webview whose storage is unavailable or holds a corrupt value keeps its temporary id:
		// it still works, it just starts a fresh per-view slot instead of restoring one.
		return undefined
	}
}

function write(identity: ViewStateIdentity): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
	} catch {
		// Same reason as the read side: an unusable store costs restoration, never correctness.
	}
}

/**
 * The identity this view presents to the host: an id generated once by the webview - it has to
 * survive a webview reload, which recreates the view on both sides - plus the host-minted claim
 * the host delivered for it. The claim is copied, never chosen here: the host owns which view may
 * hold a given persisted key.
 */
export function getViewStateIdentity(): ViewStateIdentity {
	const existing = read()
	if (existing) {
		return existing
	}
	const fresh: ViewStateIdentity = { viewStateId: mintViewId() }
	write(fresh)
	return fresh
}

/**
 * Record the claim the host just minted for this view's persisted key, so the next launch can
 * prove it owns that key. A delivery for a different id replaces the whole record: a stale id and
 * its claim never survive into the next launch.
 */
export function rememberViewStateClaim(viewStateId: string, viewStateClaim: string): void {
	write({ viewStateId, viewStateClaim })
}
