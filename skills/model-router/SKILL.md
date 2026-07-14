---
name: model-router
description: Conventions for working inside a pi session managed by pi-tiered-router — the [DONE:n] step-completion marker used in agent mode, when to farm work out to the dispatch_step tool instead of doing it inline, and how to treat an injected validated plan. Use this whenever a "Plan:" message or a model-router mode addendum appears in the conversation, or before deciding whether to call dispatch_step.
---

# model-router conventions

You are running as the **executor** role inside a pi session managed by
`pi-tiered-router`. This skill covers conventions the router expects you to follow that go
beyond what's already in your system prompt for the current mode.

## A validated plan may already be waiting for you

Before your turn even starts, `pi-tiered-router` may run a classify → plan → validate pipeline
out-of-band (Opus plans, Fable validates) and inject the result as a message in the conversation,
formatted as `Plan: <summary>` followed by numbered steps. If you see one:

- Treat it as **guidance you should follow, not a rigid script**. It was produced without seeing
  the actual repository state in detail — if reality diverges (a file doesn't exist, a step turns
  out to be unnecessary, an assumption was wrong), adapt and briefly explain why you deviated.
- Don't re-derive or re-plan from scratch when a plan is present; execute against it.
- If no plan message is present, there wasn't one for this turn (e.g. the request was classified as
  trivial and bypassed planning, or you're in `ask` mode) — just do the work directly.

## `[DONE:n]` step tracking (agent mode)

In agent mode, the system prompt already instructs you to mark each completed plan step inline
with `[DONE:n]` (where `n` is the step number) so progress can be tracked externally. This skill
doesn't change that instruction — just don't forget it applies for the rest of the turn, not only
the first step: as you finish step 2, step 3, etc., keep emitting `[DONE:2]`, `[DONE:3]` and so on
inline in your response text, in order, one per completed step. Don't batch them all at the end,
and don't mark a step done before you've actually finished it.

## When to use `dispatch_step`

A plan's steps may be prefixed with a tag: `[main]` (needs this conversation's context — do it
inline), `[subagent]` (self-contained, a good `dispatch_step` candidate), or `[parallel-group:N]`
(no dependency on other steps in the same group N — good candidates to dispatch together in one
call). These tags are advisory, not enforced: nothing dispatches a step for you automatically, and
a step's tag is a starting hint, not a rule — use your own judgment against the criteria below.

`dispatch_step` farms out one or more steps to isolated `pi -p` subagent processes — separate
processes with their own clean context, not sharing anything you've already discussed in this
conversation. Use it when a step is:

- **Independent research or exploration** — reading through an unfamiliar module, tracing how a
  library works, summarizing a large file or directory tree — where only the *conclusion* matters
  to you, not the process of getting there.
- **Context-heavy but self-contained** — a lookup that would require reading a lot of material to
  answer, but whose answer can be stated in a few sentences or a short list.
- **Genuinely parallelizable** — two or more steps that don't depend on each other's output (pass
  them in the same `dispatch_step` call; they'll run concurrently up to the configured
  `maxParallel` limit) or a fixed pipeline you can express via `dependsOn` + `{previous}` /
  `{previous:<id>}`.

Do **not** use it for:

- Anything that needs the back-and-forth you've already had in this conversation — a subagent
  starts cold, with only the `task` text you give it. If a step depends on decisions, code you've
  already written this turn, or context only available in this conversation, do it inline instead,
  or restate all the necessary context explicitly in the `task` string.
- Interactive work, or anything requiring your judgment mid-step (e.g. "try approach A, and if it
  fails try B" is fine to phrase as one self-contained task, but "let me know what you find and
  I'll decide next steps" is not — a subagent runs to completion unattended and returns once).
- The actual file edits the user is waiting on, where iterating in place is faster and safer than
  round-tripping through a separate process.

Each `task` string must be self-contained: state exactly what you want done and what "done" looks
like, since the subagent cannot ask you follow-up questions. Give each step in a call a unique
`id`, set `role` if a step should run on a different router role's model than the default
(`executor`), and use `dependsOn` for steps whose task text depends on a prior step's output.
