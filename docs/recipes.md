# Recipes

Config files live at `~/.pi/agent/model-router.json` (global) and
`<project>/.pi/model-router.json` (project — only honored when the project is
trusted). Project config wins over global; both deep-merge over the built-in
defaults, so you only need to specify the keys you want to change.

Three named presets ship for a quick start via `--router-preset <name>`
(`default`, `max-quality`, `all-local`) — a config file still overrides preset
values.

## All-Anthropic default

This is what you get with no config file at all — included here so you can
see the full shape and override just one field if you like:

```jsonc
{
  "roles": {
    "planner":   { "model": "anthropic/claude-opus-*",   "thinking": "high" },
    "validator": { "model": "anthropic/claude-fable-*",  "thinking": "medium" },
    "executor":  { "model": "anthropic/claude-sonnet-*",  "thinking": "medium" },
    "toolParser":{ "model": "anthropic/claude-haiku-*",   "thinking": "off" }
  },
  "fallbacks": {
    "planner": ["anthropic/claude-sonnet-*"],
    "validator": ["skip"],
    "executor": ["anthropic/claude-opus-*"],
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

## Lightweight: Sonnet plans, Haiku executes

For small projects where Opus-level planning is overkill:

```jsonc
{
  "roles": {
    "planner":  { "model": "anthropic/claude-sonnet-*", "thinking": "medium" },
    "executor": { "model": "anthropic/claude-haiku-*",  "thinking": "medium" }
  }
}
```

Only the two keys you're changing need to be present — `validator` and
`toolParser` stay at their defaults via the deep merge.

## Mixed-provider

Any role can point at any provider your `pi` install has models registered
for. Wildcards (`provider/prefix-*`) pick the best-authed, newest-matching
model; fallback chains kick in if the primary spec can't be resolved (no
matching model, or no API key configured):

```jsonc
{
  "roles": {
    "planner":  { "model": "openai/gpt-5", "thinking": "high" },
    "executor": { "model": "anthropic/claude-sonnet-*", "thinking": "medium" }
  },
  "fallbacks": {
    "planner": ["anthropic/claude-opus-*", "anthropic/claude-sonnet-*"]
  }
}
```

## Local-model validator

Route just the validator role to a local model (e.g. via an Ollama provider
you've registered with `pi.registerProvider`), with `"skip"` as the final
fallback so a missing local model degrades gracefully instead of blocking the
pipeline:

```jsonc
{
  "roles": {
    "validator": { "model": "ollama/qwen2.5-coder", "thinking": "medium" }
  },
  "fallbacks": {
    "validator": ["skip"]
  }
}
```

## Complexity-tiered role chains

Keep the full-quality chain for anything genuinely complex, but let the
classifier trim it for easier tasks. See [`docs/routing.md`](routing.md) for
the tier-pinning/cache-economics rationale — this is opt-in and additive, not
a downgrade:

```jsonc
{
  "routing": {
    "tiers": {
      // "complex": no entry -> always the full base chain (Opus plans+validates, Sonnet executes)
      "standard": {
        "validator": { "model": "anthropic/claude-opus-*", "thinking": "high" } // stronger self-check
      },
      "simple": {
        "planner": { "model": "anthropic/claude-sonnet-*", "thinking": "low" },
        "executor": { "model": "anthropic/claude-haiku-*", "thinking": "low" }
      }
      // "trivial": already fully handled by routing.trivialBypass, no tier needed
    }
  }
}
```

A tier can list just the one or two roles it changes — anything it doesn't
mention keeps the base `roles` config for that turn. `"skip"` is valid here
too, same as in `fallbacks`.

## Disabling a pipeline stage

Set a role's fallback chain to end in `"skip"` and its primary spec to
something that predictably won't resolve (or just rely on the fallback when
the primary is genuinely unavailable) to disable that stage entirely — the
pipeline degrades gracefully rather than erroring. The default config already
does this for `validator`, so a missing "Fable" model just skips validation
rather than blocking every turn.
