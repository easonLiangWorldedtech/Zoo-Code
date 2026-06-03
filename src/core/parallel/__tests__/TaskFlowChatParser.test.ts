/**
 * TaskFlowChatParser unit tests — Phase 7e.
 * Tests the chat command parser for TaskFlowAgent workflow control.
 */

import { describe, it, expect } from "vitest"

import { parseChatInput, generateOptions, resolveOptionSelection } from "../TaskFlowChatParser"

// ─── Slash Command Parsing ──────────────────────────────────────────────────────

describe("parseChatInput — slash commands", () => {
	it("parses /pause A", () => {
		const result = parseChatInput("/pause A")
		expect(result).toEqual({ action: "pause", nodeId: "A" })
	})

	it("parses /resume B", () => {
		const result = parseChatInput("/resume B")
		expect(result).toEqual({ action: "resume", nodeId: "B" })
	})

	it("parses /cancel C", () => {
		const result = parseChatInput("/cancel C")
		expect(result).toEqual({ action: "cancel", nodeId: "C" })
	})

	it("parses /skip D", () => {
		const result = parseChatInput("/skip D")
		expect(result).toEqual({ action: "skip", nodeId: "D" })
	})

	it("parses /rerun E search", () => {
		const result = parseChatInput("/rerun E search")
		expect(result?.action).toBe("rerun")
		expect(result?.nodeId).toBe("E")
		expect(result?.params?.type).toBe("search")
	})

	it("parses /add_node deploy to staging", () => {
		const result = parseChatInput("/add_node deploy to staging")
		expect(result?.action).toBe("add_node")
		expect(result?.params?.taskDescription).toBe("deploy to staging")
	})

	it("parses /list", () => {
		const result = parseChatInput("/list")
		expect(result).toEqual({ action: "list" })
	})

	it("parses /status", () => {
		const result = parseChatInput("/status")
		expect(result).toEqual({ action: "status" })
	})

	it("returns null for unknown slash command", () => {
		const result = parseChatInput("/unknown A")
		expect(result).toBeNull()
	})

	it("returns null for empty input", () => {
		expect(parseChatInput("")).toBeNull()
		expect(parseChatInput("   ")).toBeNull()
	})

	it("handles node IDs with hyphens and underscores", () => {
		const result = parseChatInput("/pause step-1")
		expect(result?.nodeId).toBe("step-1")

		const result2 = parseChatInput("/resume task_3")
		expect(result2?.nodeId).toBe("task_3")
	})
})

// ─── Natural Language Parsing (English) ──────────────────────────────────────────

describe("parseChatInput — natural language English", () => {
	it('parses "Pause A"', () => {
		const result = parseChatInput("Pause A")
		expect(result?.action).toBe("pause")
		expect(result?.nodeId).toBe("A")
	})

	it('parses "resume B"', () => {
		const result = parseChatInput("resume B")
		expect(result?.action).toBe("resume")
		expect(result?.nodeId).toBe("B")
	})

	it('parses "cancel C with search mode"', () => {
		const result = parseChatInput("cancel C with search mode")
		expect(result?.action).toBe("cancel")
		expect(result?.nodeId).toBe("C")
	})

	it('parses "rerun D using code"', () => {
		const result = parseChatInput("rerun D using code")
		expect(result?.action).toBe("rerun")
		expect(result?.nodeId).toBe("D")
		expect(result?.params?.type).toBe("code")
	})

	it('parses "add new node E deploy to staging"', () => {
		const result = parseChatInput("add new node E deploy to staging")
		expect(result?.action).toBe("add_node")
		expect(result?.nodeId).toBe("E")
	})

	it('parses "show all" as list', () => {
		const result = parseChatInput("show all")
		expect(result?.action).toBe("list")
	})

	it('parses "status check"', () => {
		const result = parseChatInput("status check")
		expect(result?.action).toBe("status")
	})
})

// ─── Natural Language Parsing (Chinese) ──────────────────────────────────────────

describe("parseChatInput — natural language Chinese", () => {
	it('parses "暫停 A"', () => {
		const result = parseChatInput("暫停 A")
		expect(result?.action).toBe("pause")
		expect(result?.nodeId).toBe("A")
	})

	it('parses "繼續 B"', () => {
		const result = parseChatInput("繼續 B")
		expect(result?.action).toBe("resume")
		expect(result?.nodeId).toBe("B")
	})

	it('parses "取消 C"', () => {
		const result = parseChatInput("取消 C")
		expect(result?.action).toBe("cancel")
		expect(result?.nodeId).toBe("C")
	})

	it('parses "跳過 D"', () => {
		const result = parseChatInput("跳過 D")
		expect(result?.action).toBe("skip")
		expect(result?.nodeId).toBe("D")
	})

	it('parses "新增 E deploy to staging"', () => {
		const result = parseChatInput("新增 E deploy to staging")
		expect(result?.action).toBe("add_node")
		expect(result?.params?.taskDescription).toContain("deploy to staging")
	})

	it('parses "重新執行 F 用 search mode"', () => {
		const result = parseChatInput("重新執行 F 用 search mode")
		expect(result?.action).toBe("rerun")
		expect(result?.nodeId).toBe("F")
		expect(result?.params?.type).toBe("search")
	})

	it('parses "狀態"', () => {
		const result = parseChatInput("狀態")
		expect(result?.action).toBe("status")
	})

	it('parses "列出所有"', () => {
		const result = parseChatInput("列出所有")
		expect(result?.action).toBe("list")
	})
})

// ─── AI Options System ──────────────────────────────────────────────────────────

describe("generateOptions", () => {
	it("generates pause options for running nodes", () => {
		const nodes = [
			{ id: "A", status: "running" },
			{ id: "B", status: "running" },
			{ id: "C", status: "completed" },
		]

		const options = generateOptions("pause", nodes)
		expect(options.length).toBe(2)
		expect(options[0].parsedInput).toEqual({ action: "pause", nodeId: "A" })
		expect(options[1].parsedInput).toEqual({ action: "pause", nodeId: "B" })
	})

	it("generates resume options for paused nodes", () => {
		const nodes = [
			{ id: "A", status: "paused" },
			{ id: "B", status: "running" },
		]

		const options = generateOptions("resume", nodes)
		expect(options.length).toBe(1)
		expect(options[0].parsedInput).toEqual({ action: "resume", nodeId: "A" })
	})

	it("generates cancel options for all nodes", () => {
		const nodes = [
			{ id: "A", status: "running" },
			{ id: "B", status: "paused" },
			{ id: "C", status: "completed" },
		]

		const options = generateOptions("cancel", nodes)
		expect(options.length).toBe(3)
	})

	it("generates rerun options for completed/failed nodes", () => {
		const nodes = [
			{ id: "A", status: "completed" },
			{ id: "B", status: "failed" },
			{ id: "C", status: "running" },
		]

		const options = generateOptions("rerun", nodes)
		expect(options.length).toBe(2)
		expect(options[0].parsedInput.action).toBe("rerun")
	})

	it("generates add_node option without specific nodes", () => {
		const options = generateOptions("add_node", [])
		expect(options.length).toBe(1)
		expect(options[0].parsedInput.action).toBe("add_node")
	})

	it("caps options at 8 per action type", () => {
		const nodes = Array.from({ length: 20 }, (_, i) => ({
			id: String.fromCharCode(65 + i),
			status: "running",
		}))

		const options = generateOptions("pause", nodes)
		expect(options.length).toBe(8)
	})
})

describe("resolveOptionSelection", () => {
	it("resolves a valid option selection", () => {
		const options = [
			{ number: 1, label: "A (running)", parsedInput: { action: "pause" as const, nodeId: "A" } },
			{ number: 2, label: "B (running)", parsedInput: { action: "pause" as const, nodeId: "B" } },
		]

		expect(resolveOptionSelection(options, 1)).toEqual({ action: "pause", nodeId: "A" })
		expect(resolveOptionSelection(options, 2)).toEqual({ action: "pause", nodeId: "B" })
	})

	it("returns null for invalid selection number", () => {
		const options = [
			{ number: 1, label: "A (running)", parsedInput: { action: "pause" as const, nodeId: "A" } },
		]

		expect(resolveOptionSelection(options, 99)).toBeNull()
	})
})

// ─── Edge Cases ──────────────────────────────────────────────────────────────────

describe("Edge cases", () => {
	it("handles mixed case slash commands", () => {
		const result = parseChatInput("/PAUSE A")
		expect(result?.action).toBe("pause")

		const result2 = parseChatInput("/Pause B")
		expect(result2?.action).toBe("pause")
	})

	it("ignores extra whitespace in slash commands", () => {
		const result = parseChatInput("/  pause   A  ")
		expect(result?.action).toBe("pause")
		expect(result?.nodeId).toBe("A")
	})

	it("handles node IDs starting with numbers as invalid", () => {
		const result = parseChatInput("/pause 123")
		expect(result?.nodeId).toBeUndefined()
	})

	it("parses rerun with different task types", () => {
		expect(parseChatInput("/rerun A doc")?.params?.type).toBe("doc")
		expect(parseChatInput("/rerun B code")?.params?.type).toBe("code")
		expect(parseChatInput("/rerun C commit")?.params?.type).toBe("commit")
	})

	it("returns null for unrecognized natural language", () => {
		expect(parseChatInput("hello world")).toBeNull()
		expect(parseChatInput("what is the weather")).toBeNull()
	})
})
