import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Complexity,
	COMPLEXITY_LEVELS,
	MODE_NAMES,
	type ModeName,
	type RoleConfig,
	ROLE_NAMES,
	type RoleName,
	type RouterConfig,
	type RoutingConfig,
} from "./types.ts";

export const CONFIG_FILENAME = "model-router.json";

export const VALID_THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Default configuration. Quality-first: every role gets the model + effort that
 * produces the best result for its phase. Model specs use "*" wildcards so they
 * survive model renames (e.g. a new Opus/Sonnet/Haiku/Fable point release).
 */
export const DEFAULT_CONFIG: RouterConfig = {
	roles: {
		planner: { model: "anthropic/claude-opus-*", thinking: "high" },
		validator: { model: "anthropic/claude-fable-*", thinking: "medium" },
		executor: { model: "anthropic/claude-sonnet-*", thinking: "medium" },
		toolParser: { model: "anthropic/claude-haiku-*", thinking: "off" },
	},
	fallbacks: {
		planner: ["anthropic/claude-sonnet-*"],
		validator: ["skip"],
		executor: ["anthropic/claude-opus-*"],
		toolParser: ["anthropic/claude-sonnet-*"],
	},
	routing: {
		classifier: "toolParser",
		trivialBypass: true,
		toolOutputParseThreshold: 4096,
	},
	modes: { default: "agent" },
	subagents: { enabled: true, maxParallel: 4, timeoutMs: 10 * 60 * 1000 },
};

/**
 * Named config presets, selectable via `--router-preset <name>`. Applied
 * between DEFAULT_CONFIG and the global/project config files (deep-merged
 * the same way), so a user's own config file always wins over a preset —
 * presets are a convenient starting point, not a hard override.
 */
export const PRESETS: Record<string, Partial<RouterConfig>> = {
	default: {},
	"max-quality": {
		roles: {
			planner: { model: "anthropic/claude-opus-*", thinking: "xhigh" },
			validator: { model: "anthropic/claude-opus-*", thinking: "high" },
			executor: { model: "anthropic/claude-opus-*", thinking: "high" },
			toolParser: { model: "anthropic/claude-haiku-*", thinking: "off" },
		},
		fallbacks: {
			planner: ["anthropic/claude-sonnet-*"],
			validator: ["anthropic/claude-sonnet-*"],
			executor: ["anthropic/claude-sonnet-*"],
		},
	},
	"all-local": {
		roles: {
			planner: { model: "ollama/*", thinking: "high" },
			validator: { model: "ollama/*", thinking: "medium" },
			executor: { model: "ollama/*", thinking: "medium" },
			toolParser: { model: "ollama/*", thinking: "off" },
		},
		fallbacks: {
			planner: ["skip"],
			validator: ["skip"],
			toolParser: ["skip"],
		},
	},
};

export const PRESET_NAMES = Object.keys(PRESETS);

export interface LoadedConfig {
	config: RouterConfig;
	/** Human-readable notes about what was loaded / any validation problems. */
	warnings: string[];
	sources: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge source onto target (source wins). Arrays are replaced, not concatenated. */
function deepMerge<T>(target: T, source: unknown): T {
	if (!isObject(source)) return target;
	const out: Record<string, unknown> = isObject(target) ? { ...target } : {};
	for (const [key, val] of Object.entries(source)) {
		if (isObject(val) && isObject(out[key])) {
			out[key] = deepMerge(out[key], val);
		} else {
			out[key] = val;
		}
	}
	return out as T;
}

function readJsonIfExists(file: string, warnings: string[]): unknown | undefined {
	if (!fs.existsSync(file)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (err) {
		warnings.push(`Ignored invalid config at ${file}: ${(err as Error).message}`);
		return undefined;
	}
}

/**
 * Validate the opt-in `routing.tiers` block, dropping (with a warning) any tier
 * key, role key, or role value that doesn't fit the shape — rather than
 * discarding the whole block over one bad entry elsewhere in it.
 */
function validateTiers(raw: unknown, warnings: string[]): RoutingConfig["tiers"] | undefined {
	if (raw === undefined) return undefined;
	if (!isObject(raw)) {
		warnings.push("routing.tiers must be an object; ignoring.");
		return undefined;
	}

	const out: NonNullable<RoutingConfig["tiers"]> = {};
	for (const [tierKey, tierVal] of Object.entries(raw)) {
		if (!COMPLEXITY_LEVELS.includes(tierKey as Complexity)) {
			warnings.push(`routing.tiers has unknown tier "${tierKey}" (expected one of ${COMPLEXITY_LEVELS.join(", ")}); ignoring.`);
			continue;
		}
		if (!isObject(tierVal)) {
			warnings.push(`routing.tiers.${tierKey} must be an object; ignoring.`);
			continue;
		}

		const roleOverrides: Partial<Record<RoleName, RoleConfig | "skip">> = {};
		for (const [roleKey, roleVal] of Object.entries(tierVal)) {
			if (!ROLE_NAMES.includes(roleKey as RoleName)) {
				warnings.push(`routing.tiers.${tierKey} has unknown role "${roleKey}"; ignoring.`);
				continue;
			}
			if (roleVal === "skip") {
				roleOverrides[roleKey as RoleName] = "skip";
				continue;
			}
			if (
				isObject(roleVal) &&
				typeof roleVal.model === "string" &&
				roleVal.model.trim() !== "" &&
				VALID_THINKING.includes(roleVal.thinking as ThinkingLevel)
			) {
				roleOverrides[roleKey as RoleName] = { model: roleVal.model, thinking: roleVal.thinking as ThinkingLevel };
				continue;
			}
			warnings.push(`routing.tiers.${tierKey}.${roleKey} is invalid (must be "skip" or {model, thinking}); ignoring.`);
		}

		if (Object.keys(roleOverrides).length > 0) out[tierKey as Complexity] = roleOverrides;
	}

	return Object.keys(out).length > 0 ? out : undefined;
}

/** Clamp/repair a merged config into a valid RouterConfig, collecting warnings. */
function validate(raw: RouterConfig, warnings: string[]): RouterConfig {
	const cfg = raw;

	for (const role of ROLE_NAMES) {
		if (!cfg.roles[role]) {
			warnings.push(`Role "${role}" is missing; using default.`);
			cfg.roles[role] = structuredClone(DEFAULT_CONFIG.roles[role]);
			continue;
		}
		const rc = cfg.roles[role];
		// Repair each field independently so a bad `model` doesn't discard a valid `thinking` override.
		if (typeof rc.model !== "string" || rc.model.trim() === "") {
			warnings.push(`Role "${role}" has no model; using default model "${DEFAULT_CONFIG.roles[role].model}".`);
			rc.model = DEFAULT_CONFIG.roles[role].model;
		}
		if (!VALID_THINKING.includes(rc.thinking)) {
			warnings.push(
				`Role "${role}" thinking "${String(rc.thinking)}" is invalid; using "${DEFAULT_CONFIG.roles[role].thinking}".`,
			);
			rc.thinking = DEFAULT_CONFIG.roles[role].thinking;
		}
	}

	const classifier = cfg.routing?.classifier;
	if (!ROLE_NAMES.includes(classifier as RoleName)) {
		warnings.push(`routing.classifier "${String(classifier)}" invalid; using "toolParser".`);
		cfg.routing.classifier = "toolParser";
	}
	if (typeof cfg.routing.toolOutputParseThreshold !== "number" || cfg.routing.toolOutputParseThreshold < 0) {
		cfg.routing.toolOutputParseThreshold = DEFAULT_CONFIG.routing.toolOutputParseThreshold;
	}
	cfg.routing.trivialBypass = cfg.routing.trivialBypass !== false;
	cfg.routing.tiers = validateTiers(cfg.routing.tiers, warnings);

	const defMode = cfg.modes?.default;
	if (!MODE_NAMES.includes(defMode as ModeName)) {
		warnings.push(`modes.default "${String(defMode)}" invalid; using "agent".`);
		cfg.modes = { default: "agent" };
	}

	if (!cfg.subagents || typeof cfg.subagents.maxParallel !== "number" || cfg.subagents.maxParallel < 1) {
		cfg.subagents = { ...DEFAULT_CONFIG.subagents, ...(cfg.subagents ?? {}) };
		if (cfg.subagents.maxParallel < 1) cfg.subagents.maxParallel = 1;
	}
	if (typeof cfg.subagents.timeoutMs !== "number" || !Number.isFinite(cfg.subagents.timeoutMs) || cfg.subagents.timeoutMs < 1000) {
		warnings.push(
			`subagents.timeoutMs "${String(cfg.subagents.timeoutMs)}" invalid (must be a number >= 1000); using ${DEFAULT_CONFIG.subagents.timeoutMs}.`,
		);
		cfg.subagents.timeoutMs = DEFAULT_CONFIG.subagents.timeoutMs;
	}

	return cfg;
}

export interface LoadConfigPaths {
	/** Override for the global config file path (defaults to `${getAgentDir()}/model-router.json`). Test hook. */
	globalFile?: string;
	/** Override for the project config file path (defaults to `${cwd}/.pi/model-router.json`). Test hook. */
	projectFile?: string;
}

/**
 * Load config by merging: DEFAULT_CONFIG < global (~/.pi/agent/model-router.json)
 * < project (<cwd>/.pi/model-router.json). Project config is only applied when the
 * project is trusted.
 */
export function loadConfig(
	cwd: string,
	projectTrusted: boolean,
	paths: LoadConfigPaths = {},
	presetName?: string,
): LoadedConfig {
	const warnings: string[] = [];
	const sources: string[] = ["defaults"];

	const globalFile = paths.globalFile ?? path.join(getAgentDir(), CONFIG_FILENAME);
	const projectFile = paths.projectFile ?? path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);

	let merged: RouterConfig = structuredClone(DEFAULT_CONFIG);

	if (presetName && presetName !== "default") {
		const preset = PRESETS[presetName];
		if (preset) {
			merged = deepMerge(merged, preset);
			sources.push(`preset:${presetName}`);
		} else {
			warnings.push(`Unknown --router-preset "${presetName}" (known: ${PRESET_NAMES.join(", ")}); ignoring.`);
		}
	}

	const globalRaw = readJsonIfExists(globalFile, warnings);
	if (globalRaw) {
		merged = deepMerge(merged, globalRaw);
		sources.push(globalFile);
	}

	if (projectTrusted) {
		const projectRaw = readJsonIfExists(projectFile, warnings);
		if (projectRaw) {
			merged = deepMerge(merged, projectRaw);
			sources.push(projectFile);
		}
	} else if (fs.existsSync(projectFile)) {
		warnings.push(`Project config ${projectFile} ignored (project not trusted).`);
	}

	const config = validate(merged, warnings);
	return { config, warnings, sources };
}

/** Path where `/router config` would write user-scoped settings. */
export function globalConfigPath(): string {
	return path.join(getAgentDir(), CONFIG_FILENAME);
}
