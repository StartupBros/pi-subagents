import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	compactEventLog,
	compactTerminalAsyncEventLogs,
} from "../../src/runs/background/async-retention.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-retention-"));
	tempDirs.push(dir);
	return dir;
}

describe("async event retention", () => {
	it("compacts oversized event logs while preserving a tail", () => {
		const dir = makeTempDir();
		const eventsPath = path.join(dir, "events.jsonl");
		fs.writeFileSync(
			eventsPath,
			[
				'{"type":"old"}',
				...Array.from(
					{ length: 100 },
					(_, index) => `{"type":"middle","index":${index}}`,
				),
				'{"type":"recent"}',
			].join("\n") + "\n",
			"utf-8",
		);

		const result = compactEventLog(eventsPath, {
			maxBytes: 200,
			keepTailBytes: 80,
			now: () => 123,
		});
		const compacted = fs.readFileSync(eventsPath, "utf-8");

		assert.equal(result.compacted, true);
		assert.equal(result.bytesBefore > result.bytesAfter, true);
		assert.match(compacted.split("\n")[0] ?? "", /subagent\.events\.compacted/);
		assert.doesNotMatch(compacted, /old/);
		assert.match(compacted, /recent/);
		assert.equal(fs.existsSync(`${eventsPath}.truncated`), true);
	});

	it("only compacts terminal async run event logs", () => {
		const root = makeTempDir();
		const completeDir = path.join(root, "complete-run");
		const runningDir = path.join(root, "running-run");
		fs.mkdirSync(completeDir, { recursive: true });
		fs.mkdirSync(runningDir, { recursive: true });
		fs.writeFileSync(
			path.join(completeDir, "status.json"),
			JSON.stringify({ state: "complete" }),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(runningDir, "status.json"),
			JSON.stringify({ state: "running" }),
			"utf-8",
		);
		const bigLog = `${'{"type":"x"}\n'.repeat(10)}`;
		fs.writeFileSync(path.join(completeDir, "events.jsonl"), bigLog, "utf-8");
		fs.writeFileSync(path.join(runningDir, "events.jsonl"), bigLog, "utf-8");

		const result = compactTerminalAsyncEventLogs({
			asyncDirRoot: root,
			maxBytes: 20,
			keepTailBytes: 20,
			now: () => 456,
		});

		assert.equal(result.filesCompacted, 1);
		assert.match(
			fs.readFileSync(path.join(completeDir, "events.jsonl"), "utf-8"),
			/subagent\.events\.compacted/,
		);
		assert.doesNotMatch(
			fs.readFileSync(path.join(runningDir, "events.jsonl"), "utf-8"),
			/subagent\.events\.compacted/,
		);
	});
});
