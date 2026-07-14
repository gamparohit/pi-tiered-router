import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** The four routing roles. Each maps to a model + effort level. */
export type RoleName = "planner" | "validator" | "executor" | "toolParser";

export const ROLE_NAMES: RoleName[] = ["planner", "validator", "executor", "toolParser"];

/** The four operating modes. */
export type ModeName = "plan" | "agent" | "ask" | "debug";

export const MODE_NAMES: ModeName[] = ["plan", "agent", "ask", "debug"];

/** The four task-complexity tiers the classifier rates a request into, low to high. */
export type Complexity = "trivial" | "simple" | "standard" | "complex";

export const COMPLEXITY_LEVELS: Complexity[] = ["trivial", "simple", "standard", "complex"];

/** A single role's model + effort configuration. */
export interface RoleConfig {
	/** "provider/model-id"; supports a trailing "*" prefix wildcard, e.g. "anthropic/claude-opus-*". */
	model: string;
	/** Thinking / effort level applied when this role runs. */
	thinking: ThinkingLevel;
}

export interface RoutingConfig {
	/** Role used to classify task complexity (cheap, fast). */
	classifier: RoleName;
	/** Trivial prompts skip the plan+validate pipeline entirely. */
	trivialBypass: boolean;
	/** Tool outputs larger than this (bytes) are candidates for tool-parser compression. */
	toolOutputParseThreshold: number;
	/**
	 * Opt-in per-complexity-tier role overrides — lets classified complexity pick
	 * *models*, not just effort. A tier only needs to list the roles it overrides;
	 * any role missing from a tier (or the whole `tiers` block itself) falls
	 * through to the base `roles` config unchanged. `"skip"` disables a role for
	 * that tier the same way it does in `fallbacks`. Never applied to the
	 * classifier's own call (see router.ts) — tiering depends on already knowing
	 * the complexity, so the classifier always runs on the base-resolved role.
	 */
	tiers?: Partial<Record<Complexity, Partial<Record<RoleName, RoleConfig | "skip">>>>;
}

export interface SubagentConfig {
	enabled: boolean;
	maxParallel: number;
	/** Per-step timeout (ms) for a dispatch_step subagent run before it's killed. */
	timeoutMs: number;
}

export interface RouterConfig {
	roles: Record<RoleName, RoleConfig>;
	/** Ordered fallback model specs per role. "skip" disables the role's pipeline stage. */
	fallbacks: Partial<Record<RoleName, string[]>>;
	routing: RoutingConfig;
	modes: { default: ModeName };
	subagents: SubagentConfig;
}

/** Result of resolving a role spec against the live model registry. */
export interface ResolvedRole {
	role: RoleName;
	/** The model that will actually run, or undefined if unresolved/skipped. */
	model: import("@earendil-works/pi-ai").Model<any> | undefined;
	thinking: ThinkingLevel;
	/** The spec string that was requested (may be a wildcard). */
	requested: string;
	/** "provider/id" that resolved, if any. */
	resolvedId?: string;
	/** True if a fallback (not the primary spec) satisfied the role. */
	viaFallback: boolean;
	/** True if the role is intentionally disabled ("skip"). */
	skipped: boolean;
}
