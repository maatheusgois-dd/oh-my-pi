/**
 * Built-in extension that bridges Claude Code PreToolUse/PostToolUse hooks
 * defined in `~/.claude/settings.json` and `.claude/settings.json` into
 * OMP's existing `tool_call` / `tool_result` event bus.
 *
 * Implements Option A from issue #6446: ingest the `hooks` object from
 * Claude Code's `settings.json`, translate PascalCase tool matchers to OMP
 * tool ids, shell-execute matched hooks with Claude's stdin/stdout protocol,
 * and map `permissionDecision: "deny"` onto the existing `beforeToolCall`
 * block result.
 *
 * The feature activates when `settings.json` contains a `hooks` key — the
 * Claude Code native signal.  When no hooks are found the extension
 * registers no handlers and is inert.
 */
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { ExtensionFactory, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "../extensibility/extensions";
import type { ExtensionContext } from "../extensibility/extensions/types";
import * as logger from "../../../utils/src/logger";
// ─── Claude Code settings.json hook schema ────────────────────────────────

interface ClaudeHookEntry {
	type: "command";
	command: string;
	timeout?: number;
}

interface ClaudeHookGroup {
	matcher: string;
	hooks: ClaudeHookEntry[];
}

interface ClaudeHooks {
	PreToolUse?: ClaudeHookGroup[];
	PostToolUse?: ClaudeHookGroup[];
}

interface HookStdout {
	permissionDecision?: "allow" | "deny" | "ask";
	permissionDecisionReason?: string;
	hookSpecificOutput?: {
		permissionDecision?: "allow" | "deny" | "ask";
		permissionDecisionReason?: string;
	};
	additionalContext?: string;
}

// ─── Tool name mapping (Claude PascalCase → OMP lowercase) ────────────────

const CLAUDE_TOOL_MAP: Record<string, string> = {
	Bash: "bash",
	Read: "read",
	Edit: "edit",
	Write: "write",
	Glob: "glob",
	Grep: "grep",
	Search: "grep",
	NotebookEdit: "edit",
	WebFetch: "read",
	WebSearch: "web_search",
};

function mapToolName(matcher: string): string[] {
	if (matcher === "*") return ["*"];
	const omp = CLAUDE_TOOL_MAP[matcher];
	return omp ? [omp] : [matcher.toLowerCase()];
}

function toolMatches(eventToolName: string, ompNames: string[]): boolean {
	return ompNames.some(name => name === "*" || name === eventToolName);
}

// ─── Hook execution (Claude Code stdin/stdout protocol) ───────────────────

interface HookStdin {
	tool_input: Record<string, unknown>;
	cwd: string;
}

async function runShellHook(
	command: string,
	hookStdin: HookStdin,
	cwd: string,
	timeoutMs?: number,
): Promise<{ stdout: string; code: number; killed: boolean }> {
	const stdinPayload = JSON.stringify(hookStdin);
	const child = Bun.spawn(["bash", "-c", command], {
		cwd,
		stdin: new TextEncoder().encode(stdinPayload),
		stdout: "pipe",
		stderr: "pipe",
	});

	let timedOut = false;
	if (timeoutMs && timeoutMs > 0) {
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// Process may have already exited
			}
		}, timeoutMs);
		const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		clearTimeout(timer);
		return { stdout, code: child.exitCode ?? 0, killed: timedOut };
	}

	const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	return { stdout, code: child.exitCode ?? 0, killed: false };
}

// ─── Settings.json loading ───────────────────────────────────────────────

async function tryReadHooksFromSettings(settingsPath: string): Promise<ClaudeHooks | null> {
	try {
		const content = await Bun.file(settingsPath).text();
		const data = JSON.parse(content) as Record<string, unknown>;
		const rawHooks = data.hooks;
		if (!rawHooks || typeof rawHooks !== "object") return null;
		return validateHooks(rawHooks as Record<string, unknown>);
	} catch (err) {
		if (err instanceof Error && err.message.includes("ENOENT")) return null;
		logger.warn("settings-hooks: failed to read settings.json", {
			path: settingsPath,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

function validateHooks(raw: Record<string, unknown>): ClaudeHooks {
	const result: ClaudeHooks = {};
	const pre = raw.PreToolUse;
	const post = raw.PostToolUse;
	if (Array.isArray(pre)) result.PreToolUse = pre.filter(isHookGroup);
	if (Array.isArray(post)) result.PostToolUse = post.filter(isHookGroup);
	return result;
}

function isHookGroup(item: unknown): item is ClaudeHookGroup {
	if (typeof item !== "object" || item === null) return false;
	const g = item as Record<string, unknown>;
	return typeof g.matcher === "string" && Array.isArray(g.hooks);
}

function mergeHooks(base: ClaudeHooks, addition: ClaudeHooks): void {
	if (addition.PreToolUse) {
		base.PreToolUse = [...(base.PreToolUse ?? []), ...addition.PreToolUse];
	}
	if (addition.PostToolUse) {
		base.PostToolUse = [...(base.PostToolUse ?? []), ...addition.PostToolUse];
	}
}

async function readSettingsHooks(home: string, cwd: string): Promise<ClaudeHooks | null> {
	const hooks: ClaudeHooks = {};

	const userHooks = await tryReadHooksFromSettings(path.join(home, ".claude", "settings.json"));
	if (userHooks) mergeHooks(hooks, userHooks);

	const projectHooks = await tryReadHooksFromSettings(path.join(cwd, ".claude", "settings.json"));
	if (projectHooks) mergeHooks(hooks, projectHooks);

	const hasHooks = Boolean(hooks.PreToolUse?.length || hooks.PostToolUse?.length);
	return hasHooks ? hooks : null;
}

// ─── Extension factory ───────────────────────────────────────────────────

export const createSettingsHooksExtension: ExtensionFactory = api => {
	let loadedHooks: ClaudeHooks | null | undefined;
	let loadedCwd: string | null = null;

	const ensureLoaded = async (cwd: string, home: string): Promise<ClaudeHooks | null> => {
		if (loadedCwd === cwd && loadedHooks !== undefined) return loadedHooks;
		loadedCwd = cwd;
		loadedHooks = await readSettingsHooks(home, cwd);
		if (loadedHooks) {
			logger.info("settings-hooks: loaded Claude Code hooks from settings.json", {
				preToolUse: loadedHooks.PreToolUse?.length ?? 0,
				postToolUse: loadedHooks.PostToolUse?.length ?? 0,
			});
		}
		return loadedHooks;
	};

	// PreToolUse — can block execution
	api.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
		const home = process.env.HOME ?? ctx.cwd ?? "";
		const hooks = await ensureLoaded(ctx.cwd ?? home, home);
		if (!hooks?.PreToolUse) return;

		for (const group of hooks.PreToolUse) {
			if (!toolMatches(event.toolName, mapToolName(group.matcher))) continue;

			for (const hook of group.hooks) {
				if (hook.type !== "command") continue;
				const hookStdin: HookStdin = {
					tool_input: event.input,
					cwd: ctx.cwd ?? home,
				};
				const { stdout, code, killed } = await runShellHook(hook.command, hookStdin, ctx.cwd ?? home, hook.timeout);

				if (killed) {
					logger.warn("settings-hooks: PreToolUse hook timed out", {
						command: hook.command,
						matcher: group.matcher,
					});
					continue;
				}

				// Non-zero exit = deny (Claude Code protocol: exit 2 = block, others = error)
				if (code !== 0) {
					const reason = stdout.trim() || `Hook "${group.matcher}" exited with code ${code}`;
					return { block: true, reason };
				}

				// Parse JSON stdout for explicit permissionDecision
				const trimmed = stdout.trim();
				if (!trimmed) continue; // exit 0 + no JSON = allow
				try {
					const parsed = JSON.parse(trimmed) as HookStdout;
					const decision = parsed.permissionDecision ?? parsed.hookSpecificOutput?.permissionDecision;
					const reason = parsed.permissionDecisionReason ?? parsed.hookSpecificOutput?.permissionDecisionReason;
					if (decision === "deny") {
						return { block: true, reason: reason || `Blocked by PreToolUse hook: ${group.matcher}` };
					}
				} catch {
					// Non-JSON stdout with exit 0 = allow (informational output)
				}
			}
		}
	});

	// PostToolUse — can observe results (modification is a future enhancement)
	api.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
		const home = process.env.HOME ?? ctx.cwd ?? "";
		const hooks = await ensureLoaded(ctx.cwd ?? home, home);
		if (!hooks?.PostToolUse) return;

		for (const group of hooks.PostToolUse) {
			if (!toolMatches(event.toolName, mapToolName(group.matcher))) continue;

			for (const hook of group.hooks) {
				if (hook.type !== "command") continue;
				const hookStdin: HookStdin = {
					tool_input: event.input,
					cwd: ctx.cwd ?? home,
				};
				await runShellHook(hook.command, hookStdin, ctx.cwd ?? home, hook.timeout);
			}
		}
	});
};
