import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, resolveModelScopeWithDiagnostics, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONFIG_FILENAME, globalConfigPath, loadConfig, PRESET_NAMES, VALID_THINKING } from "./config.ts";
import { checkReadOnly } from "./guard.ts";
import { isReadOnlyMode, ModeState, describeMode, modeSystemPromptAddendum } from "./modes.ts";
import { applyRoleForTurn, type PipelineApplyResult, planAndValidate, runAgentPipeline, runAskMode } from "./pipeline.ts";
import { describeRole, modelKey, orderModelsForRole, resolveAllRoles, rolesForTier } from "./roles.ts";
import { nextTierUp } from "./router.ts";
import { SessionStats } from "./stats.ts";
import { runSubagents, type SubagentTask } from "./subagents.ts";
import { byteLength, compressToolOutput, shouldCompress, summaryLine } from "./toolparse.ts";
import {
	type Complexity,
	MODE_NAMES,
	type ModeName,
	type PlanGate,
	PLAN_GATE_MODES,
	type ResolvedRole,
	ROLE_NAMES,
	type RoleName,
	type RouterConfig,
} from "./types.ts";
import { clearStatus, notify, renderStatus, setPipelineWidget, setProgressWidget } from "./ui.ts";

/** customType used to persist the last pipeline run's trace notes (for /router last across process restarts). */
const PIPELINE_TRACE_ENTRY_TYPE = "model-router:trace";

/** Phase 2 escalation safety net: consecutive executor tool failures (agent/debug mode only) before the pinned tier escalates one notch. */
const TOOL_FAILURE_ESCALATION_THRESHOLD = 3;

/**
 * pi-tiered-router — routes work across Opus (plan) / Fable (validate) /
 * Sonnet (execute) / Haiku (tool-parse) to produce the best possible output.
 * M1: config, role resolution, manual plan/agent/ask/debug mode switching.
 * M2: classify → plan → validate → execute pipeline, effort-lever mapping,
 * read-only tool gating and per-mode system prompt addenda.
 */
export default function (pi: ExtensionAPI) {
	let config: RouterConfig | undefined;
	let roles: Record<RoleName, ResolvedRole> | undefined;
	let lastNotes: string[] = [];
	let toolparseEnabled = true;
	let debugTraceEnabled = false;
	// Manual-override pinning: when the user (not the router) changes the active
	// model — via /model, the model picker, or cycling — auto-routing pauses
	// until `/router auto` so the router stops fighting the user's choice.
	// `routerDrivenModelChange` distinguishes our own pi.setModel() calls (below)
	// from user-initiated ones: pi's model_select event carries the same
	// source ("set") for both, so it can't be used to tell them apart on its own.
	let overridePinned = false;
	let routerDrivenModelChange = false;
	// [DONE:n] plan-progress tracking (agent/debug mode): set whenever a plan is
	// injected, cleared when the run had no plan. `doneSteps` accumulates as the
	// executor marks steps off across the run's assistant messages.
	let lastPlanStepCount: number | undefined;
	let doneSteps = new Set<number>();
	// Dedup key for the last stats snapshot we notified about (agent_settled) —
	// avoids re-notifying the same cumulative summary every turn.
	let lastNotifiedStatsKey: string | undefined;
	// First-run "/router setup" hint: shown at most once per session.
	let firstRunHintShown = false;
	// Complexity-tiered role chains (opt-in, routing.tiers): once a turn commits
	// to a tier, later turns this session never drop below it — ratchet only
	// escalates, so a role's model stays stable turn-to-turn for provider prompt
	// caching. Reset on session_start. See PLAN.md §12 for the cache-economics
	// rationale; ask mode intentionally doesn't participate (it has its own
	// bespoke, always-cheap role selection, untouched by tiering).
	let pinnedTier: Complexity | undefined;
	// Phase 2 escalation safety net (PLAN.md §12): repeated validator rejections
	// or consecutive executor tool failures at the current pinned tier are
	// treated as evidence that tier is inadequate, so the pin moves one notch up
	// for subsequent turns (never retried mid-turn — see nextTierUp's doc
	// comment). `consecutiveToolFailures` only counts in agent/debug mode (where
	// the executor is actually driving tool calls) and resets on any success.
	let consecutiveToolFailures = 0;
	const stats = new SessionStats();
	const modeState = new ModeState(pi, "agent");

	/** Path to the debug-mode wire-level trace log (project-scoped, one line of JSON per request/response). */
	function traceFilePath(ctx: ExtensionContext): string {
		return path.join(ctx.cwd, ".pi", "model-router-trace.log");
	}

	/** Append one JSON line to the debug trace log. Best-effort: a logging failure must never break the session. */
	function appendTrace(ctx: ExtensionContext, entry: Record<string, unknown>): void {
		try {
			const file = traceFilePath(ctx);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.appendFileSync(file, `${JSON.stringify({ timestamp: Date.now(), ...entry })}\n`);
		} catch {
			// best-effort logging only
		}
	}

	function rehydrateLastNotes(ctx: ExtensionContext): void {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PIPELINE_TRACE_ENTRY_TYPE) {
				const data = (entry as { data?: { notes?: string[] } }).data;
				if (data?.notes) lastNotes = data.notes;
			}
		}
	}

	/** One-line summary of a pipeline run for a single notify() call (avoids toast spam). */
	function summarizeApplied(mode: ModeName, applied: PipelineApplyResult): string {
		const roleLabel = applied.appliedRole
			? `${applied.appliedRole.resolvedId} (${applied.appliedThinking})`
			: "model unchanged (role unresolved)";
		const { outcome } = applied;
		const planPart = outcome.plan
			? `${outcome.plan.steps.length}-step plan${outcome.validation ? ` [${outcome.validation.verdict}${outcome.revisions ? `, ${outcome.revisions} revision(s)` : ""}]` : ""}`
			: outcome.bypassed
				? "no plan (trivial bypass)"
				: "no plan";
		return `${mode} → ${roleLabel} · ${planPart}`;
	}

	/**
	 * Reload config + re-resolve roles. Deliberately does NOT touch the active
	 * mode: session_start establishes the mode separately via
	 * `modeState.rehydrate(...)` (falling back to `cfg.modes.default` only when
	 * there's no persisted mode), and reload() is also called mid-session by
	 * `/router reload` and the config editor/wizard — those must never reset a
	 * mode the user is actively in back to the config default.
	 */
	function reload(ctx: ExtensionContext): void {
		const presetFlag = pi.getFlag("router-preset");
		const { config: cfg, warnings } = loadConfig(ctx.cwd, ctx.isProjectTrusted(), {}, typeof presetFlag === "string" ? presetFlag : undefined);
		config = cfg;
		roles = resolveAllRoles(ctx.modelRegistry, cfg);

		for (const w of warnings) notify(ctx, w, "warning");

		const unresolved = ROLE_NAMES.filter((r) => !roles![r].model && !roles![r].skipped);
		for (const r of unresolved) {
			notify(
				ctx,
				`Could not resolve role "${r}" (wanted ${roles![r].requested}). Configure it with /router config or check API keys.`,
				"warning",
			);
		}
	}

	// ---------------------------------------------------------------------
	// Setup wizard (`/router setup` for all four roles, `/router config` for
	// one). Single implementation shared by both commands: `/router config` is
	// just the wizard scoped to a single pre-picked role.
	// ---------------------------------------------------------------------

	type RoleSelection =
		| { kind: "keep" }
		| { kind: "model"; model: ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number] }
		| { kind: "custom"; spec: string }
		| { kind: "skip" };

	/** Only validator/toolParser can be skipped — planner and executor are load-bearing for the pipeline to mean anything. */
	function roleCanBeSkipped(role: RoleName): boolean {
		return role === "validator" || role === "toolParser";
	}

	/** One-line explanation of each role, shown in its setup-wizard picker title. */
	const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
		planner: "decomposes the goal into a numbered plan",
		validator: "independently critiques the plan before execution (up to 2 revision rounds)",
		executor: "writes the code once the plan is validated",
		toolParser: "classifies task complexity and compresses noisy tool output",
	};

	/**
	 * Resolve pi's scoped-model patterns (Settings.enabledModels — the set the
	 * user curates for Ctrl+P cycling) to actual models, so the wizard can offer
	 * only the models the user already scoped instead of the entire registry.
	 * Best-effort: any failure, or no scope configured, returns an empty array —
	 * the caller falls back to the full registry rather than showing an empty
	 * picker.
	 */
	async function resolveScopedModels(ctx: ExtensionCommandContext): Promise<Model<any>[]> {
		try {
			const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
			const patterns = settings.getEnabledModels();
			if (!patterns || patterns.length === 0) return [];
			const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, ctx.modelRegistry);
			return scopedModels.map((sm) => sm.model);
		} catch {
			return [];
		}
	}

	/** Prompt for a role's model: only models in the user's pi model scope (falling back to the full registry when no scope is configured), current session model marked and surfaced first, plus keep/custom/skip. Returns undefined if the user cancels. */
	async function selectModelForRole(
		ctx: ExtensionCommandContext,
		role: RoleName,
		scopedModels: Model<any>[],
	): Promise<RoleSelection | undefined> {
		const current = roles?.[role];
		const pool = scopedModels.length > 0 ? scopedModels : ctx.modelRegistry.getAll();
		const sorted = orderModelsForRole({
			all: pool,
			currentModel: ctx.model,
			scopedIds: new Set(scopedModels.map(modelKey)),
			hasAuth: (m) => ctx.modelRegistry.hasConfiguredAuth(m),
		});
		const modelLabel = (m: (typeof sorted)[number]) => {
			const key = modelKey(m);
			const scopeMark = ctx.model && modelKey(ctx.model) === key ? "▶" : " ";
			const authMark = ctx.modelRegistry.hasConfiguredAuth(m) ? "✓" : " ";
			return `${scopeMark}${authMark} ${key}`;
		};

		const keepLabel = `Keep current (${current?.skipped ? "skipped" : (current?.resolvedId ?? `unresolved: ${current?.requested}`)})`;
		const customLabel = "Custom spec… (type provider/model-id, wildcards like anthropic/claude-opus-* allowed)";
		const skipLabel = "Skip this role (disable this pipeline stage)";
		const canSkip = roleCanBeSkipped(role);

		const options = [keepLabel, ...sorted.map(modelLabel), customLabel, ...(canSkip ? [skipLabel] : [])];
		const picked = await ctx.ui.select(`Model for the "${role}" role — ${ROLE_DESCRIPTIONS[role]}`, options);
		if (picked === undefined) return undefined;

		if (picked === keepLabel) return { kind: "keep" };
		if (picked === customLabel) {
			const spec = await ctx.ui.input(
				`Model spec for "${role}" (provider/model-id, "provider/prefix-*", or "skip")`,
				current?.requested ?? "",
			);
			return spec ? { kind: "custom", spec } : undefined;
		}
		if (canSkip && picked === skipLabel) return { kind: "skip" };

		const model = sorted.find((m) => modelLabel(m) === picked);
		return model ? { kind: "model", model } : undefined;
	}

	/** Prompt for a role's thinking level, preselecting the current value. */
	async function selectThinkingForRole(ctx: ExtensionCommandContext, role: RoleName): Promise<ThinkingLevel | undefined> {
		const current = config?.roles[role].thinking;
		const picked = await ctx.ui.select(`Thinking level for "${role}"${current ? ` (current: ${current})` : ""}`, VALID_THINKING);
		return picked as ThinkingLevel | undefined;
	}

	interface ConfigScope {
		file: string;
		label: "global" | "project";
	}

	/** Prompt for global vs. project scope; project is only offered when trusted (untrusted project config is ignored on load anyway). */
	async function selectScope(ctx: ExtensionCommandContext): Promise<ConfigScope | undefined> {
		const globalFile = globalConfigPath();
		const projectFile = path.join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);
		const globalLabel = `Global (${globalFile} — applies to all projects)`;
		if (!ctx.isProjectTrusted()) return { file: globalFile, label: "global" };

		const projectLabel = `Project (${projectFile} — this project only)`;
		const picked = await ctx.ui.select("Save to which config scope?", [globalLabel, projectLabel]);
		if (!picked) return undefined;
		return picked === globalLabel ? { file: globalFile, label: "global" } : { file: projectFile, label: "project" };
	}

	/** Merge role updates into whatever JSON already exists at `file` and write it back. */
	function writeRoleConfig(file: string, updates: Partial<Record<RoleName, { model: string; thinking: ThinkingLevel }>>): void {
		let existing: Record<string, unknown> = {};
		if (fs.existsSync(file)) {
			try {
				existing = JSON.parse(fs.readFileSync(file, "utf-8"));
			} catch {
				existing = {};
			}
		}
		const existingRoles =
			typeof existing.roles === "object" && existing.roles !== null && !Array.isArray(existing.roles)
				? (existing.roles as Record<string, unknown>)
				: {};
		for (const [role, entry] of Object.entries(updates)) existingRoles[role] = entry;
		existing.roles = existingRoles;

		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`);
	}

	/**
	 * A global-scope write is silently shadowed for any role a *trusted* project
	 * config already defines (project always wins — see config.ts's precedence).
	 * Returns the role names that would be shadowed, so the caller can warn.
	 */
	function shadowedByProjectConfig(ctx: ExtensionCommandContext, scope: ConfigScope, changedRoles: RoleName[]): RoleName[] {
		if (scope.label !== "global" || !ctx.isProjectTrusted()) return [];
		const projectFile = path.join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);
		if (!fs.existsSync(projectFile)) return [];
		try {
			const projectCfg = JSON.parse(fs.readFileSync(projectFile, "utf-8"));
			const projectRoles = (projectCfg?.roles ?? {}) as Record<string, unknown>;
			return changedRoles.filter((r) => projectRoles[r] !== undefined);
		} catch {
			return [];
		}
	}

	/**
	 * Guided setup: walks `targetRoles` (all four for `/router setup`, one for
	 * `/router config`) prompting a model + thinking level for each, then a
	 * single scope choice, then writes and reloads. TUI only — the caller must
	 * check `ctx.hasUI` first.
	 */
	async function runSetupWizard(ctx: ExtensionCommandContext, targetRoles: RoleName[]): Promise<void> {
		const scopedModels = await resolveScopedModels(ctx);
		notify(
			ctx,
			scopedModels.length > 0
				? `Showing your pi model scope (${scopedModels.length} models). ▶ current session model   ✓ auth configured`
				: "No pi model scope configured — showing the full model registry. ▶ current session model   ✓ auth configured",
			"info",
		);

		const updates: Partial<Record<RoleName, { model: string; thinking: ThinkingLevel }>> = {};
		const changedRoles: RoleName[] = [];

		for (const role of targetRoles) {
			const selection = await selectModelForRole(ctx, role, scopedModels);
			if (!selection || selection.kind === "keep") continue;

			if (selection.kind === "skip") {
				updates[role] = { model: "skip", thinking: "off" };
				changedRoles.push(role);
				continue;
			}

			const spec = selection.kind === "custom" ? selection.spec : `${selection.model.provider}/${selection.model.id}`;
			const thinking = await selectThinkingForRole(ctx, role);
			if (!thinking) continue; // cancelled mid-role: don't half-apply it
			updates[role] = { model: spec, thinking };
			changedRoles.push(role);
		}

		if (changedRoles.length === 0) {
			notify(ctx, "model-router setup: no changes made.", "info");
			return;
		}

		const scope = await selectScope(ctx);
		if (!scope) {
			notify(ctx, "model-router setup: cancelled (no scope chosen); no changes were written.", "warning");
			return;
		}

		const shadowed = shadowedByProjectConfig(ctx, scope, changedRoles);
		if (shadowed.length > 0) {
			notify(
				ctx,
				`Note: ${shadowed.join(", ")} ${shadowed.length === 1 ? "is" : "are"} also set in the trusted project config, ` +
					`which takes precedence over this global change until removed there.`,
				"warning",
			);
		}

		writeRoleConfig(scope.file, updates);
		reload(ctx);
		renderStatus(ctx, modeState.current, roles!, overridePinned);
		notify(
			ctx,
			[`Saved to ${scope.file}:`, ...changedRoles.map((r) => `  ${describeRole(roles![r])}`)].join("\n"),
			"info",
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		stats.reset();
		lastNotifiedStatsKey = undefined;
		lastPlanStepCount = undefined;
		doneSteps = new Set();
		pinnedTier = undefined;
		consecutiveToolFailures = 0;
		reload(ctx);
		rehydrateLastNotes(ctx);

		const restoredFromSession = modeState.rehydrate(ctx.sessionManager, config!.modes.default);
		if (!restoredFromSession) {
			// No persisted mode entry (new session): honor --mode-router if given.
			const flag = pi.getFlag("mode-router");
			if (typeof flag === "string") {
				if (MODE_NAMES.includes(flag as ModeName)) {
					modeState.set(flag as ModeName, false);
				} else {
					notify(ctx, `Ignoring invalid --mode-router "${flag}". Valid: ${MODE_NAMES.join(", ")}`, "warning");
				}
			}
		}

		renderStatus(ctx, modeState.current, roles!);

		// First-run hint: only when there's truly no config file at either scope
		// yet AND at least one role failed to resolve — a fresh install pointed at
		// a registry that doesn't have the default Anthropic models configured,
		// say. Never a blocking prompt, never repeated within a session.
		if (!firstRunHintShown && ctx.hasUI) {
			const projectFile = path.join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);
			const noConfigYet = !fs.existsSync(globalConfigPath()) && !fs.existsSync(projectFile);
			const anyUnresolved = ROLE_NAMES.some((r) => !roles![r].model && !roles![r].skipped);
			if (noConfigYet && anyUnresolved) {
				firstRunHintShown = true;
				notify(
					ctx,
					'model-router: some roles are unresolved and no config file exists yet — run "/router setup" to configure all four interactively (or "/router help" to see all subcommands).',
					"info",
				);
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearStatus(ctx);
		setProgressWidget(ctx, undefined);
	});

	// [DONE:n] plan-progress widget: scan each finalized assistant message for the
	// convention taught in modeSystemPromptAddendum("agent") and update a small
	// "Plan progress: n/total done" widget above the editor.
	pi.on("message_end", async (event, ctx) => {
		if (lastPlanStepCount === undefined) return;
		const msg = event.message as { role?: string; content?: Array<{ type: string; text?: string }> };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;

		const text = msg.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join("\n");

		let changed = false;
		for (const m of text.matchAll(/\[DONE:(\d+)\]/g)) {
			const n = Number(m[1]);
			if (n >= 1 && n <= lastPlanStepCount && !doneSteps.has(n)) {
				doneSteps.add(n);
				changed = true;
			}
		}
		if (changed) setProgressWidget(ctx, [`Plan progress: ${doneSteps.size}/${lastPlanStepCount} done`]);
	});

	// Keep resolution fresh if the model registry/auth changes mid-session (e.g. /login).
	// Also detects manual (non-router) model changes to pin auto-routing off — see
	// the `overridePinned`/`routerDrivenModelChange` declarations above for why.
	pi.on("model_select", async (event, ctx) => {
		if (!config) return;
		// "restore" is pi re-applying a persisted model on session load/resume —
		// not a manual override, so it must never trigger pinning even though it
		// isn't router-driven either. Only "set"/"cycle" reflect an actual user
		// action taken this session.
		if (!routerDrivenModelChange && !overridePinned && event.source !== "restore") {
			overridePinned = true;
			notify(ctx, "model-router: manual model change detected — auto-routing paused until `/router auto`.", "info");
		}
		roles = resolveAllRoles(ctx.modelRegistry, config);
		renderStatus(ctx, modeState.current, roles, overridePinned);
	});

	// Same override-pinning as model_select, for manual thinking-level changes
	// (e.g. the user's own /thinking command) — our own setThinkingLevel() call
	// happens inside the same routerDrivenModelChange=true window as setModel().
	pi.on("thinking_level_select", async (_event, ctx) => {
		if (!config || !roles) return;
		if (!routerDrivenModelChange && !overridePinned) {
			overridePinned = true;
			notify(ctx, "model-router: manual thinking-level change detected — auto-routing paused until `/router auto`.", "info");
			renderStatus(ctx, modeState.current, roles, overridePinned);
		}
	});

	pi.registerFlag("mode-router", {
		description: "Initial model-router mode: plan | agent | ask | debug",
		type: "string",
	});

	pi.registerFlag("router-preset", {
		description: `model-router config preset: ${PRESET_NAMES.join(" | ")} (a user/project config file still overrides preset values)`,
		type: "string",
	});

	pi.registerShortcut("ctrl+alt+m", {
		description: "Cycle model-router mode (plan → agent → ask → debug)",
		handler: async (ctx) => {
			const next = modeState.cycle();
			if (roles) renderStatus(ctx, next, roles);
			notify(ctx, `mode: ${next} — ${describeMode(next)}`, "info");
		},
	});

	pi.registerCommand("mode", {
		description: "Show or set the model-router mode (plan | agent | ask | debug)",
		getArgumentCompletions: (prefix) =>
			MODE_NAMES.filter((m) => m.startsWith(prefix)).map((m) => ({ value: m, label: m })),
		handler: async (args, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();
			if (!arg) {
				notify(ctx, `mode: ${modeState.current} — ${describeMode(modeState.current)}`, "info");
				return;
			}
			if (!MODE_NAMES.includes(arg as ModeName)) {
				notify(ctx, `Unknown mode "${arg}". Valid: ${MODE_NAMES.join(", ")}`, "error");
				return;
			}
			modeState.set(arg as ModeName);
			if (roles) renderStatus(ctx, modeState.current, roles);
			notify(ctx, `mode: ${modeState.current} — ${describeMode(modeState.current)}`, "info");
		},
	});

	const ROUTER_SUBCOMMANDS: { value: string; description: string }[] = [
		{ value: "setup", description: "guided setup for all four roles" },
		{ value: "config", description: "guided setup for one role" },
		{ value: "reload", description: "re-read config files and re-resolve roles" },
		{ value: "auto", description: "resume auto-routing after a manual model/thinking override" },
		{ value: "last", description: "show the last pipeline run's trace notes" },
		{ value: "stats", description: "session token/cost stats" },
		{ value: "trace", description: "show debug-mode wire-trace status" },
		{ value: "trace on", description: "enable debug-mode wire tracing" },
		{ value: "trace off", description: "disable debug-mode wire tracing" },
		{ value: "toolparse on", description: "enable tool-output compression" },
		{ value: "toolparse off", description: "disable tool-output compression" },
		{ value: "gate", description: "show the plan-approval gate mode" },
		{ value: "gate off", description: "disable the human plan gate" },
		{ value: "gate replace-validator", description: "human gate replaces the automated validator" },
		{ value: "gate after-validator", description: "human gate runs after the automated validator" },
		{ value: "help", description: "show this list" },
	];

	const GATE_DESCRIPTIONS: Record<PlanGate, string> = {
		off: "fully automated — no plan approval prompt",
		"replace-validator": "you review the plan; the automated validator is skipped",
		"after-validator": "the automated validator runs first, then you review",
	};

	const ROUTER_HELP = [
		"/router subcommands:",
		...ROUTER_SUBCOMMANDS.map((c) => `  ${c.value.padEnd(14)} ${c.description}`),
		"",
		"/router (no args) shows the status dashboard.",
	].join("\n");

	pi.registerCommand("router", {
		description: "model-router status dashboard: resolved roles, mode, config sources — try /router help",
		getArgumentCompletions: (prefix) =>
			ROUTER_SUBCOMMANDS.filter((c) => c.value.startsWith(prefix.toLowerCase())).map((c) => ({
				value: c.value,
				label: c.value,
				description: c.description,
			})),
		handler: async (args, ctx: ExtensionCommandContext) => {
			const sub = args.trim().toLowerCase();

			if (sub === "help") {
				notify(ctx, ROUTER_HELP, "info");
				return;
			}

			if (sub === "reload") {
				reload(ctx);
				renderStatus(ctx, modeState.current, roles!);
				notify(ctx, "config reloaded", "info");
				return;
			}

			if (sub === "last") {
				notify(ctx, lastNotes.length > 0 ? lastNotes.join("\n") : "no pipeline run yet this session", "info");
				return;
			}

			if (sub === "stats") {
				notify(ctx, stats.summarize(), "info");
				return;
			}

			if (sub === "gate" || sub.startsWith("gate ")) {
				if (!config) {
					notify(ctx, "not initialized yet", "warning");
					return;
				}
				const arg = sub.slice("gate".length).trim();
				if (!arg) {
					const current = (config.routing.planGate ?? "off") as PlanGate;
					notify(ctx, `plan gate: ${current} — ${GATE_DESCRIPTIONS[current]} (agent/debug modes only)`, "info");
					return;
				}
				if (!PLAN_GATE_MODES.includes(arg as PlanGate)) {
					notify(ctx, `Unknown gate mode "${arg}". Valid: ${PLAN_GATE_MODES.join(", ")}`, "error");
					return;
				}
				// Session-only, like toolparse/trace — a `/router reload` re-reads the file value.
				config.routing.planGate = arg as PlanGate;
				notify(ctx, `plan gate: ${arg} — ${GATE_DESCRIPTIONS[arg as PlanGate]}`, "info");
				return;
			}

			if (sub === "toolparse on" || sub === "toolparse off") {
				toolparseEnabled = sub === "toolparse on";
				notify(ctx, `toolparse: ${toolparseEnabled ? "on" : "off"}`, "info");
				return;
			}

			if (sub === "trace on" || sub === "trace off") {
				debugTraceEnabled = sub === "trace on";
				notify(
					ctx,
					debugTraceEnabled
						? `debug trace: on → ${traceFilePath(ctx)} (only logged while in debug mode)`
						: "debug trace: off",
					"info",
				);
				return;
			}

			if (sub === "trace") {
				notify(ctx, `debug trace: ${debugTraceEnabled ? "on" : "off"} → ${traceFilePath(ctx)}`, "info");
				return;
			}

			if (sub === "setup") {
				if (!ctx.hasUI) {
					notify(ctx, `No interactive UI available in this mode. Edit ${globalConfigPath()} directly — see docs/configuration.md.`, "warning");
					return;
				}
				await runSetupWizard(ctx, ROLE_NAMES);
				return;
			}

			if (sub === "config") {
				if (!ctx.hasUI) {
					notify(ctx, `Edit ${globalConfigPath()} directly (no interactive UI available in this mode).`, "warning");
					return;
				}
				const role = await ctx.ui.select("Which role do you want to configure?", ROLE_NAMES);
				if (!role) return;
				await runSetupWizard(ctx, [role as RoleName]);
				return;
			}

			if (sub === "auto") {
				overridePinned = false;
				if (roles) renderStatus(ctx, modeState.current, roles, false);
				notify(ctx, "model-router: auto-routing resumed.", "info");
				return;
			}

			if (!config || !roles) {
				notify(ctx, "not initialized yet", "warning");
				return;
			}

			if (sub !== "") {
				notify(ctx, `Unknown /router subcommand "${sub}".\n\n${ROUTER_HELP}`, "warning");
				return;
			}

			const lines = [
				`mode: ${modeState.current} (${describeMode(modeState.current)})`,
				overridePinned ? "routing: PINNED (manual model override active — /router auto to resume)" : "routing: auto",
				"",
				"roles:",
				...ROLE_NAMES.map((r) => `  ${describeRole(roles![r])}`),
				"",
				`routing.classifier: ${config.routing.classifier}`,
				`routing.trivialBypass: ${config.routing.trivialBypass}`,
				`routing.planGate: ${config.routing.planGate ?? "off"} (agent/debug; /router gate to change)`,
				`routing.toolOutputParseThreshold: ${config.routing.toolOutputParseThreshold}B (toolparse: ${toolparseEnabled ? "on" : "off"})`,
				`routing.tiers: ${config.routing.tiers ? Object.keys(config.routing.tiers).join(", ") : "not configured"}${pinnedTier ? ` — pinned this session at "${pinnedTier}"` : ""}${consecutiveToolFailures > 0 ? ` (${consecutiveToolFailures}/${TOOL_FAILURE_ESCALATION_THRESHOLD} consecutive tool failures)` : ""}`,
				`subagents: ${config.subagents.enabled ? `enabled (max ${config.subagents.maxParallel}, timeout ${config.subagents.timeoutMs}ms)` : "disabled"}`,
				"",
				stats.summarize(),
				"",
				'Run "/router help" to see all subcommands.',
			];

			notify(ctx, lines.join("\n"), "info");
		},
	});

	// Read-only enforcement for plan/ask modes: block write tools and non-allowlisted bash.
	pi.on("tool_call", async (event, ctx) => {
		if (!isReadOnlyMode(modeState.current)) return;
		const check = checkReadOnly(event.toolName, (event.input ?? {}) as Record<string, unknown>);
		if (check.blocked) return { block: true, reason: check.reason };
	});

	// M3 + Phase 2 escalation: compress large bash/grep-like tool outputs via the
	// toolParser role (below), and separately — regardless of the toolparse
	// toggle — track consecutive executor tool failures in agent/debug mode as
	// a Phase 2 escalation signal (see TOOL_FAILURE_ESCALATION_THRESHOLD).
	pi.on("tool_result", async (event, ctx) => {
		if (modeState.current === "agent" || modeState.current === "debug") {
			if (event.isError) {
				consecutiveToolFailures++;
				if (consecutiveToolFailures >= TOOL_FAILURE_ESCALATION_THRESHOLD) {
					consecutiveToolFailures = 0;
					const escalated = nextTierUp(pinnedTier ?? "trivial");
					if (escalated !== pinnedTier) {
						pinnedTier = escalated;
						notify(
							ctx,
							`model-router: ${TOOL_FAILURE_ESCALATION_THRESHOLD} consecutive tool failures — escalating pinned tier to "${escalated}".`,
							"warning",
						);
						if (roles) renderStatus(ctx, modeState.current, roles, overridePinned);
					}
				}
			} else {
				consecutiveToolFailures = 0;
			}
		}

		if (!config || !roles || !toolparseEnabled) return;
		const outputText = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const bytes = byteLength(outputText);
		if (!shouldCompress(event.toolName, bytes, event.isError, config.routing.toolOutputParseThreshold)) return;

		const commandSummary = JSON.stringify(event.input ?? {}).slice(0, 500);
		const currentStepContext = lastNotes.length > 0 ? lastNotes[lastNotes.length - 1]! : "the user's current request";

		const result = await compressToolOutput(ctx, roles.toolParser, {
			toolName: event.toolName,
			commandSummary,
			output: outputText,
			currentStepContext,
			signal: ctx.signal,
		});
		if (result.compressedBytes >= result.originalBytes) return; // nothing gained; keep the original untouched
		stats.recordCompression(result);
		// No extension API renders a custom expandable Component for a built-in
		// tool's result (registerMessageRenderer/registerEntryRenderer only cover
		// extension-authored custom messages/entries), so the savings summary is
		// prepended into the visible text directly and the original is kept in
		// `details.original` rather than discarded. The tool's own details (e.g.
		// bash's `truncation`/`fullOutputPath`) are spread in underneath ours so
		// the built-in renderer doesn't lose fields it still reads.
		return {
			content: [{ type: "text", text: `${summaryLine(result)}\n\n${result.compressed}` }],
			details: {
				...(event.details as Record<string, unknown> | undefined),
				originalBytes: result.originalBytes,
				compressedBytes: result.compressedBytes,
				savedTokens: result.savedTokens,
				original: outputText,
			},
		};
	});

	// M2/M4: purely informational usage summary (calls per role, compression savings).
	// Never gates or influences routing — display only. Only notifies when the
	// stats actually changed since the last settle, so it doesn't repeat the same
	// cumulative summary as a toast on every turn once any activity exists
	// (use `/router stats` to see the current summary on demand anytime).
	pi.on("agent_settled", async (_event, ctx) => {
		if (stats.totalCalls() === 0) return;
		const snapshotKey = JSON.stringify(stats.snapshot());
		if (snapshotKey === lastNotifiedStatsKey) return;
		lastNotifiedStatsKey = snapshotKey;
		notify(ctx, stats.summarize(), "info");
	});

	// M5: optional wire-level trace log for debug mode (`/router trace on`). Off by
	// default; only active in debug mode. Best-effort file logging — never blocks
	// or throws on the actual provider round-trip.
	pi.on("before_provider_request", async (event, ctx) => {
		if (!debugTraceEnabled || modeState.current !== "debug") return;
		appendTrace(ctx, { type: "request", payloadBytes: byteLength(JSON.stringify(event.payload ?? {})) });
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (!debugTraceEnabled || modeState.current !== "debug") return;
		appendTrace(ctx, { type: "response", status: event.status, headers: event.headers });
	});

	// M4: lets the executor model itself farm out steps to isolated `pi -p` subagents
	// (single/parallel/chain — dependsOn + {previous}/{previous:<id>} substitution).
	pi.registerTool({
		name: "dispatch_step",
		label: "Dispatch step(s) to subagent(s)",
		description:
			"Farm out one or more self-contained steps to isolated pi subagent processes, optionally in parallel or chained via dependsOn. " +
			"Use for research/exploration steps or independent parallelizable work that doesn't need to share this conversation's context. " +
			"Each step can reference {previous} (single dependency) or {previous:<id>} (multiple dependencies) to consume a prior step's output.",
		promptSnippet: "dispatch_step(steps) — farm out steps to isolated pi subagents (single/parallel/chain)",
		parameters: Type.Object({
			steps: Type.Array(
				Type.Object({
					id: Type.String({ description: "Unique id for this step within the call." }),
					task: Type.String({
						description: "Self-contained task description for the subagent. May reference {previous} or {previous:<id>}.",
					}),
					role: Type.Optional(
						StringEnum(ROLE_NAMES as [RoleName, ...RoleName[]], {
							description: "Which router role's model runs this step. Defaults to executor.",
						}),
					),
					dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Ids of steps that must complete first." })),
				}),
				{ minItems: 1, maxItems: 8 },
			),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			if (!config || !roles) {
				return { content: [{ type: "text", text: "model-router is not initialized yet" }], details: {} };
			}
			if (!config.subagents.enabled) {
				return { content: [{ type: "text", text: "subagents are disabled (subagents.enabled=false in model-router config)" }], details: {} };
			}

			const tasks: SubagentTask[] = [];
			const stepRoles = new Map<string, RoleName>();
			const skipped: string[] = [];
			for (const step of params.steps) {
				const roleName = (step.role ?? "executor") as RoleName;
				const role = roles[roleName];
				if (!role.model) {
					skipped.push(`[${step.id}] skipped: role "${roleName}" unresolved`);
					continue;
				}
				tasks.push({ id: step.id, task: step.task, model: `${role.model.provider}/${role.model.id}`, dependsOn: step.dependsOn });
				stepRoles.set(step.id, roleName);
			}
			if (tasks.length === 0) {
				return { content: [{ type: "text", text: ["no runnable steps (all roles unresolved)", ...skipped].join("\n") }], details: {} };
			}

			const results = await runSubagents(tasks, {
				maxParallel: config.subagents.maxParallel,
				cwd: ctx.cwd,
				signal,
				timeoutMs: config.subagents.timeoutMs,
			});

			const lines = [...skipped];
			for (const [id, r] of results) {
				// Attribute usage to the role the step actually ran on, not always "executor".
				if (r.usage) stats.recordCall(stepRoles.get(id) ?? "executor", { inputTokens: r.usage.input, outputTokens: r.usage.output });
				lines.push(r.ok ? `[${id}] ok: ${String(r.result).slice(0, 4000)}` : `[${id}] failed: ${r.error}`);
			}

			return { content: [{ type: "text", text: lines.join("\n\n") }], details: { results: Object.fromEntries(results) } };
		},
	});

	// Orchestration: classify → plan → validate → execute, routed per mode.
	pi.on("before_agent_start", async (event, ctx) => {
		if (!config || !roles) return;
		const mode = modeState.current;
		const addendum = modeSystemPromptAddendum(mode);
		const onProgress = (label: string) => setPipelineWidget(ctx, [`◐ model-router (${mode}): ${label}`]);

		// Suppress the model_select/thinking_level_select handlers' override-detection
		// for the setModel/setThinkingLevel calls the pipeline is about to make itself
		// (see declarations above). Narrowly scoped via onBeforeModelSwitch to right
		// before the actual switch — not the classify/plan/validate phase beforehand,
		// which can take seconds of out-of-band network calls and should remain
		// eligible for detecting a genuinely concurrent manual override.
		const markRouterDriven = () => {
			routerDrivenModelChange = true;
		};
		try {
			let applied: PipelineApplyResult;

			if (mode === "ask") {
				// ask mode intentionally doesn't participate in tiering — it has its own
				// bespoke, always-cheap role selection (see runAskMode's own doc comment).
				applied = await runAskMode(pi, ctx, roles, config, event.prompt, ctx.signal, onProgress, stats, overridePinned, markRouterDriven);
			} else if (mode === "plan") {
				const outcome = await planAndValidate(ctx, roles, config, event.prompt, ctx.signal, onProgress, stats, pinnedTier);
				const tierRoles = rolesForTier(ctx.modelRegistry, roles, config, outcome.effectiveTier);
				applied = await applyRoleForTurn(
					pi,
					"planner",
					tierRoles,
					outcome,
					outcome.effectiveTier,
					overridePinned,
					markRouterDriven,
				);
			} else {
				// agent | debug
				applied = await runAgentPipeline(
					pi,
					ctx,
					roles,
					config,
					event.prompt,
					ctx.signal,
					onProgress,
					stats,
					overridePinned,
					markRouterDriven,
					pinnedTier,
				);
			}

			// Ratchet: never lower than what's already pinned this session (see the
			// pinnedTier declaration above for the cache-economics rationale).
			if (applied.outcome.effectiveTier) pinnedTier = applied.outcome.effectiveTier;

			// Phase 2 escalation: the validator maxed out its revision budget without
			// ever approving — treat the current tier as inadequate and escalate the
			// pin one notch for subsequent turns (this turn already proceeded with the
			// unapproved plan; escalation doesn't retry it mid-turn).
			if (applied.outcome.validatorRejectionsMaxedOut) {
				const escalated = nextTierUp(pinnedTier ?? "trivial");
				if (escalated !== pinnedTier) {
					pinnedTier = escalated;
					const escalationNote = `validator rejections maxed out — escalating pinned tier to "${escalated}"`;
					applied.outcome.notes.push(escalationNote);
					notify(ctx, `model-router: ${escalationNote}.`, "warning");
				}
			}

			lastNotes = applied.outcome.notes;
			// Persist so `/router last` works after a process restart (e.g. -p invocations, /resume).
			pi.appendEntry(PIPELINE_TRACE_ENTRY_TYPE, { mode, notes: lastNotes });
			notify(ctx, summarizeApplied(mode, applied), "info");
			renderStatus(ctx, mode, roles, overridePinned);

			if (applied.outcome.plan && (mode === "agent" || mode === "debug")) {
				lastPlanStepCount = applied.outcome.plan.steps.length;
				doneSteps = new Set();
				setProgressWidget(ctx, [`Plan progress: 0/${lastPlanStepCount} done`]);
			} else {
				lastPlanStepCount = undefined;
				setProgressWidget(ctx, undefined);
			}

			return { message: applied.message, systemPrompt: event.systemPrompt + addendum };
		} finally {
			routerDrivenModelChange = false;
			setPipelineWidget(ctx, undefined);
		}
	});
}
