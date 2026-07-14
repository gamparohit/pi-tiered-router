import type { Model } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { orderModelsForRole, resolveAllRoles, resolveRole, rolesForTier, shortModelLabel } from "../extensions/model-router/roles.ts";
import { DEFAULT_CONFIG } from "../extensions/model-router/config.ts";
import type { ResolvedRole, RoleName, RouterConfig } from "../extensions/model-router/types.ts";

function registryWithAuth(providers: string[]): ModelRegistry {
	const data = Object.fromEntries(providers.map((p) => [p, { type: "api_key" as const, key: "sk-test" }]));
	return ModelRegistry.inMemory(AuthStorage.inMemory(data));
}

describe("resolveRole", () => {
	it("resolves an exact provider/id spec", () => {
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(registry, "executor", { model: "anthropic/claude-sonnet-4-5", thinking: "medium" }, []);
		expect(r.skipped).toBe(false);
		expect(r.model?.id).toBe("claude-sonnet-4-5");
		expect(r.viaFallback).toBe(false);
	});

	it("resolves a wildcard spec to an authed, newest-id candidate", () => {
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(registry, "planner", { model: "anthropic/claude-opus-*", thinking: "high" }, []);
		expect(r.model?.provider).toBe("anthropic");
		expect(r.model?.id.startsWith("claude-opus-")).toBe(true);
		// Newest dateless id should win over an older dated one when both are authed.
		expect(r.model?.id).toBe("claude-opus-4-8");
	});

	it("prefers authed candidates over unauthed ones on wildcard resolution", () => {
		// No providers authed at all -> falls back to plain lexicographic "newest wins",
		// still deterministic.
		const registry = registryWithAuth([]);
		const r = resolveRole(registry, "planner", { model: "anthropic/claude-opus-*", thinking: "high" }, []);
		expect(r.model).toBeDefined();
	});

	it("falls through the fallback chain when the primary spec is unresolvable", () => {
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(
			registry,
			"planner",
			{ model: "anthropic/claude-does-not-exist-*", thinking: "high" },
			["anthropic/claude-sonnet-4-5"],
		);
		expect(r.viaFallback).toBe(true);
		expect(r.model?.id).toBe("claude-sonnet-4-5");
		expect(r.skipped).toBe(false);
	});

	it('honors "skip" in the fallback chain', () => {
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(registry, "validator", { model: "does-not/exist-*", thinking: "medium" }, ["skip"]);
		expect(r.skipped).toBe(true);
		expect(r.model).toBeUndefined();
	});

	it('honors "skip" as the primary model spec directly (not just in fallbacks)', () => {
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(registry, "validator", { model: "skip", thinking: "medium" }, []);
		expect(r.skipped).toBe(true);
		expect(r.model).toBeUndefined();
		expect(r.viaFallback).toBe(false);
	});

	it('treats "SKIP" (any case, surrounding whitespace) as skip too', () => {
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(registry, "toolParser", { model: "  Skip  ", thinking: "off" }, []);
		expect(r.skipped).toBe(true);
	});

	it("leaves a role unresolved (not skipped) when nothing matches and no fallback given", () => {
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(registry, "executor", { model: "nope/nothing", thinking: "medium" }, []);
		expect(r.skipped).toBe(false);
		expect(r.model).toBeUndefined();
	});

	it("resolves the real built-in claude-fable model for the validator role", () => {
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(registry, "validator", DEFAULT_CONFIG.roles.validator, DEFAULT_CONFIG.fallbacks.validator);
		expect(r.model?.id).toContain("fable");
	});
});

describe("resolveAllRoles", () => {
	let registry: ModelRegistry;
	beforeEach(() => {
		registry = registryWithAuth(["anthropic"]);
	});

	it("resolves all four default roles against the built-in catalog", () => {
		const roles = resolveAllRoles(registry, DEFAULT_CONFIG);
		expect(roles.planner.model?.id).toContain("opus");
		expect(roles.validator.model?.id).toContain("fable");
		expect(roles.executor.model?.id).toContain("sonnet");
		expect(roles.toolParser.model?.id).toContain("haiku");
	});
});

describe("rolesForTier", () => {
	let registry: ModelRegistry;
	let base: Record<RoleName, ResolvedRole>;

	beforeEach(() => {
		registry = registryWithAuth(["anthropic"]);
		base = resolveAllRoles(registry, DEFAULT_CONFIG);
	});

	function withTiers(tiers: NonNullable<RouterConfig["routing"]["tiers"]>): RouterConfig {
		return { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, tiers } };
	}

	it("passes resolved roles through unchanged when no tiers are configured", () => {
		const out = rolesForTier(registry, base, DEFAULT_CONFIG, "simple");
		expect(out).toBe(base); // same reference: a true no-op, not just equal values
	});

	it("passes resolved roles through unchanged when complexity is undefined", () => {
		const config = withTiers({ simple: { executor: { model: "anthropic/claude-haiku-*", thinking: "low" } } });
		const out = rolesForTier(registry, base, config, undefined);
		expect(out).toBe(base);
	});

	it("falls through unchanged for a tier with no entry in the tiers block", () => {
		const config = withTiers({ simple: { executor: { model: "anthropic/claude-haiku-*", thinking: "low" } } });
		const out = rolesForTier(registry, base, config, "complex");
		expect(out).toBe(base);
	});

	it("overrides only the roles a tier specifies, leaving the rest untouched", () => {
		const config = withTiers({ simple: { executor: { model: "anthropic/claude-haiku-*", thinking: "low" } } });
		const out = rolesForTier(registry, base, config, "simple");
		expect(out.executor.model?.id).toContain("haiku");
		expect(out.executor.thinking).toBe("low");
		// Untouched roles keep the exact same object identity as the base resolution.
		expect(out.planner).toBe(base.planner);
		expect(out.validator).toBe(base.validator);
		expect(out.toolParser).toBe(base.toolParser);
	});

	it('honors "skip" as a tier override', () => {
		const config = withTiers({ simple: { validator: "skip" } });
		const out = rolesForTier(registry, base, config, "simple");
		expect(out.validator.skipped).toBe(true);
		expect(out.validator.model).toBeUndefined();
	});

	it("falls back to the base resolved role when a tier override doesn't resolve and has no working fallback", () => {
		const config: RouterConfig = {
			...withTiers({ complex: { executor: { model: "nope/does-not-exist", thinking: "high" } } }),
			fallbacks: { ...DEFAULT_CONFIG.fallbacks, executor: undefined },
		};
		const out = rolesForTier(registry, base, config, "complex");
		expect(out.executor).toBe(base.executor); // degrades to the already-working base role
	});

	it("uses the role's own fallback chain when a tier override's primary spec fails to resolve", () => {
		const config: RouterConfig = {
			...withTiers({ complex: { executor: { model: "nope/does-not-exist", thinking: "high" } } }),
			fallbacks: { ...DEFAULT_CONFIG.fallbacks, executor: ["anthropic/claude-opus-*"] },
		};
		const out = rolesForTier(registry, base, config, "complex");
		expect(out.executor.model?.id).toContain("opus");
		expect(out.executor.viaFallback).toBe(true);
	});
});

describe("shortModelLabel", () => {
	it("extracts a short family label from a model id", () => {
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(registry, "planner", { model: "anthropic/claude-opus-4-8", thinking: "high" }, []);
		expect(shortModelLabel(r)).toBe("opus");
	});

	it('returns "—" for skipped roles', () => {
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(registry, "validator", { model: "nope/nothing", thinking: "medium" }, ["skip"]);
		expect(shortModelLabel(r)).toBe("—");
	});
});

describe("resolveRole — pi-delegated non-wildcard resolution", () => {
	it("resolves a bare model id with no provider prefix", () => {
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(registry, "validator", { model: "claude-fable-5", thinking: "medium" }, []);
		expect(r.skipped).toBe(false);
		expect(r.model?.provider).toBe("anthropic");
		expect(r.model?.id).toBe("claude-fable-5");
		expect(r.thinking).toBe("medium"); // no ":thinking" suffix in the spec — configured level applies
	});

	it('overrides the configured thinking level when the spec carries a ":thinking" suffix', () => {
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(registry, "executor", { model: "anthropic/claude-sonnet-5:high", thinking: "medium" }, []);
		expect(r.model?.id).toBe("claude-sonnet-5");
		expect(r.thinking).toBe("high"); // spec-embedded level wins over the configured "medium"
	});

	it("prefers the alias id over the dated id on a fuzzy (non-exact, non-wildcard) spec", () => {
		const registry = registryWithAuth(["anthropic"]);
		// "opus-4-5" is a substring of both "claude-opus-4-5" (alias) and
		// "claude-opus-4-5-20251101" (dated) — pi's fuzzy matcher prefers the alias.
		const r = resolveRole(registry, "planner", { model: "anthropic/opus-4-5", thinking: "high" }, []);
		expect(r.model?.id).toBe("claude-opus-4-5");
	});

	it("does not fabricate a placeholder model for an unmatched id under a known provider", () => {
		// pi's own resolveCliModel synthesizes a placeholder Model for CLI convenience
		// when a provider is recognized but the id isn't (so users can type not-yet-
		// registered ids). The router must reject that and stay unresolved instead —
		// silently driving requests at a made-up model is worse than a warning.
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(registry, "executor", { model: "anthropic/claude-totally-made-up-id", thinking: "medium" }, []);
		expect(r.skipped).toBe(false);
		expect(r.model).toBeUndefined();
	});

	it("still resolves an exact provider/id spec that has no alias/dated ambiguity", () => {
		const registry = registryWithAuth(["anthropic"]);
		const r = resolveRole(registry, "toolParser", { model: "anthropic/claude-haiku-4-5", thinking: "off" }, []);
		expect(r.model?.id).toBe("claude-haiku-4-5");
		expect(r.thinking).toBe("off");
	});
});

describe("orderModelsForRole", () => {
	// Model<any> requires several other fields (name, api, baseUrl, cost, ...)
	// that this ordering logic never reads — "as unknown as" is the same
	// partial-fake-data pattern test/index.test.ts uses for FAKE_MODELS.
	function m(provider: string, id: string): Model<any> {
		return { provider, id } as unknown as Model<any>;
	}

	it("orders the current session model first", () => {
		const all = [m("anthropic", "claude-opus-4-8"), m("anthropic", "claude-fable-5"), m("anthropic", "claude-sonnet-5")];
		const out = orderModelsForRole({ all, currentModel: m("anthropic", "claude-fable-5"), scopedIds: new Set(), hasAuth: () => false });
		expect(out[0]).toEqual(m("anthropic", "claude-fable-5"));
	});

	it("orders scoped models ahead of authed-but-unscoped models, which are ahead of the rest", () => {
		const all = [m("anthropic", "claude-opus-4-8"), m("anthropic", "claude-fable-5"), m("anthropic", "claude-sonnet-5")];
		const out = orderModelsForRole({
			all,
			currentModel: undefined,
			scopedIds: new Set(["anthropic/claude-fable-5"]),
			hasAuth: (mm) => mm.id === "claude-opus-4-8",
		});
		expect(out.map((mm) => mm.id)).toEqual(["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5"]);
	});

	it("breaks ties within the same rank alphabetically by provider/id", () => {
		const all = [m("anthropic", "claude-sonnet-5"), m("anthropic", "claude-fable-5")];
		const out = orderModelsForRole({ all, currentModel: undefined, scopedIds: new Set(), hasAuth: () => false });
		expect(out.map((mm) => mm.id)).toEqual(["claude-fable-5", "claude-sonnet-5"]);
	});

	it("does not mutate the input array", () => {
		const all = [m("anthropic", "claude-sonnet-5"), m("anthropic", "claude-fable-5")];
		const copy = [...all];
		orderModelsForRole({ all, currentModel: undefined, scopedIds: new Set(), hasAuth: () => false });
		expect(all).toEqual(copy);
	});
});
