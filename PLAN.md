# pi-tiered-router — Build Plan

A pi package that automatically routes work across models to produce the **best possible output** — cost-effectiveness comes from the architecture itself (right model + right effort for each phase), not from budget caps or per-task cost policing. There are **no spend limits, no downgrades, no cost gates**: every phase always gets the model and effort level that produces the best result.

| Role | Default model | Job | Default effort |
|------|--------------|-----|----------------|
| **Planner** | `anthropic/claude-opus-*` | Decompose goal into a validated, numbered plan | high |
| **Validator** | `anthropic/claude-fable-*` | Critique/validate the plan (feasibility, risk, completeness) | medium |
| **Executor** | `anthropic/claude-sonnet-*` | Execute plan steps, write code | medium |
| **Tool parser** | `anthropic/claude-haiku-*` | Compress/parse terminal & tool outputs before they enter context | off/minimal |

All roles are **configurable** (any provider/model id), so the pipeline survives model renames and lets users swap in local/OpenAI/Google models.

---

## 0. Verified API groundwork (done)

These pi extension APIs exist and are sufficient — no forks or hacks needed:

- `pi.setModel(model)` / `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)` — live model + effort-lever switching
- `ctx.modelRegistry.getApiKeyAndHeaders(model)` + `complete()` / `getModel()` from `@earendil-works/pi-ai/compat` — **out-of-band LLM calls** (used for plan, validate, and Haiku tool-output parsing without touching the main session model)
- `pi.on("before_agent_start")` — inject plan as a persistent message + swap system prompt per mode
- `pi.on("tool_call")` / `pi.on("tool_result")` — intercept and post-process tool output with Haiku
- `pi.setActiveTools()` + `tool_call` blocking — read-only enforcement for plan/ask modes
- `pi.registerCommand/Flag/Shortcut`, `ctx.ui.setWidget/setStatus`, `pi.appendEntry` — UX + persistence
- Subagent pattern: spawn `pi -p --mode json --model <role-model>` subprocesses for isolated contexts (proven in `examples/extensions/subagent/`)
- Reference implementations to borrow from: `subagent/` (process orchestration, parallel/chain), `plan-mode/` (read-only gating, `[DONE:n]` step tracking), `preset.ts` (named model+thinking+tools presets), `summarize.ts` (out-of-band `complete()` calls)

---

## 1. Package scaffold

```
pi-tiered-router/
├── package.json              # pi manifest + npm metadata
├── README.md                 # user-facing docs (install, quickstart, GIFs)
├── LICENSE                   # MIT
├── docs/
│   ├── configuration.md      # full config reference
│   ├── modes.md              # plan/agent/ask/debug deep dive
│   ├── routing.md            # how routing + effort mapping works
│   ├── subagents.md          # subagent strategy
│   └── recipes.md            # common setups (all-Anthropic, mixed-provider, all-local)
├── extensions/
│   └── model-router/
│       ├── index.ts          # entry point: wires events, commands, flags
│       ├── config.ts         # config load/merge/validate (user + project scoped)
│       ├── roles.ts          # role registry + model resolution w/ fallbacks
│       ├── router.ts         # decision engine (complexity → role/effort mapping)
│       ├── pipeline.ts       # plan → validate → execute orchestration
│       ├── modes.ts          # plan / agent / ask / debug mode state machines
│       ├── toolparse.ts      # Haiku tool-output compression (tool_result hook)
│       ├── subagents.ts      # pi subprocess spawning (single/parallel/chain)
│       ├── stats.ts          # informational usage/savings stats (tokens saved, calls per role)
│       ├── ui.ts             # widgets, status line, plan progress rendering
│       └── state.ts          # session persistence via appendEntry/details
├── skills/
│   └── model-router/SKILL.md # teaches the LLM the [DONE:n] + Plan: conventions
└── test/
    ├── router.test.ts
    ├── config.test.ts
    ├── pipeline.test.ts
    └── fixtures/
```

`package.json` essentials:

```json
{
  "name": "pi-tiered-router",
  "version": "0.1.0",
  "keywords": ["pi-package", "model-routing", "orchestration"],
  "pi": {
    "extensions": ["./extensions/model-router/index.ts"],
    "skills": ["./skills"],
    "image": "https://…/screenshot.png"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

(Core pi packages go in `peerDependencies` with `"*"` per packages.md; any real runtime deps go in `dependencies`.)

---

## 2. Config system (`config.ts`, `roles.ts`)

Config file: `~/.pi/agent/model-router.json` (global) merged with `<project>/.pi/model-router.json` (project wins; only honored when `ctx.isProjectTrusted()`).

```jsonc
{
  "roles": {
    "planner":   { "model": "anthropic/claude-opus-4-6",  "thinking": "high" },
    "validator": { "model": "anthropic/claude-fable-1",   "thinking": "medium" },
    "executor":  { "model": "anthropic/claude-sonnet-4-5", "thinking": "medium" },
    "toolParser":{ "model": "anthropic/claude-haiku-4-5",  "thinking": "off" }
  },
  "fallbacks": {
    "planner": ["anthropic/claude-sonnet-4-5"],
    "validator": ["skip"]              // validator degrades gracefully if model missing
  },
  "routing": {
    "classifier": "toolParser",         // cheap model classifies task complexity
    "trivialBypass": true,              // trivial prompts skip planner+validator entirely
    "toolOutputParseThreshold": 4096    // bytes; smaller outputs pass through untouched
  },
  "modes": { "default": "agent" },
  "subagents": { "maxParallel": 4, "enabled": true }
}
```

Role resolution: look up `provider/model-id` in `ctx.modelRegistry`; support prefix matching (`claude-opus-*` picks newest); walk `fallbacks` chain; `"skip"` disables a pipeline stage. Emit a clear startup notification for any unresolvable role.

Deliverables:
- [x] Config loader with schema validation + defaults
- [x] Role resolver with prefix matching + fallback chain
- [x] `/router config` command → interactive editor (ctx.ui.select/input)
- [x] `--router-preset <name>` flag via `pi.registerFlag` (e.g. `default`, `max-quality`, `all-local`)

---

## 3. Modes (`modes.ts`) — plan / agent / ask / debug

All four modes work **with every role's model** — the mode controls *workflow + tool access + effort*, the router controls *which model runs each phase*. Mode × role matrix:

| Mode | Pipeline | Tools | Effort bias | Primary models |
|------|----------|-------|-------------|----------------|
| **plan** | planner → validator only; **no execution** | read-only (edit/write disabled, bash allowlist from plan-mode example) | planner high | Opus + Fable |
| **agent** | full: plan → validate → execute → tool-parse | all tools | per-role defaults | all four |
| **ask** | direct answer, no plan phase | none (or read-only, configurable) | low; trivial-classifier picks executor vs toolParser model | Sonnet or Haiku |
| **debug** | hypothesis loop: reproduce → instrument → analyze → fix | all tools + verbose | planner high for root-cause analysis; Haiku parses stack traces/logs | Opus (analysis) + Sonnet (fix) + Haiku (log parsing) |

Implementation:
- Mode state machine persisted via `pi.appendEntry("model-router:mode", …)` so it survives resume/fork (rehydrate in `session_start` by scanning branch)
- `/mode <plan|agent|ask|debug>` command + `Ctrl+Alt+M` cycle shortcut + `--mode-router <mode>` startup flag
- Per-mode system prompt injection via `before_agent_start` → `{ systemPrompt: event.systemPrompt + modeAddendum }`
- plan/ask read-only enforcement: `tool_call` handler blocks write tools + non-allowlisted bash (reuse plan-mode allowlist)
- debug mode additionally taps `before_provider_request` / `after_provider_response` for an optional wire-level trace log (`/router trace on` — originally spec'd as a standalone `/debug trace on` command, renamed per §11b to avoid colliding with other extensions' command namespaces)
- Mode shown in footer via `ctx.ui.setStatus("router", "◆ agent │ opus→fable→sonnet │ $0.43")`

Deliverables:
- [x] Mode state machine + persistence + rehydration
- [x] `/mode`, shortcut, flag
- [x] Per-mode tool gating + bash allowlist
- [x] Per-mode system prompt addenda (4 prompt templates)

---

## 4. Orchestration pipeline (`pipeline.ts`, `router.ts`)

Hooked at `before_agent_start` (agent + debug modes):

```
user prompt
   │
   ├─ 1. CLASSIFY (toolParser model, out-of-band complete(), ~1 cheap call)
   │      → { complexity: trivial|simple|standard|complex, needsPlan: bool }
   │      trivial + trivialBypass → skip to step 4 with executor, thinking=low
   │
   ├─ 2. PLAN (planner model, out-of-band, thinking=high)
   │      → numbered "Plan:" markdown (reuse plan-mode's Plan:/[DONE:n] convention)
   │
   ├─ 3. VALIDATE (validator model, out-of-band, thinking=medium)
   │      → { verdict: approve|revise|reject, notes }
   │      revise → one bounded re-plan round (max 2 iterations, then proceed with notes attached)
   │
   └─ 4. EXECUTE
          pi.setModel(executor); pi.setThinkingLevel(per-role)
          return { message: { customType: "model-router", content: validatedPlan, display: true } }
          → main agent loop runs on Sonnet with the plan injected as context
```

Key decisions:
- Steps 1–3 use **out-of-band `complete()` calls** (summarize.ts pattern) so they never pollute the session context — only the final validated plan is injected. This keeps the executor's context clean and focused: Opus reasoning is distilled once into a compact plan instead of flooding the conversation.
- Pass `ctx.signal` to every `complete()` so Esc cancels the pipeline.
- Progress surfaced via `ctx.ui.setWidget("router", ["◐ planning (opus)…", "…"])`.
- `agent_settled` → informational summary widget: calls per role, tokens saved by compression (from `stats.ts`). Purely informational — never influences routing.
- Effort lever: router maps complexity × role → thinking level (e.g. complex+planner=high, standard+executor=medium, any+toolParser=off). Effort is always chosen for best output quality; complex tasks get maximum effort without restriction.

Deliverables:
- [x] Complexity classifier (cheap, single call, strict JSON output)
- [x] Plan generation + Plan:/step extraction (port plan-mode's parser from `utils.ts`)
- [x] Validator loop with bounded revisions
- [x] Model/effort swap + plan injection
- [x] Usage stats per role (informational only)
- [x] Esc/abort propagation through all out-of-band calls

---

## 5. Haiku tool-output parsing (`toolparse.ts`)

The "terminal/tool use parse with Haiku" piece — a `tool_result` middleware:

- Fires on `bash`/`grep`-like tool results larger than `toolOutputParseThreshold`
- Sends raw output to toolParser model out-of-band: *"Extract only the information relevant to: <current step>. Preserve error messages, paths, and line numbers verbatim."*
- Returns `{ content: [compressed], details: { originalBytes, compressedBytes, savedTokens } }`
- Original output preserved in `details` for the custom renderer (expandable in TUI)
- Guardrails: never compress failing test output below N lines; skip when result `isError` and short — quality preservation rules, not spend limits

Expected win: long `npm test` / build logs / `rg` dumps stop diluting Sonnet/Opus context — this is about **context quality** (keeping the executor's window focused and sharp), with token savings as a side effect.

Deliverables:
- [x] `tool_result` middleware with threshold + guardrails
- [x] Compression summary shown inline (`↓ 48.0KB → 1.2KB (toolParser, saved ~N tokens)`), original preserved in `details.original` — no true collapsible Component: pi's extension API has no renderer hook for *built-in* tool results (registerMessageRenderer/registerEntryRenderer only cover extension-authored custom messages/entries)
- [x] `/router toolparse on|off` toggle

---

## 6. Subagent strategy (`subagents.ts`)

Used when the validated plan marks steps as **parallelizable** or **context-heavy** (validator tags each step: `[main]`, `[subagent]`, `[parallel-group:N]`):

- Spawn `pi -p --mode json --model <role-model> "<step task>"` subprocesses (subagent example pattern), concurrency-capped by `subagents.maxParallel`
- Each subagent gets: the step, minimal context slice, and role-appropriate model — e.g. a pure-research step runs on Haiku, a refactor step on Sonnet
- Chain mode for dependent steps (`{previous}` substitution)
- Results parsed from JSON output, summarized by toolParser model, folded back into the main session as tool results
- Registered as a `dispatch_step` custom tool so the executor model can *itself* decide to farm out steps mid-run
- Usage from subagent JSON output feeds the same informational stats

Deliverables:
- [x] Subprocess runner with concurrency cap, timeout, kill-on-abort
- [x] Step tagging protocol in planner/validator prompt (`[main]`/`[subagent]`/`[parallel-group:N]`); executor's agent-mode prompt addendum explains when to use it with `dispatch_step`
- [x] `dispatch_step` tool (single/parallel/chain) — progress streaming via `onUpdate` not yet wired
- [x] Usage aggregation from subagent runs

---

## 7. UX polish (`ui.ts`)

- [x] Footer status: mode ◆ pipeline models ◆ current phase (`renderStatus` + transient `setPipelineWidget` during a run)
- [x] Plan progress widget with `[DONE:n]` tracking (scans `message_end` assistant text; not a port of plan-mode's parser, but the same convention)
- [x] `/router` command: status dashboard (roles resolved, pipeline activity, context tokens saved this session via `/router stats`)
- [x] `model_select` / `thinking_level_select` hooks keep UI honest when user manually overrides (manual override pins the model until `/router auto`)
- [x] Graceful non-TUI behavior: every UI touch point is guarded with `ctx.hasUI` (see `ui.ts`)

---

## 8. Testing

- [x] Unit (vitest): config merge/validation, role resolution + fallbacks, complexity mapping, plan parsing (step tagging is prompt guidance, not separate branching logic — no dedicated unit needed)
- [x] Integration: mock `complete()`/`completeSimple` to test pipeline sequencing, revision loop bounds, abort propagation
- [ ] E2E manual matrix — superseded by §13 (M9): a live `pi` binary (0.80.6, matching devDependencies) turned out to be installed at `/opt/homebrew/bin/pi`, so this is runnable after all
- [ ] Non-TUI smoke: `pi -p`, `--mode json` — superseded by §13b's scripted integration smoke
- [x] Failure drills: missing API key for one role, unresolvable model, validator "skip" (covered as unit tests, not live-session drills)

---

## 9. Documentation

- [x] `README.md`: value prop, install, 60-second quickstart, mode cheatsheet, quality/efficiency table (no screenshot/GIF — nothing to fabricate; add once the package has a real gallery image)
- [x] `docs/configuration.md`: every key, defaults, project vs global scoping, trust behavior
- [x] `docs/modes.md`: the four modes, mode × role matrix, prompts used
- [x] `docs/routing.md`: classifier, effort mapping, quality-first philosophy
- [x] `docs/subagents.md`: `dispatch_step`, concurrency, usage reporting (tagging protocol documented as not-yet-implemented — see §6)
- [x] `docs/recipes.md`: all-Anthropic default, lightweight mode (Sonnet plans/Haiku executes), mixed-provider, local-model validator
- [x] `skills/model-router/SKILL.md`: teaches conventions to the LLM
- [x] CHANGELOG.md, LICENSE

## 10. Publish

Superseded by §13d/§13e (M9), which spell these out as concrete steps verified
against the bundled `docs/packages.md`. Kept here only as the original outline:

1. [ ] `npm publish` (public) — see §13d
2. [ ] Verify install paths (`pi install npm:…`, `pi -e npm:…`, `pi install -l`) — see §13d
3. [ ] Tag GitHub release; verify `pi install git:…@v0.1.0` — see §13e
4. [ ] Post-publish smoke test on a clean machine/profile (`~/.pi` fresh) — see §13e
5. [ ] v0.1.x follow-ups: gallery video, user feedback issues, model-id refresh policy

---

## 11. M7 — Setup wizard + post-review hardening (from defensive code review, 2026-07-11)

### 11a. `/router setup` wizard (new feature)

A guided first-run flow that configures the model for **all four roles** in one pass, selecting
from models that actually exist in the registry instead of free-typed specs:

- [x] `/router setup` command (TUI only; non-TUI prints the config path and bails):
  1. For each role in order (planner → validator → executor → toolParser): `ctx.ui.select` over
     real models from `ctx.modelRegistry.getAll()`, authed models listed first and marked
     (via `hasConfiguredAuth`), plus three synthetic choices: **keep current** (shows the
     currently-resolved id), **custom spec…** (falls back to `ctx.ui.input` for wildcards like
     `anthropic/claude-opus-*`), and **skip this role** (validator/toolParser only — planner and
     executor are required for the pipeline to mean anything).
  2. Per role, `ctx.ui.select` thinking level (current value shown in the prompt title).
  3. Scope choice: write to global (`~/.pi/agent/model-router.json`) or project
     (`<cwd>/.pi/model-router.json`, only offered when `ctx.isProjectTrusted()`).
  4. Write file (merge over existing JSON), `reload()`, then show the resolved-roles summary.
- [x] First-run hint: on `session_start`, when **no** config file exists at either scope and at
  least one role is unresolved, emit a single notification suggesting `/router setup` (never a
  blocking prompt, never repeated within a session — guarded by `firstRunHintShown`).
- [x] Folded the old single-role `runConfigEditor` into `runSetupWizard(ctx, targetRoles)`:
  `/router setup` passes all four role names, `/router config` picks one role first then passes
  a single-element array — one implementation, no duplication.
- [x] Tests: `test/index.test.ts` drives the real `/router config` command end-to-end (scripted
  `ctx.ui.select` responses matched by substring, not exact copy) against a real temp-directory
  config file — verifies the merge preserves an unrelated top-level key and an untouched sibling
  role, that "skip this role" writes `{model:"skip", thinking:"off"}` as a primary spec, and that
  an untrusted project never even gets prompted for scope (goes straight to global). Plus
  `resolveRole`'s "skip" handling (roles.test.ts) and preset interaction (config.test.ts).
- [x] Docs: new "Setup" section in README + configuration.md.

### 11b. Defects found in review — fix

- [x] **`/router reload` stomps the active mode** — fixed: `reload()` no longer touches
  `modeState` at all; `session_start`'s own `modeState.rehydrate(...)` call already established
  the mode correctly (it ran redundantly after `reload()`'s stomp before, masking the bug there
  but not on a mid-session `/router reload` or wizard write). Covered by `test/index.test.ts`.
- [x] **`"skip"` as a primary model spec wasn't honored by the resolver** — fixed in
  `resolveRole` (roles.ts): a primary spec of `"skip"` (case/whitespace-insensitive) now disables
  the role directly, same as `"skip"` in a fallback chain. The wizard's "skip this role" option
  writes it this way. Covered by roles.test.ts + index.test.ts.
- [x] **Compression replaced the built-in tool's `details`** — fixed: `event.details` is now
  spread underneath our own compression fields in the `tool_result` handler. Covered by
  index.test.ts.
- [x] **`dispatch_step` booked all subagent usage under `executor`** — fixed: usage is now
  recorded against each step's actual resolved role via a per-step `stepRoles` map.
- [x] **`agent_settled` notified every turn** — fixed: dedupes against a hash of the last-notified
  stats snapshot (`lastNotifiedStatsKey`), reset each session; `/router stats` still available
  on demand anytime.
- [x] **`/debug` command name was collision-prone** — fixed: dropped the standalone `/debug`
  registration; trace control lives at `/router trace on|off|` (status).

### 11c. Hardening (lower severity, do after 11b)

- [x] `model_select` pin detection now skips `event.source === "restore"` (session restore is
  never a manual override) — the only source pi doesn't currently emit, but the type allows it,
  so this was a one-line future-proofing fix. Covered by index.test.ts.
- [x] Narrowed the `routerDrivenModelChange = true` window: `applyRoleForTurn` now accepts an
  `onBeforeModelSwitch` callback (threaded through `runAgentPipeline`/`runAskMode`) called
  immediately before `pi.setModel(...)` — not around the classify/plan/validate phase beforehand.
  The reset back to `false` deliberately stays in the outer `finally` (broad): `setThinkingLevel`'s
  own event emission is fire-and-forget (`void this._extensionRunner.emit(...)` in pi's
  `agent-session.js`), so narrowing the reset side too could clear the flag before our own
  `thinking_level_select` handler actually runs, causing a false-positive self-pin. Covered by
  two new pipeline.test.ts cases asserting call order and skip-cases.
- [x] `/router setup`/`/router config` now warn when a global-scope write would be shadowed by a
  trusted project config already defining that role (`shadowedByProjectConfig`).
- [x] `dispatch_step`'s per-step timeout is now `subagents.timeoutMs` (default 600000ms),
  validated ≥ 1000 in `config.ts`'s `validate()`. Covered by config.test.ts.
- [x] Added `test/index.test.ts` (index.ts previously had no dedicated test file): reload/mode
  preservation, tool_result details preservation, the full pin → `/router auto` → unpin cycle,
  and two `/router config` wizard write-path tests (merge preservation + skip handling, and
  untrusted-project scope gating).

### Review notes — explicitly NOT fixing (judged fine as-is)

- `[DONE:n]` scanner counts markers inside code blocks/quotes: acceptable noise; a real parser
  isn't worth it for an informational widget.
- Plan mode switching the live session model to the planner role duplicates the model already used
  out-of-band: intentional — plan mode's interactive turn *should* run on the planner model.
- Compression running in plan/ask modes: harmless, still useful there.

## 12. M8 — Complexity-tiered role chains (planned, 2026-07-11)

Let the classified complexity pick the **models** per role, not just the effort.
Today the pipeline always runs the full-quality chain (Opus plans, Fable
validates, Sonnet executes) regardless of tier; this adds an **opt-in**
`routing.tiers` block that trickles roles down for easier tasks — e.g.
standard: Opus plans+validates / Sonnet executes; simple: Sonnet plans /
Haiku executes. Inspired by pi-smart-router's triage/escalation ideas, but
deliberately *not* adopting its cost machinery (no expected-cost scoring, no
local zero-tier, no embedding matcher — the existing Haiku classifier is the
triage).

**Philosophy note:** this does not break "no silent downgrades." Tiering is
off by default; when the user configures a tier chain they are declaring
their quality bar for that tier. The router still never de-escalates below
what's configured, and escalation remains automatic and free.

### Phase 1 — tier map

- [x] `types.ts`: `RoutingConfig.tiers?: Partial<Record<Complexity, Partial<Record<RoleName, RoleConfig | "skip">>>>` — per-tier role overrides; unset roles fall through to base `roles`. `Complexity`/`COMPLEXITY_LEVELS` moved here from `router.ts` (still re-exported from there) since `RoutingConfig` needed the type and `router.ts` already imports from `types.ts`, not the other way around.
- [x] `config.ts`: `validateTiers()` drops (with a warning) any bad tier key/role key/role value individually rather than discarding the whole block; recipe in `docs/recipes.md` (complex: no overrides; standard: validator→Opus self-check; simple: planner→Sonnet, executor→Haiku; trivial: existing bypass already covers it)
- [x] `roles.ts`: `rolesForTier(registry, resolved, config, complexity)` (registry first, matching `resolveRole`'s own param order) — returns tier-adjusted resolved set via the existing resolution/fallback machinery; a tier override that fails to resolve tries that role's own `fallbacks` chain, then finally degrades to the already-working base role rather than ending up unresolved. Classifier always runs on the base cheap role (no chicken-and-egg) — structurally guaranteed since `classifyComplexity` is only ever called with the base `roles` map, never a tiered one.
- [x] `pipeline.ts`: `planAndValidate` gains a trailing `pinnedTier?: Complexity` param and an `effectiveTier` field on its outcome (`maxComplexity(pinnedTier, classification.complexity)`); tier-adjusted roles are used for the planner/validator calls, and a `tier: <x> (role override applied)` note is pushed only when an override actually changed something. `runAgentPipeline` re-derives the same tier-adjusted set for the executor step (cheap, pure, no need to smuggle a whole roles map through the outcome) and uses `effectiveTier` (not the raw classification) for effort escalation too, so both axes agree on which tier the turn actually ran at.
- [x] **Tier pinning for cache economics**: `index.ts` holds `pinnedTier` as session state (reset on `session_start`), threaded into `planAndValidate`/`runAgentPipeline` and updated from `outcome.effectiveTier` after each turn — one-way ratchet via `maxComplexity`, never de-escalates. Deliberately scoped to agent/debug/plan modes only; `ask` mode keeps its own bespoke always-cheap role selection, untouched by tiering. Surfaced in the `/router` dashboard (`routing.tiers: ... — pinned this session at "..."`).
- [x] `docs/routing.md`: added a "Complexity-tiered role chains" section (shape, fallback behavior, classifier exemption, pinning rationale) and reworded "Why no cost gates" per the philosophy note above.
- [x] Tests: `rolesForTier` fall-through/skip/unset-tier/registry-fallback (roles.test.ts), `maxComplexity` ratchet properties (router.test.ts), `routing.tiers` validation — well-formed, unknown tier/role keys, malformed values, cross-file merge precedence (config.test.ts), tier-adjusted role selection + effectiveTier ratchet-from-pinned in `planAndValidate`/`runAgentPipeline` (pipeline.test.ts). The session-level `pinnedTier` variable itself is a one-line ratchet-and-store in `index.ts` over already-tested primitives — judged not to need a separate multi-turn integration test, same call as M7's review made for other thin index.ts glue.

### Phase 2 — escalation ratchet (safety net; built 2026-07-11 per explicit request, ahead of observing Phase 1 in practice)

- [x] `router.ts`: `nextTierUp(complexity)` — one tier above (trivial→simple→standard→complex), capped at "complex".
- [x] `pipeline.ts`: `PlanAndValidateOutcome.validatorRejectionsMaxedOut` — true when the bounded revision loop
  (§4, `MAX_REVISIONS=2`) exhausts its budget while the validator is still returning "revise" (never approved).
  This *is* the "2 rejections" signal — it reuses the existing revision-loop bound rather than a new counter.
- [x] `index.ts`:
  - **Validator rejections**: after each agent/debug/plan turn, `applied.outcome.validatorRejectionsMaxedOut` →
    `pinnedTier = nextTierUp(pinnedTier ?? "trivial")` (only if that's actually higher than current), pushed into
    the turn's trace notes *and* notified directly (`notify(..., "warning")`) — initially only pushed to the
    trace; made consistent with the tool-failure path's direct notify after a test caught the UX gap.
  - **Executor tool failures**: new `consecutiveToolFailures` session counter (reset on `session_start`),
    incremented/reset in the existing `tool_result` handler — deliberately positioned *before* the
    `toolparseEnabled` early-return so tracking isn't gated by that unrelated toggle. Only counts in
    agent/debug mode (where the executor is actually driving tool calls); any success resets it to 0.
    `TOOL_FAILURE_ESCALATION_THRESHOLD = 3`.
  - Escalation is next-turn/next-tool-call only, never a mid-turn retry or live model swap — a turn that's
    already struggling proceeds as-is (bounded, degrades gracefully per the existing philosophy); only
    *subsequent* turns benefit from the higher pin. Surfaced on the `/router` dashboard alongside the pin.
- [x] Tests: `nextTierUp` ordering + cap (router.test.ts); `validatorRejectionsMaxedOut` true only when the loop
  truly maxes out unapproved, false on approve/skip/unresolved (pipeline.test.ts); end-to-end escalation through
  real `tool_result`/`before_agent_start` handler invocations — 3-consecutive-failure escalation + reset-on-success,
  no tracking outside agent/debug mode, and the full validator-maxed-out → pin-escalates-one-notch-above-this-turns-
  tier → notified-and-traced flow (index.test.ts).
- [x] Not implemented as a config-gated feature: Phase 2 has no effect unless a turn actually exhausts the revision
  budget or hits 3 tool failures, both already-conservative thresholds baked into Phase 1's existing bounds — no
  new config surface was judged necessary, matching the plan's original scope (no mention of a toggle).
- Note: shipped without observing Phase 1 in practice first, per explicit instruction to build it now rather
  than wait-and-see — the classifier's "rate higher when in doubt" bias may make this redundant in practice,
  but the safety net is now in place either way.

## 13. M9 — Live `pi` integration test + npm/pi publish walkthrough (planned, 2026-07-11)

Discovery that unblocks this: `pi` **0.80.6 is installed locally** at
`/opt/homebrew/bin/pi` (exactly matching our `devDependencies` pin), so the
§8 items previously marked "needs a live pi binary" are runnable on this
machine. All steps below verified against the bundled authoritative doc,
`node_modules/@earendil-works/pi-coding-agent/docs/packages.md`.

### 13a. Pre-flight fixes (publish blockers found while planning)

- [x] **Added `"@earendil-works/pi-agent-core": "*"` to `peerDependencies`** — we import
  `ThinkingLevel` from it in 5 files, and packages.md is explicit: every imported core pi
  package must be a `"*"` peer dep. (Type-only imports get erased at load time, so this
  happened to work locally — the manifest now follows the doc, not the accident.)
- [x] `npm pack --dry-run` inspected: two fixes made — `CHANGELOG.md` was missing from `files`
  (added), and `PLAN.md` (38KB of internal build/review notes) was shipping (dropped from
  `files`; stays in the repo, not the tarball). Final tarball: 23 files, 55KB packed —
  extensions/, skills/, docs/, README, LICENSE, CHANGELOG; no test/, node_modules/, or PLAN.md.
- [x] `pi` manifest paths verified the strong way: §13b's `pi -e <package-dir>` runs load the
  extension + skill through the real manifest. `pi-package` keyword confirmed present.

### 13b. Scripted integration smoke (local path — no publish required)

Uses packages.md's local-path + try-before-install mechanics: `pi -e <dir>` loads the package
from disk into a temporary install for one run. **Costs real tokens** (runs against the user's
existing pi auth) — keep prompts trivial; this is a pre-publish gate, not CI.

- [x] `test/e2e.sh` (bash, chmod +x, not wired into vitest), runs from a scratch cwd with
  `-e <package-dir> --no-extensions -p --mode json --no-session`, plus a portable per-run
  timeout guard (macOS has no `timeout(1)`: background + poll + kill-9 after 120s → exit 124):
  1. **Load + pipeline smoke** — exit 0, stdout is valid NDJSON, stderr has `[model-router]`
     notifications and the pipeline summary. ✅ passes.
  2. **Config honored** — project trust in `-p` mode needs the `--approve` flag (answering
     the plan's open question: it does *not* auto-trust); with it, the scratch
     `.pi/model-router.json` executor override shows up in the stderr summary. ✅ passes.
  3. **Failure drill** — first run flushed out a wrong test premise, which is itself the
     integration finding: `planner: "nope/nothing"` alone does NOT produce an unresolved
     role, because the default `fallbacks.planner: ["anthropic/claude-sonnet-*"]` survives
     the deep merge and silently rescues it (correct behavior — the fallback chain doing its
     job). The drill config must also set `"fallbacks": { "planner": [] }` (arrays replace
     wholesale in the merge) to actually exercise the unresolved path. With that, the
     `Could not resolve role` warning appears and the run still completes. ✅ passes.
- [x] Ran it: **7/7 assertions pass** against pi 0.80.6 with real Anthropic auth. One transient
  hang was observed on a manual re-run (network/model latency, not reproducible); the timeout
  guard added in response converts any recurrence into a clean scenario failure.
- [x] RPC-mode smoke: skipped (optional per plan; JSON-mode covers the non-TUI surface).

### 13c. Manual TUI matrix (interactive; needs a human at the terminal)

The §8 matrix, now runnable — run `pi -e /Users/gampa/pi-tiered-router` interactively:

- [ ] {plan, agent, ask, debug} × {trivial, standard, complex} prompts; verify footer status,
  plan-progress widget, pipeline widget phases
- [ ] `/router` dashboard, `/router setup` wizard end-to-end, `/router config` single-role,
  `/mode` + `ctrl+alt+m`, `/router trace on` in debug mode (check `.pi/model-router-trace.log`)
- [ ] Manual-override pin: `/model` mid-session → pinned notice → `/router auto` → resumed
- [ ] Resume/fork rehydration (mode + trace notes survive), `/reload` safety
- [ ] `routing.tiers` recipe active: verify tier note in `/router last` and pinning across turns

### 13d. Publishing the extension to npm (and therefore to pi)

pi has no separate registry — publishing to npm with the `pi-package` keyword *is* publishing
to pi; pi.dev/packages is a gallery over npm. Steps:

0. [x] **Name collision found and resolved**: `pi-model-router` was already registered on npm by
   an unrelated author (`a-canary`, v1.1.0, published 3 months prior, similar description) —
   `npm view pi-model-router` confirmed this before any publish attempt. Renamed the whole
   package to **`pi-tiered-router`** (user's choice among available alternatives — also checked
   `pi-router` [taken], `pi-model-orchestrator`, `model-router-pi`, `pi-multi-model-router` [all
   free]) across `package.json`, `package-lock.json` (regenerated via `npm install`, not hand-
   edited), README, docs/*.md, the skill, `test/e2e.sh`, and this file. Internal module/directory
   names (`extensions/model-router/`, the `model-router:*` customTypes, `/router` command
   namespace) were deliberately left as-is — those are implementation details, not the public
   package identity, and renaming them buys nothing.
1. [x] Complete 13a (peer dep + tarball checks) — done above, re-verified with the new name.
2. [x] `npm login` — done by the user directly (confirmed via `npm whoami` → `gamparohit`); as
   expected, this couldn't be done non-interactively from here.
3. [x] `npm publish --access public` — **published**: `pi-tiered-router@0.1.0` is live on the
   registry. First attempt hit `E403` (account requires 2FA/granular token to publish); second
   attempt switched npm to its web-based OTP flow (`EOTP`, browser auth URL) — that URL is
   redacted/unavailable in non-interactive output, so this step *also* had to be run by the user
   directly in their own terminal. Two genuine "can't be done by an agent" steps in this section,
   both expected and both now done.
4. [x] Registry verified: `npm view pi-tiered-router version keywords` → `0.1.0`,
   `['pi-package', 'model-routing', 'orchestration', 'claude', 'agent']` — `pi-package` present.
5. [x] All three install paths verified for real, against the published package (not a local path):
   - `pi -e npm:pi-tiered-router -p --mode json` — ran the full pipeline end-to-end in a scratch
     dir: plan generated, validator approved, executor switched to `anthropic/claude-sonnet-5`.
   - `pi install npm:pi-tiered-router` — installed under `~/.pi/agent/npm/`, showed up in `pi list`.
   - `pi install -l npm:pi-tiered-router` (scratch dir) — wrote `.pi/settings.json` with
     `{"packages": ["npm:pi-tiered-router"]}`, installed under `.pi/npm/`.
   - `pi remove npm:pi-tiered-router` cleaned up the user-scope test install; confirmed gone from
     `pi list` afterward. (The removal reconciled pi's shared global npm workspace as a side
     effect — expected pi behavior, unrelated to this package.)
6. [x] Version/update semantics documented in the README (unpinned spec → updated by `pi update`;
   pinned `@0.1.0` → left alone), alongside the `pi install -l` project-scope install line.

### 13e. Git-based install + release (alternative/parallel channel)

The package dir is **not currently a git repository** — this channel needs:

1. [ ] `git init`, commit, create the GitHub repo, push (user decision: repo name/owner).
2. [ ] Tag `v0.1.0` and push the tag — git installs pin to tags/commits and `pi update` reconciles
   to the configured ref rather than moving it.
3. [ ] Verify `pi install git:github.com/<user>/pi-tiered-router@v0.1.0` — clones under
   `~/.pi/agent/git/<host>/<path>` and runs `npm install` automatically (which is why the
   peer-dep manifest hygiene in 13a matters here too).
4. [ ] Post-publish smoke on a fresh profile (e.g. `HOME=$(mktemp -d) pi …` — requires re-auth,
   so manual): install from npm, run one prompt, confirm the extension loads with no local-dev
   leftovers papering over a packaging gap.
5. [ ] v0.1.x follow-ups: gallery `image`/`video` metadata in the `pi` manifest (MP4 autoplays
   on hover in the gallery; image is a static preview — currently neither is set, which is
   correct until a real asset exists), user feedback issues, model-id refresh policy.

## Milestones

| Milestone | Scope | Est. |
|-----------|-------|------|
| M1 | Scaffold + config + role resolution + manual `/mode` switching | 1 day |
| M2 | Pipeline (classify→plan→validate→execute) + effort mapping | 1–2 days |
| M3 | Haiku tool-output parsing + usage stats | 1 day |
| M4 | Subagent dispatch (single/parallel/chain) | 1–2 days |
| M5 | Modes complete (plan/ask/debug polish) + UX widgets | 1 day |
| M6 | Tests + docs + publish | 1–2 days |
| M7 | Setup wizard (§11a) + review fixes (§11b) + hardening (§11c) | 1 day |
| M8 | Complexity-tiered role chains (§12, Phase 1; Phase 2 only if needed) | 1 day |
| M9 | Live `pi` integration test (§13a–c) + npm/pi publish (§13d–e) | 0.5–1 day |

## Risks & mitigations

- **Model ids drift** (e.g. "fable" naming): prefix matching + fallback chains + `"skip"`; never hardcode ids outside default config
- **Pipeline latency on simple asks**: trivial-bypass classifier (single Haiku call, ~200ms) gates the whole pipeline
- **Out-of-band calls not cancellable**: always thread `ctx.signal`
- **Compression loses critical info**: verbatim-preserve rules + original kept in `details` + per-tool opt-out
- **User manual override fights router**: `model_select` hook detects user-initiated changes and pins until `/router auto`
- **Router overhead adds latency**: classifier + compression use the fastest role (Haiku); trivial-bypass keeps simple prompts snappy
