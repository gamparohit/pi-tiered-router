import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	type Complexity,
	type ResolvedRole,
	type RoleConfig,
	type RoleName,
	ROLE_NAMES,
	type RouterConfig,
} from "./types.ts";

/** Split "provider/model-id" into parts. Everything after the first "/" is the id. */
function splitSpec(spec: string): { provider: string; idPattern: string } | undefined {
	const trimmed = spec.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), idPattern: trimmed.slice(slash + 1) };
}

/**
 * Resolve a single "provider/id" or "provider/prefix-*" spec against the registry.
 * Wildcard matches pick the "best" candidate: prefer models that already have auth
 * configured, then the lexicographically greatest id (newest point release wins for
 * date/version-suffixed ids like claude-opus-4-20250101).
 */
function resolveSpec(registry: ModelRegistry, spec: string): Model<any> | undefined {
	const parsed = splitSpec(spec);
	if (!parsed) return undefined;
	const { provider, idPattern } = parsed;

	// Exact match first.
	if (!idPattern.includes("*")) {
		return registry.find(provider, idPattern);
	}

	// Wildcard: strip a single trailing "*" (and any trailing separator) to get the prefix.
	const prefix = idPattern.replace(/\*+$/, "").replace(/[-_]$/, "");
	const all = registry.getAll();
	const candidates = all.filter(
		(m) => m.provider === provider && (prefix === "" || m.id.startsWith(prefix)),
	);
	if (candidates.length === 0) return undefined;

	const authed = new Set(
		candidates.filter((m) => registry.hasConfiguredAuth(m)).map((m) => m.id),
	);
	candidates.sort((a, b) => {
		const aAuth = authed.has(a.id) ? 1 : 0;
		const bAuth = authed.has(b.id) ? 1 : 0;
		if (aAuth !== bAuth) return bAuth - aAuth; // authed first
		return b.id.localeCompare(a.id); // newest id last-wins
	});
	return candidates[0];
}

/**
 * Resolve one role using its primary spec, then its fallback chain.
 * A fallback of "skip" disables the role (skipped=true, model=undefined).
 */
export function resolveRole(
	registry: ModelRegistry,
	role: RoleName,
	roleConfig: RoleConfig,
	fallbacks: string[] = [],
): ResolvedRole {
	const base: Omit<ResolvedRole, "model" | "resolvedId" | "viaFallback" | "skipped"> = {
		role,
		thinking: roleConfig.thinking,
		requested: roleConfig.model,
	};

	// A primary spec of "skip" disables the role directly — same convention as
	// "skip" in a fallback chain, just spelled at the front. Lets /router config
	// and the setup wizard offer "skip" as a role's model without the resolver
	// treating it as an unresolvable "provider/id" spec and warning at startup.
	if (roleConfig.model.trim().toLowerCase() === "skip") {
		return { ...base, model: undefined, viaFallback: false, skipped: true };
	}

	// Primary.
	const primary = resolveSpec(registry, roleConfig.model);
	if (primary) {
		return {
			...base,
			model: primary,
			resolvedId: `${primary.provider}/${primary.id}`,
			viaFallback: false,
			skipped: false,
		};
	}

	// Fallback chain.
	for (const fb of fallbacks) {
		if (fb === "skip") {
			return { ...base, model: undefined, viaFallback: true, skipped: true };
		}
		const m = resolveSpec(registry, fb);
		if (m) {
			return {
				...base,
				model: m,
				resolvedId: `${m.provider}/${m.id}`,
				viaFallback: true,
				skipped: false,
			};
		}
	}

	// Unresolved and not explicitly skipped.
	return { ...base, model: undefined, viaFallback: false, skipped: false };
}

/** Resolve all four roles. */
export function resolveAllRoles(
	registry: ModelRegistry,
	config: RouterConfig,
): Record<RoleName, ResolvedRole> {
	const out = {} as Record<RoleName, ResolvedRole>;
	for (const role of ROLE_NAMES) {
		out[role] = resolveRole(registry, role, config.roles[role], config.fallbacks[role] ?? []);
	}
	return out;
}

/**
 * Apply `routing.tiers[complexity]`'s role overrides on top of already-resolved
 * base roles. Roles with no override for this tier (or when `tiers`/`complexity`
 * is absent entirely) pass through `resolved` unchanged — tiering is additive,
 * never required. An override's own spec is resolved via the same
 * resolve-then-fallback machinery as the base config (using that role's normal
 * `fallbacks` chain); if neither the override nor its fallbacks resolve, this
 * degrades to the base resolved role rather than leaving the turn with no
 * model at all — a tier override is a deliberate quality choice, not a new
 * failure mode to introduce.
 *
 * Never call this for the classifier's own role lookup: tiering depends on
 * already knowing the complexity, so classification always runs on `resolved`
 * (the base roles), not a tiered set.
 */
export function rolesForTier(
	registry: ModelRegistry,
	resolved: Record<RoleName, ResolvedRole>,
	config: RouterConfig,
	complexity: Complexity | undefined,
): Record<RoleName, ResolvedRole> {
	const tierOverrides = complexity ? config.routing.tiers?.[complexity] : undefined;
	if (!tierOverrides) return resolved;

	const out = { ...resolved };
	for (const role of ROLE_NAMES) {
		const override = tierOverrides[role];
		if (!override) continue; // no override for this role at this tier — falls through to base

		if (override === "skip") {
			out[role] = { role, model: undefined, thinking: resolved[role].thinking, requested: "skip", viaFallback: false, skipped: true };
			continue;
		}

		const tierResolved = resolveRole(registry, role, override, config.fallbacks[role] ?? []);
		out[role] = tierResolved.model || tierResolved.skipped ? tierResolved : resolved[role];
	}
	return out;
}

/** One-line human summary of a resolved role, e.g. "planner → anthropic/claude-opus-4 (high)". */
export function describeRole(r: ResolvedRole): string {
	if (r.skipped) return `${r.role} → skipped`;
	if (!r.model) return `${r.role} → UNRESOLVED (wanted ${r.requested})`;
	const via = r.viaFallback ? " [fallback]" : "";
	return `${r.role} → ${r.resolvedId} (${r.thinking})${via}`;
}

/** Short model label for status lines, e.g. "opus" from "claude-opus-4-20250101". */
export function shortModelLabel(r: ResolvedRole): string {
	if (r.skipped) return "—";
	if (!r.model) return "?";
	const id = r.model.id;
	const m = id.match(/(opus|sonnet|haiku|fable|gpt-?\d*|gemini|o\d)/i);
	if (m?.[1]) return m[1].toLowerCase();
	return id.split(/[-_]/)[0] ?? id;
}
