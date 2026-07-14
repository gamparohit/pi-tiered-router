#!/usr/bin/env bash
# Integration smoke test for pi-tiered-router against a REAL pi binary (PLAN.md §13b).
#
# This is deliberately NOT part of `npm test` / vitest: it makes real LLM calls
# against whatever pi auth is configured on this machine, so it costs real
# tokens and requires network access. Run it manually:
#
#   bash test/e2e.sh
#
# Requires: `pi` on PATH (this was written against pi 0.80.6), an authenticated
# Anthropic provider (the package's default roles all resolve to anthropic/claude-*).
set -uo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH_DIR="$(mktemp -d)"
trap 'rm -rf "$SCRATCH_DIR"' EXIT

pass=0
fail=0

ok() {
	echo "  ok: $1"
	pass=$((pass + 1))
}
bad() {
	echo "  FAIL: $1"
	fail=$((fail + 1))
}
assert_contains() {
	local haystack="$1" needle="$2" label="$3"
	if [[ "$haystack" == *"$needle"* ]]; then ok "$label"; else bad "$label (expected to find: $needle)"; fi
}

# Common flags: isolate from any other globally-installed pi packages, load only
# our package, don't persist a session file for a one-off smoke run.
PI_BASE_FLAGS=(-e "$PACKAGE_DIR" --no-extensions -p --mode json --no-session)

# Per-run wall clock cap. macOS ships no `timeout`, so: background + poll + kill.
# A hung run fails the scenario (exit 124) instead of blocking the suite forever.
RUN_TIMEOUT_SECS=120
run_pi() {
	local out="$1" err="$2"
	shift 2
	pi "$@" >"$out" 2>"$err" &
	local pid=$! waited=0
	while kill -0 "$pid" 2>/dev/null && ((waited < RUN_TIMEOUT_SECS)); do
		sleep 1
		waited=$((waited + 1))
	done
	if kill -0 "$pid" 2>/dev/null; then
		kill -9 "$pid" 2>/dev/null
		wait "$pid" 2>/dev/null
		return 124
	fi
	wait "$pid"
}

cd "$SCRATCH_DIR"

echo "== 1. Load + pipeline smoke =="
run_pi stdout1.log stderr1.log "${PI_BASE_FLAGS[@]}" "reply with exactly: ok"
exit_code=$?
stdout="$(cat stdout1.log)"
stderr="$(cat stderr1.log)"

if [[ $exit_code -eq 0 ]]; then ok "exit code 0"; else bad "exit code $exit_code"; fi

ndjson_ok=true
while IFS= read -r line; do
	[[ -z "$line" ]] && continue
	echo "$line" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' >/dev/null 2>&1 || ndjson_ok=false
done <<<"$stdout"
if $ndjson_ok; then ok "stdout is valid NDJSON"; else bad "stdout is not valid NDJSON"; fi

assert_contains "$stderr" "[model-router]" "stderr has model-router notifications"
if [[ "$stderr" == *"no plan (trivial bypass)"* || "$stderr" == *"-step plan"* ]]; then
	ok "pipeline summary present (bypass or plan)"
else
	bad "no pipeline summary found in stderr"
fi

echo
echo "== 2. Config honored (project config, trusted via --approve) =="
mkdir -p "$SCRATCH_DIR/.pi"
cat >"$SCRATCH_DIR/.pi/model-router.json" <<'EOF'
{ "roles": { "executor": { "model": "anthropic/claude-haiku-4-5", "thinking": "low" } } }
EOF

run_pi /dev/null stderr2.log "${PI_BASE_FLAGS[@]}" --approve "reply with exactly: ok"
stderr2="$(cat stderr2.log)"
assert_contains "$stderr2" "claude-haiku-4-5" "overridden executor model honored"

echo
echo "== 3. Failure drill: unresolvable role degrades gracefully =="
# The fallback chain must be emptied too: with the default
# fallbacks.planner ["anthropic/claude-sonnet-*"] left in place, a bogus
# primary spec is silently *rescued* by the fallback (deep merge preserves it),
# which is correct behavior but doesn't exercise the unresolved-role path.
# Arrays are replaced wholesale in the merge, so [] clears it.
cat >"$SCRATCH_DIR/.pi/model-router.json" <<'EOF'
{
  "roles": { "planner": { "model": "nope/nothing", "thinking": "high" } },
  "fallbacks": { "planner": [] }
}
EOF

run_pi /dev/null stderr3.log "${PI_BASE_FLAGS[@]}" --approve "reply with exactly: ok"
exit_code3=$?
stderr3="$(cat stderr3.log)"

if [[ $exit_code3 -eq 0 ]]; then ok "run completed despite unresolvable role"; else bad "run crashed (exit $exit_code3) instead of degrading gracefully"; fi
assert_contains "$stderr3" "Could not resolve role" "graceful unresolved-role warning shown"

echo
echo "== Results: $pass passed, $fail failed =="
[[ $fail -eq 0 ]]
