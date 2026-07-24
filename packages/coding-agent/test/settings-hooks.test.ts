import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createSettingsHooksExtension } from "../src/settings-hooks";

/**
 * Integration tests for the settings-hooks extension — verifies that
 * PreToolUse hooks from ~/.claude/settings.json block tool calls via the
 * existing `tool_call` event bus, and PostToolUse hooks observe results.
 *
 * These tests exercise the real extension factory with a temp HOME containing
 * a `.claude/settings.json` with hook definitions. No omp process is spawned.
 */
describe("settings-hooks extension", () => {
	let tmpHome: string;
	let tmpCwd: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "settings-hooks-test-"));
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "settings-hooks-cwd-"));
		originalHome = process.env.HOME;
		process.env.HOME = tmpHome;
	});

	afterEach(async () => {
		process.env.HOME = originalHome;
		await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
		await fs.rm(tmpCwd, { recursive: true, force: true }).catch(() => {});
	});

	/**
	 * Write a `.claude/settings.json` in the temp HOME with the given hooks.
	 */
	async function writeUserSettings(hooks: Record<string, unknown>): Promise<void> {
		const dir = path.join(tmpHome, ".claude");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ hooks }));
	}

	/**
	 * Create a minimal extension API mock that collects `tool_call` handlers
	 * and lets us invoke them with a fabricated event.
	 */
	function createMockApi() {
		const toolCallHandlers: Array<(event: any, ctx: any) => Promise<any>> = [];
		const toolResultHandlers: Array<(event: any, ctx: any) => Promise<any>> = [];
		return {
			on(event: string, handler: (event: any, ctx: any) => Promise<any>): void {
				if (event === "tool_call") toolCallHandlers.push(handler);
				if (event === "tool_result") toolResultHandlers.push(handler);
			},
			toolCallHandlers,
			toolResultHandlers,
		};
	}

	function makeCtx(cwd: string = tmpCwd): { cwd: string } {
		return { cwd };
	}

	test("PreToolUse hook with permissionDecision deny blocks the tool call", async () => {
		// Hook script: outputs JSON with deny decision
		const denyScript = `echo '{"permissionDecision":"deny","permissionDecisionReason":"direct push to main is not allowed"}'`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: denyScript }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension(api as any);

		expect(api.toolCallHandlers).toHaveLength(1);

		const event = {
			type: "tool_call" as const,
			toolName: "bash",
			toolCallId: "test-1",
			input: { command: "git push origin main" },
		};
		const result = await api.toolCallHandlers[0](event, makeCtx());

		expect(result).toEqual({
			block: true,
			reason: "direct push to main is not allowed",
		});
	});

	test("PreToolUse hook with permissionDecision allow does not block", async () => {
		const allowScript = `echo '{"permissionDecision":"allow"}'`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: allowScript }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension(api as any);

		const event = {
			type: "tool_call" as const,
			toolName: "bash",
			toolCallId: "test-2",
			input: { command: "echo hello" },
		};
		const result = await api.toolCallHandlers[0](event, makeCtx());

		// allow → no block (undefined return)
		expect(result).toBeUndefined();
	});

	test("PreToolUse hook with exit code 2 blocks the tool call (Claude deny protocol)", async () => {
		const failScript = `echo "rejected: secret detected" >&2; exit 2`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: failScript }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension(api as any);

		const event = {
			type: "tool_call" as const,
			toolName: "bash",
			toolCallId: "test-3",
			input: { command: "git commit" },
		};
		const result = await api.toolCallHandlers[0](event, makeCtx());

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("rejected: secret detected");
	});

	test("PreToolUse hook with non-2 non-zero exit does not block (hook error, not deny)", async () => {
		// exit 127 = command not found — should NOT block the tool call
		const errorScript = `exit 127`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: errorScript }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension(api as any);

		const event = {
			type: "tool_call" as const,
			toolName: "bash",
			toolCallId: "test-3b",
			input: { command: "ls" },
		};
		const result = await api.toolCallHandlers[0](event, makeCtx());

		// Non-2 non-zero exit = hook error, does not block
		expect(result).toBeUndefined();
	});

	test("PreToolUse hook with exit 0 and no JSON output allows the call", async () => {
		const infoScript = `echo "checking..."; exit 0`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: infoScript }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension(api as any);

		const event = {
			type: "tool_call" as const,
			toolName: "bash",
			toolCallId: "test-4",
			input: { command: "ls" },
		};
		const result = await api.toolCallHandlers[0](event, makeCtx());

		expect(result).toBeUndefined();
	});

	test("PreToolUse matcher '*' matches all tools", async () => {
		const denyAll = `echo '{"permissionDecision":"deny","permissionDecisionReason":"all blocked"}'`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "*", hooks: [{ type: "command", command: denyAll }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension(api as any);

		// Should block any tool
		for (const toolName of ["bash", "read", "write", "edit"]) {
			const event = {
				type: "tool_call" as const,
				toolName,
				toolCallId: `test-${toolName}`,
				input: {},
			};
			const result = await api.toolCallHandlers[0](event, makeCtx());
			expect(result?.block).toBe(true);
			expect(result?.reason).toBe("all blocked");
		}
	});

	test("PreToolUse matcher only fires for matching tool", async () => {
		const denyEdit = `echo '{"permissionDecision":"deny","permissionDecisionReason":"edit blocked"}'`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Edit", hooks: [{ type: "command", command: denyEdit }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension(api as any);

		// bash should not be blocked
		const bashEvent = {
			type: "tool_call" as const,
			toolName: "bash",
			toolCallId: "test-bash",
			input: { command: "ls" },
		};
		const bashResult = await api.toolCallHandlers[0](bashEvent, makeCtx());
		expect(bashResult).toBeUndefined();

		// edit should be blocked
		const editEvent = {
			type: "tool_call" as const,
			toolName: "edit",
			toolCallId: "test-edit",
			input: {},
		};
		const editResult = await api.toolCallHandlers[0](editEvent, makeCtx());
		expect(editResult?.block).toBe(true);
		expect(editResult?.reason).toBe("edit blocked");
	});

	test("PreToolUse pipe-separated matcher matches multiple tools", async () => {
		const denyMulti = `echo '{"permissionDecision":"deny","permissionDecisionReason":"multi-blocked"}'`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Edit|Write", hooks: [{ type: "command", command: denyMulti }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension(api as any);

		// edit and write should be blocked
		for (const toolName of ["edit", "write"]) {
			const event = {
				type: "tool_call" as const,
				toolName,
				toolCallId: `test-${toolName}`,
				input: {},
			};
			const result = await api.toolCallHandlers[0](event, makeCtx());
			expect(result?.block).toBe(true);
			expect(result?.reason).toBe("multi-blocked");
		}

		// bash should NOT be blocked
		const bashEvent = {
			type: "tool_call" as const,
			toolName: "bash",
			toolCallId: "test-bash-multi",
			input: { command: "ls" },
		};
		const bashResult = await api.toolCallHandlers[0](bashEvent, makeCtx());
		expect(bashResult).toBeUndefined();
	});

	test("no hooks in settings.json → no handlers registered with blocking behavior", async () => {
		// Write settings.json without a hooks key
		const dir = path.join(tmpHome, ".claude");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ someOtherKey: true }));

		const api = createMockApi();
		createSettingsHooksExtension(api as any);

		// tool_call handler is registered but should be inert (no hooks found)
		expect(api.toolCallHandlers).toHaveLength(1);
		const event = {
			type: "tool_call" as const,
			toolName: "bash",
			toolCallId: "test-noop",
			input: { command: "ls" },
		};
		const result = await api.toolCallHandlers[0](event, makeCtx());
		expect(result).toBeUndefined();
	});

	test("project-level settings.json hooks merge with user-level hooks", async () => {
		// User-level: deny bash
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: `echo '{"permissionDecision":"deny","permissionDecisionReason":"user-level deny"}'` }] },
			],
		});

		// Project-level: also deny write
		const projectDir = path.join(tmpCwd, ".claude");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.writeFile(
			path.join(projectDir, "settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{ matcher: "Write", hooks: [{ type: "command", command: `echo '{"permissionDecision":"deny","permissionDecisionReason":"project-level deny"}'` }] },
					],
				},
			}),
		);

		const api = createMockApi();
		createSettingsHooksExtension(api as any);

		// bash → blocked by user-level hook
		const bashResult = await api.toolCallHandlers[0](
			{ type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "ls" } },
			makeCtx(),
		);
		expect(bashResult?.block).toBe(true);
		expect(bashResult?.reason).toBe("user-level deny");

		// write → blocked by project-level hook
		const writeResult = await api.toolCallHandlers[0](
			{ type: "tool_call", toolName: "write", toolCallId: "t2", input: {} },
			makeCtx(),
		);
		expect(writeResult?.block).toBe(true);
		expect(writeResult?.reason).toBe("project-level deny");
	});

	test("PostToolUse hook is invoked and does not block", async () => {
		// PostToolUse hook that just echoes (observation)
		const observeScript = `echo "observed" > /dev/null; exit 0`;
		await writeUserSettings({
			PostToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: observeScript }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension(api as any);

		expect(api.toolResultHandlers).toHaveLength(1);

		const event = {
			type: "tool_result" as const,
			toolName: "bash",
			toolCallId: "test-post",
			input: { command: "ls" },
			content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
			details: undefined,
			isError: false,
		};
		// Should not throw and should return undefined (no modification)
		const result = await api.toolResultHandlers[0](event, makeCtx());
		expect(result).toBeUndefined();
	});

	test("hookSpecificOutput.permissionDecision deny also blocks", async () => {
		// Some hooks use hookSpecificOutput instead of top-level
		const script = `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"nested deny"}}'`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: script }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension(api as any);

		const event = {
			type: "tool_call" as const,
			toolName: "bash",
			toolCallId: "test-nested",
			input: { command: "rm -rf /" },
		};
		const result = await api.toolCallHandlers[0](event, makeCtx());

		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("nested deny");
	});
});
