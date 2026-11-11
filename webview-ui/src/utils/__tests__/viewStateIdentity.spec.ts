import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { getViewStateIdentity, rememberViewStateClaim } from "../viewStateIdentity"

const STORAGE_KEY = "zooViewStateIdentity"

// The runner gives this jsdom environment no usable localStorage (it starts node with a
// `--localstorage-file` flag that carries no path), so the store the module talks to is stubbed
// here with a map. The module's contract has two halves - persist when a store exists, keep the
// view working when it does not - and both have to be assertable.
const createStorage = () => {
	const data = new Map<string, string>()

	return {
		getItem: (key: string) => (data.has(key) ? data.get(key) : null),
		setItem: (key: string, value: string) => {
			data.set(key, String(value))
		},
		removeItem: (key: string) => {
			data.delete(key)
		},
		clear: () => {
			data.clear()
		},
	}
}

type FakeStorage = ReturnType<typeof createStorage>

let storage: FakeStorage

describe("viewStateIdentity", () => {
	beforeEach(() => {
		storage = createStorage()
		vi.stubGlobal("localStorage", storage)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("keeps the same id across reads, which is what a reload looks like from here", () => {
		const first = getViewStateIdentity()
		const second = getViewStateIdentity()

		expect(typeof first.viewStateId).toBe("string")
		expect(first.viewStateId.length).toBeGreaterThan(0)
		// A brand-new view has no claim: only the host can mint one.
		expect(first.viewStateClaim).toBeUndefined()
		expect(second).toEqual(first)
		expect(storage.getItem(STORAGE_KEY)).toBeTruthy()
	})

	it("gives two views different ids rather than sharing one slot", () => {
		const first = getViewStateIdentity()
		storage.removeItem(STORAGE_KEY)
		const second = getViewStateIdentity()

		expect(second.viewStateId).not.toBe(first.viewStateId)
	})

	it("echoes back the claim the host delivered for that id", () => {
		const identity = getViewStateIdentity()
		rememberViewStateClaim(identity.viewStateId, "host-minted-token")

		expect(getViewStateIdentity()).toEqual({
			viewStateId: identity.viewStateId,
			viewStateClaim: "host-minted-token",
		})
	})

	it("drops a claim delivered under a different id instead of mixing the pair", () => {
		const identity = getViewStateIdentity()
		rememberViewStateClaim("a-different-view", "someone-elses-claim")

		// The record is replaced whole: a stale id never survives into the next launch with someone
		// else's token attached to it.
		expect(getViewStateIdentity()).toEqual({
			viewStateId: "a-different-view",
			viewStateClaim: "someone-elses-claim",
		})
		expect(getViewStateIdentity().viewStateId).not.toBe(identity.viewStateId)
	})

	it("starts over on a corrupt stored value rather than serving an unreadable identity", () => {
		storage.setItem(STORAGE_KEY, "{not json")

		const identity = getViewStateIdentity()
		expect(typeof identity.viewStateId).toBe("string")
		expect(identity.viewStateId.length).toBeGreaterThan(0)
		expect(storage.getItem(STORAGE_KEY)).not.toBe("{not json")
	})

	it("treats a stored id that is not a string as no identity at all", () => {
		storage.setItem(STORAGE_KEY, JSON.stringify({ viewStateId: 42, viewStateClaim: "token" }))

		const identity = getViewStateIdentity()
		expect(identity.viewStateId).not.toBe(42)
		expect(identity.viewStateClaim).toBeUndefined()
		// The unreadable record is replaced, not carried forward.
		expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}")).toEqual({ viewStateId: identity.viewStateId })
	})

	it("still hands out an identity when the store itself throws", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("storage disabled")
			},
			setItem: () => {
				throw new Error("storage disabled")
			},
			removeItem: () => {
				throw new Error("storage disabled")
			},
			clear: () => {
				throw new Error("storage disabled")
			},
		})

		// A webview with storage disabled keeps its temporary id: it works, it just cannot
		// prove ownership of a persisted key on the next launch.
		const identity = getViewStateIdentity()
		expect(typeof identity.viewStateId).toBe("string")
		expect(identity.viewStateId.length).toBeGreaterThan(0)
	})
})
