import { describe, expect, it, type Mock, vi } from "bun:test";
import type { InteractiveModeContext } from "../../src/modes/types";
import type { AgentSession } from "../../src/session/agent-session";
import type { ModelChangeEntry, SessionEntry, SessionMessageEntry } from "../../src/session/session-entries";
import type { SessionManager } from "../../src/session/session-manager";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "../../src/slash-commands/types";

/**
 * Tests for the /undolast slash command — rewinds the conversation to the
 * entry before the last non-synthetic user message on the active branch.
 *
 * Uses typed mocks (no `any`) against the real InteractiveModeContext and
 * SessionManager contracts.
 */

function makeMessageEntry(
	id: string,
	parentId: string | null,
	role: "user" | "assistant",
	synthetic = false,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role,
			content: role === "user" ? "test prompt" : "test response",
			...(synthetic ? { synthetic: true } : {}),
		} as SessionMessageEntry["message"],
	};
}

interface UndolastTestHandle {
	runtime: TuiSlashCommandRuntime;
	navigateTree: Mock<(targetId: string, options: { summarize?: boolean }) => Promise<{ cancelled: boolean }>>;
	renderInitialMessages: Mock<(options?: { clearTerminalHistory?: boolean }) => void>;
	reloadTodos: Mock<() => Promise<void>>;
	showStatus: Mock<(message: string) => void>;
	showError: Mock<(message: string) => void>;
	setText: Mock<(text: string) => void>;
}

function makeTuiRuntime(entries: SessionEntry[]): UndolastTestHandle {
	const leafId = entries.length > 0 ? entries[entries.length - 1].id : null;

	const navigateTree = vi.fn(async (_targetId: string, _options: { summarize?: boolean }) => ({
		cancelled: false,
	}));

	const renderInitialMessages = vi.fn();
	const reloadTodos = vi.fn(async () => {});
	const showStatus = vi.fn();
	const showError = vi.fn();
	const setText = vi.fn();

	const sessionManager = {
		getBranch: () => entries,
		getLeafId: () => leafId,
	} as unknown as SessionManager;

	const session = {
		navigateTree,
	} as unknown as AgentSession;

	const ctx = {
		sessionManager,
		session,
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		renderInitialMessages,
		reloadTodos,
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;

	const runtime = { ctx } as unknown as TuiSlashCommandRuntime;

	return { runtime, navigateTree, renderInitialMessages, reloadTodos, showStatus, showError, setText };
}

describe("/undolast dispatch (TUI)", () => {
	it("rewinds to the entry before the last user message", async () => {
		const entries: SessionEntry[] = [
			makeMessageEntry("1", null, "user"),
			makeMessageEntry("2", "1", "assistant"),
			makeMessageEntry("3", "2", "user"),
			makeMessageEntry("4", "3", "assistant"),
		];

		const h = makeTuiRuntime(entries);
		const handled = await executeBuiltinSlashCommand("/undolast", h.runtime);

		expect(handled).toBe(true);
		expect(h.setText).toHaveBeenCalledWith("");
		// Target should be entry "2" (the assistant response before the last user message "3")
		expect(h.navigateTree).toHaveBeenCalledWith("2", { summarize: false });
		expect(h.renderInitialMessages).toHaveBeenCalledWith({ clearTerminalHistory: true });
		expect(h.showStatus).toHaveBeenCalledWith("Undid last turn");
	});

	it("shows 'Nothing to undo' when there are no user messages", async () => {
		const entries: SessionEntry[] = [makeMessageEntry("1", null, "assistant")];

		const h = makeTuiRuntime(entries);
		await executeBuiltinSlashCommand("/undolast", h.runtime);

		expect(h.showStatus).toHaveBeenCalledWith("Nothing to undo");
		expect(h.navigateTree).not.toHaveBeenCalled();
	});

	it("refuses to undo when the last user message is the first entry", async () => {
		const entries: SessionEntry[] = [makeMessageEntry("1", null, "user"), makeMessageEntry("2", "1", "assistant")];

		const h = makeTuiRuntime(entries);
		await executeBuiltinSlashCommand("/undolast", h.runtime);

		expect(h.showStatus).toHaveBeenCalledWith("Cannot undo the first message — use /clear instead");
		expect(h.navigateTree).not.toHaveBeenCalled();
	});

	it("refuses to undo when metadata entries precede the only user message", async () => {
		const modelChange: ModelChangeEntry = {
			type: "model_change",
			id: "0",
			parentId: null,
			timestamp: new Date().toISOString(),
			model: "openai/gpt-5",
		};
		const entries: SessionEntry[] = [
			modelChange,
			makeMessageEntry("1", "0", "user"),
			makeMessageEntry("2", "1", "assistant"),
		];

		const h = makeTuiRuntime(entries);
		await executeBuiltinSlashCommand("/undolast", h.runtime);

		// Only one real user message — cannot undo past the first turn
		expect(h.showStatus).toHaveBeenCalledWith("Cannot undo the first message — use /clear instead");
		expect(h.navigateTree).not.toHaveBeenCalled();
	});

	it("skips synthetic user messages when finding the last prompt", async () => {
		const entries: SessionEntry[] = [
			makeMessageEntry("1", null, "user"),
			makeMessageEntry("2", "1", "assistant"),
			// Synthetic auto-continue message — should be skipped
			makeMessageEntry("3", "2", "user", true),
			makeMessageEntry("4", "3", "assistant"),
		];

		const h = makeTuiRuntime(entries);
		await executeBuiltinSlashCommand("/undolast", h.runtime);

		// Should target entry "1" (before the last real user message at index 0)
		// But entry "1" is the first entry, so it should say "Cannot undo"
		expect(h.showStatus).toHaveBeenCalledWith("Cannot undo the first message — use /clear instead");
	});

	it("works when metadata entries precede the first turn with 2+ user turns", async () => {
		const modelChange: ModelChangeEntry = {
			type: "model_change",
			id: "0",
			parentId: null,
			timestamp: new Date().toISOString(),
			model: "openai/gpt-5",
		};
		const entries: SessionEntry[] = [
			modelChange,
			makeMessageEntry("1", "0", "user"),
			makeMessageEntry("2", "1", "assistant"),
			makeMessageEntry("3", "2", "user"),
			makeMessageEntry("4", "3", "assistant"),
		];

		const h = makeTuiRuntime(entries);
		await executeBuiltinSlashCommand("/undolast", h.runtime);

		// Should target entry "2" (assistant response before the second user message "3")
		expect(h.navigateTree).toHaveBeenCalledWith("2", { summarize: false });
		expect(h.renderInitialMessages).toHaveBeenCalledWith({ clearTerminalHistory: true });
		expect(h.showStatus).toHaveBeenCalledWith("Undid last turn");
	});

	it("handles navigateTree cancellation", async () => {
		const entries: SessionEntry[] = [
			makeMessageEntry("1", null, "user"),
			makeMessageEntry("2", "1", "assistant"),
			makeMessageEntry("3", "2", "user"),
			makeMessageEntry("4", "3", "assistant"),
		];

		const h = makeTuiRuntime(entries);
		h.navigateTree.mockResolvedValue({ cancelled: true });

		await executeBuiltinSlashCommand("/undolast", h.runtime);

		expect(h.showStatus).toHaveBeenCalledWith("Undo cancelled");
		expect(h.renderInitialMessages).not.toHaveBeenCalled();
	});

	it("also responds to /undo alias", async () => {
		const entries: SessionEntry[] = [
			makeMessageEntry("1", null, "user"),
			makeMessageEntry("2", "1", "assistant"),
			makeMessageEntry("3", "2", "user"),
			makeMessageEntry("4", "3", "assistant"),
		];

		const h = makeTuiRuntime(entries);
		const handled = await executeBuiltinSlashCommand("/undo", h.runtime);

		expect(handled).toBe(true);
		expect(h.navigateTree).toHaveBeenCalledWith("2", { summarize: false });
	});
});
