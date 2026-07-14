import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionStats } from "./stats.ts";
import { structuredCall } from "./structured.ts";
import { type Complexity, COMPLEXITY_LEVELS, type ResolvedRole, type RoleName, type RouterConfig } from "./types.ts";

export type { Complexity };

export interface ClassificationResult {
	complexity: Complexity;
	needsPlan: boolean;
	reason: string;
}

const CLASSIFY_TOOL = "emit_classification";

const classifySchema = Type.Object({
	complexity: StringEnum(["trivial", "simple", "standard", "complex"] as const),
	needsPlan: Type.Boolean({
		description: "Whether this task benefits from an explicit up-front plan before execution.",
	}),
	reason: Type.String({ description: "One short sentence explaining the rating." }),
});

const CLASSIFY_SYSTEM_PROMPT = [
	"You are a fast task-complexity classifier for a coding agent's model router.",
	"Rate the user's request using exactly these definitions:",
	"- trivial: a single fact lookup, definition, or one-line answer; no code changes.",
	"- simple: a small, well-scoped change or command confined to one file or one action.",
	"- standard: a typical multi-step coding task touching a few files; benefits from a short plan.",
	"- complex: cross-cutting change, architectural decision, ambiguous requirements, or multi-file refactor; needs careful up-front planning and validation.",
	"When in doubt between two levels, pick the higher (more careful) one — never underestimate.",
	`Respond by calling the "${CLASSIFY_TOOL}" tool exactly once. Do not write any other text.`,
].join("\n");

/**
 * Classify a task's complexity using the configured classifier role
 * (cheap/fast model, out-of-band — never enters session context).
 *
 * Returns undefined when the classifier role is unresolved/skipped or the
 * call otherwise fails. Callers must treat undefined conservatively (assume
 * "standard" or "complex", never silently skip planning) — this function
 * never fabricates a result to save effort.
 */
export async function classifyComplexity(
	ctx: ExtensionContext,
	roles: Record<RoleName, ResolvedRole>,
	config: RouterConfig,
	prompt: string,
	signal: AbortSignal | undefined,
	onProgress?: (label: string) => void,
	stats?: SessionStats,
): Promise<ClassificationResult | undefined> {
	const classifierRole = roles[config.routing.classifier];
	onProgress?.("classifying…");

	const result = await structuredCall<ClassificationResult>(ctx, classifierRole, {
		systemPrompt: CLASSIFY_SYSTEM_PROMPT,
		userPrompt: prompt,
		toolName: CLASSIFY_TOOL,
		toolDescription: "Report the classified complexity of the user's request.",
		schema: classifySchema,
		signal,
	});

	if (!result.ok) return undefined;
	stats?.recordCall(config.routing.classifier, { inputTokens: result.raw.usage?.input, outputTokens: result.raw.usage?.output });
	return result.value;
}

/** Whether a "trivial" classification should bypass the plan/validate pipeline entirely. */
export function shouldBypassPipeline(config: RouterConfig, classification: ClassificationResult | undefined): boolean {
	if (!classification) return false; // no classifier verdict → do not skip anything, stay conservative
	if (!config.routing.trivialBypass) return false;
	return classification.complexity === "trivial" && !classification.needsPlan;
}

function complexityRank(c: Complexity | undefined): number {
	return c ? COMPLEXITY_LEVELS.indexOf(c) : -1;
}

/**
 * The higher-ranked of two complexity tiers (trivial < simple < standard < complex),
 * treating `undefined` as lower than any tier. Used to ratchet a session's pinned
 * tier upward only — see index.ts's `pinnedTier` and PLAN.md §12's cache-economics
 * rationale: flapping between tiers mid-session destroys each role's provider
 * prompt cache, so once a turn commits to a tier, later turns never drop below it.
 */
export function maxComplexity(a: Complexity | undefined, b: Complexity | undefined): Complexity | undefined {
	return complexityRank(b) > complexityRank(a) ? b : a;
}

/**
 * One tier above `complexity` (trivial → simple → standard → complex), capped
 * at "complex" — there's nowhere higher to escalate to. Used by the Phase 2
 * escalation safety net (index.ts): repeated validator rejections or
 * consecutive executor tool failures at the current pinned tier are treated
 * as evidence that tier is inadequate for this session, so the pin moves up
 * one notch rather than staying put and failing the same way again.
 */
export function nextTierUp(complexity: Complexity): Complexity {
	const idx = COMPLEXITY_LEVELS.indexOf(complexity);
	return COMPLEXITY_LEVELS[idx + 1] ?? complexity;
}

const THINKING_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Minimum effort floor per complexity level. Applied as an escalation only — never a downgrade. */
const COMPLEXITY_FLOOR: Record<Complexity, ThinkingLevel> = {
	trivial: "off",
	simple: "low",
	standard: "medium",
	complex: "high",
};

function thinkingRank(level: ThinkingLevel): number {
	const idx = THINKING_ORDER.indexOf(level);
	return idx === -1 ? 0 : idx;
}

/**
 * Escalate a role's configured effort to at least the complexity floor.
 * Quality-first: this only ever raises effort above the configured baseline
 * for harder tasks, never lowers it below what the user configured.
 */
export function escalateThinking(base: ThinkingLevel, floor: ThinkingLevel): ThinkingLevel {
	return thinkingRank(floor) > thinkingRank(base) ? floor : base;
}

/**
 * Compute the effective effort level for a role given the task's classified
 * complexity. Roles that don't scale with task complexity (toolParser is
 * always cheap/fast by design) keep their configured level untouched.
 */
export function effectiveThinking(
	role: RoleName,
	roleConfig: { thinking: ThinkingLevel },
	complexity: Complexity | undefined,
): ThinkingLevel {
	if (role === "toolParser") return roleConfig.thinking;
	if (!complexity) return roleConfig.thinking;
	return escalateThinking(roleConfig.thinking, COMPLEXITY_FLOOR[complexity]);
}
