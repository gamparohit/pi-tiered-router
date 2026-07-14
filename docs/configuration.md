# Configuration

pi-tiered-router is entirely config-driven: every role can point at any
provider/model, and the pipeline degrades gracefully when a model is
unavailable. This page documents every key in `RouterConfig`, the two config
file locations, how they're merged, and the validation/repair rules applied
to whatever comes out of that merge.

## File locations and precedence

Config is loaded by merging three layers, in this order (later wins):

1. **Built-in defaults** (`DEFAULT_CONFIG` — see below).
2. **Global config**: `~/.pi/agent/model-router.json`. Always honored.
3. **Project config**: `<project>/.pi/model-router.json`. **Only honored when
   the project is trusted** (`ctx.isProjectTrusted()`). If a project config
   file exists but the project isn't trusted, it is ignored and a warning is
   emitted — it is never silently applied.

The merge is a **deep merge**, not a replace: an override that sets only
`roles.executor.model` leaves every other role, and `roles.executor.thinking`,
at their prior (default or global) values. The one exception is arrays —
`fallbacks.<role>` and similar array values are replaced wholesale by the
more specific layer, not concatenated.

Run `/router reload` to re-read both files and re-resolve every role without
restarting `pi` (useful after hand-editing a config file) — it never touches
your active `/mode`. `/router` (no args) shows a status dashboard including
which config sources were loaded.

Invalid JSON in either file is ignored (with a warning) rather than crashing
the extension; the rest of the merge proceeds as if that file didn't exist.

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

## Shape

```ts
interface RouterConfig {
  roles: Record<"planner" | "validator" | "executor" | "toolParser", RoleConfig>;
  fallbacks: Partial<Record<RoleName, string[]>>;
  routing: RoutingConfig;
  modes: { default: ModeName };
  subagents: SubagentConfig;
}

interface RoleConfig {
  model: string;       // "provider/model-id", trailing "*" wildcard supported
  thinking: ThinkingLevel; // "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
}

interface RoutingConfig {
  classifier: RoleName;              // which role classifies task complexity
  trivialBypass: boolean;            // skip plan+validate for trivial tasks
  toolOutputParseThreshold: number;  // bytes; below this, tool output passes through untouched
  tiers?: Partial<Record<Complexity, Partial<Record<RoleName, RoleConfig | "skip">>>>; // opt-in per-tier model overrides — see docs/routing.md
}

interface SubagentConfig {
  enabled: boolean;
  maxParallel: number;
  timeoutMs: number; // per-step kill timeout for a dispatch_step subagent run
}
```

## Defaults

```json
{
  "roles": {
    "planner":    { "model": "anthropic/claude-opus-*",   "thinking": "high" },
    "validator":  { "model": "anthropic/claude-fable-*",  "thinking": "medium" },
    "executor":   { "model": "anthropic/claude-sonnet-*", "thinking": "medium" },
    "toolParser": { "model": "anthropic/claude-haiku-*",  "thinking": "off" }
  },
  "fallbacks": {
    "planner":    ["anthropic/claude-sonnet-*"],
    "validator":  ["skip"],
    "executor":   ["anthropic/claude-opus-*"],
    "toolParser": ["anthropic/claude-sonnet-*"]
  },
  "routing": {
    "classifier": "toolParser",
    "trivialBypass": true,
    "toolOutputParseThreshold": 4096
  },
  "modes": { "default": "agent" },
  "subagents": { "enabled": true, "maxParallel": 4, "timeoutMs": 600000 }
}
```

This is the literal `DEFAULT_CONFIG` object the extension ships with — every
key above is real and load-bearing, not illustrative.

## `roles`

Four fixed role names: `planner`, `validator`, `executor`, `toolParser`. Each
role config is a `{ model, thinking }` pair.

- **`model`** is a `"provider/model-id"` string. It supports a trailing `*`
  wildcard prefix match, e.g. `"anthropic/claude-opus-*"` — this is the
  default form for every built-in role specifically so the config survives
  model renames/point releases without editing. Resolution:
  - An exact (non-wildcard) spec is looked up directly in the model registry.
  - A wildcard spec collects every model from that provider whose id starts
    with the given prefix, prefers candidates that already have configured
    auth, and among those picks the lexicographically greatest id (so a newer
    dated/versioned release wins).
- **`thinking`** is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
  `max`. This is the role's *baseline* effort — the router may escalate it
  upward per-task based on classified complexity (see
  [`docs/routing.md`](routing.md)), but never lowers it below what you
  configure.

If a role is missing from the merged config entirely, or its `model` is
missing/empty, or its `thinking` is not one of the valid levels, that specific
field is repaired back to the built-in default and a warning is surfaced —
repair is per-field, so a bad `model` doesn't wipe out a valid `thinking`
override on the same role (and vice versa).

## `fallbacks`

`fallbacks` is a `Partial<Record<RoleName, string[]>>` — an ordered list of
additional `"provider/model-id"` (or wildcard) specs to try, per role, if the
role's primary `model` spec doesn't resolve against the live model registry
(e.g. missing API key, unknown model id). The chain is tried in order; the
first spec that resolves wins.

**The `"skip"` convention**: a role's primary `model` spec, or any entry in
its fallback chain, can be the literal string `"skip"` instead of a
`"provider/model-id"`. Either spelling disables the role for this session
rather than leaving it unresolved (`/router setup`'s "skip this role" option
writes `"skip"` directly as the primary spec):

- A **disabled** planner/validator means that stage of the pipeline is
  skipped outright (the pipeline degrades gracefully rather than blocking).
- A disabled executor/toolParser leaves the current session model untouched
  for that turn (the router logs why and moves on).

This is exactly how the default config treats the validator:
`"validator": ["skip"]` — if you haven't configured (or can't authenticate)
a validator model, the pipeline proceeds straight from an unvalidated plan
to execution instead of failing the turn. Contrast this with a role that
is simply *unresolved* (no matching model anywhere in the chain, and no
`"skip"`): that's reported as a startup warning so you know to fix it, but
still doesn't crash anything.

## `routing`

- **`classifier`**: which role (usually `toolParser`, the cheapest/fastest)
  runs the up-front complexity classification call. Must be one of the four
  role names; an invalid value is repaired to `"toolParser"` with a warning.
- **`trivialBypass`**: when `true` (the default — any value other than the
  literal `false` is treated as `true`), a task classified as `trivial` with
  `needsPlan: false` skips the plan/validate stages entirely in agent/debug
  mode.
- **`toolOutputParseThreshold`**: byte threshold above which a bash/grep/
  find/ls tool result becomes a *candidate* for Haiku (or whichever role is
  `toolParser`) compression. Non-numeric or negative values are repaired to
  the default (4096). See [`docs/routing.md`](routing.md) and the tool-parser
  guardrails described there for how error output gets a higher bar.
- **`tiers`** *(optional)*: per-complexity-tier role model/thinking overrides
  — absent by default (tiering is opt-in). Unknown tier keys, unknown role
  keys, and malformed role values are each dropped individually with a
  warning rather than discarding the whole block. See
  [`docs/routing.md`](routing.md#complexity-tiered-role-chains-routingtiers-opt-in)
  for the shape, fallback behavior, and session tier-pinning rationale.

## `modes`

- **`default`**: the mode (`plan | agent | ask | debug`) a brand-new session
  starts in, before any `/mode` command or `--mode-router` flag is applied.
  An invalid value is repaired to `"agent"` with a warning. Once a session
  has an active mode, it's persisted as a session entry and takes precedence
  over this default on resume/fork.

## `subagents`

- **`enabled`**: whether the `dispatch_step` tool is available to the
  executor model at all. When `false`, calling it returns an explanatory
  message instead of dispatching anything.
- **`maxParallel`**: maximum number of concurrent `pi -p --mode json`
  subagent subprocesses. Values below 1 are clamped up to 1.
- **`timeoutMs`**: how long (ms) a single `dispatch_step` subagent run may take
  before it's killed (SIGTERM, then SIGKILL after a grace period) and reported
  as a timeout failure. Must be a finite number ≥ 1000; invalid values are
  repaired to the default (600000 — 10 minutes) with a warning.

See the subagents documentation for the dispatch/dependency mechanics; this
file only covers the two config knobs.

## Notes on trust

Because project config is only applied when the project is trusted, a
malicious or accidental `.pi/model-router.json` committed to a repo can't
silently repoint your roles at a different provider/model until you've
explicitly trusted that project — the same trust boundary `pi` uses for
project-local extensions and skills.
