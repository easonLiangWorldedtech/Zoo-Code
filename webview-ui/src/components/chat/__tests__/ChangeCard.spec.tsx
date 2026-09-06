// npx vitest run src/components/chat/__tests__/ChangeCard.spec.tsx

import React from "react"
import { fireEvent, renderWithExtensionState, screen, within } from "@/utils/test-utils"
import type { ChangeCardData, ClineMessage } from "@roo-code/types"

const mockPostMessage = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (...args: unknown[]) => mockPostMessage(...args),
	},
}))

// Mock i18n (same pattern as the other ChatRow specs)
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { count?: number }) => {
			const map: Record<string, string> = {
				"chat:changeCard.header": `${options?.count ?? 0} file(s) changed this step`,
				"chat:changeCard.rollbackFile": "Rollback this file",
				"chat:changeCard.rollbackStep": "Rollback step",
				"chat:changeCard.rollbackWarning": "Restores the previous content of this step's files.",
				"chat:changeCard.confirm": "Confirm",
				"chat:changeCard.cancel": "Cancel",
				"chat:changeCard.rollingBack": "Rolling back...",
				"chat:changeCard.rolledBack": "Rolled back",
				"chat:changeCard.stepRolledBack": "Step rolled back",
				"chat:changeCard.rollbackFailed": "Rollback failed",
			}
			return map[key] || key
		},
	}),
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

// Mock DiffView so the diff text is directly assertable (the real one runs a
// syntax highlighter, which is irrelevant to the lazy-expansion behavior).
vi.mock("@src/components/common/DiffView", () => ({
	default: ({ source }: { source: string }) => <div data-testid="diff-view">{source}</div>,
}))

// Mock StandardTooltip so its content is assertable without hover/focus: the
// real component portals its content only while open; the fake renders it
// inline next to the trigger.
vi.mock("@/components/ui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/components/ui")>()
	return {
		...actual,
		StandardTooltip: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => (
			<>
				<div data-testid="cc-tooltip-content">{content}</div>
				{children}
			</>
		),
	}
})

import { ChangeCard } from "../ChangeCard"
import { ChatRowContent } from "../ChatRow"

function makeCardMessage(overrides: Partial<ChangeCardData> = {}, ts = 1000): ClineMessage {
	const card: ChangeCardData = {
		checkpointIds: ["abc123"],
		files: [
			{ path: "src/a.ts", additions: 12, deletions: 3 },
			{ path: "src/b.ts", additions: 1, deletions: 1 },
		],
		totalFiles: 2,
		detail: "summary",
		...overrides,
	}
	return {
		type: "say",
		say: "change_card",
		ts,
		partial: false,
		text: JSON.stringify(card),
	}
}

const DIFF_A = "@@ -1,1 +1,2 @@\n-old\n+new-a\n+extra\n"
const DIFF_B = "@@ -1,1 +1,1 @@\n-old\n+new-b\n"

function fireRollbackResult(data: Record<string, unknown>) {
	fireEvent(window, new MessageEvent("message", { data }))
}

describe("ChangeCard", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the header count and per-file list from a multi-file payload", () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		expect(screen.getByTestId("change-card-header")).toHaveTextContent("2 file(s) changed this step")
		expect(screen.getByText((text) => text.includes("src/a.ts"))).toBeInTheDocument()
		expect(screen.getByText((text) => text.includes("src/b.ts"))).toBeInTheDocument()
		expect(screen.getByText("+12")).toBeInTheDocument()
		expect(screen.getByText("-3")).toBeInTheDocument()
		expect(screen.getByText("+1")).toBeInTheDocument()
		expect(screen.getByText("-1")).toBeInTheDocument()
	})

	it("keeps the diff hidden in summary cards until the file row is expanded", () => {
		renderWithExtensionState(
			<ChangeCard
				message={makeCardMessage({
					detail: "summary",
					files: [{ path: "src/a.ts", additions: 1, deletions: 1, diff: DIFF_A }],
					totalFiles: 1,
				})}
			/>,
		)

		// Collapsed by default: the diff text is not rendered.
		expect(screen.queryByTestId("diff-view")).toBeNull()
		expect(screen.queryByText((content) => content.includes("+new-a"))).toBeNull()

		// Expand the file row.
		fireEvent.click(screen.getByText((text) => text.includes("src/a.ts")))

		// The diff text comes from the payload and is rendered lazily on expand.
		expect(screen.getByTestId("diff-view").textContent).toContain(DIFF_A.trim())

		// Collapse again.
		fireEvent.click(screen.getByText((text) => text.includes("src/a.ts")))
		expect(screen.queryByTestId("diff-view")).toBeNull()
	})

	it("renders the diff inline by default in full cards", () => {
		renderWithExtensionState(
			<ChangeCard
				message={makeCardMessage({
					detail: "full",
					files: [
						{ path: "src/a.ts", additions: 1, deletions: 1, diff: DIFF_A },
						{ path: "src/b.ts", additions: 1, deletions: 1, diff: DIFF_B },
					],
					totalFiles: 2,
				})}
			/>,
		)

		const [diffA, diffB] = screen.getAllByTestId("diff-view")
		expect(diffA.textContent).toContain(DIFF_A.trim())
		expect(diffB.textContent).toContain(DIFF_B.trim())
	})

	it("renders compact rows without a diff section when the payload carries no diffs", () => {
		// Auto-approved steps are always emitted as summary cards without any
		// per-file diff field; the card then renders file rows with stats only.
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		expect(screen.getByTestId("change-card-header")).toBeInTheDocument()
		expect(screen.queryByTestId("diff-view")).toBeNull()
		expect(screen.getByText((text) => text.includes("src/a.ts"))).toBeInTheDocument()
		expect(screen.getByText((text) => text.includes("src/b.ts"))).toBeInTheDocument()
	})

	it("renders nothing for an unparseable card payload", () => {
		const { container } = renderWithExtensionState(
			<ChangeCard message={{ type: "say", say: "change_card", ts: 1, text: "not-json" } as ClineMessage} />,
		)

		expect(container.innerHTML).toBe("")
	})

	it("rolls back one file through the checkpointRollbackFile message and shows pending + success", async () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		// Open the confirm step for the first file.
		fireEvent.click(screen.getByTestId("change-card-file-rollback-0"))
		expect(screen.getByTestId("change-card-file-confirm-0")).toBeInTheDocument()

		// Confirm sends the webview->extension message and goes pending.
		fireEvent.click(screen.getByText("Confirm"))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "checkpointRollbackFile",
			payload: { cardTs: 1000, checkpointId: "abc123", filePath: "src/a.ts" },
		})
		expect(screen.getByTestId("change-card-file-pending-0")).toBeInTheDocument()

		// The extension ack resolves the pending state.
		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: { cardTs: 1000, filePath: "src/a.ts", success: true },
		})
		await screen.findByTestId("change-card-file-success-0")
		expect(screen.getByTestId("change-card-file-success-0")).toHaveTextContent("Rolled back")
	})

	it("shows the file rollback error state on a failed ack", async () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		fireEvent.click(screen.getByTestId("change-card-file-rollback-0"))
		fireEvent.click(screen.getByText("Confirm"))

		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: {
				cardTs: 1000,
				filePath: "src/a.ts",
				success: false,
				error: "checkpoint not found",
			},
		})

		expect(await screen.findByTestId("change-card-file-error-0")).toHaveTextContent("Rollback failed")
	})

	it("rolls back the whole step through the checkpointRollbackStep message and shows pending + success", async () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		// Open the confirm step for the step-level rollback.
		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		expect(screen.getByTestId("change-card-step-confirm")).toBeInTheDocument()
		expect(screen.getByText("Restores the previous content of this step's files.")).toBeInTheDocument()

		// Confirm sends the step message with the step's file list.
		fireEvent.click(screen.getByText("Confirm"))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "checkpointRollbackStep",
			payload: { cardTs: 1000, checkpointId: "abc123", filePaths: ["src/a.ts", "src/b.ts"] },
		})
		expect(screen.getByTestId("change-card-step-pending")).toBeInTheDocument()

		// The extension ack (per-step result carries the per-file outcomes).
		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: {
				cardTs: 1000,
				success: true,
				files: [
					{ filePath: "src/a.ts", success: true },
					{ filePath: "src/b.ts", success: true },
				],
			},
		})
		expect(await screen.findByTestId("change-card-step-success")).toHaveTextContent("Step rolled back")
		// Per-file rows resolve to success as well.
		expect(screen.getByTestId("change-card-file-success-0")).toBeInTheDocument()
		expect(screen.getByTestId("change-card-file-success-1")).toBeInTheDocument()
	})

	it("shows the step rollback error state with the first failing file's error", async () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByText("Confirm"))

		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: {
				cardTs: 1000,
				success: false,
				files: [
					{ filePath: "src/a.ts", success: true },
					{ filePath: "src/b.ts", success: false, error: "boom" },
				],
			},
		})

		expect(await screen.findByTestId("change-card-step-error")).toHaveTextContent("Rollback failed")
		expect(screen.getByTestId("change-card-file-error-1")).toBeInTheDocument()
		expect(screen.getByTestId("change-card-file-success-0")).toBeInTheDocument()
	})

	it("resolves the step state from a failure result that carries no files", async () => {
		// The missing-task response is a step-level result with success: false
		// and no per-file payload (no files, no filePath). Without handling the
		// empty shape the step button would stay in the pending state forever.
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByText("Confirm"))
		expect(screen.getByTestId("change-card-step-pending")).toBeInTheDocument()

		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: {
				cardTs: 1000,
				success: false,
				error: "Checkpoints are not enabled for this task",
			},
		})

		// The error detail rides in the tooltip content; the visible state is
		// the rollback-failed label. The assertion that matters here is that the
		// step left the pending state at all (previously it would stay pending).
		expect(await screen.findByTestId("change-card-step-error")).toHaveTextContent("Rollback failed")
	})

	it("keeps the step in the pending state until a no-files success resolves it", async () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByText("Confirm"))
		expect(screen.getByTestId("change-card-step-pending")).toBeInTheDocument()

		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: { cardTs: 1000, success: true },
		})

		expect(await screen.findByTestId("change-card-step-success")).toBeInTheDocument()
	})

	it("ignores rollback results for other change cards", () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		// Unrelated extension messages are dropped by the card's listener.
		fireEvent(window, new MessageEvent("message", { data: { type: "state", text: "x" } }))

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByText("Confirm"))
		expect(screen.getByTestId("change-card-step-pending")).toBeInTheDocument()

		// A result for a different card ts must not resolve this card.
		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: { cardTs: 999, success: true, files: [] },
		})

		expect(screen.getByTestId("change-card-step-pending")).toBeInTheDocument()
	})

	it("cancels the file and step rollback confirmations without sending a message", () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		// File-level cancel returns to idle without a rollback message.
		fireEvent.click(screen.getByTestId("change-card-file-rollback-0"))
		fireEvent.click(screen.getByTestId("change-card-file-cancel-0"))
		expect(screen.getByTestId("change-card-file-rollback-0")).toBeInTheDocument()
		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "checkpointRollbackFile" }))

		// Step-level cancel returns to idle as well.
		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByTestId("change-card-step-cancel"))
		expect(screen.getByTestId("change-card-step-rollback")).toBeInTheDocument()
		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "checkpointRollbackStep" }))
	})
})

describe("ChatRow - change_card say", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the change card for change_card messages", () => {
		renderWithExtensionState(
			<ChatRowContent
				message={makeCardMessage()}
				isExpanded={false}
				isLast={false}
				isStreaming={false}
				onToggleExpand={() => {}}
				onSuggestionClick={() => {}}
				onBatchFileResponse={() => {}}
				onFollowUpUnmount={() => {}}
				isFollowUpAnswered={false}
			/>,
		)

		expect(screen.getByTestId("change-card-header")).toHaveTextContent("2 file(s) changed this step")
	})
})

describe("ChangeCard - mutation coverage (round 2)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("re-correlates rollback results after the card ts and content change", async () => {
		const { rerender } = renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		// A re-render with a new card ts and content must re-correlate results.
		rerender(
			<ChangeCard
				message={makeCardMessage(
					{
						files: [
							{ path: "src/a.ts", additions: 12, deletions: 3 },
							{ path: "src/b.ts", additions: 1, deletions: 1 },
							{ path: "src/c.ts", additions: 4, deletions: 2 },
						],
						totalFiles: 3,
					},
					2000,
				)}
			/>,
		)
		expect(screen.getByTestId("change-card-header")).toHaveTextContent("3 file(s) changed this step")

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByText("Confirm"))
		expect(screen.getByTestId("change-card-step-pending")).toBeInTheDocument()

		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: {
				cardTs: 2000,
				success: true,
				files: [
					{ filePath: "src/a.ts", success: true },
					{ filePath: "src/b.ts", success: true },
					{ filePath: "src/c.ts", success: true },
				],
			},
		})
		expect(await screen.findByTestId("change-card-step-success")).toBeInTheDocument()
	})

	it("tolerates malformed window messages without raising", async () => {
		const errors: string[] = []
		const onError = (event: ErrorEvent) => {
			// The extension state provider's own message listener is not
			// null-safe either; count only throws that originate from the card.
			if (event.error?.stack?.includes("ChangeCard")) {
				errors.push(String(event.error))
			}
		}
		window.addEventListener("error", onError)
		try {
			renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

			// A message with no data at all.
			fireEvent(window, new MessageEvent("message"))
			// The right type but no result payload.
			fireEvent(window, new MessageEvent("message", { data: { type: "checkpointRollbackResult" } }))
			// An unrelated message type.
			fireEvent(window, new MessageEvent("message", { data: { type: "state", text: "x" } }))

			// jsdom reports uncaught listener exceptions as window error events;
			// settle a tick before asserting that none was raised.
			await new Promise((resolve) => setTimeout(resolve, 100))
			expect(errors).toEqual([])
		} finally {
			window.removeEventListener("error", onError)
		}
	})

	it("drops rollback payloads carried by messages of other types", async () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		// The type guard must drop a foreign result even when its card ts matches.
		fireEvent(
			window,
			new MessageEvent("message", {
				data: {
					type: "state",
					checkpointRollbackResult: { cardTs: 1000, success: false, error: "boom" },
				},
			}),
		)

		expect(screen.queryByTestId("change-card-step-error")).not.toBeInTheDocument()
		expect(screen.getByTestId("change-card-step-rollback")).toBeInTheDocument()
	})

	it("renders diff badges only on the rows that changed lines", () => {
		renderWithExtensionState(
			<ChangeCard
				message={makeCardMessage({
					files: [
						{ path: "src/a.ts", additions: 5, deletions: 0 },
						{ path: "src/b.ts", additions: 0, deletions: 7 },
						{ path: "src/c.ts", additions: 0, deletions: 0 },
					],
					totalFiles: 3,
				})}
			/>,
		)

		const rowOf = (path: string) =>
			within(screen.getByText((text) => text.includes(path)).closest(".flex.items-start") as HTMLElement)

		// Rows with changes render their badge (including the zero side).
		expect(rowOf("src/a.ts").getByText("+5")).toBeInTheDocument()
		expect(rowOf("src/b.ts").getByText("-7")).toBeInTheDocument()
		// The unchanged row renders no badges at all.
		expect(rowOf("src/c.ts").queryByText("+0")).toBeNull()
		expect(rowOf("src/c.ts").queryByText("-0")).toBeNull()
		// All three rows are compact bordered rows (no diff in the payload).
		expect(document.querySelectorAll(".border-vscode-panel-border")).toHaveLength(3)
	})

	it("cancelling one file keeps the other files' rollback state", async () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		fireEvent.click(screen.getByTestId("change-card-file-rollback-0"))
		fireEvent.click(screen.getByText("Confirm"))
		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: { cardTs: 1000, filePath: "src/a.ts", success: true },
		})
		await screen.findByTestId("change-card-file-success-0")

		fireEvent.click(screen.getByTestId("change-card-file-rollback-1"))
		expect(screen.getByTestId("change-card-file-cancel-1")).toHaveTextContent("Cancel")
		fireEvent.click(screen.getByTestId("change-card-file-cancel-1"))

		// The cancelled file returns to idle; the succeeded one keeps its state.
		expect(screen.getByTestId("change-card-file-rollback-1")).toBeInTheDocument()
		expect(screen.getByTestId("change-card-file-success-0")).toBeInTheDocument()
	})

	it("shows the file error detail in the tooltip and the idle label otherwise", async () => {
		renderWithExtensionState(
			<ChangeCard
				message={makeCardMessage({ files: [{ path: "src/a.ts", additions: 12, deletions: 3 }], totalFiles: 1 })}
			/>,
		)

		// Idle: the tooltip explains the rollback affordance.
		expect(screen.getByTestId("cc-tooltip-content")).toHaveTextContent("Rollback this file")

		fireEvent.click(screen.getByTestId("change-card-file-rollback-0"))
		fireEvent.click(screen.getByText("Confirm"))
		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: {
				cardTs: 1000,
				filePath: "src/a.ts",
				success: false,
				error: "checkpoint not found",
			},
		})
		await screen.findByTestId("change-card-file-error-0")
		expect(screen.getByTestId("cc-tooltip-content")).toHaveTextContent("checkpoint not found")
	})

	it("falls back to the localized failure label when the file error carries no detail", async () => {
		renderWithExtensionState(
			<ChangeCard
				message={makeCardMessage({ files: [{ path: "src/a.ts", additions: 12, deletions: 3 }], totalFiles: 1 })}
			/>,
		)

		fireEvent.click(screen.getByTestId("change-card-file-rollback-0"))
		fireEvent.click(screen.getByText("Confirm"))
		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: { cardTs: 1000, filePath: "src/a.ts", success: false },
		})
		await screen.findByTestId("change-card-file-error-0")
		expect(screen.getByTestId("cc-tooltip-content")).toHaveTextContent("Rollback failed")
	})

	it("resolves the step error with the first failing file's detail, not the outer error", async () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByText("Confirm"))
		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: {
				cardTs: 1000,
				success: false,
				error: "outer failure",
				files: [
					{ filePath: "src/a.ts", success: true },
					{ filePath: "src/b.ts", success: false, error: "boom-b" },
				],
			},
		})
		await screen.findByTestId("change-card-step-error")

		// The step tooltip (in the header row) shows the failing file's detail.
		const headerRow = screen.getByTestId("change-card-header").closest(".flex.items-center") as HTMLElement
		expect(within(headerRow).getByTestId("cc-tooltip-content")).toHaveTextContent("boom-b")
		expect(screen.getByTestId("change-card-file-error-1")).toBeInTheDocument()
		expect(screen.getByTestId("change-card-file-success-0")).toBeInTheDocument()
	})

	it("resolves the step error even when every file reports success", async () => {
		renderWithExtensionState(
			<ChangeCard
				message={makeCardMessage({ files: [{ path: "src/a.ts", additions: 12, deletions: 3 }], totalFiles: 1 })}
			/>,
		)

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByText("Confirm"))
		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: {
				cardTs: 1000,
				success: false,
				error: "outer failure",
				files: [{ filePath: "src/a.ts", success: true }],
			},
		})
		await screen.findByTestId("change-card-step-error")

		const headerRow = screen.getByTestId("change-card-header").closest(".flex.items-center") as HTMLElement
		expect(within(headerRow).getByTestId("cc-tooltip-content")).toHaveTextContent("outer failure")
	})

	it("resolves the missing-task step failure through the localized fallback label", async () => {
		renderWithExtensionState(
			<ChangeCard
				message={makeCardMessage({ files: [{ path: "src/a.ts", additions: 12, deletions: 3 }], totalFiles: 1 })}
			/>,
		)

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByText("Confirm"))
		// The missing-task response carries no per-file payload and no error detail.
		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: { cardTs: 1000, success: false },
		})
		await screen.findByTestId("change-card-step-error")

		const headerRow = screen.getByTestId("change-card-header").closest(".flex.items-center") as HTMLElement
		expect(within(headerRow).getByTestId("cc-tooltip-content")).toHaveTextContent("Rollback failed")
	})

	it("keeps the step pending when a result carries a null file path", async () => {
		renderWithExtensionState(
			<ChangeCard
				message={makeCardMessage({ files: [{ path: "src/a.ts", additions: 12, deletions: 3 }], totalFiles: 1 })}
			/>,
		)

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByText("Confirm"))
		// A null file path is out of contract; the card must not treat it as a
		// step-level (no-file) result and resolve the step.
		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: { cardTs: 1000, filePath: null, success: true },
		})
		expect(screen.getByTestId("change-card-step-pending")).toBeInTheDocument()
	})

	it("labels the rollback controls and shows the accordion diff stats while collapsed", () => {
		renderWithExtensionState(
			<ChangeCard
				message={makeCardMessage({
					files: [{ path: "src/a.ts", additions: 12, deletions: 3, diff: DIFF_A }],
					totalFiles: 1,
				})}
			/>,
		)

		// The file affordance is announced through the aria label (icon-only
		// button) and the step button carries its localized label.
		expect(screen.getByTestId("change-card-file-rollback-0")).toHaveAttribute("aria-label", "Rollback this file")
		expect(screen.getByTestId("change-card-step-rollback")).toHaveTextContent("Rollback step")
		// The collapsed accordion still shows its diff stats in the header.
		expect(screen.getByText("+12")).toBeInTheDocument()
		expect(screen.getByText("-3")).toBeInTheDocument()

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		expect(screen.getByTestId("change-card-step-cancel")).toHaveTextContent("Cancel")
		fireEvent.click(screen.getByTestId("change-card-step-confirm"))
		expect(screen.getByTestId("change-card-step-pending")).toHaveTextContent("Rolling back...")
	})

	it("renders nothing for a card without checkpoint ids", () => {
		const { container } = renderWithExtensionState(<ChangeCard message={makeCardMessage({ checkpointIds: [] })} />)
		expect(container.innerHTML).toBe("")
	})
})
