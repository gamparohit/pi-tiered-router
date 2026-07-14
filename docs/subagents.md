# Subagent dispatch

pi-tiered-router can farm out plan steps to isolated `pi -p` subprocesses instead of running
everything inline in the main session. This document covers the `dispatch_step` tool, how the
underlying subprocess runner (`extensions/model-router/subagents.ts`) behaves, and how its usage
feeds the informational stats dashboard.

## Why

The main session's context window is the executor model's most valuable resource. Research and
exploration work — reading through a large dependency, grepping a monorepo for a pattern, looking
up how a third-party API works — can burn tens of thousands of tokens without producing much that
the executor actually needs verbatim. Running that work in a separate `pi -p` subprocess keeps all
of that noise out of the main conversation: only the subagent's final answer comes back, folded in
as a tool result.

The same mechanism also covers independent parallelizable work: if a task decomposes into several
steps that don't depend on each other (e.g. "summarize module A" and "summarize module B"), they
can run concurrently as separate subprocesses rather than serially in the main loop.

## The `dispatch_step` tool

`dispatch_step` is registered in `extensions/model-router/index.ts` as a normal custom tool, so the
executor model can call it itself, mid-conversation, whenever it judges a step is a good candidate
for farming out. There is no automatic detection or forced routing — it's entirely opt-in from the
model's side.

Parameter schema (`steps`: 1–8 entries per call):

| Field | Required | Description |
|---|---|---|
| `id` | yes | Caller-chosen id, unique within the call. |
| `task` | yes | Self-contained task description for the subagent. May reference `{previous}` or `{previous:<id>}`. |
| `role` | no | Which router role's model runs this step (`planner`, `validator`, `executor`, `toolParser`). Defaults to `executor`. |
| `dependsOn` | no | Ids of other steps in the same call that must complete first. |

Each step's `role` is resolved through the already-resolved `roles` map (the same one the main
pipeline uses) to a concrete `provider/model-id` string, which is what actually gets passed to
`pi --model`. If a step's role can't be resolved (missing model, no API key), that step is skipped
before anything is spawned and a `"skipped: role ... unresolved"` line is returned instead.

### Example: two parallel research steps, then one chained step

```json
{
  "steps": [
    {
      "id": "research-auth",
      "task": "Read through the auth module in src/auth/ and summarize how session tokens are issued and validated. Be concise; focus on the token lifecycle.",
      "role": "toolParser"
    },
    {
      "id": "research-billing",
      "task": "Read through the billing module in src/billing/ and summarize how invoices are generated and reconciled.",
      "role": "toolParser"
    },
    {
      "id": "integration-plan",
      "task": "Given this auth summary:\n{previous:research-auth}\n\nAnd this billing summary:\n{previous:research-billing}\n\nPropose how a new 'billing requires an authenticated session' check should be wired in, in 3-5 concrete steps.",
      "role": "executor",
      "dependsOn": ["research-auth", "research-billing"]
    }
  ]
}
```

`research-auth` and `research-billing` have no `dependsOn`, so they start immediately and run in
parallel (subject to the concurrency cap below). `integration-plan` depends on both, so it waits
for both to finish, then has `{previous:research-auth}` and `{previous:research-billing}`
substituted with each dependency's final output before it is spawned.

Since `integration-plan` has exactly one dependency in the single-dependency case (not this
example, but the common case), a step can also use bare `{previous}` instead of naming the id. The
convention, from `substitutePrevious()` in `subagents.ts`:

- **Exactly one `dependsOn` entry** → `{previous}` is replaced with that dependency's result.
- **Multiple `dependsOn` entries** → use `{previous:<id>}` per dependency. As a convenience,
  `{previous}` is also substituted in this case, using the *first* listed dependency's result — for
  the common case where only one of several deps' output is actually referenced by name.

If a dependency failed, its substituted text is an empty string (see cascading failure below —
in practice a dependent step is never actually spawned if any of its dependencies failed, so this
mostly matters for partial `dependsOn` graphs with unrelated failed branches feeding unrelated
placeholders).

## How each subagent runs

Each step is spawned as:

```
pi -p --mode json --model <resolved-provider/model-id> "<task text, with {previous} substituted>"
```

`pi --mode json` does not print one final `{ result, usage }` blob — it streams newline-delimited
JSON *events* to stdout as the run progresses. `subagents.ts` only cares about `message_end` events
for `role: "assistant"` messages. The final result is the last text part of the last assistant
message; usage (input/output/cache tokens, cost, turn count) is aggregated by summing every
assistant message's `usage` field across the whole run. A run counts as failed if the process
exits non-zero, or the final assistant message's `stopReason` is `"error"` or `"aborted"`.

`runSubagent()` never throws: spawn failures, non-zero exits, timeouts, and aborts all resolve to
`{ ok: false, error }` rather than rejecting, so a batch can always continue past one failed
subagent instead of taking the whole call down.

## Concurrency, timeout, and abort

`runSubagents()` runs a batch of steps against a dependency graph, up to `subagents.maxParallel`
processes at once (config default: `4`; see `extensions/model-router/config.ts`). Independent steps
(no `dependsOn`, or whose deps are already satisfied) start as soon as a slot frees up; dependent
steps wait for every listed dependency to finish before their `{previous}`/`{previous:<id>}`
substitution runs and they're spawned.

- `dispatch_step` sets a **10-minute timeout** per subagent process. On timeout, the process is
  sent `SIGTERM`, then `SIGKILL` after a **5-second grace period** if it hasn't exited.
- The tool call's `signal` (abort) is wired through to every running subagent the same way: abort →
  `SIGTERM` → `SIGKILL` after the grace period if still alive. Aborting the main turn (e.g. pressing
  Esc) tears down every in-flight subagent, not just the main session's own request.
- **Dependency failures cascade.** If a step's dependency failed, the dependent step is marked
  failed (citing which dependency failed) *without ever being spawned* — it doesn't waste a process
  slot or burn tokens on a request that references broken input.
- **Unknown `dependsOn` ids fail fast.** A step that names a dependency id not present in the same
  batch fails immediately, before anything is spawned.
- **Circular or otherwise unresolvable dependency chains are detected, not hung on.** If nothing in
  the pending set can start and nothing is currently running, every remaining step is failed with a
  descriptive "circular or unresolvable dependency chain" error instead of the batch waiting
  forever.

These behaviors are covered by `test/subagents.test.ts`: concurrency cap (`maxParallel=2` with 4
tasks caps at 2 concurrent processes), `{previous}` and `{previous:<id>}` substitution, cascading
failure without spawning the dependent, unknown-dependency fast-fail, circular-dependency fast-fail,
and abort propagation (`SIGTERM` sent to every running process on `controller.abort()`).

## Usage feeding into stats

`dispatch_step`'s handler records each resolved subagent's usage against the `executor` role bucket
via `stats.recordCall("executor", { inputTokens, outputTokens })` — regardless of which role's model
actually ran the step — so subagent activity shows up in the same informational counters as the
main pipeline's calls. This is purely informational: `SessionStats` (`extensions/model-router/stats.ts`)
never gates or influences routing decisions, it only accumulates numbers for display.

Those numbers surface via:

- `/router stats` (and the general `/router` status dashboard, which includes `stats.summarize()`)
- The `agent_settled` informational widget, shown automatically at the end of a turn if any calls
  were recorded that session

Results are also returned to the executor model as the tool's own result: one line per step
(`[id] ok: <result, truncated to 4000 chars>` or `[id] failed: <error>`), plus the full untruncated
per-step results in `details.results` for any custom renderer.

## Step tagging: advisory, not automatic dispatch

The planner is instructed to prefix each plan step with `[main]`, `[subagent]`, or
`[parallel-group:N]` (see `STEP_TAGGING_GUIDANCE` in `extensions/model-router/pipeline.ts`), and the
validator is told to preserve or correct these tags if it rewrites steps via `revisedSteps`. Tags are
plain text prefixes on each step string — there's no separate schema field for them
(`planSchema`/`validateSchema` just carry `steps: string[]`), so they show up directly in the
injected plan text the executor sees.

**Nothing auto-invokes `dispatch_step` based on these tags.** The agent-mode system prompt addendum
(`modeSystemPromptAddendum("agent")` in `modes.ts`) tells the executor what the tags mean and
suggests calling `dispatch_step` for `[subagent]`/`[parallel-group:N]` steps, but the decision to
actually call the tool is always the executor model's own — tags are advisory context, not a
pipeline-level dispatch mechanism. Don't rely on tagged steps being farmed out automatically; if the
executor doesn't reach for `dispatch_step` on its own, nothing will do it for it.
