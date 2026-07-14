# Design: smoother `/router setup` that inherits pi's scoped models

Date: 2026-07-14
Branch: `router-scoped-model-setup`

## Problem

`/router setup` (and its per-role sibling `/router config`) is the extension's
guided way to point each pipeline role at a model. Today it has three gaps:

1. **It doesn't inherit what the user already uses.** `selectModelForRole`
   (`extensions/model-router/index.ts`) lists `ctx.modelRegistry.getAll()` — the
   entire registry — sorted only by auth. It ignores both `ctx.model` (the model
   active in this session) and pi's **scoped models**: the enabled-model subset
   the user curates for Ctrl+P cycling, persisted as glob patterns in pi
   settings (`Settings.enabledModels`, readable via
   `SettingsManager.getEnabledModels()` and resolvable with
   `resolveModelScopeWithDiagnostics`). The wizard starts "blind" instead of
   defaulting to the models the user has already chosen to work with.
2. **The router resolves specs with its own hand-rolled matcher.** `resolveSpec`
   in `extensions/model-router/roles.ts` reimplements wildcard/prefix matching.
   It does not share semantics with pi's canonical `parseModelPattern`
   (`@earendil-works/pi-coding-agent`), so `:thinking` suffixes,
   alias-vs-dated preference, and bare-id/fuzzy references behave differently
   from pi's own `/model`.
3. **The flow is undiscoverable.** The `/router` command registers no
   `getArgumentCompletions`, so `setup`, `config`, `last`, `stats`, `reload`,
   `auto`, `trace`, and `toolparse` are invisible; there is no `/router help`.
   A new user has no in-product path to learn setup exists.

## Goals

- The setup flow **inherits** the user's active/scoped models: it defaults to
  and surfaces, in order, `ctx.model`, the resolved scoped-model set
  (`SettingsManager.getEnabledModels()` → `resolveModelScopeWithDiagnostics`),
  and authed/available models — before the rest of the registry.
- Role specs resolve with **the same semantics as pi's `/model`** by delegating
  non-wildcard parsing to pi's `parseModelPattern`, while preserving the
  router-specific behaviors pi's parser doesn't cover (trailing-`*` wildcard
  specs with authed-first preference; the `"skip"` convention).
- The `/router` subcommands are **discoverable** (completions + help) and each
  wizard step is **self-explaining**.

## Non-goals (YAGNI)

- No change to the stored config format. `.pi/model-router.json` and the global
  config still store role models as **strings**; only *how they are resolved and
  selected* changes.
- No changes to routing, the pipeline, modes, subagents, or the classifier.
- No new runtime dependencies.
- No custom `ctx.ui.custom` TUI component unless the built-in `ctx.ui.select`
  type-to-filter proves inadequate (see Component B).

## Constraints discovered (validated against the installed SDK)

- `ResolvedRole` is consumed across `pipeline.ts`, `modes.ts`, `ui.ts`,
  `router.ts`. Its shape must stay identical so those files are untouched.
- `resolveRole` / `resolveAllRoles` are called synchronously throughout the
  pipeline. `parseModelPattern(pattern, availableModels)` is **synchronous**
  (takes a `Model[]`, not the async registry), so resolution can stay sync by
  feeding it `registry.getAll()`. Do **not** convert `resolveRole` to async — it
  would ripple through the whole pipeline for no benefit.
- **`parseModelPattern` does NOT handle `*` globs.** Verified in
  `dist/core/model-resolver.js`: it does exact match
  (`findExactModelReferenceMatch`), then substring/fuzzy match with
  alias-over-dated preference, then `:thinking`-suffix splitting. Glob handling
  lives only in the **async** `resolveModelScopeWithDiagnostics`, which uses
  `minimatch` (a transitive dep — do not import it directly). Therefore the
  router **keeps its own trailing-`*` prefix matching** for wildcard specs and
  delegates only non-glob specs to `parseModelPattern`.
- pi's parser does **not** prefer authed models. The router's authed-first
  preference among wildcard candidates stays. All current
  `test/roles.test.ts` expectations must stay green (e.g.
  `anthropic/claude-opus-*` → `claude-opus-4-8`, authed preferred over
  unauthed, `skip` disables the role).
- **Scoped models**: `Settings.enabledModels?: string[]` (glob patterns,
  global + project settings) via exported `SettingsManager`
  (`SettingsManager.create(cwd).getEnabledModels()`), resolved with
  `resolveModelScopeWithDiagnostics(patterns, registry)` (async — fine inside
  the wizard's command handler, which is already async).
  `AgentSession.scopedModels` (the `--models` flag form) is **not** exposed on
  `ExtensionContext`, so settings are the inheritance source; `ctx.model`
  covers "what the user is using right now."
- The anthropic registry (verified via `ModelRegistry.inMemory`) contains ids
  like `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-5[-dated]` — no
  bracket-variant ids. Bracket syntax (e.g. `[1m]`) is not a pi model-id form;
  in glob patterns `[…]` is a minimatch character class. The wizard writes
  exact `provider/id` specs, so it never emits glob metacharacters.
- `ctx.model` is `Model<any> | undefined` (the current session model).
- `ctx.ui.custom<T>(factory)` exists for fully custom components;
  `ctx.ui.select(title, options)` is pi's standard selector (supports
  type-to-filter). Each role needs **single** selection, so the multi-select
  checkbox machinery of pi's `ScopedModelsSelectorComponent` is not needed —
  the "pi selector inspiration" here is search/filter + smart ordering, which
  `ctx.ui.select` already provides.

## Components

### A. Resolver — delegate non-glob parsing to pi, keep router wildcard rules (`roles.ts`)

Rework `resolveSpec` (the single-spec resolver used by `resolveRole` and its
fallback loop) into a two-path resolver:

- **Non-glob specs** (no `*` in the id part): delegate to pi's synchronous
  `parseModelPattern(spec, registry.getAll())`, gaining pi-identical handling
  of `:thinking` suffixes, bare-id references, fuzzy matching, and
  alias-over-dated preference. When `parseModelPattern` returns a
  `thinkingLevel`, it **overrides** the role's configured `thinking` for that
  resolution (spec-embedded level is more specific); otherwise the configured
  level applies.
- **Wildcard specs** (`provider/prefix-*`): keep the router's existing
  candidate-gathering (provider + id-prefix filter) with authed-first,
  newest-id-second selection. Do not import minimatch (transitive dep) and do
  not call the async `resolveModelScopeWithDiagnostics` here — resolution must
  stay sync.
- **Preserve** the `"skip"` convention (primary spec or fallback entry
  disables the role).
- `ResolvedRole` shape and the `describeRole` / `shortModelLabel` helpers stay
  unchanged.

### B. Wizard — inherit + searchable ordering (`index.ts`)

`selectModelForRole` / `runSetupWizard`:

- Add an explicit **"Use current session model (`ctx.model` provider/id)"**
  option at the top of each role's picker when `ctx.model` is defined.
- **Inherit pi's scoped models**: once per wizard run, read
  `SettingsManager.create(ctx.cwd).getEnabledModels()` and resolve the
  patterns with `resolveModelScopeWithDiagnostics(patterns, ctx.modelRegistry)`
  (the wizard handler is async). The resulting set is marked (e.g. `◆`) and
  ordered ahead of other models. Read failures or an empty/unset scope degrade
  silently to the non-scoped ordering — inheriting is a bonus, never a
  blocker.
- Extract option ordering into a **pure, unit-testable helper**
  `orderModelsForRole(all, currentModel, scopedIds, hasAuth)` returning models
  ordered **current model → scoped models → authed/available (✓ marked) → the
  rest**. `selectModelForRole` renders the labels; the helper holds the logic.
- Rely on `ctx.ui.select`'s built-in type-to-filter for search. Only introduce a
  `ctx.ui.custom` picker if manual testing shows `select` does not filter.
- Add a one-line role explanation to each step (planner / validator / executor /
  toolParser — what the role does).
- Keep the existing keep-current / custom-spec / skip options and the
  scope-selection + shadow-warning + write/reload behavior unchanged.

### C. Discoverability (`index.ts` `router` command)

- Add `getArgumentCompletions(prefix)` to the `router` command returning the
  subcommands (`setup`, `config`, `last`, `stats`, `reload`, `auto`, `trace`,
  `toolparse`, `help`) filtered by prefix, each with a short label.
- Add a `help` subcommand printing a usage block (also shown for an unknown
  subcommand instead of silently falling through to the dashboard).
- Update the existing first-run hint and the `/router` status dashboard to point
  explicitly at `/router setup`.

### D. Docs

- Update the **Setup** sections of `README.md` and `docs/configuration.md` to
  describe: inherit-from-current-model, pi-consistent resolution, and the new
  discoverability (`/router help`, completions).

## Testing

- Extend `test/roles.test.ts`: `:thinking` suffix parsing (overrides configured
  level), bare-id spec (`claude-fable-5` without provider), alias-vs-dated
  preference on fuzzy specs, authed preference on wildcards, `skip`, and the
  existing wildcard cases (must stay green).
- Unit-test `orderModelsForRole` (ordering: current → scoped → authed → rest).
- Unit-test the `/router` `getArgumentCompletions` (returns expected subcommands,
  filtered by prefix).
- Wizard TUI interaction and `ctx.ui.select` filtering are verified manually
  (interactive-only surface).

## Rollout

Single branch `router-scoped-model-setup`, one PR. No migration: existing config
files keep working because the stored format is unchanged and the new resolver
is a superset of the old behavior (guarded by the preserved test cases).
