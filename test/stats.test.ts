import { describe, expect, it } from "vitest";
import { SessionStats } from "../extensions/model-router/stats.ts";

describe("SessionStats", () => {
	it("starts empty: zero calls per role, zero compression, no crash on summarize", () => {
		const stats = new SessionStats();
		const snap = stats.snapshot();
		expect(stats.totalCalls()).toBe(0);
		expect(snap.roles.planner).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
		expect(snap.roles.validator).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
		expect(snap.roles.executor).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
		expect(snap.roles.toolParser).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
		expect(snap.compression).toEqual({ events: 0, originalBytes: 0, compressedBytes: 0, savedBytes: 0, savedTokens: 0 });
		expect(stats.summarize()).toBe("Router stats: no pipeline activity this session yet.");
	});

	it("records calls per role with token usage and accumulates totals", () => {
		const stats = new SessionStats();
		stats.recordCall("planner", { inputTokens: 100, outputTokens: 200 });
		stats.recordCall("planner", { inputTokens: 50, outputTokens: 75 });
		stats.recordCall("executor");
		stats.recordCall("executor", { inputTokens: 10 });

		const snap = stats.snapshot();
		expect(snap.roles.planner).toEqual({ calls: 2, inputTokens: 150, outputTokens: 275 });
		expect(snap.roles.executor).toEqual({ calls: 2, inputTokens: 10, outputTokens: 0 });
		expect(snap.roles.validator.calls).toBe(0);
		expect(snap.roles.toolParser.calls).toBe(0);
		expect(stats.totalCalls()).toBe(4);
	});

	it("records calls without a usage argument (usage unavailable)", () => {
		const stats = new SessionStats();
		stats.recordCall("validator");
		stats.recordCall("validator");
		const snap = stats.snapshot();
		expect(snap.roles.validator).toEqual({ calls: 2, inputTokens: 0, outputTokens: 0 });
	});

	it("records compression savings and accumulates across multiple events", () => {
		const stats = new SessionStats();
		stats.recordCompression({ originalBytes: 48_000, compressedBytes: 1_200, savedTokens: 900 });
		stats.recordCompression({ originalBytes: 2_000, compressedBytes: 500, savedTokens: 100 });

		const snap = stats.snapshot();
		expect(snap.compression.events).toBe(2);
		expect(snap.compression.originalBytes).toBe(50_000);
		expect(snap.compression.compressedBytes).toBe(1_700);
		expect(snap.compression.savedBytes).toBe(48_300);
		expect(snap.compression.savedTokens).toBe(1_000);
	});

	it("floors savedBytes at 0 when compression somehow grows the output", () => {
		const stats = new SessionStats();
		stats.recordCompression({ originalBytes: 100, compressedBytes: 150, savedTokens: 0 });
		expect(stats.snapshot().compression.savedBytes).toBe(0);
	});

	it("summarize() includes per-role call counts, token totals, and compression numbers", () => {
		const stats = new SessionStats();
		stats.recordCall("planner", { inputTokens: 1234, outputTokens: 5678 });
		stats.recordCall("executor");
		stats.recordCompression({ originalBytes: 48_000, compressedBytes: 1_200, savedTokens: 900 });

		const summary = stats.summarize();
		expect(summary).toContain("planner");
		expect(summary).toContain("1234");
		expect(summary).toContain("5678");
		expect(summary).toContain("executor: 1 call");
		expect(summary).toContain("900");
		// roles with zero calls should not clutter the summary
		expect(summary).not.toContain("validator");
		expect(summary).not.toContain("toolParser");
	});

	it("reset() clears all accumulated state back to empty", () => {
		const stats = new SessionStats();
		stats.recordCall("planner", { inputTokens: 10, outputTokens: 10 });
		stats.recordCompression({ originalBytes: 100, compressedBytes: 10, savedTokens: 5 });
		stats.reset();
		expect(stats.totalCalls()).toBe(0);
		expect(stats.snapshot().compression.events).toBe(0);
		expect(stats.summarize()).toBe("Router stats: no pipeline activity this session yet.");
	});

	it("snapshot() is a detached copy: mutating it does not affect subsequent recordings", () => {
		const stats = new SessionStats();
		stats.recordCall("executor", { inputTokens: 1, outputTokens: 1 });
		const snap = stats.snapshot();
		snap.roles.executor.calls = 999;
		stats.recordCall("executor", { inputTokens: 1, outputTokens: 1 });
		expect(stats.snapshot().roles.executor.calls).toBe(2);
	});
});
