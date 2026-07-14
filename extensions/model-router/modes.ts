import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { MODE_NAMES, type ModeName } from "./types.ts";

/**
 * Minimal structural type for the branch source we need. `ReadonlySessionManager`
 * isn't re-exported from the package root, so we depend only on the one method
 * we use (matches `ctx.sessionManager.getBranch`).
 */
export interface BranchSource {
	getBranch(fromId?: string): SessionEntry[];
}

/** customType used for persisting the active mode as a session CustomEntry. */
export const MODE_ENTRY_TYPE = "model-router:mode";

interface ModePayload {
	mode: ModeName;
}

/**
 * Tracks the active router mode and persists it to the session so it survives
 * resume/fork. On session start, rehydrate() scans the branch for the most
 * recent mode entry.
 */
export class ModeState {
	private mode: ModeName;

	constructor(
		private readonly pi: ExtensionAPI,
		defaultMode: ModeName,
	) {
		this.mode = defaultMode;
	}

	get current(): ModeName {
		return this.mode;
	}

	/** Set the mode in memory and persist it. Returns false if unchanged. */
	set(mode: ModeName, persist = true): boolean {
		if (!MODE_NAMES.includes(mode)) return false;
		if (mode === this.mode) return false;
		this.mode = mode;
		if (persist) this.pi.appendEntry<ModePayload>(MODE_ENTRY_TYPE, { mode });
		return true;
	}

	/** Cycle to the next mode in order (plan → agent → ask → debug → plan). */
	cycle(): ModeName {
		const idx = MODE_NAMES.indexOf(this.mode);
		// Non-null: modulo keeps the index in bounds for the fixed, non-empty MODE_NAMES array.
		const next = MODE_NAMES[(idx + 1) % MODE_NAMES.length] as ModeName;
		this.set(next);
		return next;
	}

	/**
	 * Restore mode from the session branch (last-wins). Falls back to `fallback`
	 * (typically the resolved config default, or a CLI flag override) when no
	 * persisted entry exists. Returns true if a persisted entry was found.
	 */
	rehydrate(sm: BranchSource, fallback: ModeName): boolean {
		let restored: ModeName | undefined;
		for (const entry of sm.getBranch()) {
			if (entry.type === "custom" && entry.customType === MODE_ENTRY_TYPE) {
				const data = (entry as { data?: ModePayload }).data;
				if (data && MODE_NAMES.includes(data.mode)) restored = data.mode;
			}
		}
		this.mode = restored ?? fallback;
		return restored !== undefined;
	}
}

/** Whether a mode disables write tools (read-only exploration). */
export function isReadOnlyMode(mode: ModeName): boolean {
	return mode === "plan" || mode === "ask";
}

/** Whether a mode runs the full plan→validate→execute pipeline. */
export function usesPipeline(mode: ModeName): boolean {
	return mode === "agent" || mode === "debug";
}

/** One-line description of each mode for help/status text. */
export function describeMode(mode: ModeName): string {
	switch (mode) {
		case "plan":
			return "read-only exploration + planning (planner+validator, no execution)";
		case "agent":
			return "full autonomous pipeline (plan → validate → execute → tool-parse)";
		case "ask":
			return "direct Q&A, no plan phase, cheapest capable model";
		case "debug":
			return "hypothesis loop: root-cause analysis + fix + log parsing";
	}
}

/**
 * System-prompt addendum injected for the current mode via `before_agent_start`.
 * Explains the workflow/constraints to the model itself, on top of tool gating.
 */
export function modeSystemPromptAddendum(mode: ModeName): string {
	switch (mode) {
		case "plan":
			return [
				"\n\n## model-router: plan mode (read-only)",
				"You are in read-only exploration mode. Write/edit tools are disabled and only safe, read-only bash commands are allowed.",
				"Investigate the codebase and answer the user's request without making any changes.",
				"If a validated plan was injected into this conversation, present it clearly and explain the reasoning; do not attempt to execute it.",
				"If the user wants you to act on the plan, tell them to switch to agent mode (`/mode agent`).",
			].join("\n");
		case "agent":
			return [
				"\n\n## model-router: agent mode",
				"A plan may have been generated and validated for you before this turn started — if present, it appears as an injected message above.",
				"Follow the plan's steps in order. As you complete each numbered step, mark it inline with `[DONE:n]` (n = step number) so progress can be tracked.",
				"If reality diverges from the plan, adapt and explain why — the plan is guidance, not a rigid script.",
				'Steps may be tagged "[main]", "[subagent]", or "[parallel-group:N]". For "[subagent]" steps and groups of "[parallel-group:N]" steps that share the same N, consider calling the `dispatch_step` tool instead of doing the work inline — it runs each step in an isolated subagent process so it does not consume this conversation\'s context. "[main]" steps need this conversation\'s context and should not be dispatched.',
			].join("\n");
		case "ask":
			return [
				"\n\n## model-router: ask mode",
				"Answer directly and concisely. This mode skips planning — only use it for questions, explanations, or quick lookups, not multi-step work.",
				"If the request actually requires making changes or a multi-step plan, tell the user to switch to agent or plan mode.",
			].join("\n");
		case "debug":
			return [
				"\n\n## model-router: debug mode",
				"Work as a hypothesis-driven debugging loop: reproduce the issue, form a specific hypothesis about the root cause, instrument or inspect to confirm or reject it, then fix.",
				"Prefer verbose, explicit reasoning about *why* something fails over jumping straight to a fix.",
				"Quote exact error messages, stack traces, and line numbers verbatim when you find them.",
			].join("\n");
	}
}
