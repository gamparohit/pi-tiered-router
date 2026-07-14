import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ResolvedRole } from "./types.ts";

export interface StructuredCallOptions<T> {
	/** System prompt for the out-of-band call. */
	systemPrompt: string;
	/** User-turn content (the actual task/question). */
	userPrompt: string;
	/** Name of the single forced tool used to carry structured output. */
	toolName: string;
	toolDescription: string;
	schema: TSchema;
	signal?: AbortSignal;
}

export type StructuredCallResult<T> =
	| { ok: true; value: T; raw: AssistantMessage }
	| { ok: false; error: string; raw?: AssistantMessage };

const NO_STRUCTURED_OUTPUT = "returned no usable structured output";

const FORCE_TOOL_USE_SUFFIX = (toolName: string) =>
	[
		"",
		`IMPORTANT: you must call the "${toolName}" tool now.`,
		"This is an internal, non-interactive plumbing call: no one will read plain text you write, and there is no opportunity to ask a clarifying question.",
		"If information seems incomplete or ambiguous, make your best-effort judgment call and proceed anyway.",
	].join("\n");

/**
 * Single attempt: send the request and try to extract structured output from
 * either a matching tool call or, failing that, the first JSON object found
 * in any text content.
 */
async function attempt<T>(
	ctx: ExtensionContext,
	role: ResolvedRole,
	opts: StructuredCallOptions<T>,
): Promise<StructuredCallResult<T>> {
	if (role.skipped) return { ok: false, error: `role "${role.role}" is disabled ("skip")` };
	if (!role.model) return { ok: false, error: `role "${role.role}" has no resolved model (wanted ${role.requested})` };

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(role.model);
	if (!auth.ok) return { ok: false, error: `role "${role.role}" (${role.resolvedId}): ${auth.error}` };
	if (!auth.apiKey) return { ok: false, error: `role "${role.role}" (${role.resolvedId}): no API key configured` };

	const context: Context = {
		systemPrompt: opts.systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: opts.userPrompt }], timestamp: Date.now() }],
		tools: [{ name: opts.toolName, description: opts.toolDescription, parameters: opts.schema }],
	};

	const providerOptions: Record<string, unknown> = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		// pi-ai's streamSimple only skips its thinking-budget math when `reasoning`
		// is falsy; the literal string "off" is truthy and falls through into budget
		// math with no "off" entry in the default budget table, producing NaN ->
		// an invalid max_tokens request. Omit the field entirely for "off".
		reasoning: role.thinking === "off" ? undefined : role.thinking,
		signal: opts.signal,
		// NOTE: completeSimple's internal option-building only forwards a fixed
		// whitelist of fields and currently drops `toolChoice`, so this does not
		// actually force tool use today. Left in place (harmless) in case a
		// future pi-ai version forwards it; reliability is instead handled by
		// the retry-with-stronger-prompt in structuredCall() below.
		...(role.model.api === "anthropic-messages" ? { toolChoice: { type: "tool", name: opts.toolName } } : {}),
	};

	let response: AssistantMessage;
	try {
		response = await completeSimple(role.model, context, providerOptions as never);
	} catch (err) {
		if (opts.signal?.aborted) return { ok: false, error: "aborted" };
		return { ok: false, error: `role "${role.role}" (${role.resolvedId}) request failed: ${(err as Error).message}` };
	}

	if (response.stopReason === "aborted") return { ok: false, error: "aborted", raw: response };
	if (response.stopReason === "error") {
		return { ok: false, error: response.errorMessage ?? "provider error", raw: response };
	}

	const toolCall = response.content.find((c): c is ToolCall => c.type === "toolCall" && c.name === opts.toolName);
	if (toolCall) {
		if (Value.Check(opts.schema, toolCall.arguments)) {
			return { ok: true, value: toolCall.arguments as T, raw: response };
		}
		const errors = [...Value.Errors(opts.schema, toolCall.arguments)].slice(0, 3);
		return {
			ok: false,
			error: `tool call arguments failed schema validation: ${errors.map((e) => `${e.instancePath || "/"}: ${e.message}`).join("; ")}`,
			raw: response,
		};
	}

	// Fallback: extract the first JSON object from any text content.
	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const match = text.match(/\{[\s\S]*\}/);
	if (match) {
		try {
			const parsed = JSON.parse(match[0]);
			if (Value.Check(opts.schema, parsed)) {
				return { ok: true, value: parsed as T, raw: response };
			}
			return { ok: false, error: "fallback JSON did not match expected schema", raw: response };
		} catch {
			// fall through to final error
		}
	}

	return { ok: false, error: `role "${role.role}" (${role.resolvedId}) ${NO_STRUCTURED_OUTPUT}`, raw: response };
}

/**
 * Run an out-of-band structured call against a resolved role's model. Never
 * touches session context — used for classify/plan/validate calls that must
 * not pollute the main conversation.
 *
 * Reliability strategy: models occasionally respond conversationally instead
 * of calling the offered tool (observed most often with faster/cheaper
 * models on ambiguous prompts). When that happens — and only then, not on
 * auth/schema/provider errors, which a retry cannot fix — we retry exactly
 * once with a strengthened system prompt that explicitly forbids asking
 * clarifying questions. This is provider-agnostic and works regardless of
 * whether a given provider honors forced tool-choice.
 */
export async function structuredCall<T>(
	ctx: ExtensionContext,
	role: ResolvedRole,
	opts: StructuredCallOptions<T>,
): Promise<StructuredCallResult<T>> {
	const first = await attempt<T>(ctx, role, opts);
	if (first.ok) return first;
	if (!first.error.endsWith(NO_STRUCTURED_OUTPUT)) return first;

	return attempt<T>(ctx, role, { ...opts, systemPrompt: opts.systemPrompt + FORCE_TOOL_USE_SUFFIX(opts.toolName) });
}
