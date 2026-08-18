import { render, screen, fireEvent } from "@/utils/test-utils"

import { useExtensionState } from "@src/context/ExtensionStateContext"

import HistoryView from "../HistoryView"

vi.mock("@src/context/ExtensionStateContext")
vi.mock("@src/utils/vscode")

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({
		value,
		onInput,
		placeholder,
	}: {
		value?: string
		onInput?: (e: React.FormEvent) => void
		placeholder?: string
	}) => (
		// Wire both native events so tests can drive it with fireEvent.change or fireEvent.input.
		<input
			data-testid="history-search-input"
			placeholder={placeholder}
			value={value ?? ""}
			onInput={(e) => onInput?.(e)}
			onChange={(e) => onInput?.(e)}
		/>
	),
}))

// react-virtuoso needs a measured viewport to render items, which jsdom cannot provide.
// Render every item directly so tests can interact with task rows.
vi.mock("react-virtuoso", () => ({
	Virtuoso: <T,>({ data, itemContent }: { data: T[]; itemContent: (index: number, item: T) => React.ReactNode }) => (
		<div data-testid="virtuoso-container">
			{data.map((item, index) => (
				<div key={index}>{itemContent(index, item)}</div>
			))}
		</div>
	),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

const mockTaskHistory = [
	{
		id: "1",
		task: "Test task 1",
		ts: Date.now(),
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.002,
		workspace: "/test/workspace",
	},
	{
		id: "2",
		task: "Test task 2",
		ts: Date.now() + 1000,
		tokensIn: 200,
		tokensOut: 100,
		totalCost: 0.003,
		workspace: "/test/workspace",
	},
]

const mockTaskHistoryWithSubtasks = [
	{
		id: "parent-1",
		task: "Parent task with subtask",
		ts: Date.now(),
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.002,
		workspace: "/test/workspace",
	},
	{
		id: "child-1",
		task: "Child subtask of parent",
		ts: Date.now() + 1000,
		tokensIn: 200,
		tokensOut: 100,
		totalCost: 0.003,
		workspace: "/test/workspace",
		parentTaskId: "parent-1",
	},
]

describe("HistoryView", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			taskHistory: mockTaskHistory,
			cwd: "/test/workspace",
		})
	})

	it("renders the history interface", () => {
		const onDone = vi.fn()
		render(<HistoryView onDone={onDone} />)

		// Check for main UI elements
		expect(screen.getByText("history:history")).toBeInTheDocument()
		expect(screen.getByText("history:done")).toBeInTheDocument()
		expect(screen.getByPlaceholderText("history:searchPlaceholder")).toBeInTheDocument()
	})

	it("calls onDone when done button is clicked", () => {
		const onDone = vi.fn()
		render(<HistoryView onDone={onDone} />)

		const doneButton = screen.getByText("history:done")
		fireEvent.click(doneButton)

		expect(onDone).toHaveBeenCalled()
	})

	describe("cascade delete warning", () => {
		beforeEach(() => {
			vi.clearAllMocks()
			;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
				taskHistory: mockTaskHistoryWithSubtasks,
				cwd: "/test/workspace",
			})
		})

		it("shows subtask count warning when deleting a task with children in grouped mode", () => {
			render(<HistoryView onDone={vi.fn()} />)

			fireEvent.click(screen.getByTestId("delete-task-button"))

			expect(screen.getByText("history:deleteWithSubtasks")).toBeInTheDocument()
		})

		it("shows subtask count warning when deleting a task with children in search mode", () => {
			render(<HistoryView onDone={vi.fn()} />)

			// Enter search mode — useGroupedTasks returns empty groups, so the
			// subtask count must be derived from the full task list instead.
			// "Parent task with" matches only the parent row (fzf subsequence match;
			// the child title contains "parent" but not this phrase).
			fireEvent.change(screen.getByPlaceholderText("history:searchPlaceholder"), {
				target: { value: "Parent task with" },
			})

			fireEvent.click(screen.getByTestId("delete-task-button"))

			expect(screen.getByText("history:deleteWithSubtasks")).toBeInTheDocument()
		})
	})
})
