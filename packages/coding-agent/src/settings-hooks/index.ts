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
 * Security: requires the `claudeHooks.enabled` setting to be turned on.
 * Project-level hooks (`.claude/settings.json` in the repo) additionally
 * require `claudeHooks.trustProject` to avoid executing untrusted commands
 * from checked-out repositories.
 */
import * as path from "node:path";
import * as logger from "../../../utils/src/logger";
import type { ExtensionAPI, ExtensionFactory, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "../extensibility/extensions/types";

// ─── Claude Code settings.json hook schema ────────────────────────────────

interface ClaudeHookEntry {
	type: "command";
	command: string;
	/** Timeout in seconds (Claude convention) */
	timeout?: number;
}

interface ClaudeHookGroup {
	/** Claude matcher pattern. Omitted/empty = match all. Supports pipe/comma
	 * alternatives ("Edit|Write") and regex ("mcp__.*"). */
	matcher?: string;
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

/** OMP tool input field → Claude hook field name. */
const TOOL_FIELD_MAP: Record<string, string> = {
	path: "file_path",
	file_path: "file_path",
	command: "command",
	pattern: "pattern",
};

/** Translate an OMP tool input payload to Claude's expected field names. */
function adaptToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
	const adapted: Record<string, unknown> = { ...input };
	for (const [omp, claude] of Object.entries(TOOL_FIELD_MAP)) {
		if (omp !== claude && omp in adapted && !(claude in adapted)) {
			adapted[claude] = adapted[omp];
		}
	}
	// Claude expects `tool_name` in the PascalCase original, not the OMP lowercase id.
	void toolName;
	return adapted;
}

function mapToolName(matcher: string): string[] {
	if (matcher === "*") return ["*"];
	// Claude matchers support pipe-separated and comma-separated alternatives
	// (e.g. "Edit|Write", "Bash,Read"). Split on both before mapping each.
	const alternatives = matcher.split(/[|,]/).map(m => m.trim()).filter(Boolean);
	const results: string[] = [];
	for (const alt of alternatives) {
		const omp = CLAUDE_TOOL_MAP[alt];
		results.push(omp ?? alt.toLowerCase());
	}
	return results.length > 0 ? results : [matcher.toLowerCase()];
}

function toolMatches(eventToolName: string, group: ClaudeHookGroup): boolean {
	const matcher = group.matcher;
	// Omitted/empty matcher = match all tools
	if (!matcher || matcher.trim() === "") return true;
	// Regex matchers (e.g. "mcp__.*") — try as regex against the event tool name
	if (/[.*+?^${}()|[\]\\]/.test(matcher) && !Object.prototype.hasOwnProperty.call(CLAUDE_TOOL_MAP, matcher) && matcher !== "*") {
		try {
			const re = new RegExp(matcher, "i");
			return re.test(eventToolName);
		} catch {
			// Invalid regex — fall through to exact/pattern matching
		}
	}
	const ompNames = mapToolName(matcher);
	return ompNames.some(name => name === "*" || name === eventToolName);
}

// ─── Hook execution (Claude Code stdin/stdout protocol) ───────────────────

interface HookStdin {
	tool_input: Record<string, unknown>;
	cwd: string;
	/** OMP session id */
	session_id?: string;
	/** Hook event name: "PreToolUse" or "PostToolUse" */
	hook_event_name: string;
	/** Tool name (OMP lowercase id) */
	tool_name: string;
	/** Unique tool call id */
	tool_use_id?: string;
	/** PostToolUse: the tool result (Claude sends `tool_response`) */
	tool_response?: unknown;
}

async function runShellHook(
	command: string,
	hookStdin: HookStdin,
	cwd: string,
	timeoutSeconds?: number,
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
	const stdinPayload = JSON.stringify(hookStdin);
	const child = Bun.spawn(["bash", "-c", command], {
		cwd,
		stdin: new TextEncoder().encode(stdinPayload),
		stdout: "pipe",
		stderr: "pipe",
	});

	// Claude's timeout field is in seconds; setTimeout uses milliseconds.
	const timeoutMs = timeoutSeconds && timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined;
	let timedOut = false;
	if (timeoutMs) {
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// Process may have already exited
			}
		}, timeoutMs);
		// Drain stdout and stderr concurrently to avoid pipe deadlock.
		const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		clearTimeout(timer);
		return { stdout, stderr, code: child.exitCode ?? 0, killed: timedOut };
	}

	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { stdout, stderr, code: child.exitCode ?? 0, killed: false };
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
	// matcher is optional (omitted = match all); hooks array is required
	return (g.matcher === undefined || typeof g.matcher === "string") && Array.isArray(g.hooks);
}

function mergeHooks(base: ClaudeHooks, addition: ClaudeHooks): void {
	if (addition.PreToolUse) {
		base.PreToolUse = [...(base.PreToolUse ?? []), ...addition.PreToolUse];
	}
	if (addition.PostToolUse) {
		base.PostToolUse = [...(base.PostToolUse ?? []), ...addition.PostToolUse];
	}
}

/**
 * Read hooks from user-level settings.json (always) and project-level
 * settings.json (only when `trustProject` is true).
 */
async function readSettingsHooks(home: string, cwd: string, trustProject: boolean): Promise<ClaudeHooks | null> {
	const hooks: ClaudeHooks = {};

	const userHooks = await tryReadHooksFromSettings(path.join(home, ".claude", "settings.json"));
	if (userHooks) mergeHooks(hooks, userHooks);

	if (trustProject) {
		const projectHooks = await tryReadHooksFromSettings(path.join(cwd, ".claude", "settings.json"));
		if (projectHooks) mergeHooks(hooks, projectHooks);
	}

	const hasHooks = Boolean(hooks.PreToolUse?.length || hooks.PostToolUse?.length);
	return hasHooks ? hooks : null;
}

// ─── Extension factory ───────────────────────────────────────────────────

export function createSettingsHooksExtension(trustProject = false): ExtensionFactory {
	return (api: ExtensionAPI) => {
	let loadedHooks: ClaudeHooks | null | undefined;
	let loadedCwd: string | null = null;

	const ensureLoaded = async (cwd: string, home: string): Promise<ClaudeHooks | null> => {
		if (loadedCwd === cwd && loadedHooks !== undefined) return loadedHooks;
		loadedCwd = cwd;
		loadedHooks = await readSettingsHooks(home, cwd, trustProject);
		if (loadedHooks) {
			logger.info("settings-hooks: loaded Claude Code hooks from settings.json", {
				preToolUse: loadedHooks.PreToolUse?.length ?? 0,
				postToolUse: loadedHooks.PostToolUse?.length ?? 0,
				trustProject,
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
			if (!toolMatches(event.toolName, group)) continue;

			for (const hook of group.hooks) {
				if (hook.type !== "command") continue;
				const hookStdin: HookStdin = {
					tool_input: adaptToolInput(event.toolName, event.input),
					cwd: ctx.cwd ?? home,
					hook_event_name: "PreToolUse",
					tool_name: event.toolName,
					tool_use_id: event.toolCallId,
				};
				const { stdout, stderr, code, killed } = await runShellHook(hook.command, hookStdin, ctx.cwd ?? home, hook.timeout);

				if (killed) {
					logger.warn("settings-hooks: PreToolUse hook timed out", {
						command: hook.command,
						matcher: group.matcher,
					});
					continue;
				}

				// Claude Code protocol: exit 2 = deny (block), other non-zero = hook error
				// (do NOT block — a missing dependency like jq exit 127 should not deny the call)
				if (code === 2) {
					const reason = stderr.trim() || stdout.trim() || `Hook "${group.matcher ?? "*"}" denied the tool call`;
					return { block: true, reason };
				}
				if (code !== 0) {
					logger.warn("settings-hooks: PreToolUse hook error (non-blocking)", {
						command: hook.command,
						matcher: group.matcher,
						code,
						stderr: stderr.trim(),
					});
					continue;
				}

				// exit 0 — parse JSON stdout for explicit permissionDecision
				const trimmed = stdout.trim();
				if (!trimmed) continue; // exit 0 + no JSON = allow
				try {
					const parsed = JSON.parse(trimmed) as HookStdout;
					const decision = parsed.permissionDecision ?? parsed.hookSpecificOutput?.permissionDecision;
					const reason = parsed.permissionDecisionReason ?? parsed.hookSpecificOutput?.permissionDecisionReason;
					if (decision === "deny") {
						return { block: true, reason: reason || `Blocked by PreToolUse hook: ${group.matcher ?? "*"}` };
					}
				} catch {
					// Non-JSON stdout with exit 0 = allow (informational output)
				}
			}
		}
	});

	// PostToolUse — fires only on successful tool results (Claude reserves
	// PostToolUseFailure for errors; we guard isError until that exists).
	api.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
		if (event.isError) return;

		const home = process.env.HOME ?? ctx.cwd ?? "";
		const hooks = await ensureLoaded(ctx.cwd ?? home, home);
		if (!hooks?.PostToolUse) return;

		for (const group of hooks.PostToolUse) {
			if (!toolMatches(event.toolName, group)) continue;

			for (const hook of group.hooks) {
				if (hook.type !== "command") continue;
				const hookStdin: HookStdin = {
					tool_input: adaptToolInput(event.toolName, event.input),
					cwd: ctx.cwd ?? home,
					hook_event_name: "PostToolUse",
					tool_name: event.toolName,
					tool_use_id: event.toolCallId,
					tool_response: event.content,
				};
				await runShellHook(hook.command, hookStdin, ctx.cwd ?? home, hook.timeout);
			}
		}
	});
	};
};
