---
title: "Why I route each phase of my coding agent to a different model"
published: false
description: "One model planning, coding, and reading giant test logs wastes a good model. Here's my phase-based routing method, where it thrives — and an honest look at where the orchestrator pattern beats it."
tags: ai, llm, opensource, architecture
---

Most agentic coding setups run one model for the whole job: it decomposes the task, writes the code, and then wades through thousand-line test logs looking for the one line that matters. That wastes a good model twice over — you're paying frontier-model rates for work a much cheaper model would do just as well, and you're diluting the model's context with noise while you're at it.

My method is simple to state: **treat a coding turn as a sequence of phases, and give each phase the model best suited to it.** I've packaged it as [**pi-tiered-router**](https://pi.dev/packages/pi-tiered-router?name=pi-tiered-router), an extension for the [pi](https://pi.dev) coding agent — but the method matters more than the package, so that's what this post is really about.

## The method: decompose by phase, not by subtask

A coding turn breaks into phases:

```
classify → plan → validate → execute
                              (tool output compressed as it streams in)
```

Each phase binds to a role, and each role binds to a model plus a thinking level — all configurable:

| Role | Default (model, thinking) | Job |
|------|---------------------------|-----|
| **Planner** | Opus, high | Decompose the goal into a numbered plan |
| **Validator** | Fable, medium | Independently critique the plan before any code is written |
| **Executor** | Sonnet, medium | Do the actual work |
| **Tool parser** | Haiku, off | Classify the task up front, and compress noisy tool output before it hits the executor's context |

Note that the cheapest role does double duty: it runs the up-front complexity classification *and* the tool-output compression. Both are high-volume, low-difficulty jobs — exactly what you don't want a frontier model spending context on.

Planning and validation happen **out of band** — they never touch the executor's conversation. Only the final, validated plan gets injected as context. The model doing the actual coding sees a clean, distilled plan instead of the whole reasoning trace that produced it.

A minimal config is just the roles you want to change; everything else falls back to defaults:

```jsonc
{
  "roles": {
    "planner":   { "model": "anthropic/claude-opus-*",   "thinking": "high" },
    "validator": { "model": "anthropic/claude-fable-*",  "thinking": "medium" },
    "executor":  { "model": "anthropic/claude-sonnet-*", "thinking": "medium" },
    "toolParser":{ "model": "anthropic/claude-haiku-*",  "thinking": "off" }
  }
}
```

Model specs use wildcards (`claude-opus-*`) so the config survives point releases, and any role can point at any provider — OpenAI, Google, a local Ollama model, whatever your setup has.

## The "tiered" part: complexity scales the chain

The name comes from what the classification is *for*. Before anything runs, the cheapest role rates the request into a tier — trivial, simple, standard, or complex — and the tier scales the whole chain:

- **Effort floors.** A complex task escalates each role's thinking level above its configured baseline. Escalation only ever goes *up* — the router never quietly lowers effort below what you configured.
- **Trivial bypass.** A one-line question skips planning and validation entirely and goes straight to execution.
- **Per-tier model overrides (opt-in).** You can declare a lighter chain for lighter tiers — say, Sonnet plans and Haiku executes on simple tasks — while complex tasks always get the full chain.
- **Tier pinning.** Once a session commits to a tier, it never drops below it. That keeps each role's model stable across turns, which keeps the provider's prompt cache warm — flip-flopping models mid-session throws that cache away.

## This is deliberately *not* a cost-cutting tool

This is the part I want to be clear about, because it's an easy thing to get wrong. There are no spend caps and no silent downgrades. Every phase always gets the model and effort level that produces the best result *for that phase*.

The efficiency is a **side effect of routing well**, not the goal:

- A validator catching a bad plan before it wastes a full execution pass.
- A compressed 40KB test log keeping the executor's context sharp instead of drowning it.
- Haiku parsing a stack trace instead of Opus.

If you want it cheaper, you configure cheaper models per role (or lighter tier chains) — the router will never make that tradeoff for you behind your back.

## Where my method thrives — and where it doesn't

If you've read Anthropic's writing on multi-agent systems, the obvious question is: how is this different from the **orchestrator/subagent** pattern — a lead agent that dynamically decomposes a task, spawns worker agents, and synthesizes their results?

The honest answer is that they optimize different things, and being clear about the tradeoffs is more useful than pretending my method wins on every axis.

**The load-bearing difference: I decompose by phase, decided by code; the orchestrator decomposes by subtask, decided by a reasoning model.** My pipeline is fixed, and its cleverness is binding each phase to a model — deterministic, given a cheap up-front classification. The orchestrator instead has a reasoning model look at *this specific task*, decide how to split it, spawn workers in parallel, read what comes back, and re-plan.

### Where it thrives

- **Model-to-phase matching captures capability the orchestrator pattern squanders.** A lead agent typically reads logs and greps files on the same strong model that plans. Routing that work to a cheap model keeps the strong model's context — its scarcest resource — for the work that needs it.
- **The validator gate is a quality mechanism most orchestrator setups lack.** An independent model critiquing the plan before execution catches bad plans early. The lead agent, by contrast, grades its own homework.
- **Predictable cost and latency.** No risk of a task quietly exploding because the orchestrator decided to spawn a dozen workers — Anthropic has published that multi-agent research runs can hit ~15× the tokens of a normal chat. My overhead is a fixed handful of out-of-band calls.
- **Debuggability.** Fixed phases plus trace notes mean you can actually reason about why a turn did what it did. Orchestrator runs are notoriously hard to reproduce.

### Where it doesn't

- **It's a pipeline, not an agent.** Planning happens once up front, with a bounded revision loop. A true orchestrator re-plans continuously as it learns from execution. When my classifier misjudges, an escalation ratchet bumps the complexity tier — it doesn't re-decompose the task.
- **No dynamic, breadth-first parallelism.** For open-ended work where you don't know the decomposition up front ("research how X is done across these repos," "try three approaches and compare"), the orchestrator's parallel-explore-then-synthesize loop is exactly right. My parallelism is opt-in and shallower.
- **It can't invent a new shape of work.** A fixed pipeline handles the task shapes it was built for; a reasoning orchestrator adapts to novel ones.

### When to reach for which

- **My method thrives** on well-shaped coding tasks with a knowable structure: implement a feature, fix a bug, refactor a module. Predictable, quality-gated, easy on context. This is most day-to-day coding.
- **The orchestrator thrives** on ambiguous, breadth-first work where the decomposition *is* the hard part.

The way I'd put it: I built a well-engineered assembly line; the orchestrator is a research team. An assembly line is faster and more reliable when the product is known — and the wrong tool when the job is "go figure out what we should even build."

It isn't strictly either/or: the package includes an opt-in `dispatch_step` tool that farms parallel steps out to isolated subprocesses, so the executor can borrow a page from the orchestrator playbook when a step genuinely benefits from it.

## Try it

```bash
pi install npm:pi-tiered-router
```

Or browse it on the pi package gallery: [pi.dev/packages/pi-tiered-router](https://pi.dev/packages/pi-tiered-router?name=pi-tiered-router)

It ships with four modes (plan / agent / ask / debug) and a first-run setup wizard. It's v0.1.0 — I'd genuinely like to hear how it holds up on real work, especially where the phase-based method breaks down and you'd want something more orchestrator-shaped.
