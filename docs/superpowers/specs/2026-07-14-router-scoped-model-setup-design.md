# Design: smoother `/router setup` that inherits pi's scoped models

Date: 2026-07-14
Branch: `router-scoped-model-setup`

## Problem

`/router setup` (and its per-role sibling `/router config`) is the extension's
guided way to point each pipeline role at a model. Today it has three gaps:

1. **It doesn't inherit what the user already uses.** `selectModelForRole`
   (`extensions/model-router/index.ts`) lists `ctx.modelRegistry.getAll()` — the
   entire registry — sorted only by auth. It never looks at `ctx.model` (the
   model the user selected this session via pi's `/model`), so the wizard starts
   "blind" instead of defaulting to the user's current choice.
2. **The router resolves specs with its own hand-rolled matcher.** `resolveSpec`
   in `extensions/model-router/roles.ts` reimplements wildcard/prefix matching.
   It does not share semantics with pi's canonical model resolver
   (`resolveModelScopeWithDiagnostics` / `parseModelPattern` in
   `@earendil-works/pi-coding-agent`), so `:thinking` suffixes and alias-vs-dated
   preference behave differently from pi's own `/model`, and scope variants like
   `claude-fable-5[1m]` don't round-trip predictably.
3. **The flow is undiscoverable.** The `/router` command registers no
   `getArgumentCompletions`, so `setup`, `config`, `last`, `stats`, `reload`,
   `auto`, `trace`, and `toolparse` are invisible; there is no `/router help`.
   A new user has no in-product path to learn setup exists.

## Goals

- The setup flow **inherits** the user's active/scoped models: it defaults to
  and surfaces `ctx.model` and authed/available models first.
- Role specs resolve with **the same semantics as pi's `/model`** by delegating
  to pi's model-resolver utilities, while preserving the two router-specific
  behaviors pi's resolver doesn't cover (authed-first preference among wildcard
  candidates; the `"skip"` convention).
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

## Constraints discovered

- `ResolvedRole` is consumed across `pipeline.ts`, `modes.ts`, `ui.ts`,
  `router.ts`. Its shape must stay identical so those files are untouched.
- `resolveRole` / `resolveAllRoles` are called synchronously throughout the
  pipeline. `parseModelPattern(pattern, availableModels)` is **synchronous**
  (takes a `Model[]`, not the async registry), so resolution can stay sync by
  feeding it `registry.getAll()`. Do **not** convert `resolveRole` to async — it
  would ripple through the whole pipeline for no benefit.
- pi's resolver prefers alias over dated and picks the best version, but does
  **not** prefer authed models and uses partial/fuzzy matching rather than the
  router's explicit trailing-`*` wildcard syntax. The existing config specs use
  `provider/prefix-*`. Reconciling these two is the main resolver design point
  (below) and must keep the current `test/roles.test.ts` expectations green
  (e.g. `anthropic/claude-opus-*` → `claude-opus-4-8`, authed preferred over
  unauthed, `skip` disables the role).
- `ctx.model` is `Model<any> | undefined` (the current session model).
- `ctx.ui.custom<T>(factory)` exists for fully custom components;
  `ctx.ui.select(title, options)` is pi's standard selector (supports
  type-to-filter). Each role needs **single** selection, so the multi-select
  checkbox machinery of pi's `ScopedModelsSelectorComponent` is not needed —
  the "pi selector inspiration" here is search/filter + smart ordering, which
  `ctx.ui.select` already provides.

## Components

### A. Resolver — delegate parsing to pi, keep router selection rules (`roles.ts`)

Rework `resolveSpec` (the single-spec resolver used by `resolveRole` and its
fallback loop) so it produces results consistent with pi's `/model`:

- Use pi's `parseModelPattern` (fed `registry.getAll()`) to split a spec into
  `{ model, thinkingLevel }`, giving the router pi-identical handling of
  `:thinking` suffixes, alias-vs-dated preference, and scope variants such as
  `claude-fable-5[1m]`.
- **Preserve router-specific behavior** that pi's resolver lacks:
  - `"skip"` (as primary spec or fallback entry) still disables the role.
  - For a wildcard/ambiguous spec, still prefer a candidate that has configured
    auth before falling back to newest-id. Compose this on top of / around pi's
    parse result rather than discarding it.
- Reconcile the wildcard syntax: the stored format keeps `provider/prefix-*`.
  Normalize the trailing `*` for pi's matcher (or keep the router's
  candidate-gathering for the wildcard case and use pi's utilities only for
  parsing the resolved id + thinking suffix) — the implementer picks the
  smallest approach that keeps every existing `roles.test.ts` case green and
  adds the new ones below.
- `ResolvedRole` shape and the `describeRole` / `shortModelLabel` helpers stay
  unchanged.

### B. Wizard — inherit + searchable ordering (`index.ts`)

`selectModelForRole` / `runSetupWizard`:

- Add an explicit **"Use current session model (`ctx.model` provider/id)"**
  option at the top of each role's picker when `ctx.model` is defined.
- Extract option ordering into a **pure, unit-testable helper**
  `orderModelsForRole(all, currentModel, hasAuth)` returning models ordered
  **current model → authed/available (✓ marked) → the rest**. `selectModelForRole`
  renders the labels; the helper holds the logic.
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

- Extend `test/roles.test.ts`: scope-variant spec (`claude-fable-5[1m]`),
  `:thinking` suffix parsing, alias-vs-dated preference, authed preference,
  `skip`, and the existing wildcard cases (must stay green).
- Unit-test `orderModelsForRole` (ordering: current → authed → rest).
- Unit-test the `/router` `getArgumentCompletions` (returns expected subcommands,
  filtered by prefix).
- Wizard TUI interaction and `ctx.ui.select` filtering are verified manually
  (interactive-only surface).

## Rollout

Single branch `router-scoped-model-setup`, one PR. No migration: existing config
files keep working because the stored format is unchanged and the new resolver
is a superset of the old behavior (guarded by the preserved test cases).
