# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-07-14

### Added

- Setup wizard (`/router setup` / `/router config`) now inherits your pi
  model scope (`Settings.enabledModels`, the set `Ctrl+P` cycles): each
  role's picker is filtered to those models, falling back to the full
  registry only when no scope is configured. The active session model is
  marked `▶` and sorted first; authed models are marked `✓`.
- Non-wildcard model specs (exact id, bare id, or either with a `:thinking`
  suffix) now resolve through pi's own model resolver, matching `/model`
  semantics exactly (alias-over-dated preference, fuzzy match, thinking-level
  suffix parsing). Trailing-`*` wildcard specs keep the router's own
  authed-first matcher.
- `/router` gains argument completions, a `/router help` subcommand, and a
  warning on unknown subcommands instead of silently falling through to the
  dashboard.
- Human plan-approval gate for agent/debug modes (`routing.planGate`: `off`
  (default) | `replace-validator` | `after-validator`). When enabled, the
  pipeline pauses after planning so you can approve, request changes
  (fed back to the planner for unlimited re-plan rounds), or proceed without
  a plan. Toggle per-session with `/router gate <mode>`. Interactive-only —
  forced off in `-p`/JSON/RPC mode.

## [0.1.0] - 2026-07-11

### Added

- Config & role resolution: global/project config merge with trust gating,
  wildcard prefix matching (`provider/prefix-*`), fallback chains, `"skip"` to
  disable a role, `--router-preset` (`default`/`max-quality`/`all-local`),
  interactive `/router config` editor.
- Modes: `plan` / `agent` / `ask` / `debug`, `/mode` command, `ctrl+alt+m`
  cycle shortcut, `--mode-router` startup flag, session-persisted mode state,
  read-only tool/bash gating for plan and ask modes, per-mode system prompt
  addenda.
- Pipeline: classify → plan → validate → execute, bounded validator revision
  loop (max 2 rounds), complexity-based effort escalation (never downgraded),
  trivial-bypass fast path, abort propagation through all out-of-band calls.
- Tool-output compression: `tool_result` middleware that compresses large
  bash/grep/find/ls output via the cheap toolParser role, with guardrails so
  error output is never over-compressed; `/router toolparse on|off` toggle.
- Subagent dispatch: `dispatch_step` tool for farming steps out to isolated
  `pi -p --mode json` subprocesses, single/parallel/chained via `dependsOn`
  and `{previous}`/`{previous:<id>}` substitution, concurrency capping,
  timeout, and kill-on-abort.
- Usage stats: informational per-role call/token counters and compression
  savings, surfaced via `/router stats` and an `agent_settled` summary —
  purely informational, never gates or influences routing.
