/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig } from "./agents.ts";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "./artifacts.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type RunSyncOptions,
	type SingleResult,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	truncateOutput,
	getSubagentDepthEnv,
} from "./types.ts";
import {
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	extractToolArgsPreview,
	extractTextFromContent,
} from "./utils.ts";
import { buildSkillInjection, resolveSkills } from "./skills.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { createJsonlWriter } from "./jsonl-writer.ts";
import {
	executeWithRuntimeModelFallback,
	type ModelAttemptExecutionResult,
} from "./runtime-model-fallback.ts";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir } from "./pi-args.ts";
import { captureSingleOutputSnapshot, resolveSingleOutput } from "./single-output.ts";

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function mergeUsage(results: SingleResult[]): Usage {
	return results.reduce<Usage>((totals, result) => ({
		input: totals.input + result.usage.input,
		output: totals.output + result.usage.output,
		cacheRead: totals.cacheRead + result.usage.cacheRead,
		cacheWrite: totals.cacheWrite + result.usage.cacheWrite,
		cost: totals.cost + result.usage.cost,
		turns: totals.turns + result.usage.turns,
	}), emptyUsage());
}

function emitFallbackUpdate(
	onUpdate: RunSyncOptions["onUpdate"],
	result: SingleResult,
	message: string,
): void {
	if (!onUpdate) return;
	const progress = result.progress;
	if (progress) {
		progress.recentOutput.push(message);
		if (progress.recentOutput.length > 50) {
			progress.recentOutput.splice(0, progress.recentOutput.length - 50);
		}
	}
	onUpdate({
		content: [{ type: "text", text: message }],
		details: { mode: "single", results: [result], progress: progress ? [progress] : undefined },
	});
}

function buildFailureResult(agentName: string, task: string, error: string): SingleResult {
	return {
		agent: agentName,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error,
	};
}

async function runSyncAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	options: RunSyncOptions,
	attemptModel?: string,
): Promise<ModelAttemptExecutionResult<SingleResult>> {
	const { cwd, signal, onUpdate, maxOutput, artifactsDir, artifactConfig, runId, index } = options;
	const shareEnabled = options.share === true;
	const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
	const effectiveModel = attemptModel ?? options.modelOverride ?? agent.model;
	const modelArg = applyThinkingSuffix(effectiveModel, agent.thinking);
	const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);

	const skillNames = options.skills ?? agent.skills ?? [];
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkills(skillNames, runtimeCwd);

	let systemPrompt = agent.systemPrompt?.trim() || "";
	if (resolvedSkills.length > 0) {
		const skillInjection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
	}

	const { args, env: sharedEnv, tempDir } = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task,
		sessionEnabled,
		sessionDir: options.sessionDir,
		sessionFile: options.sessionFile,
		model: effectiveModel,
		thinking: agent.thinking,
		tools: agent.tools,
		extensions: agent.extensions,
		skills: skillNames,
		systemPrompt,
		mcpDirectTools: agent.mcpDirectTools,
		promptFileStem: agent.name,
	});

	const result: SingleResult = {
		agent: agent.name,
		task,
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		skills: resolvedSkills.length > 0 ? resolvedSkills.map((s) => s.name) : undefined,
		skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
	};

	const progress: AgentProgress = {
		index: index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: resolvedSkills.length > 0 ? resolvedSkills.map((s) => s.name) : undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
	};
	result.progress = progress;

	const startTime = Date.now();

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	if (artifactsDir && artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(artifactsDir, runId, agent.name, index);
		ensureArtifactsDir(artifactsDir);
		if (artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agent.name}\n\n${task}`);
		}
		if (artifactConfig?.includeJsonl !== false) {
			jsonlPath = artifactPathsResult.jsonlPath;
		}
	}

	const spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };

	let closeJsonlWriter: (() => Promise<void>) | undefined;
	let stderrBuf = "";
	const exitCode = await new Promise<number>((resolve) => {
		const spawnSpec = getPiSpawnCommand(args);
		const proc = spawn(spawnSpec.command, spawnSpec.args, {
			cwd: cwd ?? runtimeCwd,
			env: spawnEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const jsonlWriter = createJsonlWriter(jsonlPath, proc.stdout);
		closeJsonlWriter = () => jsonlWriter.close();
		let buf = "";
		let processClosed = false;

		const fireUpdate = () => {
			if (!onUpdate || processClosed) return;
			progress.durationMs = Date.now() - startTime;
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
				details: { mode: "single", results: [result], progress: [progress] },
			});
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			jsonlWriter.writeLine(line);
			try {
				const evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };
				const now = Date.now();
				progress.durationMs = now - startTime;

				if (evt.type === "tool_execution_start") {
					progress.toolCount++;
					progress.currentTool = evt.toolName;
					progress.currentToolArgs = extractToolArgsPreview((evt.args || {}) as Record<string, unknown>);
					fireUpdate();
				}

				if (evt.type === "tool_execution_end") {
					if (progress.currentTool) {
						progress.recentTools.push({
							tool: progress.currentTool,
							args: progress.currentToolArgs || "",
							endMs: now,
						});
					}
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					fireUpdate();
				}

				if (evt.type === "message_end" && evt.message) {
					result.messages.push(evt.message);
					if (evt.message.role === "assistant") {
						result.usage.turns++;
						const u = evt.message.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							progress.tokens = result.usage.input + result.usage.output;
						}
						if (!result.model && evt.message.model) result.model = evt.message.model;
						if (evt.message.errorMessage) result.error = evt.message.errorMessage;

						const text = extractTextFromContent(evt.message.content);
						if (text) {
							const lines = text.split("\n").filter((l) => l.trim()).slice(-10);
							progress.recentOutput.push(...lines);
							if (progress.recentOutput.length > 50) {
								progress.recentOutput.splice(0, progress.recentOutput.length - 50);
							}
						}
					}
					fireUpdate();
				}
				if (evt.type === "tool_result_end" && evt.message) {
					result.messages.push(evt.message);
					const toolText = extractTextFromContent(evt.message.content);
					if (toolText) {
						const toolLines = toolText.split("\n").filter((l) => l.trim()).slice(-10);
						progress.recentOutput.push(...toolLines);
						if (progress.recentOutput.length > 50) {
							progress.recentOutput.splice(0, progress.recentOutput.length - 50);
						}
					}
					fireUpdate();
				}
			} catch {
				// Non-JSON stdout lines are expected; only structured events are parsed.
			}
		};

		proc.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});
		proc.stderr.on("data", (d) => {
			stderrBuf += d.toString();
		});
		proc.on("close", (code) => {
			processClosed = true;
			if (buf.trim()) processLine(buf);
			if (code !== 0 && stderrBuf.trim() && !result.error) {
				result.error = stderrBuf.trim();
			}
			resolve(code ?? 0);
		});
		proc.on("error", () => resolve(1));

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});

	if (closeJsonlWriter) {
		try {
			await closeJsonlWriter();
		} catch {
			// JSONL artifact flush is best effort.
		}
	}

	cleanupTempDir(tempDir);
	result.exitCode = exitCode;

	if (exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages);
		if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}

	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	if (result.error) {
		progress.error = result.error;
		if (progress.currentTool) {
			progress.failedTool = progress.currentTool;
		}
	}

	result.progress = progress;
	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	let fullOutput = getFinalOutput(result.messages);
	if (options.outputPath && result.exitCode === 0) {
		const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, outputSnapshot);
		fullOutput = resolvedOutput.fullOutput;
		result.savedOutputPath = resolvedOutput.savedPath;
		result.outputSaveError = resolvedOutput.saveError;
	}
	result.finalOutput = fullOutput;

	if (artifactPathsResult && artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;

		if (artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, fullOutput);
		}
		if (artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId,
				agent: agent.name,
				task,
				exitCode: result.exitCode,
				usage: result.usage,
				model: result.model,
				durationMs: progress.durationMs,
				toolCount: progress.toolCount,
				error: result.error,
				skills: result.skills,
				skillsWarning: result.skillsWarning,
				timestamp: Date.now(),
			});
		}

		if (maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
			const truncationResult = truncateOutput(fullOutput, config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) {
				result.truncation = truncationResult;
			}
		}
	} else if (maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
		const truncationResult = truncateOutput(fullOutput, config);
		if (truncationResult.truncated) {
			result.truncation = truncationResult;
		}
	}

	if (shareEnabled) {
		const sessionFile = options.sessionFile
			?? (options.sessionDir ? findLatestSessionFile(options.sessionDir) : null);
		if (sessionFile) {
			result.sessionFile = sessionFile;
		}
	}

	return {
		ok: result.exitCode === 0,
		result,
		exitCode: result.exitCode,
		error: result.error,
		stderr: stderrBuf.trim() || undefined,
		output: fullOutput,
	};
}

/**
 * Run a subagent synchronously (blocking until complete)
 */
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return buildFailureResult(agentName, task, `Unknown agent: ${agentName}`);
	}

	const attemptResults: SingleResult[] = [];
	const execution = await executeWithRuntimeModelFallback<SingleResult>({
		context: options.runtimeModelContext,
		modelOverride: options.modelOverride,
		agentModel: agent.model,
		agentThinking: agent.thinking,
		makeFailureResult: (message) => buildFailureResult(agent.name, task, message),
		executeAttempt: async (candidate) => {
			const attempt = await runSyncAttempt(runtimeCwd, agent, task, options, candidate?.normalizedModel ?? candidate?.model);
			attemptResults.push(attempt.result);
			return attempt;
		},
		onAttemptEvent: (event) => {
			const latestResult = attemptResults.at(-1);
			if (!latestResult) return;
			if (event.type === "retry") {
				const nextModel = event.nextCandidate?.model ?? "next candidate";
				emitFallbackUpdate(options.onUpdate, latestResult, `fallback: ${event.attempt.classification} (${event.attempt.reason}), trying ${nextModel}`);
			} else if (event.type === "skipped") {
				emitFallbackUpdate(options.onUpdate, latestResult, `fallback: skipped ${event.candidate.model} (${event.attempt.cooldownScope} cooldown)`);
			} else if (event.type === "stop") {
				emitFallbackUpdate(options.onUpdate, latestResult, `fallback: stopped on ${event.candidate.model} (${event.attempt.classification})`);
			} else if (event.type === "exhausted") {
				emitFallbackUpdate(options.onUpdate, latestResult, `fallback: exhausted ${event.attempts.length} candidates`);
			}
		},
	});

	const finalResult = execution.result;
	finalResult.usage = mergeUsage(attemptResults);
	finalResult.requestedModel = execution.requestedModel;
	finalResult.finalModel = finalResult.model ?? execution.finalModel;
	finalResult.modelAttempts = execution.modelAttempts;
	finalResult.fallbackSummary = execution.fallbackSummary;
	if (finalResult.progressSummary) {
		finalResult.progressSummary.durationMs = attemptResults.reduce(
			(total, result) => total + (result.progressSummary?.durationMs ?? 0),
			0,
		);
		finalResult.progressSummary.toolCount = attemptResults.reduce(
			(total, result) => total + (result.progressSummary?.toolCount ?? 0),
			0,
		);
		finalResult.progressSummary.tokens = attemptResults.reduce(
			(total, result) => total + (result.progressSummary?.tokens ?? 0),
			0,
		);
	}
	if (finalResult.progress) {
		finalResult.progress.durationMs = attemptResults.reduce(
			(total, result) => total + (result.progress?.durationMs ?? 0),
			0,
		);
		finalResult.progress.toolCount = attemptResults.reduce(
			(total, result) => total + (result.progress?.toolCount ?? 0),
			0,
		);
		finalResult.progress.tokens = finalResult.usage.input + finalResult.usage.output;
		finalResult.progress.status = finalResult.exitCode === 0 ? "completed" : "failed";
		if (finalResult.fallbackSummary) {
			finalResult.progress.recentOutput.push(finalResult.fallbackSummary);
			if (finalResult.progress.recentOutput.length > 50) {
				finalResult.progress.recentOutput.splice(0, finalResult.progress.recentOutput.length - 50);
			}
		}
	}
	return finalResult;
}
