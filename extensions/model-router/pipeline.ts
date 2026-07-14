import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type Complexity,
	type ClassificationResult,
	classifyComplexity,
	effectiveThinking,
	maxComplexity,
	shouldBypassPipeline,
} from "./router.ts";
import { rolesForTier } from "./roles.ts";
import type { SessionStats } from "./stats.ts";
import { structuredCall } from "./structured.ts";
import type { ResolvedRole, RoleName, RouterConfig } from "./types.ts";

export interface PlanResult {
	summary: string;
	steps: string[];
}

export interface ValidationResult {
	verdict: "approve" | "revise" | "reject";
	notes: string;
	revisedSteps?: string[];
}

const PLAN_TOOL = "emit_plan";
const planSchema = Type.Object({
	summary: Type.String({ description: "One-sentence summary of the overall approach." }),
	steps: Type.Array(Type.String({ description: "One concrete, imperative-mood step." }), {
		minItems: 1,
		maxItems: 20,
	}),
});

const VALIDATE_TOOL = "emit_validation";
const validateSchema = Type.Object({
	verdict: StringEnum(["approve", "revise", "reject"] as const),
	notes: Type.String({ description: "Concise validation notes: risks, gaps, or required revisions." }),
	revisedSteps: Type.Optional(
		Type.Array(Type.String(), { description: "Only when verdict is 'revise': the corrected step list." }),
	),
});

const MAX_REVISIONS = 2;

/** Shared step-tagging convention taught to both the planner and the validator (which may rewrite steps). */
const STEP_TAGGING_GUIDANCE =
	'Prefix each step with a tag: "[main]" for a step that needs this conversation\'s shared context, ' +
	'"[subagent]" for a self-contained step (e.g. isolated research/exploration) that could run in an isolated subagent process, ' +
	'or "[parallel-group:N]" for steps that have no dependency on each other and could run concurrently as group N. ' +
	'Default to "[main]" when unsure — only tag a step [subagent]/[parallel-group:N] if it genuinely does not need anything from the ongoing conversation.';

function planSystemPrompt(classification: ClassificationResult | undefined, extraGuidance?: string): string {
	return [
		"You are the planning phase of a coding agent's model router.",
		"Decompose the user's request into a short, numbered, actionable plan. Each step should be concrete and independently checkable.",
		STEP_TAGGING_GUIDANCE,
		classification ? `Task complexity has been rated "${classification.complexity}": ${classification.reason}` : "",
		extraGuidance ? `A reviewer requested revisions. Address this feedback: ${extraGuidance}` : "",
		`Respond by calling the "${PLAN_TOOL}" tool exactly once. Do not write any other text.`,
	]
		.filter(Boolean)
		.join("\n");
}

async function generatePlan(
	ctx: ExtensionContext,
	plannerRole: ResolvedRole,
	prompt: string,
	classification: ClassificationResult | undefined,
	signal: AbortSignal | undefined,
	extraGuidance?: string,
	onProgress?: (label: string) => void,
	stats?: SessionStats,
): Promise<PlanResult | undefined> {
	onProgress?.(extraGuidance ? "re-planning…" : "planning…");
	const result = await structuredCall<PlanResult>(ctx, plannerRole, {
		systemPrompt: planSystemPrompt(classification, extraGuidance),
		userPrompt: prompt,
		toolName: PLAN_TOOL,
		toolDescription: "Report the generated plan.",
		schema: planSchema,
		signal,
	});
	if (!result.ok) return undefined;
	stats?.recordCall("planner", { inputTokens: result.raw.usage?.input, outputTokens: result.raw.usage?.output });
	return result.value;
}

const VALIDATE_SYSTEM_PROMPT = [
	"You are the validation phase of a coding agent's model router.",
	"Critique the proposed plan for feasibility, risk, and completeness against the user's request.",
	"Approve if it is solid. Request revision if steps are missing, wrong, unsafe, or too vague, and provide revisedSteps when you can write a better list yourself.",
	`If you write revisedSteps, preserve or correct their step tags using the same convention the planner uses: ${STEP_TAGGING_GUIDANCE}`,
	"Reject only if the request itself cannot or should not be fulfilled as stated.",
	`Respond by calling the "${VALIDATE_TOOL}" tool exactly once. Do not write any other text.`,
].join("\n");

async function validatePlan(
	ctx: ExtensionContext,
	validatorRole: ResolvedRole,
	prompt: string,
	plan: PlanResult,
	signal: AbortSignal | undefined,
	onProgress?: (label: string) => void,
	stats?: SessionStats,
): Promise<ValidationResult | undefined> {
	onProgress?.("validating…");
	const userPrompt = [
		`User request:\n${prompt}`,
		"",
		`Proposed plan (${plan.summary}):`,
		plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
	].join("\n");

	const result = await structuredCall<ValidationResult>(ctx, validatorRole, {
		systemPrompt: VALIDATE_SYSTEM_PROMPT,
		userPrompt,
		toolName: VALIDATE_TOOL,
		toolDescription: "Report the validation verdict for the proposed plan.",
		schema: validateSchema,
		signal,
	});
	if (!result.ok) return undefined;
	stats?.recordCall("validator", { inputTokens: result.raw.usage?.input, outputTokens: result.raw.usage?.output });
	return result.value;
}

export interface PlanAndValidateOutcome {
	classification?: ClassificationResult;
	/** True when trivial-bypass short-circuited planning entirely. */
	bypassed: boolean;
	plan?: PlanResult;
	validation?: ValidationResult;
	revisions: number;
	/** Rendered "Plan:\n1. ...\n" markdown ready for injection, if a plan exists. */
	planText?: string;
	/** Human-readable trace of pipeline decisions, for widgets/debugging. */
	notes: string[];
	/**
	 * The tier this turn actually ran at: `maxComplexity(pinnedTier, classification.complexity)`.
	 * Ratcheted — never lower than the `pinnedTier` the caller passed in. Callers
	 * that pin a session-wide tier (see index.ts) should persist this value as
	 * their new `pinnedTier` after the call. Undefined only when the classifier
	 * itself produced no result and no tier was already pinned.
	 */
	effectiveTier?: Complexity;
	/**
	 * True when the bounded revision loop exhausted MAX_REVISIONS while the
	 * validator was still returning "revise" — i.e. the plan never earned an
	 * approve within the allowed rounds. Phase 2's escalation safety net (see
	 * index.ts) treats this as evidence the current tier is inadequate and
	 * escalates the pinned tier one notch for subsequent turns. False whenever
	 * validation concluded any other way (approved, rejected, validator
	 * skipped/unresolved, or never reached at all).
	 */
	validatorRejectionsMaxedOut: boolean;
	/**
	 * True when the human plan gate ended without an approval — the user chose
	 * "proceed without a plan" or dismissed the dialog. The turn still runs (the
	 * executor is still switched in), but no plan is injected into context.
	 * Always false when the gate is off or was never reached.
	 */
	planDeclined: boolean;
}

/** Render the final plan + any validator notes as injectable markdown. */
export function buildPlanMarkdown(plan: PlanResult, validation?: ValidationResult): string {
	const lines = [`Plan: ${plan.summary}`, ""];
	plan.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
	if (validation && validation.notes) {
		lines.push("", `Validator (${validation.verdict}): ${validation.notes}`);
	}
	return lines.join("\n");
}

const GATE_APPROVE = "Approve — send this plan to the executor";
const GATE_REQUEST = "Request changes…";
const GATE_SKIP = "Proceed without a plan (run unguided)";

/**
 * Human plan-approval gate. Shows the plan and loops on the user's choice:
 * approve (proceed as-is), request changes (feed the note back to the planner
 * and re-show), or proceed without a plan (declined — the turn still runs, but
 * nothing is injected). A dismissed dialog (Escape / aborted signal → undefined)
 * is treated as "proceed without a plan": never force an unreviewed plan
 * through. Unlimited rounds — a human is approving each one, so there's no
 * runaway risk. UI-only; callers must gate on ctx.hasUI before calling.
 */
async function runHumanPlanGate(
	ctx: ExtensionContext,
	plannerRole: ResolvedRole,
	prompt: string,
	classification: ClassificationResult | undefined,
	initialPlan: PlanResult,
	initialValidation: ValidationResult | undefined,
	signal: AbortSignal | undefined,
	onProgress: ((label: string) => void) | undefined,
	stats: SessionStats | undefined,
	notes: string[],
): Promise<{ plan: PlanResult; declined: boolean }> {
	let plan = initialPlan;
	let validation = initialValidation;
	for (;;) {
		ctx.ui.notify(buildPlanMarkdown(plan, validation), "info");
		onProgress?.("awaiting plan review…");
		const choice = await ctx.ui.select("Review the plan before execution", [GATE_APPROVE, GATE_REQUEST, GATE_SKIP], { signal });

		if (choice === GATE_APPROVE) {
			notes.push("human gate: approved");
			return { plan, declined: false };
		}
		if (choice === undefined || choice === GATE_SKIP) {
			notes.push(choice === undefined ? "human gate: dismissed — proceeding without a plan" : "human gate: proceeding without a plan");
			return { plan, declined: true };
		}

		// Request changes: collect a note and re-plan with it as guidance.
		const feedback = await ctx.ui.input("What should change about the plan?");
		if (!feedback) {
			notes.push("human gate: no change described; re-showing the plan");
			continue;
		}
		notes.push(`human gate: revision requested — ${feedback}`);
		const replanned = await generatePlan(ctx, plannerRole, prompt, classification, signal, feedback, onProgress, stats);
		if (!replanned) {
			notes.push("human gate: re-plan failed; keeping the prior plan");
			continue;
		}
		plan = replanned;
		validation = undefined; // a human-driven re-plan supersedes any earlier validator note
	}
}

/**
 * Classify → plan → validate (bounded revision loop). Never executes
 * anything and never switches the active model — pure planning phase shared
 * by "plan" mode and the "agent"/"debug" pipeline. All calls are out-of-band
 * (via structuredCall) so they never pollute session context.
 *
 * Failures degrade gracefully at every stage (missing classifier, missing
 * planner, missing/skipped validator) rather than blocking the user's turn —
 * quality-first does not mean fragile.
 */
export async function planAndValidate(
	ctx: ExtensionContext,
	roles: Record<RoleName, ResolvedRole>,
	config: RouterConfig,
	prompt: string,
	signal: AbortSignal | undefined,
	onProgress?: (label: string) => void,
	stats?: SessionStats,
	pinnedTier?: Complexity,
	allowHumanGate = false,
): Promise<PlanAndValidateOutcome> {
	const notes: string[] = [];

	// Classification always runs on the base (untiered) roles — tiering depends
	// on already knowing the complexity, so the classifier itself can't be tiered.
	const classification = await classifyComplexity(ctx, roles, config, prompt, signal, onProgress, stats);
	notes.push(
		classification
			? `classified: ${classification.complexity} (needsPlan=${classification.needsPlan}) — ${classification.reason}`
			: "classifier unresolved/failed; proceeding conservatively (no bypass)",
	);

	// Ratchet: this turn never runs at a lower tier than one already pinned this
	// session (see index.ts) — only ever escalates, for provider-cache economics.
	const effectiveTier = maxComplexity(pinnedTier, classification?.complexity);
	const tierRoles = rolesForTier(ctx.modelRegistry, roles, config, effectiveTier);
	if (tierRoles !== roles) notes.push(`tier: ${effectiveTier} (role override applied)`);

	if (shouldBypassPipeline(config, classification)) {
		notes.push("trivial-bypass: skipping plan/validate");
		return { classification, bypassed: true, revisions: 0, notes, effectiveTier, validatorRejectionsMaxedOut: false, planDeclined: false };
	}

	let plan = await generatePlan(ctx, tierRoles.planner, prompt, classification, signal, undefined, onProgress, stats);
	if (!plan) {
		notes.push(`planner unresolved/failed (wanted ${tierRoles.planner.requested}); no plan injected`);
		return { classification, bypassed: false, revisions: 0, notes, effectiveTier, validatorRejectionsMaxedOut: false, planDeclined: false };
	}
	notes.push(`plan generated: ${plan.steps.length} step(s)`);

	// The human gate (agent/debug only, when configured) can replace or follow
	// the automated validator. It's UI-only, so it's forced off in -p/JSON mode.
	const gate: "off" | "replace-validator" | "after-validator" =
		allowHumanGate && ctx.hasUI ? (config.routing.planGate ?? "off") : "off";

	let validation: ValidationResult | undefined;
	let revisions = 0;
	let validatorRejectionsMaxedOut = false;
	if (gate !== "replace-validator") {
		for (;;) {
			validation = await validatePlan(ctx, tierRoles.validator, prompt, plan, signal, onProgress, stats);
			if (!validation) {
				notes.push("validator unresolved/skipped; proceeding with unvalidated plan");
				break;
			}
			notes.push(`validation round ${revisions}: ${validation.verdict}`);
			if (validation.verdict !== "revise") break;
			if (revisions >= MAX_REVISIONS) {
				notes.push(`max revisions (${MAX_REVISIONS}) reached; proceeding with validator notes attached`);
				validatorRejectionsMaxedOut = true;
				break;
			}
			revisions++;
			if (validation.revisedSteps && validation.revisedSteps.length > 0) {
				plan = { ...plan, steps: validation.revisedSteps };
				notes.push(`applied validator's revised steps (round ${revisions})`);
			} else {
				const replanned = await generatePlan(ctx, tierRoles.planner, prompt, classification, signal, validation.notes, onProgress, stats);
				if (!replanned) {
					notes.push("re-plan after revision request failed; proceeding with prior plan");
					break;
				}
				plan = replanned;
				notes.push(`planner re-generated plan (round ${revisions})`);
			}
		}
	}

	let planDeclined = false;
	if (gate === "replace-validator" || gate === "after-validator") {
		const gated = await runHumanPlanGate(ctx, tierRoles.planner, prompt, classification, plan, validation, signal, onProgress, stats, notes);
		plan = gated.plan;
		planDeclined = gated.declined;
		if (planDeclined) validation = undefined; // nothing was approved; don't attach a stale validator note
	}

	return {
		classification,
		bypassed: false,
		plan,
		validation,
		revisions,
		planText: buildPlanMarkdown(plan, validation),
		notes,
		effectiveTier,
		validatorRejectionsMaxedOut,
		planDeclined,
	};
}

export interface PipelineApplyResult {
	outcome: PlanAndValidateOutcome;
	appliedRole?: ResolvedRole;
	appliedThinking?: ThinkingLevel;
	/** Message to inject into session context via before_agent_start's result, if any. */
	message?: { customType: string; content: string; display: boolean };
}

const MESSAGE_CUSTOM_TYPE = "model-router:plan";

/**
 * Full "agent"/"debug" pipeline: plan+validate, then switch the live session
 * model to the executor role at complexity-escalated effort. For "plan" mode,
 * use planAndValidate() directly and switch to the planner role instead (the
 * caller in index.ts owns that distinction since it also governs tool gating).
 */
export async function runAgentPipeline(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	roles: Record<RoleName, ResolvedRole>,
	config: RouterConfig,
	prompt: string,
	signal: AbortSignal | undefined,
	onProgress?: (label: string) => void,
	stats?: SessionStats,
	skipModelSwitch = false,
	onBeforeModelSwitch?: () => void,
	pinnedTier?: Complexity,
): Promise<PipelineApplyResult> {
	const outcome = await planAndValidate(ctx, roles, config, prompt, signal, onProgress, stats, pinnedTier, true);
	// Re-derive the tier-adjusted roles for the executor step — planAndValidate
	// already applied them internally for planner/validator, but returns only the
	// outcome (not its internal roles map), so this recomputes the same (cheap,
	// pure) result rather than smuggling a whole roles map through the outcome.
	const tierRoles = rolesForTier(ctx.modelRegistry, roles, config, outcome.effectiveTier);
	return applyRoleForTurn(pi, "executor", tierRoles, outcome, outcome.effectiveTier, skipModelSwitch, onBeforeModelSwitch);
}

/**
 * "ask" mode: classify only (cheap/fast), never plan. Routes trivial questions
 * to the toolParser role (cheapest) and everything else to the executor role
 * at its configured (non-escalated) effort — ask mode intentionally never
 * escalates effort, since its whole point is a quick direct answer.
 */
export async function runAskMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	roles: Record<RoleName, ResolvedRole>,
	config: RouterConfig,
	prompt: string,
	signal: AbortSignal | undefined,
	onProgress?: (label: string) => void,
	stats?: SessionStats,
	skipModelSwitch = false,
	onBeforeModelSwitch?: () => void,
): Promise<PipelineApplyResult> {
	const notes: string[] = [];
	const classification = await classifyComplexity(ctx, roles, config, prompt, signal, onProgress, stats);
	notes.push(
		classification
			? `classified: ${classification.complexity} (ask mode: no plan, no effort escalation)`
			: "classifier unresolved/failed; defaulting to executor role",
	);
	const role: RoleName = classification?.complexity === "trivial" ? "toolParser" : "executor";
	const outcome: PlanAndValidateOutcome = {
		classification,
		bypassed: true,
		revisions: 0,
		notes,
		validatorRejectionsMaxedOut: false,
		planDeclined: false,
	};
	return applyRoleForTurn(pi, role, roles, outcome, undefined, skipModelSwitch, onBeforeModelSwitch);
}

/**
 * Apply a resolved role's model + complexity-escalated effort as the active
 * session model for this turn, and build the injectable plan message (if a
 * plan exists). Shared by plan mode (role="planner") and agent/debug mode
 * (role="executor").
 */
export async function applyRoleForTurn(
	pi: ExtensionAPI,
	role: RoleName,
	roles: Record<RoleName, ResolvedRole>,
	outcome: PlanAndValidateOutcome,
	complexity: Complexity | undefined,
	skipModelSwitch = false,
	onBeforeModelSwitch?: () => void,
): Promise<PipelineApplyResult> {
	const resolved = roles[role];
	const notes = outcome.notes;

	let appliedRole: ResolvedRole | undefined;
	let appliedThinking: ThinkingLevel | undefined;

	if (skipModelSwitch) {
		notes.push("model switch skipped: a manual model override is pinned (`/router auto` to resume routing)");
	} else if (resolved.model) {
		const thinking = effectiveThinking(role, { thinking: resolved.thinking }, complexity);
		// Narrow scope for callers that suppress their own model_select/thinking_level_select
		// handling around this exact call (see index.ts) — called right before the switch,
		// not around the classify/plan/validate phase that already ran before this point.
		onBeforeModelSwitch?.();
		const switched = await pi.setModel(resolved.model);
		if (switched) {
			pi.setThinkingLevel(thinking);
			appliedRole = resolved;
			appliedThinking = thinking;
			notes.push(`switched active model to ${resolved.resolvedId} (${thinking})`);
		} else {
			notes.push(`could not switch to ${resolved.resolvedId}: no API key available; leaving current model active`);
		}
	} else {
		notes.push(`role "${role}" unresolved (wanted ${resolved.requested}); leaving current model active`);
	}

	const message =
		outcome.planText && !outcome.bypassed && !outcome.planDeclined
			? { customType: MESSAGE_CUSTOM_TYPE, content: outcome.planText, display: true }
			: undefined;

	return { outcome, appliedRole, appliedThinking, message };
}

export { MESSAGE_CUSTOM_TYPE as PLAN_MESSAGE_CUSTOM_TYPE };
