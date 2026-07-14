import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration-style tests for extensions/model-router/index.ts's wiring —
 * the hand-assembled event/command registration that has no dedicated test
 * file of its own (every other module here does). These target the specific
 * gaps a defensive review flagged: reload() must not reset an active mode,
 * tool_result compression must preserve the built-in tool's own `details`,
 * the manual-override pin/unpin flow must actually flip, and the setup
 * wizard's write path must merge safely and honor skip/scope-trust.
 *
 * `loadConfig` and `globalConfigPath` are mocked so these tests never touch
 * a real ~/.pi/agent/model-router.json on the machine running them; every
 * other config.ts export is passed through untouched via importActual.
 */
const loadConfigMock = vi.fn();
const globalConfigPathMock = vi.fn();
vi.mock("../extensions/model-router/config.ts", async () => {
	const actual = await vi.importActual<typeof import("../extensions/model-router/config.ts")>(
		"../extensions/model-router/config.ts",
	);
	return {
		...actual,
		loadConfig: (...args: unknown[]) => loadConfigMock(...args),
		globalConfigPath: () => globalConfigPathMock(),
	};
});

const completeSimpleMock = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({
	completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
}));

/**
 * Only SettingsManager is faked here (no file I/O in tests); every other
 * export — including the real, un-mocked resolveModelScopeWithDiagnostics,
 * which only touches the ctx.modelRegistry passed to it — comes through
 * untouched via importActual.
 */
const settingsManagerMock = { getEnabledModels: vi.fn().mockReturnValue(undefined) };
vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
	return {
		...actual,
		SettingsManager: { create: () => settingsManagerMock },
	};
});

const routerExtension = (await import("../extensions/model-router/index.ts")).default;

const BASE_CONFIG = {
	roles: {
		planner: { model: "test/planner-model", thinking: "high" as const },
		validator: { model: "skip", thinking: "medium" as const },
		executor: { model: "test/executor-model", thinking: "medium" as const },
		toolParser: { model: "test/toolparser-model", thinking: "off" as const },
	},
	fallbacks: {},
	routing: { classifier: "toolParser" as const, trivialBypass: true, toolOutputParseThreshold: 10 },
	modes: { default: "agent" as const },
	subagents: { enabled: true, maxParallel: 4, timeoutMs: 600000 },
};

const FAKE_MODELS = [
	{ provider: "test", id: "planner-model", api: "anthropic-messages" },
	{ provider: "test", id: "executor-model", api: "anthropic-messages" },
	{ provider: "test", id: "toolparser-model", api: "anthropic-messages" },
	{ provider: "test", id: "validator-model", api: "anthropic-messages" },
] as const;

/** Captures every pi.on()/registerCommand() registration so tests can invoke handlers directly. */
function createFakePi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => unknown>();
	const completions = new Map<string, (prefix: string) => unknown>();
	const pi = {
		on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		}),
		registerCommand: vi.fn(
			(
				name: string,
				opts: {
					handler: (args: string, ctx: ExtensionCommandContext) => unknown;
					getArgumentCompletions?: (prefix: string) => unknown;
				},
			) => {
				commands.set(name, opts.handler);
				if (opts.getArgumentCompletions) completions.set(name, opts.getArgumentCompletions);
			},
		),
		registerFlag: vi.fn(),
		registerShortcut: vi.fn(),
		registerTool: vi.fn(),
		getFlag: vi.fn().mockReturnValue(undefined),
		setModel: vi.fn().mockResolvedValue(true),
		setThinkingLevel: vi.fn(),
		appendEntry: vi.fn(),
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, completions };
}

function createFakeCtx(): ExtensionContext {
	return {
		cwd: "/tmp/model-router-test-project",
		isProjectTrusted: () => true,
		hasUI: true,
		signal: undefined,
		modelRegistry: {
			getAll: () => FAKE_MODELS,
			getAvailable: () => FAKE_MODELS,
			hasConfiguredAuth: () => true,
			find: (provider: string, id: string) => FAKE_MODELS.find((m) => m.provider === provider && m.id === id),
			getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-test", headers: {}, env: {} }),
		},
		ui: {
			notify: vi.fn(),
			select: vi.fn(),
			input: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
		},
		sessionManager: { getBranch: () => [] },
	} as unknown as ExtensionContext;
}

/** Wires the extension against a fresh fake pi/ctx and runs session_start once, as pi itself would on load. */
async function bootstrap() {
	const { pi, handlers, commands, completions } = createFakePi();
	routerExtension(pi);
	const ctx = createFakeCtx();
	await handlers.get("session_start")!({ type: "session_start", reason: "new" }, ctx);
	return { handlers, commands, completions, ctx };
}

beforeEach(() => {
	loadConfigMock.mockReset();
	loadConfigMock.mockReturnValue({ config: structuredClone(BASE_CONFIG), warnings: [] });
	completeSimpleMock.mockReset();
	// Default to a definitely-nonexistent path so session_start's first-run-hint
	// check (fs.existsSync(globalConfigPath())) always gets a real string; tests
	// that actually exercise the write path override this to a real temp file.
	globalConfigPathMock.mockReset();
	globalConfigPathMock.mockReturnValue(path.join(os.tmpdir(), "model-router-test-nonexistent", "global.json"));
	settingsManagerMock.getEnabledModels.mockReset();
	settingsManagerMock.getEnabledModels.mockReturnValue(undefined);
});

describe("reload() mode preservation", () => {
	it("does not reset the active mode back to the config default", async () => {
		const { handlers, commands, ctx } = await bootstrap();

		await commands.get("mode")!("debug", ctx as ExtensionCommandContext);
		(ctx.ui.notify as ReturnType<typeof vi.fn>).mockClear();

		// Previously, reload() called modeState.set(cfg.modes.default), silently
		// resetting "debug" back to "agent" (BASE_CONFIG.modes.default).
		await commands.get("router")!("reload", ctx as ExtensionCommandContext);

		await commands.get("mode")!("", ctx as ExtensionCommandContext);
		const lastNotify = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1);
		expect(lastNotify?.[0]).toContain("debug");

		void handlers; // handlers map unused in this test beyond bootstrap
	});
});

describe("tool_result compression preserves built-in tool details", () => {
	it("spreads the original event.details under the compression's own fields", async () => {
		const { handlers, ctx } = await bootstrap();

		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "short summary" }],
			stopReason: "stop",
			usage: {},
			api: "anthropic-messages",
			provider: "test",
			model: "toolparser-model",
			timestamp: Date.now(),
		});

		const longOutput = "x".repeat(500); // well over the configured 10-byte threshold
		const result = await handlers.get("tool_result")!(
			{
				type: "tool_result",
				toolCallId: "call-1",
				toolName: "bash",
				input: { command: "echo hi" },
				content: [{ type: "text", text: longOutput }],
				isError: false,
				details: { truncation: undefined, fullOutputPath: "/tmp/original-output.log" },
			},
			ctx,
		);

		expect(result).toBeDefined();
		const details = (result as { details: Record<string, unknown> }).details;
		// The built-in bash tool's own detail field must survive the compression rewrite.
		expect(details.fullOutputPath).toBe("/tmp/original-output.log");
		// Alongside our own compression bookkeeping fields.
		expect(details.originalBytes).toBe(500);
		expect(typeof details.compressedBytes).toBe("number");
		expect(details.original).toBe(longOutput);
	});
});

describe("manual override pin/unpin flow", () => {
	it("pins on a manual model_select, ignores restore, and unpins via /router auto", async () => {
		const { handlers, commands, ctx } = await bootstrap();

		// A session-restore model_select must never count as a manual override.
		await handlers.get("model_select")!(
			{ type: "model_select", model: FAKE_MODELS[0], previousModel: undefined, source: "restore" },
			ctx,
		);
		expect((ctx.ui.setStatus as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).not.toContain("pinned");

		// A real user-driven model_select ("set") pins auto-routing off.
		await handlers.get("model_select")!(
			{ type: "model_select", model: FAKE_MODELS[1], previousModel: FAKE_MODELS[0], source: "set" },
			ctx,
		);
		expect((ctx.ui.setStatus as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toContain("pinned");
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toContain("manual model change detected");

		// /router auto lifts the pin.
		await commands.get("router")!("auto", ctx as ExtensionCommandContext);
		expect((ctx.ui.setStatus as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).not.toContain("pinned");

		// And routing is detectable as manual again afterward (proves state actually reset, not just the notification).
		(ctx.ui.notify as ReturnType<typeof vi.fn>).mockClear();
		await handlers.get("model_select")!(
			{ type: "model_select", model: FAKE_MODELS[0], previousModel: FAKE_MODELS[1], source: "set" },
			ctx,
		);
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toContain("manual model change detected");
	});
});

describe("/router config wizard write path", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-wizard-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("merges into existing global config, honors skip-as-primary-spec, and respects global scope choice", async () => {
		const globalFile = path.join(tmpDir, "global.json");
		globalConfigPathMock.mockReturnValue(globalFile);
		fs.writeFileSync(
			globalFile,
			JSON.stringify({
				roles: { executor: { model: "pre-existing/model", thinking: "low" } },
				unrelatedTopLevelKey: "preserve-me",
			}),
		);

		const { commands, ctx } = await bootstrap();

		// Script the wizard's prompts by matching on substrings of the title/options
		// rather than exact copy, so the test doesn't break on wording tweaks.
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async (title: string, options: string[]) => {
			if (title.includes("Which role")) return "validator";
			if (title.startsWith("Model for")) return options.find((o) => o.includes("Skip this role"));
			if (title.includes("scope")) return options.find((o) => o.includes("Global"));
			throw new Error(`unscripted select prompt: "${title}" (options: ${options.join(" | ")})`);
		});

		await commands.get("router")!("config", ctx as ExtensionCommandContext);

		const written = JSON.parse(fs.readFileSync(globalFile, "utf-8"));
		// Untouched top-level key and untouched sibling role both survive the merge.
		expect(written.unrelatedTopLevelKey).toBe("preserve-me");
		expect(written.roles.executor).toEqual({ model: "pre-existing/model", thinking: "low" });
		// The newly-configured role was written with "skip" as a primary spec (no fallbacks dance needed).
		expect(written.roles.validator).toEqual({ model: "skip", thinking: "off" });
	});

	it("only offers project scope when the project is trusted", async () => {
		globalConfigPathMock.mockReturnValue(path.join(tmpDir, "global.json"));
		const { commands, ctx } = await bootstrap();
		ctx.isProjectTrusted = vi.fn().mockReturnValue(false);

		(ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async (title: string, options: string[]) => {
			if (title.includes("Which role")) return "toolParser";
			if (title.startsWith("Model for")) return options.find((o) => o.includes("Skip this role"));
			// selectScope must not even prompt when the project isn't trusted — it should
			// go straight to global. If it does prompt, fail loudly instead of silently picking one.
			throw new Error(`unexpected select prompt when project is untrusted: "${title}"`);
		});

		await commands.get("router")!("config", ctx as ExtensionCommandContext);
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toContain(path.join(tmpDir, "global.json"));
	});

	it("surfaces the current session model first, marked, in the role picker", async () => {
		globalConfigPathMock.mockReturnValue(path.join(tmpDir, "global.json"));
		const { commands, ctx } = await bootstrap();
		(ctx as unknown as { model: (typeof FAKE_MODELS)[number] }).model = FAKE_MODELS[3]; // "test/validator-model"

		let seenOptions: string[] = [];
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async (title: string, options: string[]) => {
			if (title.includes("Which role")) return "validator";
			if (title.startsWith("Model for")) {
				seenOptions = options;
				return options.find((o) => o.includes("Skip this role"));
			}
			if (title.includes("scope")) return options.find((o) => o.includes("Global"));
			throw new Error(`unscripted select prompt: "${title}"`);
		});

		await commands.get("router")!("config", ctx as ExtensionCommandContext);

		// Index 0 is "Keep current"; index 1 is the first model option and must be
		// the session's active model, marked with the "▶" current-session marker.
		expect(seenOptions[1]).toContain("▶");
		expect(seenOptions[1]).toContain("test/validator-model");
	});

	it("filters the role picker down to the pi model scope when one is configured", async () => {
		globalConfigPathMock.mockReturnValue(path.join(tmpDir, "global.json"));
		settingsManagerMock.getEnabledModels.mockReturnValue(["test/planner-model", "test/executor-model"]);
		const { commands, ctx } = await bootstrap();

		let seenOptions: string[] = [];
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async (title: string, options: string[]) => {
			if (title.includes("Which role")) return "validator";
			if (title.startsWith("Model for")) {
				seenOptions = options;
				return options.find((o) => o.includes("Skip this role"));
			}
			if (title.includes("scope")) return options.find((o) => o.includes("Global"));
			throw new Error(`unscripted select prompt: "${title}"`);
		});

		await commands.get("router")!("config", ctx as ExtensionCommandContext);

		const modelOptions = seenOptions.filter((o) => o.includes("test/"));
		expect(modelOptions).toHaveLength(2);
		expect(modelOptions.some((o) => o.includes("test/planner-model"))).toBe(true);
		expect(modelOptions.some((o) => o.includes("test/executor-model"))).toBe(true);
		expect(modelOptions.some((o) => o.includes("test/toolparser-model"))).toBe(false);
		expect(modelOptions.some((o) => o.includes("test/validator-model"))).toBe(false);

		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes("Showing your pi model scope (2 models)"))).toBe(
			true,
		);
	});

	it("falls back to the full registry when no pi model scope is configured", async () => {
		globalConfigPathMock.mockReturnValue(path.join(tmpDir, "global.json"));
		settingsManagerMock.getEnabledModels.mockReturnValue(undefined);
		const { commands, ctx } = await bootstrap();

		let seenOptions: string[] = [];
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async (title: string, options: string[]) => {
			if (title.includes("Which role")) return "validator";
			if (title.startsWith("Model for")) {
				seenOptions = options;
				return options.find((o) => o.includes("Skip this role"));
			}
			if (title.includes("scope")) return options.find((o) => o.includes("Global"));
			throw new Error(`unscripted select prompt: "${title}"`);
		});

		await commands.get("router")!("config", ctx as ExtensionCommandContext);

		const modelOptions = seenOptions.filter((o) => o.includes("test/"));
		expect(modelOptions).toHaveLength(FAKE_MODELS.length);
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes("No pi model scope configured"))).toBe(true);
	});
});

describe("Phase 2 escalation: consecutive tool failures", () => {
	function fireToolResult(handlers: Awaited<ReturnType<typeof bootstrap>>["handlers"], ctx: ExtensionContext, isError: boolean) {
		return handlers.get("tool_result")!(
			{ type: "tool_result", toolCallId: "t", toolName: "bash", input: {}, content: [{ type: "text", text: "x" }], isError },
			ctx,
		);
	}

	it("escalates the pinned tier after 3 consecutive tool failures in agent mode, and resets on success", async () => {
		const { handlers, ctx } = await bootstrap(); // default mode is "agent"
		const escalationCalls = () =>
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes("escalating pinned tier"));

		await fireToolResult(handlers, ctx, true);
		await fireToolResult(handlers, ctx, true);
		expect(escalationCalls()).toHaveLength(0); // only 2 so far — threshold is 3

		await fireToolResult(handlers, ctx, true);
		expect(escalationCalls()).toHaveLength(1);
		expect(escalationCalls()[0]?.[0]).toContain('escalating pinned tier to "simple"'); // trivial -> simple, one notch up

		// A success resets the counter; 2 more failures alone must not re-trigger.
		await fireToolResult(handlers, ctx, false);
		await fireToolResult(handlers, ctx, true);
		await fireToolResult(handlers, ctx, true);
		expect(escalationCalls()).toHaveLength(1); // unchanged — still just the one escalation from before
	});

	it("does not track tool failures outside agent/debug mode", async () => {
		const { handlers, commands, ctx } = await bootstrap();
		await commands.get("mode")!("ask", ctx as ExtensionCommandContext);
		(ctx.ui.notify as ReturnType<typeof vi.fn>).mockClear();

		for (let i = 0; i < 5; i++) await fireToolResult(handlers, ctx, true);

		expect(
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes("escalating pinned tier")),
		).toBe(false);
	});
});

describe("Phase 2 escalation: validator rejections maxed out", () => {
	/** Scripts completeSimple (the real structuredCall's transport) by inspecting which tool was force-offered. */
	function scriptStructuredCalls(responses: Record<string, unknown>) {
		completeSimpleMock.mockImplementation(async (_model: unknown, context: { tools?: Array<{ name: string }> }) => {
			const toolName = context.tools?.[0]?.name;
			const value = toolName ? responses[toolName] : undefined;
			return {
				role: "assistant",
				content: value ? [{ type: "toolCall", id: "tc1", name: toolName, arguments: value }] : [],
				stopReason: "stop",
				usage: {},
				api: "anthropic-messages",
				provider: "test",
				model: "x",
				timestamp: Date.now(),
			};
		});
	}

	it("escalates the pinned tier one notch above this turn's classified tier when the validator never approves", async () => {
		loadConfigMock.mockReturnValue({
			config: {
				...structuredClone(BASE_CONFIG),
				roles: { ...BASE_CONFIG.roles, validator: { model: "test/validator-model", thinking: "medium" } },
			},
			warnings: [],
		});
		const { handlers, commands, ctx } = await bootstrap(); // re-bootstraps with the validator-enabled config above

		scriptStructuredCalls({
			emit_classification: { complexity: "standard", needsPlan: true, reason: "x" },
			emit_plan: { summary: "s", steps: ["a"] },
			emit_validation: { verdict: "revise", notes: "still not good enough" }, // never approves
		});

		await handlers.get("before_agent_start")!(
			{ type: "before_agent_start", prompt: "do something", systemPrompt: "base", images: undefined, systemPromptOptions: {} },
			ctx,
		);

		const notifyMessages = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
		// The regular per-turn summary proves the revision loop actually maxed out...
		expect(notifyMessages.some((m) => m.includes("[revise, 2 revision(s)]"))).toBe(true);
		// ...and escalation notifies directly too, same as the tool-failure path.
		// Normal ratchet pins "standard" (this turn's classification); the escalation
		// then bumps one notch above whatever's pinned, landing on "complex".
		expect(notifyMessages.some((m) => m.includes('escalating pinned tier to "complex"'))).toBe(true);

		// The escalation note also landed in this turn's trace, visible via /router last.
		(ctx.ui.notify as ReturnType<typeof vi.fn>).mockClear();
		await commands.get("router")!("last", ctx as ExtensionCommandContext);
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toContain(
			'validator rejections maxed out — escalating pinned tier to "complex"',
		);
	});
});

describe("/router discoverability", () => {
	it("getArgumentCompletions lists subcommands filtered by prefix", async () => {
		const { completions } = await bootstrap();
		const getCompletions = completions.get("router")!;

		const all = (await getCompletions("")) as { value: string }[];
		expect(all.map((c) => c.value)).toContain("setup");
		expect(all.map((c) => c.value)).toContain("help");

		const filtered = (await getCompletions("tr")) as { value: string }[];
		expect(filtered.map((c) => c.value).sort()).toEqual(["trace", "trace off", "trace on"]);
	});

	it('"/router help" prints the subcommand list', async () => {
		const { commands, ctx } = await bootstrap();
		await commands.get("router")!("help", ctx as ExtensionCommandContext);
		const lastNotify = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
		expect(lastNotify).toContain("/router subcommands:");
		expect(lastNotify).toContain("setup");
	});

	it("warns on an unknown subcommand instead of silently showing the dashboard", async () => {
		const { commands, ctx } = await bootstrap();
		await commands.get("router")!("bogus", ctx as ExtensionCommandContext);
		const lastNotify = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
		expect(lastNotify).toContain('Unknown /router subcommand "bogus"');
	});

	it("the no-arg dashboard still renders and points at /router help", async () => {
		const { commands, ctx } = await bootstrap();
		await commands.get("router")!("", ctx as ExtensionCommandContext);
		const lastNotify = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
		expect(lastNotify).toContain("roles:");
		expect(lastNotify).toContain("/router help");
	});
});
