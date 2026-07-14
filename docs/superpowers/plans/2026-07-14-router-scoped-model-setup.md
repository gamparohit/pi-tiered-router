# Router Scoped-Model Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/router setup` inherit the models the user already uses in pi (current session model + pi's scoped-model settings), resolve non-wildcard specs with pi's own model-resolution semantics, and make the `/router` subcommands discoverable.

**Architecture:** Two independently-testable changes to `extensions/model-router/`: (A) `roles.ts` gets a two-path spec resolver — wildcard specs keep the router's own authed-first matcher, everything else delegates to pi's public `resolveCliModel`; (B) `index.ts`'s setup wizard gains a pure `orderModelsForRole` sort (current session model → pi's scoped-model set → authed → rest) and `/router` gains argument completions + a help subcommand.

**Tech Stack:** TypeScript, Vitest, the `@earendil-works/pi-coding-agent` / `pi-ai` / `pi-agent-core` SDKs already used throughout the extension. No new dependencies.

## Global Constraints

- `ResolvedRole` (types.ts) shape must not change — `pipeline.ts`, `modes.ts`, `ui.ts`, `router.ts` all consume it as-is.
- `resolveRole` / `resolveAllRoles` / `resolveSpec` must stay **synchronous** — they're called throughout the sync pipeline. Do not introduce `async` there.
- Do not import `minimatch` directly and do not call the async `resolveModelScopeWithDiagnostics` from the synchronous resolver path (roles.ts). That async function is only used in the wizard (index.ts), which is already async.
- Only import from `@earendil-works/pi-coding-agent`'s public root export (its `package.json` `exports` map only exposes `"."` and `"./rpc-entry"` — deep paths like `.../dist/core/model-resolver.js` are NOT importable at runtime). Confirmed importable names used in this plan: `resolveCliModel`, `resolveModelScopeWithDiagnostics`, `SettingsManager`, `ModelRegistry` (type), `ScopedModel` (type).
- `resolveCliModel` fabricates a synthetic `Model` object for an unmatched id under a *known* provider (pi's own `--model` UX for not-yet-registered ids — see Task 2). The router must reject that fabrication and treat it as unresolved, never silently drive real API calls with a made-up model.
- No new runtime dependencies. No custom `ctx.ui.custom` TUI component — `ctx.ui.select`'s existing type-to-filter is enough.
- All existing tests in `test/roles.test.ts` and `test/index.test.ts` must stay green throughout.

---

## Task 1: Failing tests for the new resolver behavior

**Files:**
- Modify: `test/roles.test.ts`

**Interfaces:**
- Consumes: `resolveRole(registry, role, roleConfig, fallbacks)` — unchanged call signature, from `extensions/model-router/roles.ts` (already imported in this file).
- Consumes: `registryWithAuth(providers: string[]): ModelRegistry` — existing test helper in this file.

The real built-in anthropic catalog (confirmed via `ModelRegistry.inMemory`) includes both an alias and a dated id for the same release, e.g. `claude-opus-4-5` (alias) and `claude-opus-4-5-20251101` (dated) — that pair is what makes the alias-vs-dated fuzzy-match test meaningful.

- [ ] **Step 1: Add the new test cases**

Add this new `describe` block at the end of `test/roles.test.ts` (after the existing `describe("shortModelLabel", ...)` block):

```typescript
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
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npm test -- test/roles.test.ts`
Expected: the 5 new tests in `"resolveRole — pi-delegated non-wildcard resolution"` FAIL (bare-id and fuzzy specs return `undefined` today because `resolveSpec`'s current `splitSpec` requires an explicit `provider/` prefix with no fuzzy matching, and there's no `:thinking`-suffix handling yet). All pre-existing tests in the file still PASS.

- [ ] **Step 3: Commit**

```bash
git add test/roles.test.ts
git commit -m "test: add failing cases for pi-delegated non-wildcard model resolution"
```

---

## Task 2: Implement the two-path resolver in roles.ts

**Files:**
- Modify: `extensions/model-router/roles.ts:1-54` (imports and `resolveSpec`)
- Modify: `extensions/model-router/roles.ts:56-111` (`resolveRole`)

**Interfaces:**
- Produces: `resolveSpec(registry: ModelRegistry, spec: string): { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined` (internal, not exported — same as before, just a new return shape).
- Produces: `resolveRole(...)` — same exported signature and `ResolvedRole` return shape as before; only the internal computation of `thinking` changes (a spec-embedded `:thinking` suffix now overrides the configured level for that particular resolution).

- [ ] **Step 1: Replace the imports and `splitSpec`/`resolveSpec` block**

Replace lines 1-54 of `extensions/model-router/roles.ts` (from the top of the file through the end of the old `resolveSpec` function) with:

```typescript
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { resolveCliModel, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	type Complexity,
	type ResolvedRole,
	type RoleConfig,
	type RoleName,
	ROLE_NAMES,
	type RouterConfig,
} from "./types.ts";

interface SpecResolution {
	model: Model<any>;
	/** Explicit ":thinking" suffix on the spec, if any — overrides the role's configured level. */
	thinkingLevel?: ThinkingLevel;
}

/**
 * Resolve a single model spec against the registry. Two paths:
 *
 * - "provider/prefix-*" wildcards: matched by the router itself (prefer
 *   candidates with configured auth, then the lexicographically greatest id —
 *   newest point release wins for date-suffixed ids). pi's own resolver has
 *   no glob support, so this stays hand-rolled.
 * - Everything else (an exact "provider/id", a bare id, or either with a
 *   ":thinking" suffix): delegated to pi's own `resolveCliModel`, so a config
 *   spec resolves with the exact same semantics as pi's `/model` command
 *   (alias-over-dated preference, fuzzy substring match, ":thinking" suffix
 *   parsing). `resolveCliModel` also fabricates a placeholder Model for an
 *   unmatched id under a *known* provider (pi's CLI convenience for
 *   not-yet-registered ids) — that placeholder is rejected here since it was
 *   never a real registry entry; the router must not silently "resolve" to a
 *   made-up model.
 */
function resolveSpec(registry: ModelRegistry, spec: string): SpecResolution | undefined {
	const trimmed = spec.trim();
	if (!trimmed) return undefined;

	const slash = trimmed.indexOf("/");
	const hasProviderPrefix = slash > 0 && slash < trimmed.length - 1;
	const idPart = hasProviderPrefix ? trimmed.slice(slash + 1) : trimmed;

	if (idPart.includes("*")) {
		if (!hasProviderPrefix) return undefined; // wildcards require an explicit "provider/" prefix
		const provider = trimmed.slice(0, slash);
		const prefix = idPart.replace(/\*+$/, "").replace(/[-_]$/, "");
		const candidates = registry.getAll().filter((m) => m.provider === provider && (prefix === "" || m.id.startsWith(prefix)));
		if (candidates.length === 0) return undefined;

		const authed = new Set(candidates.filter((m) => registry.hasConfiguredAuth(m)).map((m) => m.id));
		candidates.sort((a, b) => {
			const aAuth = authed.has(a.id) ? 1 : 0;
			const bAuth = authed.has(b.id) ? 1 : 0;
			if (aAuth !== bAuth) return bAuth - aAuth; // authed first
			return b.id.localeCompare(a.id); // newest id wins
		});
		return { model: candidates[0] };
	}

	const result = resolveCliModel({ cliModel: trimmed, modelRegistry: registry });
	if (!result.model) return undefined;

	// Reject resolveCliModel's fabricated placeholder: it's never reference-identical
	// to (and won't match provider+id of) any real registry entry.
	const isReal = registry.getAll().some((m) => m.provider === result.model!.provider && m.id === result.model!.id);
	if (!isReal) return undefined;

	return { model: result.model, thinkingLevel: result.thinkingLevel };
}
```

- [ ] **Step 2: Replace `resolveRole` to apply the resolution's `thinkingLevel` override**

After Step 1, the file continues with the original `resolveRole` function, unchanged so far (the blank line, doc comment, and function body that were originally at lines 56-111). Replace that entire function — from the `/**\n * Resolve one role using its primary spec...` doc comment through its closing `}` — with:

```typescript
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
	const base: Pick<ResolvedRole, "role" | "requested"> = {
		role,
		requested: roleConfig.model,
	};

	// A primary spec of "skip" disables the role directly — same convention as
	// "skip" in a fallback chain, just spelled at the front. Lets /router config
	// and the setup wizard offer "skip" as a role's model without the resolver
	// treating it as an unresolvable "provider/id" spec and warning at startup.
	if (roleConfig.model.trim().toLowerCase() === "skip") {
		return { ...base, model: undefined, thinking: roleConfig.thinking, viaFallback: false, skipped: true };
	}

	// Primary.
	const primary = resolveSpec(registry, roleConfig.model);
	if (primary) {
		return {
			...base,
			model: primary.model,
			resolvedId: `${primary.model.provider}/${primary.model.id}`,
			thinking: primary.thinkingLevel ?? roleConfig.thinking,
			viaFallback: false,
			skipped: false,
		};
	}

	// Fallback chain.
	for (const fb of fallbacks) {
		if (fb === "skip") {
			return { ...base, model: undefined, thinking: roleConfig.thinking, viaFallback: true, skipped: true };
		}
		const resolved = resolveSpec(registry, fb);
		if (resolved) {
			return {
				...base,
				model: resolved.model,
				resolvedId: `${resolved.model.provider}/${resolved.model.id}`,
				thinking: resolved.thinkingLevel ?? roleConfig.thinking,
				viaFallback: true,
				skipped: false,
			};
		}
	}

	// Unresolved and not explicitly skipped.
	return { ...base, model: undefined, thinking: roleConfig.thinking, viaFallback: false, skipped: false };
}
```

Leave the rest of the file (`resolveAllRoles`, `rolesForTier`, `describeRole`, `shortModelLabel`) untouched — none of them reference `splitSpec` or the old `resolveSpec` return shape directly.

- [ ] **Step 3: Run the full roles test file**

Run: `npm test -- test/roles.test.ts`
Expected: PASS — all pre-existing tests plus the 5 new ones from Task 1.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add extensions/model-router/roles.ts
git commit -m "feat: delegate non-wildcard model spec resolution to pi's resolveCliModel"
```

---

## Task 3: `orderModelsForRole` — pure ordering helper + tests

**Files:**
- Modify: `extensions/model-router/roles.ts` (append the new function)
- Modify: `test/roles.test.ts` (append its tests)

**Interfaces:**
- Consumes: nothing new — pure function over plain data.
- Produces: `orderModelsForRole(input: { all: Model<any>[]; currentModel: Model<any> | undefined; scopedIds: Set<string>; hasAuth: (m: Model<any>) => boolean }): Model<any>[]`, exported from `roles.ts`. Task 5 (index.ts wizard) imports and calls this directly.

- [ ] **Step 1: Write the failing tests**

Append to `test/roles.test.ts`:

```typescript
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
```

Replace the current top-of-file imports of `test/roles.test.ts` (lines 1-5):

```typescript
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveAllRoles, resolveRole, rolesForTier, shortModelLabel } from "../extensions/model-router/roles.ts";
import { DEFAULT_CONFIG } from "../extensions/model-router/config.ts";
import type { ResolvedRole, RoleName, RouterConfig } from "../extensions/model-router/types.ts";
```

with:

```typescript
import type { Model } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { orderModelsForRole, resolveAllRoles, resolveRole, rolesForTier, shortModelLabel } from "../extensions/model-router/roles.ts";
import { DEFAULT_CONFIG } from "../extensions/model-router/config.ts";
import type { ResolvedRole, RoleName, RouterConfig } from "../extensions/model-router/types.ts";
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npm test -- test/roles.test.ts`
Expected: FAIL with "orderModelsForRole is not a function" (or a TypeScript import error) — it doesn't exist yet.

- [ ] **Step 3: Implement `orderModelsForRole`**

Append to the end of `extensions/model-router/roles.ts`:

```typescript
/** "provider/id" key for a model — used to match against the current session model and the scoped-model set. */
export function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}

/**
 * Order a role's model options for the setup wizard: the current pi session
 * model first, then models in pi's scoped-model set (Settings.enabledModels,
 * resolved by the caller), then authed/available models, then the rest —
 * ties within a rank break alphabetically by "provider/id" for a stable,
 * predictable list. Pure and synchronous so it's testable without a registry
 * or UI context; `index.ts`'s setup wizard supplies the real registry data.
 */
export function orderModelsForRole(input: {
	all: Model<any>[];
	currentModel: Model<any> | undefined;
	scopedIds: Set<string>;
	hasAuth: (m: Model<any>) => boolean;
}): Model<any>[] {
	const { all, currentModel, scopedIds, hasAuth } = input;
	const currentKey = currentModel ? modelKey(currentModel) : undefined;

	function rank(m: Model<any>): number {
		if (currentKey && modelKey(m) === currentKey) return 0;
		if (scopedIds.has(modelKey(m))) return 1;
		if (hasAuth(m)) return 2;
		return 3;
	}

	return [...all].sort((a, b) => {
		const ra = rank(a);
		const rb = rank(b);
		if (ra !== rb) return ra - rb;
		return modelKey(a).localeCompare(modelKey(b));
	});
}
```

- [ ] **Step 4: Run the tests again**

Run: `npm test -- test/roles.test.ts`
Expected: PASS, all tests including the 4 new `orderModelsForRole` ones.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extensions/model-router/roles.ts test/roles.test.ts
git commit -m "feat: add orderModelsForRole — current/scoped/authed ordering for the setup wizard"
```

---

## Task 4: Wizard inherits current model + scoped models, gets role explanations

**Files:**
- Modify: `extensions/model-router/index.ts:1-26` (imports)
- Modify: `extensions/model-router/index.ts:153-198` (`RoleSelection`, `roleCanBeSkipped`, `selectModelForRole`)
- Modify: `extensions/model-router/index.ts:270-289` (`runSetupWizard`'s per-role loop start)
- Modify: `test/index.test.ts` (one new integration test)

**Interfaces:**
- Consumes: `orderModelsForRole`, `modelKey` from `./roles.ts` (Task 3).
- Consumes (pi SDK, both already-public exports): `SettingsManager.create(cwd, agentDir?, options?)` / `.getEnabledModels(): string[] | undefined`; `resolveModelScopeWithDiagnostics(patterns: string[], registry: ModelRegistry): Promise<{ scopedModels: { model: Model<any>; thinkingLevel?: ThinkingLevel }[]; diagnostics: unknown[] }>`.
- Produces: `resolveScopedModelIds(ctx): Promise<Set<string>>` (module-private, used only inside `runSetupWizard`).

- [ ] **Step 1: Add the new imports**

In `extensions/model-router/index.ts`, replace line 12:

```typescript
import { describeRole, resolveAllRoles, rolesForTier } from "./roles.ts";
```

with:

```typescript
import { describeRole, modelKey, orderModelsForRole, resolveAllRoles, rolesForTier } from "./roles.ts";
```

And replace line 5-6:

```typescript
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
```

with:

```typescript
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, resolveModelScopeWithDiagnostics, SettingsManager } from "@earendil-works/pi-coding-agent";
```

- [ ] **Step 2: Add role descriptions, the scoped-model resolver, and the model-key/marker helpers**

Immediately before the `type RoleSelection = ...` block (currently `extensions/model-router/index.ts:153`), insert:

```typescript
	/** One-line explanation of each role, shown in its setup-wizard picker title. */
	const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
		planner: "decomposes the goal into a numbered plan",
		validator: "independently critiques the plan before execution (up to 2 revision rounds)",
		executor: "writes the code once the plan is validated",
		toolParser: "classifies task complexity and compresses noisy tool output",
	};

	/**
	 * Resolve pi's scoped-model patterns (Settings.enabledModels — the set the
	 * user curates for Ctrl+P cycling) to a "provider/id" key set, so the wizard
	 * can surface models the user already scoped ahead of the rest of the
	 * registry. Best-effort: any failure, or no scope configured, degrades to an
	 * empty set rather than blocking setup — inheriting is a bonus, not a
	 * requirement for the wizard to work.
	 */
	async function resolveScopedModelIds(ctx: ExtensionCommandContext): Promise<Set<string>> {
		try {
			const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
			const patterns = settings.getEnabledModels();
			if (!patterns || patterns.length === 0) return new Set();
			const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, ctx.modelRegistry);
			return new Set(scopedModels.map((sm) => modelKey(sm.model)));
		} catch {
			return new Set();
		}
	}

```

- [ ] **Step 3: Rewrite `selectModelForRole`**

Replace the existing `selectModelForRole` function (currently `extensions/model-router/index.ts:165-198`, i.e. from `async function selectModelForRole(ctx: ExtensionCommandContext, role: RoleName)` through its closing `}`) with:

```typescript
	/** Prompt for a role's model: the current session model and scoped models surfaced first (marked), then authed models, plus keep/custom/skip. Returns undefined if the user cancels. */
	async function selectModelForRole(
		ctx: ExtensionCommandContext,
		role: RoleName,
		scopedIds: Set<string>,
	): Promise<RoleSelection | undefined> {
		const current = roles?.[role];
		const sorted = orderModelsForRole({
			all: ctx.modelRegistry.getAll(),
			currentModel: ctx.model,
			scopedIds,
			hasAuth: (m) => ctx.modelRegistry.hasConfiguredAuth(m),
		});
		const modelLabel = (m: (typeof sorted)[number]) => {
			const key = modelKey(m);
			const scopeMark = ctx.model && modelKey(ctx.model) === key ? "▶" : scopedIds.has(key) ? "◆" : " ";
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
```

- [ ] **Step 4: Wire the scoped-model lookup and legend into `runSetupWizard`**

In `runSetupWizard` (currently `extensions/model-router/index.ts:270-274`), replace:

```typescript
	async function runSetupWizard(ctx: ExtensionCommandContext, targetRoles: RoleName[]): Promise<void> {
		const updates: Partial<Record<RoleName, { model: string; thinking: ThinkingLevel }>> = {};
		const changedRoles: RoleName[] = [];

		for (const role of targetRoles) {
			const selection = await selectModelForRole(ctx, role);
```

with:

```typescript
	async function runSetupWizard(ctx: ExtensionCommandContext, targetRoles: RoleName[]): Promise<void> {
		const scopedIds = await resolveScopedModelIds(ctx);
		notify(ctx, "▶ current session model   ◆ in your pi model scope   ✓ auth configured", "info");

		const updates: Partial<Record<RoleName, { model: string; thinking: ThinkingLevel }>> = {};
		const changedRoles: RoleName[] = [];

		for (const role of targetRoles) {
			const selection = await selectModelForRole(ctx, role, scopedIds);
```

(The rest of the function body — everything after this line — is unchanged.)

- [ ] **Step 5: Add an integration test proving the current-session-model marker/ordering**

Append to `test/index.test.ts`, inside (or right after) the existing `describe("/router config wizard write path", ...)` block — add this as a new `it` inside that same `describe`:

```typescript
	it("surfaces the current session model first, marked, in the role picker", async () => {
		globalConfigPathMock.mockReturnValue(path.join(tmpDir, "global.json"));
		const { commands, ctx } = await bootstrap();
		(ctx as unknown as { model: (typeof FAKE_MODELS)[number] }).model = FAKE_MODELS[3]; // "test/validator-model"

		let seenOptions: string[] = [];
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async (title: string, options: string[]) => {
			if (title.includes("Which role")) return "validator";
			if (title.startsWith("Model for")) {
				seenOptions = options;
				return options.find((o) => o.includes("Skip this role"));
			}
			if (title.includes("scope")) return options.find((o) => o.includes("Global"));
			throw new Error(`unscripted select prompt: "${title}"`);
		});

		await commands.get("router")!("config", ctx as ExtensionCommandContext);

		// Index 0 is "Keep current"; index 1 is the first model option and must be
		// the session's active model, marked with the "▶" current-session marker.
		expect(seenOptions[1]).toContain("▶");
		expect(seenOptions[1]).toContain("test/validator-model");
	});
```

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npm test`
Expected: PASS, all tests including the new one.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Manual verification (interactive-only surface)**

The scoped-model inheritance path (`resolveScopedModelIds` actually reading `SettingsManager`) and `ctx.ui.select`'s live type-to-filter behavior can't be exercised by the fake-pi test harness without real file I/O — verify by hand once:

1. `pi install -l .` (or run `pi -e .` from this repo) in a project where `~/.pi/agent/settings.json` has a non-empty `enabledModels` list.
2. Run `/router setup`.
3. Confirm the current session model shows first with `▶`, scoped models show next with `◆`, and typing a few characters filters the list.

- [ ] **Step 8: Commit**

```bash
git add extensions/model-router/index.ts test/index.test.ts
git commit -m "feat: setup wizard inherits current session model and pi's scoped-model set"
```

---

## Task 5: `/router` discoverability — argument completions, help, unknown-subcommand guard

**Files:**
- Modify: `extensions/model-router/index.ts:322-360` (`session_start`'s first-run hint text, line 357)
- Modify: `extensions/model-router/index.ts:459-554` (`router` command registration)
- Modify: `test/index.test.ts` (new tests)

**Interfaces:**
- Produces: `ROUTER_SUBCOMMANDS` (module-private constant) and `getArgumentCompletions` on the `router` command — no other module depends on these.

- [ ] **Step 1: Add the subcommand table**

Immediately before `pi.registerCommand("router", {` (currently `extensions/model-router/index.ts:459`), insert:

```typescript
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
		{ value: "help", description: "show this list" },
	];

	const ROUTER_HELP = [
		"/router subcommands:",
		...ROUTER_SUBCOMMANDS.map((c) => `  ${c.value.padEnd(14)} ${c.description}`),
		"",
		"/router (no args) shows the status dashboard.",
	].join("\n");

```

- [ ] **Step 2: Add `getArgumentCompletions`, the `help` subcommand, and the unknown-subcommand guard**

Replace the `pi.registerCommand("router", { ... })` call's opening (currently `extensions/model-router/index.ts:459-462`):

```typescript
	pi.registerCommand("router", {
		description: "model-router status dashboard: resolved roles, mode, config sources",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const sub = args.trim().toLowerCase();
```

with:

```typescript
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
```

Then, in the same handler, find the existing block (currently `extensions/model-router/index.ts:531-535`):

```typescript
			if (!config || !roles) {
				notify(ctx, "not initialized yet", "warning");
				return;
			}

			const lines = [
```

and replace it with:

```typescript
			if (!config || !roles) {
				notify(ctx, "not initialized yet", "warning");
				return;
			}

			if (sub !== "") {
				notify(ctx, `Unknown /router subcommand "${sub}".\n\n${ROUTER_HELP}`, "warning");
				return;
			}

			const lines = [
```

Finally, in that same `lines` array (ends right before the closing `notify(ctx, lines.join("\n"), "info");`, currently around `extensions/model-router/index.ts:549-552`), add a trailing hint. Replace:

```typescript
				stats.summarize(),
			];

			notify(ctx, lines.join("\n"), "info");
```

with:

```typescript
				stats.summarize(),
				"",
				'Run "/router help" to see all subcommands.',
			];

			notify(ctx, lines.join("\n"), "info");
```

- [ ] **Step 3: Tweak the first-run hint to mention `/router help`**

In the `session_start` handler (currently `extensions/model-router/index.ts:357`), replace:

```typescript
				notify(ctx, 'model-router: some roles are unresolved and no config file exists yet — run "/router setup" to configure all four interactively.', "info");
```

with:

```typescript
				notify(
					ctx,
					'model-router: some roles are unresolved and no config file exists yet — run "/router setup" to configure all four interactively (or "/router help" to see all subcommands).',
					"info",
				);
```

- [ ] **Step 4: Add tests**

First, extend `createFakePi()`'s `registerCommand` mock so tests can retrieve `getArgumentCompletions`, not just the handler. In `test/index.test.ts`, replace:

```typescript
function createFakePi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => unknown>();
	const pi = {
		on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		}),
		registerCommand: vi.fn((name: string, opts: { handler: (args: string, ctx: ExtensionCommandContext) => unknown }) => {
			commands.set(name, opts.handler);
		}),
```

with:

```typescript
function createFakePi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => unknown>();
	const completions = new Map<string, (prefix: string) => unknown>();
	const pi = {
		on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		}),
		registerCommand: vi.fn(
			(
				name: string,
				opts: {
					handler: (args: string, ctx: ExtensionCommandContext) => unknown;
					getArgumentCompletions?: (prefix: string) => unknown;
				},
			) => {
				commands.set(name, opts.handler);
				if (opts.getArgumentCompletions) completions.set(name, opts.getArgumentCompletions);
			},
		),
```

Then update the function's return statement (currently `return { pi, handlers, commands };`) to also return `completions`:

```typescript
	return { pi, handlers, commands, completions };
}
```

And update `bootstrap()`'s return to pass `completions` through:

```typescript
async function bootstrap() {
	const { pi, handlers, commands, completions } = createFakePi();
	routerExtension(pi);
	const ctx = createFakeCtx();
	await handlers.get("session_start")!({ type: "session_start", reason: "new" }, ctx);
	return { handlers, commands, completions, ctx };
}
```

Now add a new `describe` block at the end of `test/index.test.ts`:

```typescript
describe("/router discoverability", () => {
	it("getArgumentCompletions lists subcommands filtered by prefix", async () => {
		const { completions } = await bootstrap();
		const getCompletions = completions.get("router")!;

		const all = (await getCompletions("")) as { value: string }[];
		expect(all.map((c) => c.value)).toContain("setup");
		expect(all.map((c) => c.value)).toContain("help");

		const filtered = (await getCompletions("tr")) as { value: string }[];
		expect(filtered.map((c) => c.value).sort()).toEqual(["trace", "trace off", "trace on"]);
	});

	it('"/router help" prints the subcommand list', async () => {
		const { commands, ctx } = await bootstrap();
		await commands.get("router")!("help", ctx as ExtensionCommandContext);
		const lastNotify = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
		expect(lastNotify).toContain("/router subcommands:");
		expect(lastNotify).toContain("setup");
	});

	it("warns on an unknown subcommand instead of silently showing the dashboard", async () => {
		const { commands, ctx } = await bootstrap();
		await commands.get("router")!("bogus", ctx as ExtensionCommandContext);
		const lastNotify = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
		expect(lastNotify).toContain('Unknown /router subcommand "bogus"');
	});

	it("the no-arg dashboard still renders and points at /router help", async () => {
		const { commands, ctx } = await bootstrap();
		await commands.get("router")!("", ctx as ExtensionCommandContext);
		const lastNotify = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
		expect(lastNotify).toContain("roles:");
		expect(lastNotify).toContain("/router help");
	});
});
```

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test`
Expected: PASS — every test in the repo, including the 4 new ones here.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extensions/model-router/index.ts test/index.test.ts
git commit -m "feat: add /router argument completions, help subcommand, and unknown-subcommand guard"
```

---

## Task 6: Update docs

**Files:**
- Modify: `README.md` (the "Setup" section, currently lines ~34-40)
- Modify: `docs/configuration.md` (the "## Setup" section, currently lines ~33-49)

**Interfaces:** None — documentation only.

- [ ] **Step 1: Update `README.md`'s Setup paragraph**

In `README.md`, find this paragraph (in the "## Setup" section):

```markdown
Want to point specific roles at different models? Run `/router setup` — it
walks all four roles in order, one at a time, offering the models your `pi`
install actually has available (authenticated ones marked and listed first),
plus keep-current / type-a-custom-spec / skip-this-role options, then a
thinking-level pick per role, then one prompt for global vs. project config
scope. `/router config` is the same wizard scoped to a single role, for a
quick one-off change.
```

Replace it with:

```markdown
Want to point specific roles at different models? Run `/router setup` — it
walks all four roles in order, one at a time. Each role's picker surfaces
your current pi session model first (marked `▶`), then any models in your
pi model scope (`◆`, from `Settings.enabledModels`), then everything else
with configured auth listed next (`✓`) — plus keep-current /
type-a-custom-spec / skip-this-role options. A spec without a wildcard (an
exact id, a bare id, or either with a `:thinking` suffix) resolves with the
same matching pi's own `/model` command uses; a trailing-`*` wildcard spec
(`anthropic/claude-opus-*`) is matched by the router itself, preferring
whichever candidate already has auth configured. After a thinking-level pick
per changed role, it asks once whether to save to the global config or the
project config (project only offered when the project is trusted), writes
the file (merged with whatever's already there), reloads, and shows the
resolved roles.

`/router config` is the same wizard scoped to a single role you pick first —
use it for a one-off tweak instead of walking all four. Run `/router help`
any time to see every `/router` subcommand (also available via tab-completion
after typing `/router `).
```

- [ ] **Step 2: Update `docs/configuration.md`'s Setup section**

In `docs/configuration.md`, find the `## Setup` section:

```markdown
## Setup

`/router setup` walks all four roles in order (planner → validator → executor
→ toolParser), one `ctx.ui.select` prompt per role listing the models actually
present in your `pi` model registry — authed models (✓) sorted first — plus
three extra choices: **keep current**, **custom spec…** (free-typed, wildcards
allowed), and **skip this role** (validator/toolParser only; planner and
executor are load-bearing for the pipeline to mean anything). After a
thinking-level prompt per changed role, it asks once whether to save to the
global config or the project config (project only offered when the project is
trusted), writes the file (merged with whatever's already there), reloads, and
shows the resolved roles.

`/router config` is the same wizard scoped to a single role you pick first —
use it for a one-off tweak instead of walking all four.

If you're on a fresh install with unresolved roles and no config file yet,
model-router shows a one-time hint suggesting `/router setup` at session
start — it never blocks and never repeats within a session.

Both commands require an interactive UI; in `-p`/JSON/RPC mode they print the
global config path instead so you can edit it by hand.
```

Replace it with:

```markdown
## Setup

`/router setup` walks all four roles in order (planner → validator → executor
→ toolParser), one `ctx.ui.select` prompt per role. Each role's option list is
ordered: the current pi session model first (marked `▶`), then models in your
pi model scope (`◆` — pi's `Settings.enabledModels`, resolved the same way pi
resolves `--models`), then the rest of the registry with authed models (`✓`)
sorted ahead of unauthed ones — plus three extra choices: **keep current**,
**custom spec…** (free-typed, wildcards allowed), and **skip this role**
(validator/toolParser only; planner and executor are load-bearing for the
pipeline to mean anything). Reading the scoped-model set is best-effort — if
it can't be read, or none is configured, the wizard just falls back to the
authed/rest ordering.

A role's `model` spec resolves in one of two ways: a trailing-`*` wildcard
(`anthropic/claude-opus-*`) is matched by the router itself, preferring a
candidate that already has auth configured, then the newest id. Every other
form — an exact `provider/id`, a bare id (`claude-fable-5`), or either with a
`:thinking` suffix (`anthropic/claude-sonnet-5:high`, which overrides that
role's configured thinking level) — is resolved by pi's own model resolver, so
a config spec behaves exactly like typing the same string into pi's `/model`
command.

After a thinking-level prompt per changed role, it asks once whether to save to
the global config or the project config (project only offered when the project
is trusted), writes the file (merged with whatever's already there), reloads,
and shows the resolved roles.

`/router config` is the same wizard scoped to a single role you pick first —
use it for a one-off tweak instead of walking all four.

If you're on a fresh install with unresolved roles and no config file yet,
model-router shows a one-time hint suggesting `/router setup` at session
start — it never blocks and never repeats within a session.

Both commands require an interactive UI; in `-p`/JSON/RPC mode they print the
global config path instead so you can edit it by hand.

Run `/router help` (or press tab after typing `/router `) to see every
subcommand — `setup`, `config`, `reload`, `auto`, `last`, `stats`, `trace[
on|off]`, `toolparse [on|off]`, `help`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/configuration.md
git commit -m "docs: describe the scoped-model-inheriting setup wizard and /router help"
```

---

## Task 7: Final full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — every test file in `test/`, no failures, no skipped tests.

- [ ] **Step 2: Typecheck the whole project**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Confirm the working tree is clean and every task's commit is present**

Run: `git log --oneline main..HEAD`
Expected: one commit per task (7 commits: failing tests, resolver, orderModelsForRole, wizard inheritance, discoverability, docs — plus this step produces no new commit since there's nothing to change).

Run: `git status`
Expected: clean working tree (nothing to commit).

- [ ] **Step 4: Push the branch**

```bash
git push -u origin router-scoped-model-setup
```

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** Component A → Tasks 1-2. Component B → Tasks 3-4. Component C → Task 5. Component D (docs) → Task 6. Testing section → covered inline in each task; wizard TUI/scoped-settings-file-I/O explicitly scoped to manual verification (Task 4 Step 7), matching the spec's own testing section.
- **Deviation from the spec's literal wording, and why:** the spec's Component B text says "Add an explicit 'Use current session model' option at the top of each role's picker." The plan instead orders `ctx.model` to the top of the existing list and marks it `▶`, without a separate duplicate menu entry — `orderModelsForRole` already achieves "surfaced first, clearly marked" with less code and no redundant second way to pick the same model. Flagged here explicitly so this isn't mistaken for a missed requirement.
- **Type consistency check:** `resolveSpec`'s new return shape (`SpecResolution | undefined`) is only consumed inside `resolveRole` (Task 2) — no other file imports `resolveSpec` (it was never exported). `orderModelsForRole`'s signature (Task 3) matches its only call site in `selectModelForRole` (Task 4) exactly (`all`, `currentModel`, `scopedIds`, `hasAuth`). `modelKey` is exported once (Task 3) and imported once (Task 4) — no naming drift.
