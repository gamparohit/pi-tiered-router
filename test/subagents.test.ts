import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeChildProcess extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: ReturnType<typeof vi.fn>;
	killed: boolean;
}

function createFakeProc(): FakeChildProcess {
	const proc = new EventEmitter() as FakeChildProcess;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.killed = false;
	proc.kill = vi.fn((_signal?: string) => {
		proc.killed = true;
		return true;
	});
	return proc;
}

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { runSubagent, runSubagents } = await import("../extensions/model-router/subagents.ts");

/** One `message_end` JSON line for a completed assistant turn, as `--mode json` emits it. */
function assistantLine(text: string, opts: { stopReason?: string; errorMessage?: string; usage?: Record<string, unknown> } = {}) {
	return (
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				usage: opts.usage ?? { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				stopReason: opts.stopReason ?? "end",
				errorMessage: opts.errorMessage,
			},
		}) + "\n"
	);
}

/** Flush pending microtasks/macrotasks so async scheduling loops can progress in tests. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

let createdProcs: FakeChildProcess[] = [];

/** Non-null accessor for the nth spawned fake process (array is reset each test in beforeEach). */
function getProc(index: number): FakeChildProcess {
	const proc = createdProcs[index];
	if (!proc) throw new Error(`expected a fake process at index ${index}, but only ${createdProcs.length} were spawned`);
	return proc;
}

beforeEach(() => {
	spawnMock.mockReset();
	createdProcs = [];
	spawnMock.mockImplementation(() => {
		const proc = createFakeProc();
		createdProcs.push(proc);
		return proc;
	});
});

describe("runSubagent", () => {
	it("resolves ok:true with the final assistant text and aggregated usage on success", async () => {
		const promise = runSubagent({ id: "a", task: "do the thing", model: "anthropic/claude-haiku-4-5" });
		await tick();
		const proc = getProc(0);
		expect(spawnMock).toHaveBeenCalledWith(
			"pi",
			["-p", "--mode", "json", "--model", "anthropic/claude-haiku-4-5", "do the thing"],
			expect.objectContaining({ shell: false }),
		);
		proc.stdout.emit("data", Buffer.from(assistantLine("the final answer")));
		proc.emit("close", 0);

		const result = await promise;
		expect(result).toEqual({
			id: "a",
			ok: true,
			result: "the final answer",
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
		});
	});

	it("resolves ok:false with a descriptive error on non-zero exit", async () => {
		const promise = runSubagent({ id: "b", task: "do the thing", model: "m" });
		await tick();
		const proc = getProc(0);
		proc.stderr.emit("data", Buffer.from("boom: something broke\n"));
		proc.emit("close", 1);

		const result = await promise;
		expect(result.ok).toBe(false);
		expect(result.error).toContain("boom: something broke");
	});

	it("resolves ok:false when the final assistant message reports an error stopReason", async () => {
		const promise = runSubagent({ id: "c", task: "do the thing", model: "m" });
		await tick();
		const proc = getProc(0);
		proc.stdout.emit("data", Buffer.from(assistantLine("", { stopReason: "error", errorMessage: "rate limited" })));
		proc.emit("close", 0);

		const result = await promise;
		expect(result.ok).toBe(false);
		expect(result.error).toBe("rate limited");
	});

	it("kills the process and resolves ok:false after timeoutMs elapses", async () => {
		vi.useFakeTimers();
		try {
			const promise = runSubagent({ id: "d", task: "slow task", model: "m" }, { timeoutMs: 50 });
			await vi.advanceTimersByTimeAsync(0);
			const proc = getProc(0);

			await vi.advanceTimersByTimeAsync(50);
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

			// Simulate the process actually exiting once killed.
			proc.emit("close", null);
			const result = await promise;
			expect(result.ok).toBe(false);
			expect(result.error).toContain("timed out after 50ms");
		} finally {
			vi.useRealTimers();
		}
	});

	it("kills the process and resolves ok:false with 'aborted' when the signal fires", async () => {
		const controller = new AbortController();
		const promise = runSubagent({ id: "e", task: "task", model: "m" }, { signal: controller.signal });
		await tick();
		const proc = getProc(0);

		controller.abort();
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

		proc.emit("close", null);
		const result = await promise;
		expect(result.ok).toBe(false);
		expect(result.error).toBe("aborted");
	});

	it("propagates an already-aborted signal immediately (kill-on-abort before any data)", async () => {
		const controller = new AbortController();
		controller.abort();
		const promise = runSubagent({ id: "f", task: "task", model: "m" }, { signal: controller.signal });
		await tick();
		const proc = getProc(0);
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

		proc.emit("close", null);
		const result = await promise;
		expect(result.ok).toBe(false);
		expect(result.error).toBe("aborted");
	});
});

describe("runSubagents", () => {
	it("respects the concurrency cap: with maxParallel=2 and 4 tasks, at most 2 run at once", async () => {
		const tasks = [1, 2, 3, 4].map((n) => ({ id: `t${n}`, task: `task ${n}`, model: "m" }));
		const resultsPromise = runSubagents(tasks, { maxParallel: 2 });

		await tick();
		expect(spawnMock).toHaveBeenCalledTimes(2);

		// Finish the first two.
		getProc(0).stdout.emit("data", Buffer.from(assistantLine("out1")));
		getProc(0).emit("close", 0);
		getProc(1).stdout.emit("data", Buffer.from(assistantLine("out2")));
		getProc(1).emit("close", 0);

		await tick();
		expect(spawnMock).toHaveBeenCalledTimes(4);
		// Still only 4 total processes ever created (cap held: never 3+ concurrently started up front).
		expect(createdProcs).toHaveLength(4);

		getProc(2).stdout.emit("data", Buffer.from(assistantLine("out3")));
		getProc(2).emit("close", 0);
		getProc(3).stdout.emit("data", Buffer.from(assistantLine("out4")));
		getProc(3).emit("close", 0);

		const results = await resultsPromise;
		expect(results.size).toBe(4);
		for (const n of [1, 2, 3, 4]) {
			expect(results.get(`t${n}`)?.ok).toBe(true);
		}
	});

	it("substitutes {previous} with the dependency's result before spawning the dependent task", async () => {
		const tasks = [
			{ id: "a", task: "produce a value", model: "m" },
			{ id: "b", task: "use this: {previous}", model: "m", dependsOn: ["a"] },
		];
		const resultsPromise = runSubagents(tasks, { maxParallel: 2 });

		await tick();
		expect(spawnMock).toHaveBeenCalledTimes(1); // b waits on a

		getProc(0).stdout.emit("data", Buffer.from(assistantLine("RESULT_A")));
		getProc(0).emit("close", 0);

		await tick();
		expect(spawnMock).toHaveBeenCalledTimes(2);
		expect(spawnMock).toHaveBeenLastCalledWith(
			"pi",
			["-p", "--mode", "json", "--model", "m", "use this: RESULT_A"],
			expect.anything(),
		);

		getProc(1).stdout.emit("data", Buffer.from(assistantLine("final")));
		getProc(1).emit("close", 0);

		const results = await resultsPromise;
		expect(results.get("a")?.result).toBe("RESULT_A");
		expect(results.get("b")?.result).toBe("final");
	});

	it("substitutes {previous:<id>} per-dependency when a task has multiple deps", async () => {
		const tasks = [
			{ id: "a", task: "task a", model: "m" },
			{ id: "b", task: "task b", model: "m" },
			{
				id: "c",
				task: "combine {previous:a} and {previous:b}",
				model: "m",
				dependsOn: ["a", "b"],
			},
		];
		const resultsPromise = runSubagents(tasks, { maxParallel: 2 });

		await tick();
		expect(spawnMock).toHaveBeenCalledTimes(2); // a and b start in parallel, c waits

		getProc(0).stdout.emit("data", Buffer.from(assistantLine("A_OUT")));
		getProc(0).emit("close", 0);
		getProc(1).stdout.emit("data", Buffer.from(assistantLine("B_OUT")));
		getProc(1).emit("close", 0);

		await tick();
		expect(spawnMock).toHaveBeenCalledTimes(3);
		expect(spawnMock).toHaveBeenLastCalledWith(
			"pi",
			["-p", "--mode", "json", "--model", "m", "combine A_OUT and B_OUT"],
			expect.anything(),
		);

		getProc(2).stdout.emit("data", Buffer.from(assistantLine("combined")));
		getProc(2).emit("close", 0);

		const results = await resultsPromise;
		expect(results.get("c")?.result).toBe("combined");
	});

	it("cascades failure to dependents without spawning them", async () => {
		const tasks = [
			{ id: "a", task: "task a", model: "m" },
			{ id: "b", task: "use {previous}", model: "m", dependsOn: ["a"] },
		];
		const resultsPromise = runSubagents(tasks, { maxParallel: 2 });

		await tick();
		getProc(0).emit("close", 1); // a fails

		const results = await resultsPromise;
		expect(results.get("a")?.ok).toBe(false);
		expect(results.get("b")?.ok).toBe(false);
		expect(results.get("b")?.error).toContain('dependency "a" failed');
		expect(spawnMock).toHaveBeenCalledTimes(1); // b never spawned
	});

	it("fails a task immediately when it depends on an unknown id", async () => {
		const tasks = [{ id: "a", task: "use {previous}", model: "m", dependsOn: ["ghost"] }];
		const results = await runSubagents(tasks, { maxParallel: 2 });
		expect(results.get("a")?.ok).toBe(false);
		expect(results.get("a")?.error).toContain('unknown dependency "ghost"');
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("fails all remaining tasks on a circular dependency instead of hanging", async () => {
		const tasks = [
			{ id: "a", task: "a needs b: {previous}", model: "m", dependsOn: ["b"] },
			{ id: "b", task: "b needs a: {previous}", model: "m", dependsOn: ["a"] },
		];
		const results = await runSubagents(tasks, { maxParallel: 2 });
		expect(results.get("a")?.ok).toBe(false);
		expect(results.get("b")?.ok).toBe(false);
		expect(results.get("a")?.error).toContain("circular");
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("propagates an abort signal to all currently-running subagent processes", async () => {
		const controller = new AbortController();
		const tasks = [1, 2].map((n) => ({ id: `t${n}`, task: `task ${n}`, model: "m" }));
		const resultsPromise = runSubagents(tasks, { maxParallel: 2, signal: controller.signal });

		await tick();
		expect(createdProcs).toHaveLength(2);
		controller.abort();
		expect(getProc(0).kill).toHaveBeenCalledWith("SIGTERM");
		expect(getProc(1).kill).toHaveBeenCalledWith("SIGTERM");

		getProc(0).emit("close", null);
		getProc(1).emit("close", null);

		const results = await resultsPromise;
		expect(results.get("t1")?.error).toBe("aborted");
		expect(results.get("t2")?.error).toBe("aborted");
	});
});
