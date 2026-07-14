# Routing: classifier and effort escalation

**Quality first, not cost first.** There are no spend limits and no
downgrades anywhere in this pipeline — routing decisions only ever pick the
model/effort that produces the best result for a phase, or *raise* effort for
harder tasks. Nothing here ever lowers effort or model quality to save money.

## The complexity classifier

Before planning, the `routing.classifier` role (the cheap/fast `toolParser`
role by default) rates every request into one of four tiers:

| Tier | Definition |
|------|------------|
| `trivial` | A single fact lookup, definition, or one-line answer; no code changes. |
| `simple` | A small, well-scoped change or command confined to one file or action. |
| `standard` | A typical multi-step coding task touching a few files; benefits from a short plan. |
| `complex` | Cross-cutting change, architectural decision, ambiguous requirements, or multi-file refactor; needs careful planning and validation. |

The classifier is told: *"when in doubt between two levels, pick the higher
(more careful) one — never underestimate."* If the classifier call fails or
the role is unresolved, the pipeline proceeds conservatively (full plan +
validate), never silently skipping steps.

## Trivial bypass

When `routing.trivialBypass` is `true` (default) and the classifier rates a
request `trivial` with `needsPlan: false`, the plan/validate phases are
skipped entirely and the executor runs directly. This is purely a latency
optimization for simple asks — it never applies to anything the classifier
isn't confident is trivial.

## Effort escalation

Each complexity tier has a minimum effort **floor**:

| Complexity | Effort floor |
|------------|--------------|
| trivial | off |
| simple | low |
| standard | medium |
| complex | high |

A role's *configured* effort (from `roles.<role>.thinking`) is escalated up to
the floor for the classified complexity, but never lowered below what you
configured — escalation is always an increase. The `toolParser` role is
exempt: it's always cheap/fast by design and never scales with task
complexity.

## Complexity-tiered role chains (`routing.tiers`, opt-in)

Effort escalation (above) changes *how hard* a role thinks; `routing.tiers`
lets classified complexity change *which model* runs a role, for tasks that
don't need your full-quality chain. It's entirely opt-in — with no `tiers`
block configured, every role always runs its base `roles.<role>.model`
regardless of complexity, exactly as described above.

```jsonc
{
  "routing": {
    "tiers": {
      "simple": {
        "planner": { "model": "anthropic/claude-sonnet-*", "thinking": "low" },
        "executor": { "model": "anthropic/claude-haiku-*", "thinking": "low" }
      },
      "standard": {
        "executor": { "model": "anthropic/claude-sonnet-*", "thinking": "medium" }
      }
      // "complex" and "trivial" omitted entirely -> full base chain / existing bypass
    }
  }
}
```

A tier only needs to list the roles it overrides — any role missing from a
tier (or a complexity level missing from `tiers` altogether) falls through to
the base `roles` config unchanged. `"skip"` works the same as it does in
`fallbacks`. If an override's spec can't be resolved, it falls back to that
role's own `fallbacks` chain, and if that also fails, to the already-working
base role — a tier override is a deliberate quality choice, not a new way for
a turn to end up with no model at all.

The classifier itself is never tiered: tiering depends on already knowing the
complexity, so classification always runs on the base-resolved classifier
role, regardless of what a tier might otherwise say about that role.

**Tier pinning.** Once a turn commits to a tier this session, later turns
never drop below it — only escalate. This is deliberate, not a limitation:
provider prompt caches are keyed to the exact model in use, and a session's
whole conversation is the cache prefix every subsequent turn benefits from.
Dropping from Opus to Haiku for one "trivial" turn in the middle of a mostly-
"standard" session would force the *next* Opus turn to rebuild that cache
from scratch — pinning avoids paying for that churn. The one-way ratchet
means a turn may escalate a session's tier (a genuinely harder request
shows up mid-session) but a lower classification afterward is silently
absorbed rather than downgrading anything already committed to.

## Why no cost gates

Every phase always gets the model and effort level that produces the best
result for that phase. A validator round that catches a bad plan before it
wastes an execution pass, or a compressed test log that keeps the executor's
context sharp, are side effects of routing well — never the goal.

This applies to `routing.tiers` too: configuring a "simple" tier's executor
down to Haiku isn't the router deciding your task deserves less — it's *you*
declaring the quality bar you're comfortable with for that tier, opted into
explicitly. The router still never de-escalates below whatever's configured
or already pinned, and escalation (to a higher tier, or a higher effort
level) remains automatic and free in both directions. If you want a cheaper
setup without tiering at all, configure cheaper models per role directly (see
[`docs/recipes.md`](recipes.md)); the router itself will never make that
tradeoff for you silently.
