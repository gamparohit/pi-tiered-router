import { AuthStorage, type ExtensionAPI, type ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/model-router/config.ts";
import { resolveAllRoles } from "../extensions/model-router/roles.ts";
import type { ResolvedRole, RoleName, RouterConfig } from "../extensions/model-router/types.ts";

const structuredCallMock = vi.fn();
vi.mock("../extensions/model-router/structured.ts", () => ({
	structuredCall: (...args: unknown[]) => structuredCallMock(...args),
}));

const { applyRoleForTurn, buildPlanMarkdown, planAndValidate, runAgentPipeline, runAskMode } = await import(
	"../extensions/model-router/pipeline.ts"
);

function fakeRole(role: RoleName, overrides: Partial<ResolvedRole> = {}): ResolvedRole {
	return {
		role,
		model: { provider: "anthropic", id: `claude-${role}-fake`, api: "anthropic-messages" } as never,
		thinking: "medium",
		requested: `anthropic/claude-${role}-*`,
		resolvedId: `anthropic/claude-${role}-fake`,
		viaFallback: false,
		skipped: false,
		...overrides,
	};
}

function fakeRoles(overrides: Partial<Record<RoleName, ResolvedRole>> = {}): Record<RoleName, ResolvedRole> {
	return {
		planner: fakeRole("planner", { thinking: "high" }),
		validator: fakeRole("validator", { thinking: "medium" }),
		executor: fakeRole("executor", { thinking: "medium" }),
		toolParser: fakeRole("toolParser", { thinking: "off" }),
		...overrides,
	};
}

function fakePi(setModelResult = true): ExtensionAPI {
	return {
		setModel: vi.fn().mockResolvedValue(setModelResult),
		setThinkingLevel: vi.fn(),
	} as unknown as ExtensionAPI;
}

const fakeCtx = {} as ExtensionContext;

function registryWithAuth(providers: string[]): ModelRegistry {
	const data = Object.fromEntries(providers.map((p) => [p, { type: "api_key" as const, key: "sk-test" }]));
	return ModelRegistry.inMemory(AuthStorage.inMemory(data));
}

/** A real ModelRegistry-backed ctx — needed for tiering tests, since rolesForTier
 * re-resolves overridden roles against the registry (unlike the plain `fakeCtx`
 * used elsewhere, which is safe only because untiered tests never touch it). */
function fakeCtxWithRegistry(registry: ModelRegistry): ExtensionContext {
	return { modelRegistry: registry } as unknown as ExtensionContext;
}

/** Route structuredCall by toolName so classify/plan/validate can be scripted independently. */
function mockByTool(handlers: Record<string, (call: number) => unknown>) {
	const calls: Record<string, number> = {};
	structuredCallMock.mockImplementation(async (_ctx: unknown, _role: unknown, opts: { toolName: string }) => {
		const n = (calls[opts.toolName] = (calls[opts.toolName] ?? 0) + 1);
		const handler = handlers[opts.toolName];
		if (!handler) return { ok: false, error: `no handler for ${opts.toolName}` };
		const value = handler(n);
		return value === undefined ? { ok: false, error: "handler returned undefined" } : { ok: true, value, raw: {} };
	});
}

beforeEach(() => {
	structuredCallMock.mockReset();
});

describe("planAndValidate", () => {
	it("bypasses plan/validate for a trivial, no-plan-needed classification", async () => {
		mockByTool({
			emit_classification: () => ({ complexity: "trivial", needsPlan: false, reason: "quick fact" }),
		});
		const outcome = await planAndValidate(fakeCtx, fakeRoles(), DEFAULT_CONFIG, "what is 2+2", undefined);
		expect(outcome.bypassed).toBe(true);
		expect(outcome.plan).toBeUndefined();
		// Only the classifier should have been called.
		expect(structuredCallMock).toHaveBeenCalledTimes(1);
	});

	it("runs plan + validate(approve) end to end and renders plan text", async () => {
		mockByTool({
			emit_classification: () => ({ complexity: "standard", needsPlan: true, reason: "multi-step" }),
			emit_plan: () => ({ summary: "Do the thing", steps: ["Step one", "Step two"] }),
			emit_validation: () => ({ verdict: "approve", notes: "looks good" }),
		});
		const outcome = await planAndValidate(fakeCtx, fakeRoles(), DEFAULT_CONFIG, "do the thing", undefined);
		expect(outcome.bypassed).toBe(false);
		expect(outcome.plan?.steps).toEqual(["Step one", "Step two"]);
		expect(outcome.validation?.verdict).toBe("approve");
		expect(outcome.revisions).toBe(0);
		expect(outcome.planText).toContain("Step one");
		expect(outcome.planText).toContain("Validator (approve)");
	});

	it("applies revisedSteps from a single revise round and stops", async () => {
		mockByTool({
			emit_classification: () => ({ complexity: "standard", needsPlan: true, reason: "x" }),
			emit_plan: () => ({ summary: "s", steps: ["bad step"] }),
			emit_validation: (n) =>
				n === 1
					? { verdict: "revise", notes: "step is wrong", revisedSteps: ["good step 1", "good step 2"] }
					: { verdict: "approve", notes: "now good" },
		});
		const outcome = await planAndValidate(fakeCtx, fakeRoles(), DEFAULT_CONFIG, "x", undefined);
		expect(outcome.revisions).toBe(1);
		expect(outcome.plan?.steps).toEqual(["good step 1", "good step 2"]);
		expect(outcome.validation?.verdict).toBe("approve");
	});

	it("bounds the revision loop at MAX_REVISIONS and proceeds anyway", async () => {
		mockByTool({
			emit_classification: () => ({ complexity: "complex", needsPlan: true, reason: "x" }),
			emit_plan: (n) => ({ summary: "s", steps: [`plan v${n}`] }),
			emit_validation: () => ({ verdict: "revise", notes: "still not good enough" }),
		});
		const outcome = await planAndValidate(fakeCtx, fakeRoles(), DEFAULT_CONFIG, "x", undefined);
		// Bounded: must terminate, not loop forever.
		expect(outcome.revisions).toBeLessThanOrEqual(2);
		expect(outcome.validation?.verdict).toBe("revise");
		expect(outcome.planText).toContain("Validator (revise)");
		// Phase 2 escalation signal: the validator never approved within the revision budget.
		expect(outcome.validatorRejectionsMaxedOut).toBe(true);
	});

	it("does not flag validatorRejectionsMaxedOut when the plan is eventually approved", async () => {
		mockByTool({
			emit_classification: () => ({ complexity: "standard", needsPlan: true, reason: "x" }),
			emit_plan: () => ({ summary: "s", steps: ["a"] }),
			emit_validation: (n) => (n === 1 ? { verdict: "revise", notes: "fix it" } : { verdict: "approve", notes: "ok now" }),
		});
		const outcome = await planAndValidate(fakeCtx, fakeRoles(), DEFAULT_CONFIG, "x", undefined);
		expect(outcome.validatorRejectionsMaxedOut).toBe(false);
	});

	it("does not flag validatorRejectionsMaxedOut when the validator is skipped/unresolved", async () => {
		mockByTool({
			emit_classification: () => ({ complexity: "standard", needsPlan: true, reason: "x" }),
			emit_plan: () => ({ summary: "s", steps: ["a"] }),
		});
		const roles = fakeRoles({ validator: fakeRole("validator", { skipped: true, model: undefined }) });
		const outcome = await planAndValidate(fakeCtx, roles, DEFAULT_CONFIG, "x", undefined);
		expect(outcome.validatorRejectionsMaxedOut).toBe(false);
	});

	it("degrades gracefully when the planner is unresolved: no plan, no crash", async () => {
		mockByTool({
			emit_classification: () => ({ complexity: "standard", needsPlan: true, reason: "x" }),
			// no emit_plan handler -> structuredCall fails for planner
		});
		const outcome = await planAndValidate(fakeCtx, fakeRoles(), DEFAULT_CONFIG, "x", undefined);
		expect(outcome.plan).toBeUndefined();
		expect(outcome.planText).toBeUndefined();
		expect(outcome.notes.some((n) => n.includes("planner"))).toBe(true);
	});

	it("proceeds with an unvalidated plan when the validator is configured to skip", async () => {
		mockByTool({
			emit_classification: () => ({ complexity: "standard", needsPlan: true, reason: "x" }),
			emit_plan: () => ({ summary: "s", steps: ["step 1"] }),
		});
		const roles = fakeRoles({ validator: fakeRole("validator", { skipped: true, model: undefined }) });
		const outcome = await planAndValidate(fakeCtx, roles, DEFAULT_CONFIG, "x", undefined);
		expect(outcome.plan?.steps).toEqual(["step 1"]);
		expect(outcome.validation).toBeUndefined();
		expect(outcome.planText).toContain("step 1");
		expect(outcome.notes.some((n) => n.includes("validator"))).toBe(true);
	});

	it("never bypasses when the classifier itself is unresolved (stays conservative)", async () => {
		structuredCallMock.mockImplementation(async (_ctx: unknown, _role: unknown, opts: { toolName: string }) => {
			if (opts.toolName === "emit_classification") return { ok: false, error: "classifier down" };
			if (opts.toolName === "emit_plan") return { ok: true, value: { summary: "s", steps: ["a"] }, raw: {} };
			if (opts.toolName === "emit_validation") return { ok: true, value: { verdict: "approve", notes: "ok" }, raw: {} };
			return { ok: false, error: "?" };
		});
		const outcome = await planAndValidate(fakeCtx, fakeRoles(), DEFAULT_CONFIG, "x", undefined);
		expect(outcome.bypassed).toBe(false);
		expect(outcome.plan).toBeDefined();
	});
});

describe("planAndValidate — complexity tiers", () => {
	function tieredConfig(tiers: NonNullable<RouterConfig["routing"]["tiers"]>): RouterConfig {
		return { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, tiers } };
	}

	function findRoleArg(toolName: string): ResolvedRole {
		const call = structuredCallMock.mock.calls.find((c) => (c[2] as { toolName: string }).toolName === toolName);
		return call?.[1] as ResolvedRole;
	}

	it("resolves and uses the tier-adjusted planner role when the classified tier has an override", async () => {
		const registry = registryWithAuth(["anthropic"]);
		const roles = resolveAllRoles(registry, DEFAULT_CONFIG);
		const config = tieredConfig({ simple: { planner: { model: "anthropic/claude-haiku-*", thinking: "low" } } });
		mockByTool({
			emit_classification: () => ({ complexity: "simple", needsPlan: true, reason: "x" }),
			emit_plan: () => ({ summary: "s", steps: ["a"] }),
			emit_validation: () => ({ verdict: "approve", notes: "ok" }),
		});

		const outcome = await planAndValidate(fakeCtxWithRegistry(registry), roles, config, "x", undefined);

		expect(outcome.effectiveTier).toBe("simple");
		expect(outcome.notes.some((n) => n.includes("tier: simple"))).toBe(true);
		const planRole = findRoleArg("emit_plan");
		expect(planRole.model?.id).toContain("haiku");
		expect(planRole).not.toBe(roles.planner);
	});

	it("falls through to the base roles when the classified tier has no override configured", async () => {
		const registry = registryWithAuth(["anthropic"]);
		const roles = resolveAllRoles(registry, DEFAULT_CONFIG);
		// Only "simple" has an override; this turn classifies as "complex".
		const config = tieredConfig({ simple: { planner: { model: "anthropic/claude-haiku-*", thinking: "low" } } });
		mockByTool({
			emit_classification: () => ({ complexity: "complex", needsPlan: true, reason: "x" }),
			emit_plan: () => ({ summary: "s", steps: ["a"] }),
			emit_validation: () => ({ verdict: "approve", notes: "ok" }),
		});

		const outcome = await planAndValidate(fakeCtxWithRegistry(registry), roles, config, "x", undefined);

		expect(outcome.notes.some((n) => n.includes("tier:"))).toBe(false);
		expect(findRoleArg("emit_plan")).toBe(roles.planner); // base role, untouched
	});

	it("ratchets effectiveTier up from a pinned tier, never down, regardless of this turn's own classification", async () => {
		const registry = registryWithAuth(["anthropic"]);
		const roles = resolveAllRoles(registry, DEFAULT_CONFIG);
		mockByTool({
			emit_classification: () => ({ complexity: "trivial", needsPlan: true, reason: "x" }),
			emit_plan: () => ({ summary: "s", steps: ["a"] }),
			emit_validation: () => ({ verdict: "approve", notes: "ok" }),
		});

		const outcome = await planAndValidate(
			fakeCtxWithRegistry(registry),
			roles,
			DEFAULT_CONFIG,
			"x",
			undefined,
			undefined,
			undefined,
			"standard", // pinnedTier
		);

		expect(outcome.effectiveTier).toBe("standard"); // pinned tier wins over this turn's lower "trivial" classification
	});
});

describe("buildPlanMarkdown", () => {
	it("numbers steps and includes the summary", () => {
		const md = buildPlanMarkdown({ summary: "Fix the bug", steps: ["Find it", "Fix it"] });
		expect(md).toContain("Plan: Fix the bug");
		expect(md).toContain("1. Find it");
		expect(md).toContain("2. Fix it");
	});

	it("appends validator notes when present", () => {
		const md = buildPlanMarkdown(
			{ summary: "s", steps: ["a"] },
			{ verdict: "revise", notes: "missing edge case" },
		);
		expect(md).toContain("Validator (revise): missing edge case");
	});
});

describe("applyRoleForTurn", () => {
	it("switches the model and applies escalated thinking on success", async () => {
		const pi = fakePi(true);
		const roles = fakeRoles();
		const outcome = { bypassed: false, revisions: 0, notes: [] as string[], validatorRejectionsMaxedOut: false };
		const result = await applyRoleForTurn(pi, "executor", roles, outcome, "complex");
		expect(pi.setModel).toHaveBeenCalledWith(roles.executor.model);
		expect(pi.setThinkingLevel).toHaveBeenCalledWith("high"); // escalated from medium -> complex floor
		expect(result.appliedRole).toBe(roles.executor);
		expect(result.appliedThinking).toBe("high");
	});

	it("calls onBeforeModelSwitch immediately before pi.setModel, not before", async () => {
		const pi = fakePi(true);
		const roles = fakeRoles();
		const outcome = { bypassed: false, revisions: 0, notes: [] as string[], validatorRejectionsMaxedOut: false };
		const order: string[] = [];
		(pi.setModel as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			order.push("setModel");
			return true;
		});
		const onBeforeModelSwitch = vi.fn(() => order.push("onBeforeModelSwitch"));
		await applyRoleForTurn(pi, "executor", roles, outcome, undefined, false, onBeforeModelSwitch);
		expect(onBeforeModelSwitch).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["onBeforeModelSwitch", "setModel"]);
	});

	it("does not call onBeforeModelSwitch when the switch is skipped (pinned) or the role is unresolved", async () => {
		const pi = fakePi(true);
		const roles = fakeRoles();
		const onBeforeModelSwitch = vi.fn();

		await applyRoleForTurn(pi, "executor", roles, { bypassed: false, revisions: 0, notes: [], validatorRejectionsMaxedOut: false }, undefined, true, onBeforeModelSwitch);
		expect(onBeforeModelSwitch).not.toHaveBeenCalled();

		const unresolvedRoles = fakeRoles({ executor: fakeRole("executor", { model: undefined }) });
		await applyRoleForTurn(pi, "executor", unresolvedRoles, { bypassed: false, revisions: 0, notes: [], validatorRejectionsMaxedOut: false }, undefined, false, onBeforeModelSwitch);
		expect(onBeforeModelSwitch).not.toHaveBeenCalled();
	});

	it("leaves the model unchanged when setModel fails (no API key)", async () => {
		const pi = fakePi(false);
		const roles = fakeRoles();
		const outcome = { bypassed: false, revisions: 0, notes: [] as string[], validatorRejectionsMaxedOut: false };
		const result = await applyRoleForTurn(pi, "executor", roles, outcome, undefined);
		expect(pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(result.appliedRole).toBeUndefined();
		expect(outcome.notes.some((n) => n.includes("no API key"))).toBe(true);
	});

	it("skips the model switch entirely when skipModelSwitch is set (manual override pinned)", async () => {
		const pi = fakePi(true);
		const roles = fakeRoles();
		const outcome = { bypassed: false, revisions: 0, notes: [] as string[], validatorRejectionsMaxedOut: false };
		const result = await applyRoleForTurn(pi, "executor", roles, outcome, "complex", true);
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(result.appliedRole).toBeUndefined();
		expect(outcome.notes.some((n) => n.includes("manual model override is pinned"))).toBe(true);
	});

	it("handles an unresolved role without switching or crashing", async () => {
		const pi = fakePi(true);
		const roles = fakeRoles({ executor: fakeRole("executor", { model: undefined }) });
		const outcome = { bypassed: false, revisions: 0, notes: [] as string[], validatorRejectionsMaxedOut: false };
		const result = await applyRoleForTurn(pi, "executor", roles, outcome, undefined);
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(result.appliedRole).toBeUndefined();
	});

	it("builds an injectable message only when a plan exists and the run was not bypassed", async () => {
		const pi = fakePi(true);
		const roles = fakeRoles();
		const withPlan = {
			bypassed: false,
			revisions: 0,
			notes: [] as string[],
			plan: { summary: "s", steps: ["a"] },
			planText: "Plan: s\n\n1. a",
			validatorRejectionsMaxedOut: false,
		};
		const result = await applyRoleForTurn(pi, "executor", roles, withPlan, undefined);
		expect(result.message?.content).toBe("Plan: s\n\n1. a");
		expect(result.message?.display).toBe(true);

		const bypassed = { bypassed: true, revisions: 0, notes: [] as string[], validatorRejectionsMaxedOut: false };
		const result2 = await applyRoleForTurn(pi, "executor", roles, bypassed, undefined);
		expect(result2.message).toBeUndefined();
	});
});

describe("runAgentPipeline", () => {
	it("runs the full pipeline and switches to the executor role", async () => {
		mockByTool({
			emit_classification: () => ({ complexity: "standard", needsPlan: true, reason: "x" }),
			emit_plan: () => ({ summary: "s", steps: ["a", "b"] }),
			emit_validation: () => ({ verdict: "approve", notes: "ok" }),
		});
		const pi = fakePi(true);
		const roles = fakeRoles();
		const result = await runAgentPipeline(pi, fakeCtx, roles, DEFAULT_CONFIG, "do it", undefined);
		expect(pi.setModel).toHaveBeenCalledWith(roles.executor.model);
		expect(result.message?.content).toContain("1. a");
	});

	it("switches to the tier-adjusted executor role, not the base one, when a tier override applies", async () => {
		const registry = registryWithAuth(["anthropic"]);
		const roles = resolveAllRoles(registry, DEFAULT_CONFIG);
		const config: RouterConfig = {
			...DEFAULT_CONFIG,
			routing: {
				...DEFAULT_CONFIG.routing,
				tiers: { simple: { executor: { model: "anthropic/claude-haiku-*", thinking: "low" } } },
			},
		};
		mockByTool({
			emit_classification: () => ({ complexity: "simple", needsPlan: true, reason: "x" }),
			emit_plan: () => ({ summary: "s", steps: ["a"] }),
			emit_validation: () => ({ verdict: "approve", notes: "ok" }),
		});

		const pi = fakePi(true);
		const result = await runAgentPipeline(pi, fakeCtxWithRegistry(registry), roles, config, "do it", undefined);

		expect(pi.setModel).not.toHaveBeenCalledWith(roles.executor.model); // base executor (opus) was NOT used
		const [switchedModel] = (pi.setModel as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(switchedModel.id).toContain("haiku");
		expect(result.appliedThinking).toBe("low");
	});
});

describe("runAskMode", () => {
	it("routes trivial questions to the toolParser role", async () => {
		mockByTool({ emit_classification: () => ({ complexity: "trivial", needsPlan: false, reason: "x" }) });
		const pi = fakePi(true);
		const roles = fakeRoles();
		const result = await runAskMode(pi, fakeCtx, roles, DEFAULT_CONFIG, "what time is it", undefined);
		expect(pi.setModel).toHaveBeenCalledWith(roles.toolParser.model);
		expect(result.message).toBeUndefined(); // ask mode never plans
	});

	it("routes non-trivial questions to the executor role without escalating effort", async () => {
		mockByTool({ emit_classification: () => ({ complexity: "complex", needsPlan: false, reason: "x" }) });
		const pi = fakePi(true);
		const roles = fakeRoles();
		const result = await runAskMode(pi, fakeCtx, roles, DEFAULT_CONFIG, "explain this architecture", undefined);
		expect(pi.setModel).toHaveBeenCalledWith(roles.executor.model);
		// complexity passed as undefined to applyRoleForTurn -> no escalation above configured "medium"
		expect(result.appliedThinking).toBe("medium");
	});

	it("defaults to the executor role when the classifier is unresolved", async () => {
		structuredCallMock.mockResolvedValue({ ok: false, error: "down" });
		const pi = fakePi(true);
		const roles = fakeRoles();
		const result = await runAskMode(pi, fakeCtx, roles, DEFAULT_CONFIG, "x", undefined);
		expect(pi.setModel).toHaveBeenCalledWith(roles.executor.model);
	});
});
