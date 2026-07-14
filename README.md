# pi-tiered-router

A [pi](https://pi.dev) extension that routes every phase of an agentic coding
session to the model best suited for it — a strong reasoner to plan, an
independent model to critique the plan, a fast coder to execute it, and a
cheap model to keep tool output out of everyone's way.

**This is not a cost-saving tool.** There are no spend limits, no budget
gates, no "downgrade when the bill gets big." Every phase always gets the
model and effort level that produces the best result for that phase. Any
efficiency you see (a validator round that catches a bad plan before it wastes
an execution pass, a compressed test log that keeps the executor's context
sharp) is a side effect of routing well, never the goal.

## Install

```bash
pi install npm:pi-tiered-router
```

To try it first without installing:

```bash
pi -e npm:pi-tiered-router
```

For a team-shared, project-local install instead of a per-user one:

```bash
pi install -l npm:pi-tiered-router
```

**Versioning and updates**: an unpinned `npm:pi-tiered-router` spec (the form
above) is updated automatically by `pi update --extensions` / `pi update
--all`. Pin a specific release with `npm:pi-tiered-router@0.1.0` if you'd
rather update deliberately — pinned specs are left alone by `pi update`.

## 60-second quickstart

1. Install the package (above) and start `pi` in your project.
2. The router activates in **agent** mode by default. Check the footer status
   line — it shows the active mode and the model chain, e.g.
   `◆ agent │ opus→fable→sonnet · parse:haiku`.
3. Send a normal request. Behind the scenes: a cheap classifier rates task
   complexity, a planner drafts a numbered plan, a validator critiques it (up
   to 2 revision rounds), and the executor model runs with the validated plan
   injected as context.
4. Run `/router` any time for a status dashboard: resolved roles, current
   mode, config sources, and session stats. Run `/router last` to see the
   trace notes from the most recent pipeline run.
5. Switch modes with `/mode <plan|agent|ask|debug>` or cycle through them
   with `ctrl+alt+m`.

Nothing to configure for the default experience — `pi-tiered-router` ships
with an all-Anthropic default (Opus plans, Fable validates, Sonnet executes,
Haiku parses). See [`docs/configuration.md`](docs/configuration.md) to point
roles at other providers/models, and [`docs/recipes.md`](docs/recipes.md) for
ready-made config files.

## Setup

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

If you start a session with unresolved roles and no config file yet,
model-router shows a one-time nudge toward `/router setup` — never a blocking
prompt, never repeated.

## Mode cheatsheet

| Mode | What it does | Tools | Effort bias | Switch |
|------|---------------|-------|--------------|--------|
| **plan** | Planner drafts, validator critiques — nothing is executed | Read-only (write tools blocked; bash restricted to a safe allowlist) | Planner runs at high effort | `/mode plan` |
| **agent** | Full pipeline: classify → plan → validate → execute → tool-parse | All tools | Per-role defaults, escalated for harder tasks (never downgraded) | `/mode agent` (default) |
| **ask** | Classify only, answer directly — no plan phase | Read-only (same allowlist as plan) | No escalation; trivial questions route to the cheapest role, everything else to the executor role at its configured effort | `/mode ask` |
| **debug** | Same classify → plan → validate → execute pipeline as agent, with a hypothesis-driven system prompt (reproduce → instrument → analyze → fix) | All tools | Same escalation as agent | `/mode debug` |

All four modes are also reachable with `--mode-router <mode>` at startup, and
the active mode persists across `/resume`/fork (it's stored as a session
entry and rehydrated on session start).

## Routing philosophy: right model, right phase

| Phase | Default model | Why this model |
|-------|---------------|-----------------|
| **Planner** | `anthropic/claude-opus-*` (high effort) | Decomposing an ambiguous goal into a correct, complete plan is the highest-leverage place to spend reasoning — mistakes here compound through every later step. |
| **Validator** | `anthropic/claude-fable-*` (medium effort) | An independent model catches a planner's blind spots better than the planner reviewing its own work; bounded to 2 revision rounds so it can't stall the session. |
| **Executor** | `anthropic/claude-sonnet-*` (medium effort, escalated for complex tasks) | Fast and highly capable at actually writing code once a plan already exists; effort is raised automatically for harder classified tasks. |
| **Tool parser** | `anthropic/claude-haiku-*` (off/minimal effort) | Cheapest, fastest model available — used both to classify task complexity up front and to compress noisy tool output (long test/build logs) so it doesn't dilute the executor's context. |

Every role is fully configurable — swap in any provider's models, add
fallback chains, or set a role to `"skip"` to disable that pipeline stage.
See [`docs/configuration.md`](docs/configuration.md).

## Learn more

- [`docs/configuration.md`](docs/configuration.md) — every config key, file locations, precedence
- [`docs/modes.md`](docs/modes.md) — the four modes in depth
- [`docs/routing.md`](docs/routing.md) — the complexity classifier and effort escalation
- [`docs/recipes.md`](docs/recipes.md) — ready-made config files for common setups
