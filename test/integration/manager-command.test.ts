import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerSubagentExtension from "../../index.ts";

function makeFakePi() {
	const commands = new Map<string, { description?: string }>();
	return {
		commands,
		events: {
			on() { return () => {}; },
			emit() {},
		},
		on() {},
		registerTool() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerCommand(name: string, options: { description?: string }) {
			commands.set(name, options);
		},
	};
}

function writeConfig(homeDir: string, config: Record<string, unknown>) {
	const configDir = path.join(homeDir, ".pi", "agent", "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config, null, 2));
}

function setHomeDir(homeDir: string) {
	process.env.HOME = homeDir;
	process.env.USERPROFILE = homeDir;
}

describe("managerCommand config", () => {
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
	});

	it("defaults to /agents", () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		setHomeDir(homeDir);

		const pi = makeFakePi();
		registerSubagentExtension(pi as never);

		assert.ok(pi.commands.has("agents"));
		assert.ok(!pi.commands.has("subagents"));
	});

	it("registers a custom manager command", () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		setHomeDir(homeDir);
		writeConfig(homeDir, { managerCommand: "subagents" });

		const pi = makeFakePi();
		registerSubagentExtension(pi as never);

		assert.ok(pi.commands.has("subagents"));
		assert.ok(!pi.commands.has("agents"));
	});

	it("normalizes a leading slash in managerCommand", () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		setHomeDir(homeDir);
		writeConfig(homeDir, { managerCommand: "/subagents" });

		const pi = makeFakePi();
		registerSubagentExtension(pi as never);

		assert.ok(pi.commands.has("subagents"));
	});

	it("disables manager command registration when set to false", () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		setHomeDir(homeDir);
		writeConfig(homeDir, { managerCommand: false });

		const pi = makeFakePi();
		registerSubagentExtension(pi as never);

		assert.ok(!pi.commands.has("agents"));
		assert.ok(!pi.commands.has("subagents"));
		assert.ok(pi.commands.has("run"));
		assert.ok(pi.commands.has("chain"));
		assert.ok(pi.commands.has("parallel"));
	});
});
