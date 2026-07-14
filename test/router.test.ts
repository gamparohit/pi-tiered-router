import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/model-router/config.ts";
import type { ResolvedRole, RoleName } from "../extensions/model-router/types.ts";

const structuredCallMock = vi.fn();
vi.mock("../extensions/model-router/structured.ts", () => ({
	structuredCall: (...args: unknown[]) => structuredCallMock(...args),
}));

const {
	classifyComplexity,
	effectiveThinking,
	escalateThinking,
	maxComplexity,
	nextTierUp,
	shouldBypassPipeline,
} = await import("../extensions/model-router/router.ts");

function fakeRole(role: RoleName, overrides: Partial<ResolvedRole> = {}): ResolvedRole {
	return {
		role,
		model: { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" } as never,
		thinking: "off",
		requested: "anthropic/claude-haiku-*",
		resolvedId: "anthropic/claude-haiku-4-5",
		viaFallback: false,
		skipped: false,
		...overrides,
	};
}

function fakeRoles(): Record<RoleName, ResolvedRole> {
	return {
		planner: fakeRole("planner", { thinking: "high" }),
		validator: fakeRole("validator", { thinking: "medium" }),
		executor: fakeRole("executor", { thinking: "medium" }),
		toolParser: fakeRole("toolParser", { thinking: "off" }),
	};
}

beforeEach(() => {
	structuredCallMock.mockReset();
});

describe("classifyComplexity", () => {
	it("returns the classification when structuredCall succeeds", async () => {
		structuredCallMock.mockResolvedValue({
			ok: true,
			value: { complexity: "standard", needsPlan: true, reason: "multi-file change" },
			raw: {},
		});
		const ctx = {} as ExtensionContext;
		const result = await classifyComplexity(ctx, fakeRoles(), DEFAULT_CONFIG, "refactor the auth module", undefined);
		expect(result).toEqual({ complexity: "standard", needsPlan: true, reason: "multi-file change" });
		expect(structuredCallMock).toHaveBeenCalledTimes(1);
	});

	it("returns undefined when structuredCall fails (never fabricates a result)", async () => {
		structuredCallMock.mockResolvedValue({ ok: false, error: "no api key" });
		const ctx = {} as ExtensionContext;
		const result = await classifyComplexity(ctx, fakeRoles(), DEFAULT_CONFIG, "anything", undefined);
		expect(result).toBeUndefined();
	});

	it("uses the role configured as routing.classifier", async () => {
		structuredCallMock.mockResolvedValue({
			ok: true,
			value: { complexity: "trivial", needsPlan: false, reason: "one-line answer" },
			raw: {},
		});
		const roles = fakeRoles();
		const ctx = {} as ExtensionContext;
		await classifyComplexity(ctx, roles, { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, classifier: "executor" } }, "x", undefined);
		const [, roleArg] = structuredCallMock.mock.calls[0]!;
		expect(roleArg).toBe(roles.executor);
	});
});

describe("shouldBypassPipeline", () => {
	it("bypasses when trivial + no plan needed + trivialBypass enabled", () => {
		expect(
			shouldBypassPipeline(DEFAULT_CONFIG, { complexity: "trivial", needsPlan: false, reason: "" }),
		).toBe(true);
	});

	it("does not bypass when needsPlan is true even if trivial", () => {
		expect(
			shouldBypassPipeline(DEFAULT_CONFIG, { complexity: "trivial", needsPlan: true, reason: "" }),
		).toBe(false);
	});

	it("does not bypass for non-trivial complexity", () => {
		expect(
			shouldBypassPipeline(DEFAULT_CONFIG, { complexity: "standard", needsPlan: false, reason: "" }),
		).toBe(false);
	});

	it("does not bypass when trivialBypass is disabled in config", () => {
		const cfg = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, trivialBypass: false } };
		expect(shouldBypassPipeline(cfg, { complexity: "trivial", needsPlan: false, reason: "" })).toBe(false);
	});

	it("never bypasses when there is no classification (stays conservative)", () => {
		expect(shouldBypassPipeline(DEFAULT_CONFIG, undefined)).toBe(false);
	});
});

describe("escalateThinking", () => {
	it("escalates when the floor is higher than the base", () => {
		expect(escalateThinking("low", "high")).toBe("high");
	});

	it("never downgrades below the configured base", () => {
		expect(escalateThinking("high", "low")).toBe("high");
	});

	it("returns the same level when equal", () => {
		expect(escalateThinking("medium", "medium")).toBe("medium");
	});
});

describe("maxComplexity", () => {
	it("returns the higher-ranked tier regardless of argument order", () => {
		expect(maxComplexity("simple", "complex")).toBe("complex");
		expect(maxComplexity("complex", "simple")).toBe("complex");
	});

	it("never ratchets down: the higher of a pinned tier and a lower new classification stays pinned", () => {
		expect(maxComplexity("standard", "trivial")).toBe("standard");
	});

	it("escalates: a pinned tier plus a higher new classification moves up", () => {
		expect(maxComplexity("simple", "complex")).toBe("complex");
	});

	it("treats undefined as lower than any real tier", () => {
		expect(maxComplexity(undefined, "trivial")).toBe("trivial");
		expect(maxComplexity("trivial", undefined)).toBe("trivial");
	});

	it("returns undefined when both sides are undefined", () => {
		expect(maxComplexity(undefined, undefined)).toBeUndefined();
	});

	it("returns the same tier when both sides are equal", () => {
		expect(maxComplexity("standard", "standard")).toBe("standard");
	});
});

describe("nextTierUp", () => {
	it("steps up one tier at a time", () => {
		expect(nextTierUp("trivial")).toBe("simple");
		expect(nextTierUp("simple")).toBe("standard");
		expect(nextTierUp("standard")).toBe("complex");
	});

	it("caps at complex — there's nowhere higher to escalate to", () => {
		expect(nextTierUp("complex")).toBe("complex");
	});
});

describe("effectiveThinking", () => {
	it("escalates planner/executor/validator effort for complex tasks", () => {
		expect(effectiveThinking("executor", { thinking: "medium" }, "complex")).toBe("high");
	});

	it("does not downgrade a high baseline for a trivial task", () => {
		expect(effectiveThinking("planner", { thinking: "high" }, "trivial")).toBe("high");
	});

	it("keeps toolParser at its configured level regardless of complexity (never scales)", () => {
		expect(effectiveThinking("toolParser", { thinking: "off" }, "complex")).toBe("off");
	});

	it("returns the configured level unchanged when there is no classification", () => {
		expect(effectiveThinking("executor", { thinking: "medium" }, undefined)).toBe("medium");
	});
});
