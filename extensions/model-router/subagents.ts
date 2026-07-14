import { type ChildProcess, spawn } from "node:child_process";

/**
 * Subprocess orchestration for farming out plan steps the validator has
 * tagged `[subagent]` / `[parallel-group:N]` (see PLAN.md section 6).
 *
 * Deliberately dependency-light: only `node:child_process` (mockable in
 * tests) — no `ExtensionAPI`/`ExtensionContext` imports here. The orchestrator
 * (a future `dispatch_step` tool, per PLAN.md, not built in this file) is
 * responsible for wiring this into pi's tool system and session context.
 *
 * Modeled on the `examples/extensions/subagent/` reference pattern bundled
 * with `@earendil-works/pi-coding-agent` (single/parallel/chain modes,
 * `--mode json` parsing, kill-on-abort), adapted to work off plain
 * `{ model, task }` specs instead of named agent files.
 *
 * ## `--mode json` output shape (from `pi`'s own docs, `docs/json.md`)
 *
 * `pi --mode json` does NOT print one final `{ result, usage }` blob. It
 * streams newline-delimited JSON *events* to stdout as the run progresses;
 * the ones this module cares about are:
 *
 * ```json
 * {"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}
 * {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"..."}],"usage":{...},"stopReason":"end"}}
 * ```
 *
 * We reconstruct a single `result` by taking the last text part of the last
 * assistant `message_end`, and aggregate `usage` (input/output/cache/cost
 * tokens, turn count) by summing every assistant message's `usage` field —
 * exactly what `runSingleAgent()` does in the reference implementation.
 * A subagent run is treated as failed if the process exits non-zero, or the
 * final assistant message's `stopReason` is `"error"` or `"aborted"`.
 */

/** One unit of work to farm out to an isolated `pi` subprocess. */
export interface SubagentTask {
	/** Caller-chosen id, unique within a single `runSubagents()` batch. */
	id: string;
	/** The task prompt. May contain `{previous}` / `{previous:<id>}` placeholders (see `runSubagents`). */
	task: string;
	/** "provider/model-id" string passed to `pi --model`. */
	model: string;
	/** Ids of tasks (within the same batch) whose results must be substituted in before this task runs. */
	dependsOn?: string[];
}

/** Aggregated token/cost usage for one subagent run, summed across all its turns. */
export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface SubagentResult {
	id: string;
	ok: boolean;
	/** Final assistant text output, when `ok` is true. */
	result?: unknown;
	/** Human-readable failure reason, when `ok` is false. */
	error?: string;
	usage?: SubagentUsage;
}

export interface RunSubagentOptions {
	/** Working directory for the spawned `pi` process. Defaults to the current process's cwd. */
	cwd?: string;
	/** Abort the subprocess (SIGTERM, then SIGKILL after a grace period) when this fires. */
	signal?: AbortSignal;
	/** Kill the subprocess and fail with a timeout error if it runs longer than this. */
	timeoutMs?: number;
}

/** Grace period between SIGTERM and SIGKILL when a process must be killed (abort or timeout). */
const SIGKILL_GRACE_MS = 5000;

interface RawAssistantMessage {
	role: string;
	content?: Array<{ type: string; text?: string }>;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
	};
	stopReason?: string;
	errorMessage?: string;
}

function emptyUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/** Last text part of the last assistant message, mirroring the reference implementation's `getFinalOutput`. */
function getFinalOutput(messages: RawAssistantMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j];
			if (part && part.type === "text" && typeof part.text === "string") return part.text;
		}
	}
	return "";
}

/**
 * Spawn `pi -p --mode json --model <task.model> "<task.task>"`, parse its
 * newline-delimited JSON event stream, and resolve with a single result.
 * Never throws: spawn failures, non-zero exits, timeouts, and aborts all
 * resolve `{ ok: false, error }` rather than rejecting, so a batch runner can
 * always continue past one failed subagent.
 */
export function runSubagent(task: SubagentTask, opts: RunSubagentOptions = {}): Promise<SubagentResult> {
	return new Promise<SubagentResult>((resolve) => {
		const args = ["-p", "--mode", "json", "--model", task.model, task.task];

		let proc: ChildProcess;
		try {
			proc = spawn("pi", args, { cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({ id: task.id, ok: false, error: `failed to spawn "pi": ${(err as Error).message}` });
			return;
		}

		let stdoutBuffer = "";
		let stderrBuffer = "";
		const messages: RawAssistantMessage[] = [];
		const usage = emptyUsage();
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

		const killProc = () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			const killTimer = setTimeout(() => {
				try {
					if (!proc.killed) proc.kill("SIGKILL");
				} catch {
					/* ignore */
				}
			}, SIGKILL_GRACE_MS);
			killTimer.unref?.();
		};

		const onAbort = () => {
			aborted = true;
			killProc();
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		if (opts.timeoutMs && opts.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				killProc();
			}, opts.timeoutMs);
			timeoutTimer.unref?.();
		}

		const finish = (result: SubagentResult) => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			resolve(result);
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: { type?: string; message?: RawAssistantMessage };
			try {
				event = JSON.parse(line);
			} catch {
				return; // Tolerate non-JSON noise on stdout.
			}
			if (event.type !== "message_end" || !event.message) return;

			const msg = event.message;
			messages.push(msg);
			if (msg.role !== "assistant") return;

			usage.turns++;
			const u = msg.usage;
			if (u) {
				usage.input += u.input ?? 0;
				usage.output += u.output ?? 0;
				usage.cacheRead += u.cacheRead ?? 0;
				usage.cacheWrite += u.cacheWrite ?? 0;
				usage.cost += u.cost?.total ?? 0;
			}
			if (msg.stopReason) stopReason = msg.stopReason;
			if (msg.errorMessage) errorMessage = msg.errorMessage;
		};

		proc.stdout?.on("data", (data: Buffer | string) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr?.on("data", (data: Buffer | string) => {
			stderrBuffer += data.toString();
		});

		proc.on("error", (err) => {
			finish({ id: task.id, ok: false, error: `subagent process error: ${(err as Error).message}` });
		});

		proc.on("close", (code) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);

			if (aborted) {
				finish({ id: task.id, ok: false, error: "aborted", usage });
				return;
			}
			if (timedOut) {
				finish({ id: task.id, ok: false, error: `timed out after ${opts.timeoutMs}ms`, usage });
				return;
			}

			const exitCode = code ?? 0;
			const failed = exitCode !== 0 || stopReason === "error" || stopReason === "aborted";
			if (failed) {
				const error =
					errorMessage || stderrBuffer.trim() || getFinalOutput(messages) || `subagent exited with code ${exitCode}`;
				finish({ id: task.id, ok: false, error, usage });
				return;
			}

			finish({ id: task.id, ok: true, result: getFinalOutput(messages) || "(no output)", usage });
		});
	});
}

export interface RunSubagentsOptions {
	/** Max number of subagent processes running concurrently. */
	maxParallel: number;
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Substitute chain-mode placeholders in a task's prompt using already-completed
 * dependency results.
 *
 * Convention:
 * - Exactly one `dependsOn` entry: `{previous}` is replaced with that
 *   dependency's result (empty string if it failed).
 * - Multiple `dependsOn` entries: `{previous:<id>}` is replaced with the
 *   result of dependency `<id>`. Plain `{previous}` is also substituted with
 *   the *first* listed dependency's result, as a convenience for the common
 *   case where only one of several deps' output is actually referenced.
 */
function substitutePrevious(task: SubagentTask, results: Map<string, SubagentResult>): string {
	const deps = task.dependsOn ?? [];
	if (deps.length === 0) return task.task;

	const textOf = (id: string): string => {
		const dep = results.get(id);
		return dep?.ok ? String(dep.result ?? "") : "";
	};

	let out = task.task;
	for (const depId of deps) {
		out = out.replaceAll(`{previous:${depId}}`, textOf(depId));
	}
	const firstDep = deps[0];
	if (firstDep !== undefined) out = out.replaceAll("{previous}", textOf(firstDep));
	return out;
}

/**
 * Run a batch of tasks with a dependency graph, up to `maxParallel`
 * subagent processes running at once. Independent tasks (no `dependsOn`, or
 * whose deps are already satisfied) start immediately; dependent tasks wait
 * for every listed dependency to finish, then have `{previous}` /
 * `{previous:<id>}` substituted into their prompt before spawning (see
 * `substitutePrevious`).
 *
 * Never throws. Degrades gracefully:
 * - An unknown `dependsOn` id fails that task immediately (no spawn) with a
 *   descriptive error.
 * - A failed dependency cascades: dependents fail without spawning, citing
 *   which dependency failed.
 * - A circular/unresolvable dependency chain among the remaining tasks is
 *   detected (no task can start and none are running) and every remaining
 *   task fails with a descriptive error, rather than hanging forever.
 */
export async function runSubagents(
	tasks: SubagentTask[],
	opts: RunSubagentsOptions,
): Promise<Map<string, SubagentResult>> {
	const results = new Map<string, SubagentResult>();
	if (tasks.length === 0) return results;

	const byId = new Map(tasks.map((t) => [t.id, t]));
	const maxParallel = Math.max(1, opts.maxParallel);
	const pending = new Set(tasks.map((t) => t.id));
	const running = new Map<string, Promise<void>>();

	const tryStart = (): void => {
		for (const id of Array.from(pending)) {
			if (running.size >= maxParallel) break;
			const task = byId.get(id);
			if (!task) continue;
			const deps = task.dependsOn ?? [];

			const unknownDep = deps.find((d) => !byId.has(d));
			if (unknownDep) {
				pending.delete(id);
				results.set(id, { id, ok: false, error: `skipped: unknown dependency "${unknownDep}"` });
				continue;
			}

			const unresolvedDeps = deps.filter((d) => !results.has(d));
			if (unresolvedDeps.length > 0) continue; // Still waiting on in-flight dependencies.

			const failedDep = deps.find((d) => !results.get(d)?.ok);
			if (failedDep) {
				pending.delete(id);
				results.set(id, { id, ok: false, error: `skipped: dependency "${failedDep}" failed` });
				continue;
			}

			pending.delete(id);
			const runnable: SubagentTask = { ...task, task: substitutePrevious(task, results) };
			const runPromise = runSubagent(runnable, {
				cwd: opts.cwd,
				signal: opts.signal,
				timeoutMs: opts.timeoutMs,
			})
				.then((r) => {
					results.set(id, r);
				})
				.finally(() => {
					running.delete(id);
				});
			running.set(id, runPromise);
		}
	};

	while (pending.size > 0 || running.size > 0) {
		tryStart();

		if (running.size === 0 && pending.size > 0) {
			// Nothing could start and nothing is in flight: a circular or otherwise
			// unresolvable dependency chain among the remaining tasks.
			for (const id of pending) {
				results.set(id, { id, ok: false, error: "skipped: circular or unresolvable dependency chain" });
			}
			pending.clear();
			break;
		}

		if (running.size > 0) {
			await Promise.race(running.values());
		}
	}

	return results;
}
