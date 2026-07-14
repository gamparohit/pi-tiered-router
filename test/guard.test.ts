import { describe, expect, it } from "vitest";
import { checkReadOnly, isSafeCommand } from "../extensions/model-router/guard.ts";

describe("isSafeCommand", () => {
	it.each(["ls -la", "cat package.json", "grep -rn foo .", "git status", "git log --oneline", "rg TODO", "pwd"])(
		"allows read-only command: %s",
		(cmd) => {
			expect(isSafeCommand(cmd)).toBe(true);
		},
	);

	it.each([
		"rm -rf /",
		"mv a b",
		"git commit -m x",
		"git push",
		"npm install left-pad",
		"sudo reboot",
		"echo hi > file.txt",
		"vim file.txt",
	])("blocks destructive/write command: %s", (cmd) => {
		expect(isSafeCommand(cmd)).toBe(false);
	});

	it("rejects commands that are neither explicitly safe nor explicitly destructive", () => {
		// Not on the allowlist at all -> conservative default is unsafe.
		expect(isSafeCommand("some-random-binary --flag")).toBe(false);
	});

	it("a safe-looking prefix combined with a destructive redirect is blocked", () => {
		expect(isSafeCommand("cat file.txt > /etc/passwd")).toBe(false);
	});
});

describe("checkReadOnly", () => {
	it("blocks the edit tool unconditionally", () => {
		const result = checkReadOnly("edit", { path: "a.ts" });
		expect(result.blocked).toBe(true);
	});

	it("blocks the write tool unconditionally", () => {
		const result = checkReadOnly("write", { path: "a.ts" });
		expect(result.blocked).toBe(true);
	});

	it("allows the read tool", () => {
		const result = checkReadOnly("read", { path: "a.ts" });
		expect(result.blocked).toBe(false);
	});

	it("allows a safe bash command", () => {
		const result = checkReadOnly("bash", { command: "git status" });
		expect(result.blocked).toBe(false);
	});

	it("blocks an unsafe bash command", () => {
		const result = checkReadOnly("bash", { command: "rm -rf /" });
		expect(result.blocked).toBe(true);
		expect(result.reason).toMatch(/allowlist/);
	});

	it("blocks bash with a missing/non-string command defensively", () => {
		const result = checkReadOnly("bash", {});
		expect(result.blocked).toBe(true);
	});

	it("allows other/custom tools by default (only bash and write tools are gated)", () => {
		const result = checkReadOnly("some_custom_tool", { anything: 1 });
		expect(result.blocked).toBe(false);
	});
});
