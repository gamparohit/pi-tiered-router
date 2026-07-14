# Modes

`pi-tiered-router` has four modes. The mode controls **workflow, tool access,
and effort bias** — the router config controls **which model** runs each
phase. Every mode works with every role's model.

Switch with `/mode <plan|agent|ask|debug>`, cycle with `ctrl+alt+m`, or set
the initial mode at startup with `--mode-router <mode>`. The active mode is
persisted as a session entry, so it survives `/resume` and forking.

## plan

Planner drafts, validator critiques — **nothing is executed**.

- Tools: read-only. Write/edit tools are blocked outright; bash commands are
  filtered through a safe allowlist (`cat`, `grep`, `git status`, etc. — see
  `guard.ts`) and destructive patterns (`rm`, `git commit`, `sudo`, redirects,
  package installs, …) are always blocked.
- Effort: planner runs at its configured (high, by default) effort.
- The validated plan is presented for you to read; the model is told to
  explain it, not act on it, and to suggest switching to agent mode if you
  want it executed.

## agent (default)

The full pipeline: **classify → plan → validate → execute → tool-parse**.

- Tools: all tools available.
- Effort: each role runs at its configured effort, escalated (never
  downgraded) based on classified task complexity.
- A `[DONE:n]` convention is used in the system prompt addendum so the model
  marks off plan steps as it completes them.

## ask

Direct Q&A — the classifier still runs, but there is **no plan phase**.

- Tools: read-only, same allowlist as plan mode.
- Effort: never escalated — trivial questions route to the cheapest role
  (`toolParser`), everything else to the executor role at its *configured*
  (not escalated) effort. The whole point of ask mode is a quick, direct
  answer.
- If the request actually needs multi-step work, the model is told to say so
  and suggest switching modes.

## debug

Same **classify → plan → validate → execute** pipeline as agent mode, with a
different system-prompt addendum: reproduce → form a specific hypothesis →
instrument/inspect → fix, quoting exact error messages/paths/line numbers
verbatim rather than jumping straight to a fix.

- Tools: all tools available.
- Effort: same escalation behavior as agent mode.

## Mode × role matrix

| Mode | Pipeline | Tools | Effort | Primary roles |
|------|----------|-------|--------|----------------|
| plan | planner → validator only | read-only | planner: high | planner, validator |
| agent | full | all | per-role, escalated | all four |
| ask | classify only | read-only | never escalated | toolParser or executor |
| debug | full (hypothesis-driven prompt) | all | per-role, escalated | all four |
