import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR } from "../../shared/types.ts";

export const DEFAULT_ASYNC_EVENT_LOG_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_ASYNC_EVENT_LOG_TAIL_BYTES = 2 * 1024 * 1024;

const TERMINAL_STATES = new Set(["complete", "failed", "paused"]);

interface CompactEventLogOptions {
	maxBytes?: number;
	keepTailBytes?: number;
	now?: () => number;
}

interface CompactAsyncEventLogsOptions extends CompactEventLogOptions {
	asyncDirRoot?: string;
}

export interface AsyncEventLogCompactionResult {
	filesCompacted: number;
	bytesBefore: number;
	bytesAfter: number;
}

function readRunState(runDir: string): string | undefined {
	try {
		const status = JSON.parse(
			fs.readFileSync(path.join(runDir, "status.json"), "utf-8"),
		) as { state?: unknown };
		return typeof status.state === "string" ? status.state : undefined;
	} catch {
		return undefined;
	}
}

function listRunDirs(asyncDirRoot: string): string[] {
	try {
		return fs
			.readdirSync(asyncDirRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(asyncDirRoot, entry.name));
	} catch {
		return [];
	}
}

export function compactEventLog(
	filePath: string,
	options: CompactEventLogOptions = {},
): { compacted: boolean; bytesBefore: number; bytesAfter: number } {
	const maxBytes = options.maxBytes ?? DEFAULT_ASYNC_EVENT_LOG_MAX_BYTES;
	const keepTailBytes = Math.min(
		options.keepTailBytes ?? DEFAULT_ASYNC_EVENT_LOG_TAIL_BYTES,
		maxBytes,
	);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return { compacted: false, bytesBefore: 0, bytesAfter: 0 };
	}
	if (!stat.isFile() || stat.size <= maxBytes) {
		return { compacted: false, bytesBefore: stat.size, bytesAfter: stat.size };
	}

	const tailBytes = Math.min(keepTailBytes, stat.size);
	const buffer = Buffer.alloc(tailBytes);
	const fd = fs.openSync(filePath, "r");
	try {
		fs.readSync(fd, buffer, 0, tailBytes, stat.size - tailBytes);
	} finally {
		fs.closeSync(fd);
	}

	let tail = buffer.toString("utf-8");
	if (stat.size > tailBytes) {
		const firstNewline = tail.indexOf("\n");
		tail = firstNewline >= 0 ? tail.slice(firstNewline + 1) : "";
	}

	const marker = JSON.stringify({
		type: "subagent.events.compacted",
		ts: options.now?.() ?? Date.now(),
		originalBytes: stat.size,
		keptTailBytes: Buffer.byteLength(tail, "utf-8"),
	});
	const nextContent = tail ? `${marker}\n${tail}` : `${marker}\n`;
	fs.writeFileSync(filePath, nextContent, "utf-8");
	fs.writeFileSync(`${filePath}.truncated`, `${marker}\n`, "utf-8");
	const bytesAfter = Buffer.byteLength(nextContent, "utf-8");
	return { compacted: true, bytesBefore: stat.size, bytesAfter };
}

export function compactTerminalAsyncEventLogs(
	options: CompactAsyncEventLogsOptions = {},
): AsyncEventLogCompactionResult {
	const asyncDirRoot = options.asyncDirRoot ?? ASYNC_DIR;
	const result: AsyncEventLogCompactionResult = {
		filesCompacted: 0,
		bytesBefore: 0,
		bytesAfter: 0,
	};
	for (const runDir of listRunDirs(asyncDirRoot)) {
		const state = readRunState(runDir);
		if (!state || !TERMINAL_STATES.has(state)) continue;
		const compaction = compactEventLog(
			path.join(runDir, "events.jsonl"),
			options,
		);
		if (!compaction.compacted) continue;
		result.filesCompacted++;
		result.bytesBefore += compaction.bytesBefore;
		result.bytesAfter += compaction.bytesAfter;
	}
	return result;
}
