import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createSettingsHooksExtension } from "../src/settings-hooks";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "../src/extensibility/extensions/types";

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

	/** Minimal mock of ExtensionAPI that collects event handlers. */
	interface MockApi {
		toolCallHandlers: Array<(event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void>>;
		toolResultHandlers: Array<(event: ToolResultEvent, ctx: ExtensionContext) => Promise<ToolResultEventResult | void>>;
		on: ExtensionAPI["on"];
	}

	function createMockApi(): MockApi {
		const toolCallHandlers: MockApi["toolCallHandlers"] = [];
		const toolResultHandlers: MockApi["toolResultHandlers"] = [];
		const on: ExtensionAPI["on"] = (event, handler) => {
			if (event === "tool_call") toolCallHandlers.push(handler as MockApi["toolCallHandlers"][number]);
			if (event === "tool_result") toolResultHandlers.push(handler as MockApi["toolResultHandlers"][number]);
		};
		return { on, toolCallHandlers, toolResultHandlers };
	}

	function makeCtx(cwd: string = tmpCwd): ExtensionContext {
		// Minimal context — only fields the extension actually uses.
		return { cwd } as unknown as ExtensionContext;
	}

	/** Fabricate a ToolCallEvent for the given tool. */
	function makeCallEvent(toolName: string, input: Record<string, unknown> = {}): ToolCallEvent {
		return {
			type: "tool_call",
			toolName,
			toolCallId: `test-${toolName}`,
			input,
		} as unknown as ToolCallEvent;
	}

	/** Fabricate a ToolResultEvent for the given tool. */
	function makeResultEvent(
		toolName: string,
		input: Record<string, unknown>,
		content: Array<{ type: "text"; text: string }>,
		isError = false,
	): ToolResultEvent {
		return {
			type: "tool_result",
			toolName,
			toolCallId: `test-${toolName}`,
			input,
			content,
			isError,
			details: undefined,
		} as unknown as ToolResultEvent;
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
		createSettingsHooksExtension()(api);

		const event = makeCallEvent("bash", { command: "git push origin main" });
		const result = await api.toolCallHandlers[0](event, makeCtx());

		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("direct push to main is not allowed");
	});

	test("PreToolUse hook with permissionDecision allow does not block", async () => {
		const allowScript = `echo '{"permissionDecision":"allow"}'`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: allowScript }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension()(api);

		const event = makeCallEvent("bash", { command: "echo hello" });
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
		createSettingsHooksExtension()(api);

		const event = makeCallEvent("bash", { command: "git commit" });
		const result = await api.toolCallHandlers[0](event, makeCtx());

		expect(result?.block).toBe(true);
		// stderr is the Claude deny reason, not stdout
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
		createSettingsHooksExtension()(api);

		const event = makeCallEvent("bash", { command: "ls" });
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
		createSettingsHooksExtension()(api);

		const event = makeCallEvent("bash", { command: "ls" });
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
		createSettingsHooksExtension()(api);

		// Should block any tool
		for (const toolName of ["bash", "read", "write", "edit"]) {
			const event = makeCallEvent(toolName);
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
		createSettingsHooksExtension()(api);

		// edit should be blocked
		const editEvent = makeCallEvent("edit");
		const editResult = await api.toolCallHandlers[0](editEvent, makeCtx());
		expect(editResult?.block).toBe(true);
		expect(editResult?.reason).toBe("edit blocked");

		// bash should NOT be blocked
		const bashEvent = makeCallEvent("bash", { command: "ls" });
		const bashResult = await api.toolCallHandlers[0](bashEvent, makeCtx());
		expect(bashResult).toBeUndefined();
	});

	test("PreToolUse pipe-separated matcher matches multiple tools", async () => {
		const denyMulti = `echo '{"permissionDecision":"deny","permissionDecisionReason":"multi-blocked"}'`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Edit|Write", hooks: [{ type: "command", command: denyMulti }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension()(api);

		// edit and write should be blocked
		for (const toolName of ["edit", "write"]) {
			const event = makeCallEvent(toolName);
			const result = await api.toolCallHandlers[0](event, makeCtx());
			expect(result?.block).toBe(true);
			expect(result?.reason).toBe("multi-blocked");
		}

		// bash should NOT be blocked
		const bashEvent = makeCallEvent("bash", { command: "ls" });
		const bashResult = await api.toolCallHandlers[0](bashEvent, makeCtx());
		expect(bashResult).toBeUndefined();
	});

	test("PreToolUse omitted matcher matches all tools (Claude convention)", async () => {
		const denyAll = `echo '{"permissionDecision":"deny","permissionDecisionReason":"no-matcher-block"}'`;
		await writeUserSettings({
			PreToolUse: [
				// No matcher field — should match all
				{ hooks: [{ type: "command", command: denyAll }] } as Record<string, unknown>,
			] as unknown as Array<Record<string, unknown>>,
		});

		const api = createMockApi();
		createSettingsHooksExtension()(api);

		for (const toolName of ["bash", "read", "edit"]) {
			const event = makeCallEvent(toolName);
			const result = await api.toolCallHandlers[0](event, makeCtx());
			expect(result?.block).toBe(true);
			expect(result?.reason).toBe("no-matcher-block");
		}
	});

	test("no hooks in settings.json → no handlers registered with blocking behavior", async () => {
		// Write settings.json without a hooks key
		const dir = path.join(tmpHome, ".claude");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ someOtherKey: true }));

		const api = createMockApi();
		createSettingsHooksExtension()(api);

		// Even though handlers are registered, they should find no hooks and not block
		const event = makeCallEvent("bash", { command: "ls" });
		const result = await api.toolCallHandlers[0](event, makeCtx());
		expect(result).toBeUndefined();
	});

	test("project-level settings.json hooks are NOT loaded (security: no self-grant)", async () => {
		// User-level: deny bash
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: `echo '{"permissionDecision":"deny","permissionDecisionReason":"user-level deny"}'` }] },
			],
		});

		// Project-level: also deny write — should NOT be loaded
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
		createSettingsHooksExtension()(api);

		// bash → blocked by user-level hook
		const bashResult = await api.toolCallHandlers[0](makeCallEvent("bash", { command: "ls" }), makeCtx());
		expect(bashResult?.block).toBe(true);
		expect(bashResult?.reason).toBe("user-level deny");

		// write → NOT blocked (project hooks are not loaded)
		const writeResult = await api.toolCallHandlers[0](makeCallEvent("write"), makeCtx());
		expect(writeResult).toBeUndefined();
	});

	test("PostToolUse hook receives tool result and does not block", async () => {
		// PostToolUse hook writes stdin to a temp file so we can verify it ran
		const observeFile = path.join(tmpCwd, "post-hook-observed.json");
		const observeScript = `cat > "${observeFile}"`;
		await writeUserSettings({
			PostToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: observeScript }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension()(api);

		expect(api.toolResultHandlers).toHaveLength(1);

		const event = makeResultEvent(
			"bash",
			{ command: "ls" },
			[{ type: "text", text: "file1.txt\nfile2.txt" }],
		);
		const result = await api.toolResultHandlers[0](event, makeCtx());
		expect(result).toBeUndefined();

		// Verify the hook actually ran — the file should contain the hook stdin JSON
		const observed = await fs.readFile(observeFile, "utf-8");
		const parsed = JSON.parse(observed);
		expect(parsed.hook_event_name).toBe("PostToolUse");
		expect(parsed.tool_name).toBe("Bash");
		expect(parsed.tool_use_id).toBe("test-bash");
		expect(parsed.tool_input.command).toBe("ls");
	});

	test("PostToolUse hook does NOT fire on error results", async () => {
		// Hook that would write a file if invoked
		const observeFile = path.join(tmpCwd, "post-hook-should-not-exist.json");
		const observeScript = `cat > "${observeFile}"`;
		await writeUserSettings({
			PostToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: observeScript }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension()(api);

		const event = makeResultEvent(
			"bash",
			{ command: "ls" },
			[{ type: "text", text: "error: command not found" }],
			true, // isError = true
		);
		await api.toolResultHandlers[0](event, makeCtx());

		// The file should NOT exist — PostToolUse must not fire on errors
		const exists = await Bun.file(observeFile).exists();
		expect(exists).toBe(false);
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
		createSettingsHooksExtension()(api);

		const event = makeCallEvent("bash", { command: "rm -rf /" });
		const result = await api.toolCallHandlers[0](event, makeCtx());

		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("nested deny");
	});

	test("PreToolUse hook with `if` filter only blocks matching commands", async () => {
		const denyScript = `echo '{"permissionDecision":"deny","permissionDecisionReason":"push blocked"}'`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: denyScript, if: "Bash(git push*)" }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension()(api);

		// git push should be blocked
		const pushEvent = makeCallEvent("bash", { command: "git push origin main" });
		const pushResult = await api.toolCallHandlers[0](pushEvent, makeCtx());
		expect(pushResult?.block).toBe(true);
		expect(pushResult?.reason).toBe("push blocked");

		// ls should NOT be blocked (if filter doesn't match)
		const lsEvent = makeCallEvent("bash", { command: "ls -la" });
		const lsResult = await api.toolCallHandlers[0](lsEvent, makeCtx());
		expect(lsResult).toBeUndefined();

		// chained command with git push should also be blocked
		const chainedEvent = makeCallEvent("bash", { command: "npm test && git push origin main" });
		const chainedResult = await api.toolCallHandlers[0](chainedEvent, makeCtx());
		expect(chainedResult?.block).toBe(true);
	});

	test("PreToolUse hook stdin maps path to file_path for Read tool", async () => {
		const observeFile = path.join(tmpCwd, "read-hook-observed.json");
		const observeScript = `cat > "${observeFile}"`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Read", hooks: [{ type: "command", command: observeScript }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension()(api);

		const event = makeCallEvent("read", { path: "/tmp/test.txt" });
		await api.toolCallHandlers[0](event, makeCtx());

		const observed = await fs.readFile(observeFile, "utf-8");
		const parsed = JSON.parse(observed);
		// Claude expects file_path, not path
		expect(parsed.tool_input.file_path).toBe("/tmp/test.txt");
		expect(parsed.tool_input.path).toBe("/tmp/test.txt");
		expect(parsed.tool_name).toBe("Read");
	});

	test("PreToolUse hook with exec form (args) blocks the tool call", async () => {
		// Exec form: args array instead of command string
		const denyScript = `echo '{"permissionDecision":"deny","permissionDecisionReason":"exec-form deny"}'`;
		await writeUserSettings({
			PreToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", args: ["bash", "-c", denyScript] }] },
			],
		});

		const api = createMockApi();
		createSettingsHooksExtension()(api);

		const event = makeCallEvent("bash", { command: "ls" });
		const result = await api.toolCallHandlers[0](event, makeCtx());
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("exec-form deny");
	});
});
