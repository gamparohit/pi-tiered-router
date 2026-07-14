import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedRole } from "../extensions/model-router/types.ts";

const completeSimpleMock = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({
	completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
}));

const { structuredCall } = await import("../extensions/model-router/structured.ts");

const schema = Type.Object({ verdict: Type.String(), count: Type.Number() });

function fakeCtx(authOk = true): ExtensionContext {
	return {
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn().mockResolvedValue(
				authOk ? { ok: true, apiKey: "sk-test", headers: {}, env: {} } : { ok: false, error: "no auth" },
			),
		},
	} as unknown as ExtensionContext;
}

function anthropicRole(overrides: Partial<ResolvedRole> = {}): ResolvedRole {
	return {
		role: "planner",
		model: { provider: "anthropic", id: "claude-opus-4-8", api: "anthropic-messages" } as never,
		thinking: "high",
		requested: "anthropic/claude-opus-*",
		resolvedId: "anthropic/claude-opus-4-8",
		viaFallback: false,
		skipped: false,
		...overrides,
	};
}

beforeEach(() => {
	completeSimpleMock.mockReset();
});

describe("structuredCall", () => {
	it("returns ok=false immediately for a skipped role, without calling completeSimple", async () => {
		const role = anthropicRole({ skipped: true, model: undefined });
		const result = await structuredCall(fakeCtx(), role, {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		expect(result.ok).toBe(false);
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("returns ok=false for an unresolved role (no model)", async () => {
		const role = anthropicRole({ model: undefined });
		const result = await structuredCall(fakeCtx(), role, {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		expect(result.ok).toBe(false);
	});

	it("returns ok=false when auth resolution fails", async () => {
		const result = await structuredCall(fakeCtx(false), anthropicRole(), {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("no auth");
	});

	it("extracts and validates a matching tool call from the response", async () => {
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "t", arguments: { verdict: "approve", count: 3 } }],
			stopReason: "toolUse",
			usage: {},
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
			timestamp: Date.now(),
		});
		const result = await structuredCall(fakeCtx(), anthropicRole(), {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual({ verdict: "approve", count: 3 });
	});

	it("forces Anthropic toolChoice for anthropic-messages models", async () => {
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "t", arguments: { verdict: "approve", count: 1 } }],
			stopReason: "toolUse",
			usage: {},
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
			timestamp: Date.now(),
		});
		await structuredCall(fakeCtx(), anthropicRole(), {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		const [, , options] = completeSimpleMock.mock.calls[0]!;
		expect(options.toolChoice).toEqual({ type: "tool", name: "t" });
	});

	it("does not force toolChoice for non-Anthropic models", async () => {
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "t", arguments: { verdict: "approve", count: 1 } }],
			stopReason: "toolUse",
			usage: {},
			api: "openai-completions",
			provider: "openai",
			model: "gpt-5",
			timestamp: Date.now(),
		});
		await structuredCall(
			fakeCtx(),
			anthropicRole({ model: { provider: "openai", id: "gpt-5", api: "openai-completions" } as never }),
			{ systemPrompt: "s", userPrompt: "u", toolName: "t", toolDescription: "d", schema },
		);
		const [, , options] = completeSimpleMock.mock.calls[0]!;
		expect(options.toolChoice).toBeUndefined();
	});

	it('omits the reasoning field entirely when the role thinking level is "off" (pi-ai treats the string "off" as truthy)', async () => {
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "t", arguments: { verdict: "approve", count: 1 } }],
			stopReason: "toolUse",
			usage: {},
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			timestamp: Date.now(),
		});
		await structuredCall(fakeCtx(), anthropicRole({ thinking: "off" }), {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		const [, , options] = completeSimpleMock.mock.calls[0]!;
		expect((options as Record<string, unknown>).reasoning).toBeUndefined();
		expect("reasoning" in (options as Record<string, unknown>)).toBe(true); // key present, value undefined
	});

	it("passes the reasoning level through unchanged for non-off levels", async () => {
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "t", arguments: { verdict: "approve", count: 1 } }],
			stopReason: "toolUse",
			usage: {},
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
			timestamp: Date.now(),
		});
		await structuredCall(fakeCtx(), anthropicRole({ thinking: "high" }), {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		const [, , options] = completeSimpleMock.mock.calls[0]!;
		expect((options as Record<string, unknown>).reasoning).toBe("high");
	});

	it("falls back to extracting JSON from text when no matching tool call is present", async () => {
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: 'Sure, here it is:\n{"verdict":"approve","count":5}\nHope that helps.' }],
			stopReason: "stop",
			usage: {},
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
			timestamp: Date.now(),
		});
		const result = await structuredCall(fakeCtx(), anthropicRole(), {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual({ verdict: "approve", count: 5 });
	});

	it("returns ok=false when neither a tool call nor extractable JSON is present after retrying once", async () => {
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "I cannot help with that." }],
			stopReason: "stop",
			usage: {},
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
			timestamp: Date.now(),
		});
		const result = await structuredCall(fakeCtx(), anthropicRole(), {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		expect(result.ok).toBe(false);
		// Retried exactly once (2 attempts total), not looped indefinitely.
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
	});

	it("retries once with a strengthened prompt when the model responds conversationally, and recovers", async () => {
		completeSimpleMock
			.mockResolvedValueOnce({
				role: "assistant",
				content: [{ type: "text", text: "Could you clarify what you mean?" }],
				stopReason: "stop",
				usage: {},
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				role: "assistant",
				content: [{ type: "toolCall", id: "1", name: "t", arguments: { verdict: "approve", count: 2 } }],
				stopReason: "toolUse",
				usage: {},
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				timestamp: Date.now(),
			});
		const result = await structuredCall(fakeCtx(), anthropicRole(), {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual({ verdict: "approve", count: 2 });
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		// Second attempt's system prompt should include the stronger nudge.
		const secondCallContext = completeSimpleMock.mock.calls[1]![1] as { systemPrompt: string };
		expect(secondCallContext.systemPrompt).toContain("must call the");
	});

	it("does not retry on auth failure (a retry cannot fix missing credentials)", async () => {
		const result = await structuredCall(fakeCtx(false), anthropicRole(), {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		expect(result.ok).toBe(false);
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("does not retry on schema validation failure (a retry with the same call would just repeat)", async () => {
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "t", arguments: { verdict: "approve" } }],
			stopReason: "toolUse",
			usage: {},
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
			timestamp: Date.now(),
		});
		const result = await structuredCall(fakeCtx(), anthropicRole(), {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		expect(result.ok).toBe(false);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("returns ok=false when the tool call arguments fail schema validation", async () => {
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "t", arguments: { verdict: "approve" /* missing count */ } }],
			stopReason: "toolUse",
			usage: {},
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
			timestamp: Date.now(),
		});
		const result = await structuredCall(fakeCtx(), anthropicRole(), {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/schema/);
	});

	it("returns ok=false with 'aborted' when the signal was already aborted and the call throws", async () => {
		const controller = new AbortController();
		controller.abort();
		completeSimpleMock.mockRejectedValue(new Error("aborted by user"));
		const result = await structuredCall(fakeCtx(), anthropicRole(), {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
			signal: controller.signal,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("aborted");
	});

	it("surfaces provider error responses as ok=false", async () => {
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "rate limited",
			usage: {},
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
			timestamp: Date.now(),
		});
		const result = await structuredCall(fakeCtx(), anthropicRole(), {
			systemPrompt: "s",
			userPrompt: "u",
			toolName: "t",
			toolDescription: "d",
			schema,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("rate limited");
	});
});
