import type { RoleName } from "./types.ts";
import { ROLE_NAMES } from "./types.ts";

/**
 * Purely informational usage bookkeeping — call counts, token counts, and
 * tool-output compression savings per role. This module never gates, limits,
 * or influences routing decisions; it only accumulates numbers for
 * display (the `agent_settled` widget, the `/router` status dashboard).
 *
 * No pi imports: this is a plain in-memory accumulator over plain data, so
 * it is trivially unit-testable and reusable from both the out-of-band
 * pipeline calls (structured.ts) and subagent JSON output (subagents.ts).
 */

/** Token usage for a single out-of-band or subagent call, when available. */
export interface CallUsage {
	inputTokens?: number;
	outputTokens?: number;
}

/** Per-role accumulated call counts and token totals. */
export interface RoleUsage {
	calls: number;
	inputTokens: number;
	outputTokens: number;
}

/** Shape produced by toolparse.ts's `compressToolOutput` for one compression event. */
export interface CompressionSaved {
	originalBytes: number;
	compressedBytes: number;
	savedTokens: number;
}

/** Accumulated compression savings across all tool-output compression events. */
export interface CompressionTotals {
	events: number;
	originalBytes: number;
	compressedBytes: number;
	/** originalBytes - compressedBytes, floored at 0. */
	savedBytes: number;
	savedTokens: number;
}

/** Immutable point-in-time view of accumulated stats, safe to read/render/serialize. */
export interface StatsSnapshot {
	roles: Record<RoleName, RoleUsage>;
	compression: CompressionTotals;
}

function emptyRoleUsage(): RoleUsage {
	return { calls: 0, inputTokens: 0, outputTokens: 0 };
}

function emptyCompressionTotals(): CompressionTotals {
	return { events: 0, originalBytes: 0, compressedBytes: 0, savedBytes: 0, savedTokens: 0 };
}

function emptyRoleUsageMap(): Record<RoleName, RoleUsage> {
	const roles = {} as Record<RoleName, RoleUsage>;
	for (const role of ROLE_NAMES) roles[role] = emptyRoleUsage();
	return roles;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * In-memory, per-session usage accumulator. One instance per pi session;
 * construct fresh (or call `reset()`) on session start. All methods are
 * synchronous, side-effect-free beyond mutating this instance's own state,
 * and never throw.
 */
export class SessionStats {
	private roles: Record<RoleName, RoleUsage> = emptyRoleUsageMap();
	private compression: CompressionTotals = emptyCompressionTotals();

	/** Record one completed call against a role, with optional token usage. */
	recordCall(role: RoleName, usage?: CallUsage): void {
		const bucket = this.roles[role];
		bucket.calls += 1;
		if (usage?.inputTokens) bucket.inputTokens += usage.inputTokens;
		if (usage?.outputTokens) bucket.outputTokens += usage.outputTokens;
	}

	/** Record one tool-output compression event (from toolparse.ts or a subagent's report). */
	recordCompression(saved: CompressionSaved): void {
		this.compression.events += 1;
		this.compression.originalBytes += saved.originalBytes;
		this.compression.compressedBytes += saved.compressedBytes;
		this.compression.savedBytes += Math.max(0, saved.originalBytes - saved.compressedBytes);
		this.compression.savedTokens += saved.savedTokens;
	}

	/** Total calls across all roles. */
	totalCalls(): number {
		return ROLE_NAMES.reduce((sum, role) => sum + this.roles[role].calls, 0);
	}

	/** Reset all accumulated stats back to empty (e.g. on a new session/pipeline run). */
	reset(): void {
		this.roles = emptyRoleUsageMap();
		this.compression = emptyCompressionTotals();
	}

	/** A deep-copied, read-only snapshot of the current state. Safe to stash or serialize. */
	snapshot(): StatsSnapshot {
		const roles = {} as Record<RoleName, RoleUsage>;
		for (const role of ROLE_NAMES) roles[role] = { ...this.roles[role] };
		return { roles, compression: { ...this.compression } };
	}

	/**
	 * Render a short, human-readable multi-line summary suitable for the
	 * `agent_settled` informational widget and the `/router` status
	 * dashboard's "context tokens saved this session" line.
	 */
	summarize(): string {
		const snap = this.snapshot();
		const totalCalls = ROLE_NAMES.reduce((sum, role) => sum + snap.roles[role].calls, 0);

		if (totalCalls === 0 && snap.compression.events === 0) {
			return "Router stats: no pipeline activity this session yet.";
		}

		const lines: string[] = ["Router stats (informational only):"];

		for (const role of ROLE_NAMES) {
			const usage = snap.roles[role];
			if (usage.calls === 0) continue;
			const tokenParts: string[] = [];
			if (usage.inputTokens > 0) tokenParts.push(`${usage.inputTokens} in`);
			if (usage.outputTokens > 0) tokenParts.push(`${usage.outputTokens} out`);
			const tokenSuffix = tokenParts.length > 0 ? `, ${tokenParts.join(" / ")} tokens` : "";
			lines.push(`  ${role}: ${usage.calls} call${usage.calls === 1 ? "" : "s"}${tokenSuffix}`);
		}

		if (snap.compression.events > 0) {
			const { events, originalBytes, compressedBytes, savedBytes, savedTokens } = snap.compression;
			lines.push(
				`  compression: ${events} output${events === 1 ? "" : "s"} compressed, ` +
					`${formatBytes(originalBytes)} → ${formatBytes(compressedBytes)} ` +
					`(saved ${formatBytes(savedBytes)}, ~${savedTokens} tokens)`,
			);
		}

		return lines.join("\n");
	}
}
