import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../extensions/model-router/config.ts";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function paths(globalJson?: unknown, projectJson?: unknown) {
	const globalFile = path.join(tmpDir, "global.json");
	const projectFile = path.join(tmpDir, "project.json");
	if (globalJson !== undefined) fs.writeFileSync(globalFile, JSON.stringify(globalJson));
	if (projectJson !== undefined) fs.writeFileSync(projectFile, JSON.stringify(projectJson));
	return { globalFile, projectFile };
}

describe("loadConfig", () => {
	it("returns defaults when no config files exist", () => {
		const { config, warnings } = loadConfig(tmpDir, true, paths());
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(warnings).toEqual([]);
	});

	it("merges global config over defaults", () => {
		const { config } = loadConfig(
			tmpDir,
			true,
			paths({ roles: { executor: { model: "openai/gpt-5", thinking: "high" } } }),
		);
		expect(config.roles.executor.model).toBe("openai/gpt-5");
		expect(config.roles.executor.thinking).toBe("high");
		// Other roles remain default (deep merge, not replace).
		expect(config.roles.planner).toEqual(DEFAULT_CONFIG.roles.planner);
	});

	it("project config wins over global config when trusted", () => {
		const { config } = loadConfig(
			tmpDir,
			true,
			paths(
				{ roles: { executor: { model: "openai/gpt-5", thinking: "high" } } },
				{ roles: { executor: { model: "google/gemini-3", thinking: "low" } } },
			),
		);
		expect(config.roles.executor.model).toBe("google/gemini-3");
	});

	it("ignores project config when the project is not trusted", () => {
		const { config, warnings } = loadConfig(
			tmpDir,
			false,
			paths(undefined, { roles: { executor: { model: "google/gemini-3", thinking: "low" } } }),
		);
		expect(config.roles.executor.model).toBe(DEFAULT_CONFIG.roles.executor.model);
		expect(warnings.some((w) => w.includes("not trusted"))).toBe(true);
	});

	it("repairs an invalid thinking level with a warning", () => {
		const { config, warnings } = loadConfig(
			tmpDir,
			true,
			paths({ roles: { executor: { model: "openai/gpt-5", thinking: "ultra-mega" } } }),
		);
		expect(config.roles.executor.thinking).toBe(DEFAULT_CONFIG.roles.executor.thinking);
		expect(warnings.some((w) => w.includes("executor"))).toBe(true);
	});

	it("backfills a partially-specified role from defaults via deep merge (no warning needed)", () => {
		// Deep merge means an override that only sets `thinking` keeps the default `model`.
		const { config, warnings } = loadConfig(tmpDir, true, paths({ roles: { planner: { thinking: "high" } } }));
		expect(config.roles.planner.model).toBe(DEFAULT_CONFIG.roles.planner.model);
		expect(config.roles.planner.thinking).toBe("high");
		expect(warnings).toEqual([]);
	});

	it("repairs an explicitly empty role model with a warning, without discarding a valid thinking override", () => {
		const { config, warnings } = loadConfig(tmpDir, true, paths({ roles: { planner: { model: "", thinking: "high" } } }));
		expect(config.roles.planner.model).toBe(DEFAULT_CONFIG.roles.planner.model);
		expect(config.roles.planner.thinking).toBe("high");
		expect(warnings.some((w) => w.includes("planner"))).toBe(true);
	});

	it("repairs an invalid routing.classifier", () => {
		const { config, warnings } = loadConfig(tmpDir, true, paths({ routing: { classifier: "nonsense" } }));
		expect(config.routing.classifier).toBe("toolParser");
		expect(warnings.some((w) => w.includes("classifier"))).toBe(true);
	});

	it("repairs an invalid routing.planGate", () => {
		const { config, warnings } = loadConfig(tmpDir, true, paths({ routing: { planGate: "sometimes" } }));
		expect(config.routing.planGate).toBe("off");
		expect(warnings.some((w) => w.includes("planGate"))).toBe(true);
	});

	it("preserves a valid routing.planGate", () => {
		const { config, warnings } = loadConfig(tmpDir, true, paths({ routing: { planGate: "replace-validator" } }));
		expect(config.routing.planGate).toBe("replace-validator");
		expect(warnings).toEqual([]);
	});

	it("repairs an invalid modes.default", () => {
		const { config, warnings } = loadConfig(tmpDir, true, paths({ modes: { default: "sleep" } }));
		expect(config.modes.default).toBe("agent");
		expect(warnings.some((w) => w.includes("modes.default"))).toBe(true);
	});

	it("clamps subagents.maxParallel to at least 1", () => {
		const { config } = loadConfig(tmpDir, true, paths({ subagents: { enabled: true, maxParallel: 0 } }));
		expect(config.subagents.maxParallel).toBeGreaterThanOrEqual(1);
	});

	it("accepts a configured subagents.timeoutMs", () => {
		const { config, warnings } = loadConfig(
			tmpDir,
			true,
			paths({ subagents: { enabled: true, maxParallel: 2, timeoutMs: 30000 } }),
		);
		expect(config.subagents.timeoutMs).toBe(30000);
		expect(warnings).toEqual([]);
	});

	it("repairs an invalid subagents.timeoutMs (too low, non-numeric, or non-finite) with a warning", () => {
		for (const bad of [500, "not-a-number", Number.POSITIVE_INFINITY]) {
			const { config, warnings } = loadConfig(
				tmpDir,
				true,
				paths({ subagents: { enabled: true, maxParallel: 2, timeoutMs: bad } }),
			);
			expect(config.subagents.timeoutMs).toBe(DEFAULT_CONFIG.subagents.timeoutMs);
			expect(warnings.some((w) => w.includes("timeoutMs"))).toBe(true);
		}
	});

	it("applies a named preset over defaults, still overridden by config files", () => {
		const { config } = loadConfig(tmpDir, true, paths(), "max-quality");
		expect(config.roles.executor.model).toBe("anthropic/claude-opus-*");
		expect(config.roles.executor.thinking).toBe("high");

		const { config: withOverride } = loadConfig(
			tmpDir,
			true,
			paths({ roles: { executor: { model: "openai/gpt-5", thinking: "low" } } }),
			"max-quality",
		);
		expect(withOverride.roles.executor.model).toBe("openai/gpt-5");
	});

	it("warns and falls back to defaults for an unknown preset name", () => {
		const { config, warnings } = loadConfig(tmpDir, true, paths(), "nonsense-preset");
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(warnings.some((w) => w.includes("nonsense-preset"))).toBe(true);
	});

	it("ignores an invalid JSON file with a warning instead of throwing", () => {
		const globalFile = path.join(tmpDir, "global.json");
		fs.writeFileSync(globalFile, "{ not valid json");
		const { config, warnings } = loadConfig(tmpDir, true, { globalFile, projectFile: path.join(tmpDir, "none.json") });
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(warnings.some((w) => w.includes("Ignored invalid config"))).toBe(true);
	});

	describe("routing.tiers", () => {
		it("is absent by default (tiering is opt-in)", () => {
			const { config, warnings } = loadConfig(tmpDir, true, paths());
			expect(config.routing.tiers).toBeUndefined();
			expect(warnings).toEqual([]);
		});

		it("accepts a well-formed tiers block with a model override and a skip", () => {
			const { config, warnings } = loadConfig(
				tmpDir,
				true,
				paths({
					routing: {
						tiers: {
							simple: {
								executor: { model: "anthropic/claude-haiku-*", thinking: "low" },
								validator: "skip",
							},
						},
					},
				}),
			);
			expect(warnings).toEqual([]);
			expect(config.routing.tiers?.simple?.executor).toEqual({ model: "anthropic/claude-haiku-*", thinking: "low" });
			expect(config.routing.tiers?.simple?.validator).toBe("skip");
		});

		it("drops an unknown tier key with a warning, keeping other valid tiers", () => {
			const { config, warnings } = loadConfig(
				tmpDir,
				true,
				paths({
					routing: {
						tiers: {
							nonsense: { executor: "skip" },
							simple: { executor: "skip" },
						},
					},
				}),
			);
			expect(Object.keys(config.routing.tiers ?? {})).not.toContain("nonsense");
			expect(config.routing.tiers?.simple?.executor).toBe("skip");
			expect(warnings.some((w) => w.includes("nonsense"))).toBe(true);
		});

		it("drops an unknown role key within a tier with a warning", () => {
			const { config, warnings } = loadConfig(
				tmpDir,
				true,
				paths({ routing: { tiers: { simple: { notARole: "skip" } } } }),
			);
			expect(config.routing.tiers).toBeUndefined(); // the tier ends up empty and is dropped too
			expect(warnings.some((w) => w.includes("notARole"))).toBe(true);
		});

		it("drops a malformed role override (bad thinking, missing model) with a warning", () => {
			const { config, warnings } = loadConfig(
				tmpDir,
				true,
				paths({ routing: { tiers: { simple: { executor: { model: "anthropic/claude-haiku-*", thinking: "ultra" } } } } }),
			);
			expect(config.routing.tiers).toBeUndefined();
			expect(warnings.some((w) => w.includes("tiers.simple.executor"))).toBe(true);
		});

		it("rejects a non-object tiers value entirely", () => {
			const { config, warnings } = loadConfig(tmpDir, true, paths({ routing: { tiers: "nonsense" } }));
			expect(config.routing.tiers).toBeUndefined();
			expect(warnings.some((w) => w.includes("routing.tiers"))).toBe(true);
		});

		it("merges a project tiers block over a global one (project wins per-tier)", () => {
			const { config } = loadConfig(
				tmpDir,
				true,
				paths(
					{ routing: { tiers: { simple: { executor: "skip" }, standard: { validator: "skip" } } } },
					{ routing: { tiers: { simple: { executor: { model: "anthropic/claude-haiku-*", thinking: "low" } } } } },
				),
			);
			expect(config.routing.tiers?.simple?.executor).toEqual({ model: "anthropic/claude-haiku-*", thinking: "low" });
			expect(config.routing.tiers?.standard?.validator).toBe("skip"); // untouched tier from global survives
		});
	});
});
