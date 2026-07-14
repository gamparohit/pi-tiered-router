/**
 * Haiku tool-output compression (M3): a `tool_result` middleware that shrinks
 * large bash/grep-like tool outputs using the cheap "toolParser" role before
 * they enter the executor's session context. This is about *context quality*
 * — keeping Sonnet/Opus's window focused on what matters for the current
 * step — with token savings as a side effect, not the goal. See PLAN.md §5.
 *
 * This module is intentionally self-contained and side-effect-free: it does
 * not register the `tool_result` hook itself (that wiring, plus the
 * `/router toolparse on|off` toggle and the expandable TUI renderer, belongs
 * in index.ts/ui.ts). It only exports the pure decision function and the
 * async compression call so a handler elsewhere can do:
 *
 *   pi.on("tool_result", async (event, ctx) => {
 *     if (!shouldCompress(event.toolName, bytesOf(event.content), event.isError, threshold)) return;
 *     const result = await compressToolOutput(ctx, roles.toolParser, { ... });
 *     return { content: [{ type: "text", text: result.compressed }], details: { ... } };
 *   });
 */

import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedRole } from "./types.ts";

/**
 * Tool names that can legitimately produce large terminal-style dumps worth
 * compressing (bash/grep-like output). Deliberately excludes "read", "edit",
 * and "write": read's output is the file the user/model explicitly asked to
 * see in full, and edit/write results are small structured diffs, not
 * incidental noise — compressing them risks losing exactly the content the
 * caller wanted.
 */
const COMPRESSIBLE_TOOLS = new Set(["bash", "grep", "find", "ls"]);

/**
 * Error results must clear a substantially higher bar than the plain
 * threshold before we'll even consider compressing them. A failing test's
 * stack trace is exactly the kind of verbatim detail (error messages, paths,
 * line numbers) the executor needs most — per PLAN.md's guardrail, we would
 * rather leave a moderately-large error untouched than risk summarizing away
 * the one line that explains the failure. Only very large error dumps (e.g.
 * a huge CI log tail) are eligible.
 */
const ERROR_THRESHOLD_MULTIPLIER = 4;

/**
 * Pure decision: should this tool result be sent through the toolParser role
 * for compression? No I/O, no side effects — easy to unit test and to call
 * cheaply from a `tool_result` handler before doing any real work.
 *
 * Rules (in order):
 *  1. Only bash/grep-like tools are eligible (see COMPRESSIBLE_TOOLS).
 *  2. A non-positive/invalid threshold disables compression entirely.
 *  3. Outputs at or under the threshold pass through untouched.
 *  4. Error outputs need to exceed threshold * ERROR_THRESHOLD_MULTIPLIER —
 *     short/medium failing output is never compressed, so error messages,
 *     paths, and line numbers always survive verbatim.
 */
export function shouldCompress(toolName: string, outputBytes: number, isError: boolean, threshold: number): boolean {
	if (!COMPRESSIBLE_TOOLS.has(toolName)) return false;
	if (!Number.isFinite(threshold) || threshold <= 0) return false;
	if (outputBytes <= threshold) return false;
	if (isError && outputBytes <= threshold * ERROR_THRESHOLD_MULTIPLIER) return false;
	return true;
}

/** Byte length of a string, UTF-8 accurate (tool output may contain multi-byte chars). */
export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Rough token estimate: ~4 bytes/token for English-ish text and code. This is
 * intentionally crude — it's used only for informational "tokens saved"
 * reporting (stats.ts), never for anything that affects routing or spend
 * decisions.
 */
export function estimateTokens(bytes: number): number {
	return Math.round(bytes / 4);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * One-line human summary of a compression, e.g. "↓ 48.0KB → 1.2KB (haiku, saved ~11000 tokens)".
 * There is no extension-level API to register a custom expandable Component
 * for a *built-in* tool's result (registerMessageRenderer/registerEntryRenderer
 * only apply to extension-authored custom messages/entries) — this line is
 * prepended directly into the visible compressed text instead, so the
 * savings are still visible inline even without a collapsible affordance.
 */
export function summaryLine(result: Pick<CompressToolOutputResult, "originalBytes" | "compressedBytes" | "savedTokens">): string {
	return `↓ ${formatBytes(result.originalBytes)} → ${formatBytes(result.compressedBytes)} (toolParser, saved ~${result.savedTokens} tokens)`;
}

export interface CompressToolOutputParams {
	/** The tool that produced the output, e.g. "bash", "grep". */
	toolName: string;
	/** Short human-readable summary of what was run, e.g. the bash command or grep pattern — gives the parser model intent, not just raw bytes. */
	commandSummary: string;
	/** The raw tool output to compress. */
	output: string;
	/** Description of the current plan step/task; focuses extraction on what's relevant right now. */
	currentStepContext: string;
	signal?: AbortSignal;
}

export interface CompressToolOutputResult {
	/** The text to show the executor: the compressed summary on success, or the untouched original on any failure/degradation path. */
	compressed: string;
	originalBytes: number;
	compressedBytes: number;
	/** Estimated tokens saved (see estimateTokens's doc comment on why this is an estimate). Zero (never negative) when nothing was saved or compression didn't happen. */
	savedTokens: number;
}

function passthrough(output: string): CompressToolOutputResult {
	const bytes = byteLength(output);
	return { compressed: output, originalBytes: bytes, compressedBytes: bytes, savedTokens: 0 };
}

function systemPrompt(currentStepContext: string): string {
	return [
		`Extract only the information relevant to: ${currentStepContext}`,
		"Preserve error messages, paths, and line numbers verbatim.",
		"Be concise: drop repetitive/noisy lines (progress bars, duplicate warnings, unchanged boilerplate) that carry no new information.",
		"Do not fabricate or infer content that is not present in the output.",
	].join("\n");
}

/**
 * Minimal plain-text out-of-band completion, local to toolparse: unlike
 * structured.ts's structuredCall, we want free-text compressed output here,
 * not a schema-validated tool call, so there's no forced-tool-use dance or
 * JSON extraction — just send the prompt and read back the response text.
 * Mirrors structured.ts's attempt() for auth resolution and error handling.
 */
async function completePlainText(
	ctx: ExtensionContext,
	role: ResolvedRole,
	opts: { systemPrompt: string; userPrompt: string; signal?: AbortSignal },
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	if (role.skipped) return { ok: false, error: `role "${role.role}" is disabled ("skip")` };
	if (!role.model) return { ok: false, error: `role "${role.role}" has no resolved model (wanted ${role.requested})` };

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(role.model);
	if (!auth.ok) return { ok: false, error: `role "${role.role}" (${role.resolvedId}): ${auth.error}` };
	if (!auth.apiKey) return { ok: false, error: `role "${role.role}" (${role.resolvedId}): no API key configured` };

	const context: Context = {
		systemPrompt: opts.systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: opts.userPrompt }], timestamp: Date.now() }],
	};

	const providerOptions: Record<string, unknown> = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		// See structured.ts for why "off" must be omitted rather than passed through.
		reasoning: role.thinking === "off" ? undefined : role.thinking,
		signal: opts.signal,
	};

	let response: AssistantMessage;
	try {
		response = await completeSimple(role.model, context, providerOptions as never);
	} catch (err) {
		if (opts.signal?.aborted) return { ok: false, error: "aborted" };
		return { ok: false, error: `role "${role.role}" (${role.resolvedId}) request failed: ${(err as Error).message}` };
	}

	if (response.stopReason === "aborted") return { ok: false, error: "aborted" };
	if (response.stopReason === "error") return { ok: false, error: response.errorMessage ?? "provider error" };

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	if (!text) return { ok: false, error: `role "${role.role}" (${role.resolvedId}) returned no text content` };
	return { ok: true, text };
}

/**
 * Compress a large tool output out-of-band via the toolParser role. Never
 * touches session context directly (the caller decides how to fold the
 * result back via the `tool_result` handler's return value) and never
 * throws: any failure (unresolved/skipped role, auth failure, provider
 * error, abort, empty response) degrades gracefully to the original output
 * unmodified — the tool_result pipeline must never crash and must never
 * lose the original data.
 */
export async function compressToolOutput(
	ctx: ExtensionContext,
	toolParserRole: ResolvedRole,
	params: CompressToolOutputParams,
): Promise<CompressToolOutputResult> {
	const originalBytes = byteLength(params.output);

	const userPrompt = [
		`Tool: ${params.toolName}`,
		`Command/args: ${params.commandSummary}`,
		"",
		"Output:",
		params.output,
	].join("\n");

	const result = await completePlainText(ctx, toolParserRole, {
		systemPrompt: systemPrompt(params.currentStepContext),
		userPrompt,
		signal: params.signal,
	});

	if (!result.ok) return passthrough(params.output);

	const compressedBytes = byteLength(result.text);
	const savedTokens = Math.max(0, estimateTokens(originalBytes) - estimateTokens(compressedBytes));

	return { compressed: result.text, originalBytes, compressedBytes, savedTokens };
}
