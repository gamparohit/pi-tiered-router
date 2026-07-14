import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedRole } from "../extensions/model-router/types.ts";

const completeSimpleMock = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({
	completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
}));

const { shouldCompress, compressToolOutput, byteLength, estimateTokens, summaryLine } = await import(
	"../extensions/model-router/toolparse.ts"
);

function fakeCtx(authOk = true): ExtensionContext {
	return {
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn().mockResolvedValue(
				authOk ? { ok: true, apiKey: "sk-test", headers: {}, env: {} } : { ok: false, error: "no auth" },
			),
		},
	} as unknown as ExtensionContext;
}

function toolParserRole(overrides: Partial<ResolvedRole> = {}): ResolvedRole {
	return {
		role: "toolParser",
		model: { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" } as never,
		thinking: "off",
		requested: "anthropic/claude-haiku-*",
		resolvedId: "anthropic/claude-haiku-4-5",
		viaFallback: false,
		skipped: false,
		...overrides,
	};
}

function assistantText(text: string): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: {},
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		timestamp: Date.now(),
	};
}

beforeEach(() => {
	completeSimpleMock.mockReset();
});

describe("shouldCompress", () => {
	const THRESHOLD = 4096;

	it("does not compress when output is under the threshold", () => {
		expect(shouldCompress("bash", THRESHOLD - 1, false, THRESHOLD)).toBe(false);
	});

	it("does not compress when output is exactly at the threshold (boundary)", () => {
		expect(shouldCompress("bash", THRESHOLD, false, THRESHOLD)).toBe(false);
	});

	it("compresses when output is one byte over the threshold", () => {
		expect(shouldCompress("bash", THRESHOLD + 1, false, THRESHOLD)).toBe(true);
	});

	it("does not compress tools outside the bash/grep-like allowlist", () => {
		expect(shouldCompress("read", THRESHOLD * 10, false, THRESHOLD)).toBe(false);
		expect(shouldCompress("edit", THRESHOLD * 10, false, THRESHOLD)).toBe(false);
		expect(shouldCompress("write", THRESHOLD * 10, false, THRESHOLD)).toBe(false);
	});

	it("compresses grep/find/ls outputs too when large enough", () => {
		expect(shouldCompress("grep", THRESHOLD + 1, false, THRESHOLD)).toBe(true);
		expect(shouldCompress("find", THRESHOLD + 1, false, THRESHOLD)).toBe(true);
		expect(shouldCompress("ls", THRESHOLD + 1, false, THRESHOLD)).toBe(true);
	});

	it("never compresses short/medium failing (isError) output, even above the plain threshold", () => {
		expect(shouldCompress("bash", THRESHOLD + 1, true, THRESHOLD)).toBe(false);
		expect(shouldCompress("bash", THRESHOLD * 4, true, THRESHOLD)).toBe(false);
	});

	it("compresses error output once it clears the higher error-specific bar", () => {
		expect(shouldCompress("bash", THRESHOLD * 4 + 1, true, THRESHOLD)).toBe(true);
	});

	it("disables compression entirely for a non-positive threshold", () => {
		expect(shouldCompress("bash", 1_000_000, false, 0)).toBe(false);
		expect(shouldCompress("bash", 1_000_000, false, -1)).toBe(false);
	});

	it("disables compression for a non-finite threshold", () => {
		expect(shouldCompress("bash", 1_000_000, false, Number.NaN)).toBe(false);
	});
});

describe("byteLength / estimateTokens", () => {
	it("measures UTF-8 byte length, not JS string length, for multi-byte characters", () => {
		expect(byteLength("abc")).toBe(3);
		expect(byteLength("café")).toBe(5); // "é" is 2 bytes in UTF-8
	});

	it("estimates roughly 4 bytes per token", () => {
		expect(estimateTokens(4000)).toBe(1000);
		expect(estimateTokens(0)).toBe(0);
	});
});

describe("summaryLine", () => {
	it("renders a human-readable KB summary with tokens saved", () => {
		const line = summaryLine({ originalBytes: 49152, compressedBytes: 1229, savedTokens: 11983 });
		expect(line).toContain("48.0KB");
		expect(line).toContain("1.2KB");
		expect(line).toContain("11983");
	});

	it("renders bytes under 1KB without a KB suffix", () => {
		const line = summaryLine({ originalBytes: 900, compressedBytes: 100, savedTokens: 200 });
		expect(line).toContain("900B");
		expect(line).toContain("100B");
	});
});

describe("compressToolOutput", () => {
	const baseParams = {
		toolName: "bash",
		commandSummary: "npm test",
		output: "x".repeat(5000),
		currentStepContext: "fix the failing auth test",
	};

	it("compresses successfully via the toolParser role", async () => {
		completeSimpleMock.mockResolvedValue(assistantText("Test failed: auth.test.ts:42 expected true got false"));
		const result = await compressToolOutput(fakeCtx(), toolParserRole(), baseParams);

		expect(result.compressed).toBe("Test failed: auth.test.ts:42 expected true got false");
		expect(result.originalBytes).toBe(5000);
		expect(result.compressedBytes).toBeLessThan(result.originalBytes);
		expect(result.savedTokens).toBeGreaterThan(0);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("sends the current step context and preserve-verbatim instructions in the system prompt", async () => {
		completeSimpleMock.mockResolvedValue(assistantText("summary"));
		await compressToolOutput(fakeCtx(), toolParserRole(), baseParams);
		const [, context] = completeSimpleMock.mock.calls[0]! as [unknown, { systemPrompt: string }];
		expect(context.systemPrompt).toContain("fix the failing auth test");
		expect(context.systemPrompt).toContain("Preserve error messages, paths, and line numbers verbatim");
	});

	it("falls back to the original output, unmodified, when the role is skipped", async () => {
		const result = await compressToolOutput(fakeCtx(), toolParserRole({ skipped: true, model: undefined }), baseParams);
		expect(result.compressed).toBe(baseParams.output);
		expect(result.savedTokens).toBe(0);
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("falls back to the original output when the role is unresolved (no model)", async () => {
		const result = await compressToolOutput(fakeCtx(), toolParserRole({ model: undefined }), baseParams);
		expect(result.compressed).toBe(baseParams.output);
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("falls back to the original output when auth resolution fails", async () => {
		const result = await compressToolOutput(fakeCtx(false), toolParserRole(), baseParams);
		expect(result.compressed).toBe(baseParams.output);
	});

	it("falls back to the original output when completeSimple throws", async () => {
		completeSimpleMock.mockRejectedValue(new Error("network error"));
		const result = await compressToolOutput(fakeCtx(), toolParserRole(), baseParams);
		expect(result.compressed).toBe(baseParams.output);
		expect(result.originalBytes).toBe(result.compressedBytes);
	});

	it("falls back to the original output when the call is aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		completeSimpleMock.mockRejectedValue(new Error("aborted"));
		const result = await compressToolOutput(fakeCtx(), toolParserRole(), { ...baseParams, signal: controller.signal });
		expect(result.compressed).toBe(baseParams.output);
	});

	it("falls back to the original output when the provider returns an error stop reason", async () => {
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "rate limited",
			usage: {},
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			timestamp: Date.now(),
		});
		const result = await compressToolOutput(fakeCtx(), toolParserRole(), baseParams);
		expect(result.compressed).toBe(baseParams.output);
	});

	it("falls back to the original output when the response has no usable text content", async () => {
		completeSimpleMock.mockResolvedValue(assistantText(""));
		const result = await compressToolOutput(fakeCtx(), toolParserRole(), baseParams);
		expect(result.compressed).toBe(baseParams.output);
	});

	it("never returns a negative savedTokens value", async () => {
		// Degenerate case: "compression" that somehow grows the output.
		completeSimpleMock.mockResolvedValue(assistantText("x".repeat(50_000)));
		const result = await compressToolOutput(fakeCtx(), toolParserRole(), { ...baseParams, output: "short but over threshold".repeat(200) });
		expect(result.savedTokens).toBeGreaterThanOrEqual(0);
	});
});
