import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { type BranchSource, MODE_ENTRY_TYPE, ModeState } from "../extensions/model-router/modes.ts";

function fakePi(): { pi: ExtensionAPI; appended: Array<{ customType: string; data: unknown }> } {
	const appended: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		appendEntry: (customType: string, data?: unknown) => {
			appended.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	return { pi, appended };
}

function branchWithModes(...modes: string[]): BranchSource {
	return {
		getBranch: () =>
			modes.map((mode, i) => ({
				type: "custom" as const,
				id: `e${i}`,
				parentId: i === 0 ? undefined : `e${i - 1}`,
				timestamp: i,
				customType: MODE_ENTRY_TYPE,
				data: { mode },
			})) as any,
	};
}

describe("ModeState", () => {
	it("starts at the constructor default", () => {
		const { pi } = fakePi();
		const state = new ModeState(pi, "agent");
		expect(state.current).toBe("agent");
	});

	it("set() persists a custom entry and updates current mode", () => {
		const { pi, appended } = fakePi();
		const state = new ModeState(pi, "agent");
		const changed = state.set("plan");
		expect(changed).toBe(true);
		expect(state.current).toBe("plan");
		expect(appended).toEqual([{ customType: MODE_ENTRY_TYPE, data: { mode: "plan" } }]);
	});

	it("set() is a no-op (and does not persist) when mode is unchanged", () => {
		const { pi, appended } = fakePi();
		const state = new ModeState(pi, "agent");
		const changed = state.set("agent");
		expect(changed).toBe(false);
		expect(appended).toEqual([]);
	});

	it("set(mode, persist=false) updates in-memory state without appending an entry", () => {
		const { pi, appended } = fakePi();
		const state = new ModeState(pi, "agent");
		state.set("debug", false);
		expect(state.current).toBe("debug");
		expect(appended).toEqual([]);
	});

	it("rejects unknown mode names", () => {
		const { pi } = fakePi();
		const state = new ModeState(pi, "agent");
		// @ts-expect-error intentionally invalid
		const changed = state.set("sleep");
		expect(changed).toBe(false);
		expect(state.current).toBe("agent");
	});

	it("cycle() advances plan -> agent -> ask -> debug -> plan", () => {
		const { pi } = fakePi();
		const state = new ModeState(pi, "plan");
		expect(state.cycle()).toBe("agent");
		expect(state.cycle()).toBe("ask");
		expect(state.cycle()).toBe("debug");
		expect(state.cycle()).toBe("plan");
	});

	it("rehydrate() restores the last persisted mode from the branch", () => {
		const { pi } = fakePi();
		const state = new ModeState(pi, "agent");
		const restored = state.rehydrate(branchWithModes("plan", "debug", "ask"), "agent");
		expect(restored).toBe(true);
		expect(state.current).toBe("ask");
	});

	it("rehydrate() falls back to the given default when no mode entries exist", () => {
		const { pi } = fakePi();
		const state = new ModeState(pi, "agent");
		const restored = state.rehydrate({ getBranch: () => [] }, "debug");
		expect(restored).toBe(false);
		expect(state.current).toBe("debug");
	});

	it("rehydrate() ignores malformed mode entries", () => {
		const { pi } = fakePi();
		const state = new ModeState(pi, "agent");
		const branch: BranchSource = {
			getBranch: () =>
				[
					{
						type: "custom",
						id: "e1",
						timestamp: 0,
						customType: MODE_ENTRY_TYPE,
						data: { mode: "not-a-real-mode" },
					},
				] as any,
		};
		const restored = state.rehydrate(branch, "ask");
		expect(restored).toBe(false);
		expect(state.current).toBe("ask");
	});
});
