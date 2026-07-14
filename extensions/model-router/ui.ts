import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { shortModelLabel } from "./roles.ts";
import type { ResolvedRole, RoleName } from "./types.ts";
import type { ModeName } from "./types.ts";

const STATUS_KEY = "model-router";
const PIPELINE_WIDGET_KEY = "model-router-pipeline";
const PROGRESS_WIDGET_KEY = "model-router-progress";

/**
 * Footer status: "◆ agent │ opus→fable→sonnet". Shows the mode and the active
 * pipeline model chain. No cost — quality-first, purely informational.
 */
export function renderStatus(
	ctx: ExtensionContext,
	mode: ModeName,
	roles: Record<RoleName, ResolvedRole>,
	pinned = false,
): void {
	if (!ctx.hasUI) return;
	const chain = [roles.planner, roles.validator, roles.executor]
		.map(shortModelLabel)
		.filter((s) => s !== "—")
		.join("→");
	const parser = shortModelLabel(roles.toolParser);
	const parserPart = parser !== "—" ? ` · parse:${parser}` : "";
	const pinnedPart = pinned ? " · pinned (manual override)" : "";
	ctx.ui.setStatus(STATUS_KEY, `◆ ${mode} │ ${chain}${parserPart}${pinnedPart}`);
}

export function clearStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, "");
}

/** Show a transient progress widget above the editor while the pipeline runs. */
export function setPipelineWidget(ctx: ExtensionContext, lines: string[] | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(PIPELINE_WIDGET_KEY, lines);
}

/** Show `[DONE:n]` plan-step progress ("Plan progress: 2/5 done") while agent mode works through an injected plan. */
export function setProgressWidget(ctx: ExtensionContext, lines: string[] | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(PROGRESS_WIDGET_KEY, lines);
}

/**
 * Notify the user. Uses ctx.ui.notify() when a UI is present (TUI/RPC).
 * In print/JSON mode (ctx.hasUI === false), ctx.ui.notify() is a safe no-op,
 * so route to stderr instead — keeps stdout clean for JSON-mode consumers
 * while still surfacing warnings/errors to `-p` users and scripts.
 */
export function notify(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	const prefix = level === "error" ? "[model-router:error]" : level === "warning" ? "[model-router:warn]" : "[model-router]";
	console.error(`${prefix} ${message}`);
}
