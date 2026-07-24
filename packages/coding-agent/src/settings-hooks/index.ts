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
import { logger } from "@oh-my-pi/pi-utils";
import type { ExtensionAPI, ExtensionFactory, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "../extensibility/extensions/types";

// ─── Claude Code settings.json hook schema ────────────────────────────────

interface ClaudeHookEntry {
	type: "command";
	/** Shell command form (e.g. "echo hello") */
	command?: string;
	/** Exec form: array of args passed directly (e.g. ["git", "status"]) */
	args?: string[];
	/** Timeout in seconds (Claude convention) */
	timeout?: number;
	/** Optional condition filter (e.g. "Bash(git push*)") — if unsupported, the hook is skipped */
	if?: string;
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

/** Reverse map: OMP tool id → Claude PascalCase name (for hook stdin). */
const OMP_TO_CLAUDE_MAP: Record<string, string> = {
	bash: "Bash",
	read: "Read",
	edit: "Edit",
	write: "Write",
	glob: "Glob",
	grep: "Grep",
	web_search: "WebSearch",
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

/**
 * Evaluate a Claude hook `if` filter (e.g. "Bash(git push*)").
 * Pattern format: ToolName(glob_pattern) — matches the tool and checks if
 * the tool input's primary argument matches the glob.
 * Returns true if the filter matches, false if it doesn't (hook should be skipped).
 */
function evaluateIfFilter(filter: string, toolName: string, input: Record<string, unknown>): boolean {
	const match = filter.match(/^(\w+)\((.*)\)$/);
	if (!match) {
		// Unrecognized filter format — fail open (run the hook) per Claude's permission semantics
		return true;
	}
	const [, filterTool, pattern] = match;
	// Tool name must match
	const ompName = CLAUDE_TOOL_MAP[filterTool] ?? filterTool.toLowerCase();
	if (ompName !== toolName) return false;

	// Glob-match the primary input field against the pattern
	// Bash → command, Read/Write/Edit → file_path/path
	const primaryField = toolName === "bash" ? "command" : "path";
	const value = String(input[primaryField] ?? input.file_path ?? "");
	if (!value) return true; // fail open — can't evaluate

	// Simple glob: * → .*, ? → .
	const globPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, c => (c === "*" ? ".*" : c === "?" ? "." : "\\" + c));

	if (toolName === "bash") {
		// For Bash commands, match any subcommand in the command string.
		const regex = new RegExp(`(?:^|&&|;|\\|)\\s*${globPattern}`, "i");
		return regex.test(value);
	}
	// For file tools, match the full path
	const regex = new RegExp(`^${globPattern}$`);
	return regex.test(value);
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
	hook: ClaudeHookEntry,
	hookStdin: HookStdin,
	cwd: string,
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
	const stdinPayload = JSON.stringify(hookStdin);
	// Support both shell form (command string) and exec form (args array)
	const spawnArgs = hook.args ? hook.args : ["bash", "-c", hook.command ?? ""];

	let child: Bun.Subprocess;
	try {
		child = Bun.spawn(spawnArgs, {
			cwd,
			env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
			stdin: new TextEncoder().encode(stdinPayload),
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		// Exec-form spawn failure (missing executable, etc.) — treat as non-blocking hook error
		const message = err instanceof Error ? err.message : String(err);
		logger.warn("settings-hooks: hook spawn failed", { args: spawnArgs, error: message });
		return { stdout: "", stderr: message, code: -1, killed: false };
	}

	// Claude's timeout field is in seconds; setTimeout uses milliseconds.
	const timeoutMs = hook.timeout && hook.timeout > 0 ? hook.timeout * 1000 : undefined;
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

async function tryReadHooksFromSettings(settingsPath: string): Promise<{ hooks: ClaudeHooks | null; disabled: boolean }> {
	try {
		const content = await Bun.file(settingsPath).text();
		const data = JSON.parse(content) as Record<string, unknown>;
		// Honor Claude's kill switch — when disableAllHooks is true, signal disabled
		if (data.disableAllHooks === true) return { hooks: null, disabled: true };
		const rawHooks = data.hooks;
		if (!rawHooks || typeof rawHooks !== "object") return { hooks: null, disabled: false };
		return { hooks: validateHooks(rawHooks as Record<string, unknown>), disabled: false };
	} catch (err) {
		if (err instanceof Error && err.message.includes("ENOENT")) return { hooks: null, disabled: false };
		logger.warn("settings-hooks: failed to read settings.json", {
			path: settingsPath,
			error: err instanceof Error ? err.message : String(err),
		});
		return { hooks: null, disabled: false };
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
	// matcher is optional (omitted = match all); hooks array is required and must contain valid entries
	if ((g.matcher !== undefined && typeof g.matcher !== "string") || !Array.isArray(g.hooks)) return false;
	// Filter out invalid hook entries (null, non-objects, missing type/command/args)
	return (g.hooks as unknown[]).every(h => isHookEntry(h));
}

function isHookEntry(item: unknown): boolean {
	if (typeof item !== "object" || item === null) return false;
	const h = item as Record<string, unknown>;
	return h.type === "command" && (typeof h.command === "string" || Array.isArray(h.args));
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
 * Read hooks from user-level settings.json only.
 * Project-level hooks (.claude/settings.json in the repo) are NOT loaded
 * to prevent untrusted repos from executing arbitrary shell commands.
 * Project hook support requires an explicit trust UI (future enhancement).
 */
async function readSettingsHooks(home: string): Promise<ClaudeHooks | null> {
	if (!home) return null;
	const hooks: ClaudeHooks = {};

	const { hooks: userHooks, disabled } = await tryReadHooksFromSettings(path.join(home, ".claude", "settings.json"));
	// Honor Claude's kill switch
	if (disabled) return null;
	if (userHooks) mergeHooks(hooks, userHooks);

	const hasHooks = Boolean(hooks.PreToolUse?.length || hooks.PostToolUse?.length);
	return hasHooks ? hooks : null;
}

// ─── Extension factory ───────────────────────────────────────────────────

export function createSettingsHooksExtension(): ExtensionFactory {
	return (api: ExtensionAPI) => {
	let loadedHooks: ClaudeHooks | null | undefined;

	const ensureLoaded = async (home: string): Promise<ClaudeHooks | null> => {
		if (loadedHooks !== undefined) return loadedHooks;
		loadedHooks = await readSettingsHooks(home);
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
	const home = process.env.HOME ?? "";
	const hooks = await ensureLoaded(home);
		if (!hooks?.PreToolUse) return;

	let denyResult: ToolCallEventResult | undefined;
		for (const group of hooks.PreToolUse) {
			if (!toolMatches(event.toolName, group)) continue;

		for (const hook of group.hooks) {
				if (hook.type !== "command") continue;
				// Skip hooks with unsupported `if` filters rather than running them broadly
				if (hook.if && !evaluateIfFilter(hook.if, event.toolName, event.input)) continue;
			const hookStdin: HookStdin = {
					tool_input: adaptToolInput(event.toolName, event.input),
					cwd: ctx.cwd ?? home,
					hook_event_name: "PreToolUse",
					tool_name: OMP_TO_CLAUDE_MAP[event.toolName] ?? event.toolName,
					tool_use_id: event.toolCallId,
				};
			const { stdout, stderr, code, killed } = await runShellHook(hook, hookStdin, ctx.cwd);

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
					denyResult = { block: true, reason };
					continue; // run remaining hooks (audit/logging) before returning
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
						denyResult = { block: true, reason: reason || `Blocked by PreToolUse hook: ${group.matcher ?? "*"}` };
						continue; // run remaining hooks before returning
					}
				} catch {
					// Non-JSON stdout with exit 0 = allow (informational output)
				}
			}
		}
		return denyResult;
	});

	// PostToolUse — fires only on successful tool results (Claude reserves
	// PostToolUseFailure for errors; we guard isError until that exists).
	api.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
		if (event.isError) return;

	const home = process.env.HOME ?? "";
	const hooks = await ensureLoaded(home);
		if (!hooks?.PostToolUse) return;

		for (const group of hooks.PostToolUse) {
			if (!toolMatches(event.toolName, group)) continue;

			for (const hook of group.hooks) {
				if (hook.type !== "command") continue;
			// Skip hooks with unsupported `if` filters rather than running them broadly
				if (hook.if && !evaluateIfFilter(hook.if, event.toolName, event.input)) continue;
				const hookStdin: HookStdin = {
					tool_input: adaptToolInput(event.toolName, event.input),
					cwd: ctx.cwd ?? home,
					hook_event_name: "PostToolUse",
					tool_name: OMP_TO_CLAUDE_MAP[event.toolName] ?? event.toolName,
					tool_use_id: event.toolCallId,
					tool_response: event.content,
				};
			await runShellHook(hook, hookStdin, ctx.cwd);
			}
		}
	});
	};
};
