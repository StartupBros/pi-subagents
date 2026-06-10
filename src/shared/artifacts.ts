import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ARTIFACTS_DIR, type ArtifactPaths } from "./types.ts";
import { getAgentDir } from "./utils.ts";
const CLEANUP_MARKER_FILE = ".last-cleanup";

export function getArtifactsDir(sessionFile: string | null): string {
	if (sessionFile) {
		const sessionDir = path.dirname(sessionFile);
		return path.join(sessionDir, "subagent-artifacts");
	}
	return TEMP_ARTIFACTS_DIR;
}

export function getArtifactPaths(
	artifactsDir: string,
	runId: string,
	agent: string,
	index?: number,
): ArtifactPaths {
	const suffix = index !== undefined ? `_${index}` : "";
	const safeAgent = agent.replace(/[^\w.-]/g, "_");
	const base = `${runId}_${safeAgent}${suffix}`;
	return {
		inputPath: path.join(artifactsDir, `${base}_input.md`),
		outputPath: path.join(artifactsDir, `${base}_output.md`),
		jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
		metadataPath: path.join(artifactsDir, `${base}_meta.json`),
	};
}

export function ensureArtifactsDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function writeArtifact(filePath: string, content: string): void {
	fs.writeFileSync(filePath, content, "utf-8");
}

export function writeMetadata(filePath: string, metadata: object): void {
	fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}

export interface AppendJsonlOptions {
	maxBytes?: number;
	truncationLine?: string;
	truncationMarkerPath?: string;
}

function appendJsonlTruncationMarker(
	filePath: string,
	options: Required<Pick<AppendJsonlOptions, "maxBytes">> & AppendJsonlOptions,
): void {
	const markerPath = options.truncationMarkerPath ?? `${filePath}.truncated`;
	if (fs.existsSync(markerPath)) return;

	const markerLine =
		options.truncationLine ??
		JSON.stringify({
			type: "jsonl.truncated",
			ts: Date.now(),
			maxBytes: options.maxBytes,
		});
	fs.appendFileSync(filePath, `${markerLine}\n`);
	fs.writeFileSync(markerPath, `${markerLine}\n`, "utf-8");
}

export function appendJsonl(
	filePath: string,
	line: string,
	options: AppendJsonlOptions = {},
): void {
	if (options.maxBytes === undefined) {
		fs.appendFileSync(filePath, `${line}\n`);
		return;
	}

	const chunk = `${line}\n`;
	const chunkBytes = Buffer.byteLength(chunk, "utf-8");
	let currentBytes = 0;
	try {
		currentBytes = fs.statSync(filePath).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	if (currentBytes + chunkBytes <= options.maxBytes) {
		fs.appendFileSync(filePath, chunk);
		return;
	}

	appendJsonlTruncationMarker(filePath, {
		...options,
		maxBytes: options.maxBytes,
	});
}

export function cleanupOldArtifacts(dir: string, maxAgeDays: number): void {
	if (!fs.existsSync(dir)) return;

	const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
	const now = Date.now();

	if (fs.existsSync(markerPath)) {
		const stat = fs.statSync(markerPath);
		if (now - stat.mtimeMs < 24 * 60 * 60 * 1000) return;
	}

	const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
	const cutoff = now - maxAgeMs;

	for (const file of fs.readdirSync(dir)) {
		if (file === CLEANUP_MARKER_FILE) continue;
		const filePath = path.join(dir, file);
		try {
			const stat = fs.statSync(filePath);
			if (stat.mtimeMs < cutoff) {
				fs.unlinkSync(filePath);
			}
		} catch {
			// Artifact cleanup is best-effort housekeeping. Skip files that disappear
			// or become unreadable while scanning so one bad entry does not block the rest.
		}
	}

	fs.writeFileSync(markerPath, String(now));
}

export function cleanupAllArtifactDirs(maxAgeDays: number): void {
	cleanupOldArtifacts(TEMP_ARTIFACTS_DIR, maxAgeDays);

	const sessionsBase = path.join(getAgentDir(), "sessions");
	if (!fs.existsSync(sessionsBase)) return;

	let dirs: string[];
	try {
		dirs = fs.readdirSync(sessionsBase);
	} catch {
		// Session artifact cleanup is best-effort. If the sessions root cannot be read,
		// skip cleanup instead of failing extension startup.
		return;
	}

	for (const dir of dirs) {
		const artifactsDir = path.join(sessionsBase, dir, "subagent-artifacts");
		try {
			cleanupOldArtifacts(artifactsDir, maxAgeDays);
		} catch {
			// Session cleanup is best-effort. Keep going so one unreadable session dir
			// does not block cleanup for the rest.
		}
	}
}
