import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type AgentConfig, type AgentScope } from "./agents.js";
import { getArtifactsDir } from "./artifacts.js";
import { ChainClarifyComponent, type ChainClarifyResult, type ModelInfo } from "./chain-clarify.js";
import { executeChain } from "./chain-execution.js";
import { resolveExecutionAgentScope } from "./agent-scope.js";
import { handleManagementAction } from "./agent-management.js";
import { runSync } from "./execution.js";
import { aggregateParallelOutputs } from "./parallel-utils.js";
import { recordRun } from "./run-history.js";
import {
	getStepAgents,
	isParallelStep,
	resolveStepBehavior,
	type ChainStep,
	type SequentialStep,
} from "./settings.js";
import { discoverAvailableSkills, normalizeSkillInput } from "./skills.js";
import { executeAsyncChain, executeAsyncSingle, isAsyncAvailable } from "./async-execution.js";
import { finalizeSingleOutput, injectSingleOutputInstruction, resolveSingleOutputPath } from "./single-output.js";
import { getFinalOutput, mapConcurrent } from "./utils.js";
import {
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	type Details,
	type ExtensionConfig,
	type MaxOutputConfig,
	type SingleResult,
	type SubagentState,
	DEFAULT_ARTIFACT_CONFIG,
	MAX_CONCURRENCY,
	MAX_PARALLEL,
	checkSubagentDepth,
} from "./types.js";

interface TaskParam {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	skill?: string | string[] | boolean;
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
}

interface SubagentParamsLike {
	action?: string;
	agent?: string;
	task?: string;
	chain?: ChainStep[];
	tasks?: TaskParam[];
	async?: boolean;
	clarify?: boolean;
	share?: boolean;
	sessionDir?: string;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifacts?: boolean;
	includeProgress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	agentScope?: unknown;
	chainDir?: string;
}

interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: ExtensionConfig;
	asyncByDefault: boolean;
	tempArtifactsDir: string;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[] };
}

interface ExecutionContextData {
	params: SubagentParamsLike;
	ctx: ExtensionContext;
	signal: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	agents: AgentConfig[];
	runId: string;
	shareEnabled: boolean;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	parallelDowngraded: boolean;
	effectiveAsync: boolean;
}

function validateExecutionInput(
	params: SubagentParamsLike,
	agents: AgentConfig[],
	hasChain: boolean,
	hasTasks: boolean,
	hasSingle: boolean,
): AgentToolResult<Details> | null {
	if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
		return {
			content: [
				{
					type: "text",
					text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
				},
			],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	if (hasChain && params.chain) {
		if (params.chain.length === 0) {
			return {
				content: [{ type: "text", text: "Chain must have at least one step" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const firstStep = params.chain[0] as ChainStep;
		if (isParallelStep(firstStep)) {
			const missingTaskIndex = firstStep.parallel.findIndex((t) => !t.task);
			if (missingTaskIndex !== -1) {
				return {
					content: [{ type: "text", text: `First parallel step: task ${missingTaskIndex + 1} must have a task (no previous output to reference)` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		} else if (!(firstStep as SequentialStep).task && !params.task) {
			return {
				content: [{ type: "text", text: "First step in chain must have a task" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i] as ChainStep;
			const stepAgents = getStepAgents(step);
			for (const agentName of stepAgents) {
				if (!agents.find((a) => a.name === agentName)) {
					return {
						content: [{ type: "text", text: `Unknown agent: ${agentName} (step ${i + 1})` }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
			}
			if (isParallelStep(step) && step.parallel.length === 0) {
				return {
					content: [{ type: "text", text: `Parallel step ${i + 1} must have at least one task` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		}
	}

	return null;
}

function runAsyncPath(data: ExecutionContextData, deps: ExecutorDeps): AgentToolResult<Details> | null {
	const { params, agents, ctx, shareEnabled, sessionRoot, artifactConfig, artifactsDir, effectiveAsync } = data;
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	if (!effectiveAsync) return null;

	if (!isAsyncAvailable()) {
		return {
			content: [{ type: "text", text: "Async mode requires jiti for TypeScript execution but it could not be found. Install globally: npm install -g jiti" }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}
	const id = randomUUID();
	const asyncCtx = { pi: deps.pi, cwd: ctx.cwd, currentSessionId: deps.state.currentSessionId! };

	if (hasChain && params.chain) {
		const normalized = normalizeSkillInput(params.skill);
		const chainSkills = normalized === false ? [] : (normalized ?? []);
		return executeAsyncChain(id, {
			chain: params.chain as ChainStep[],
			agents,
			ctx: asyncCtx,
			cwd: params.cwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills,
		});
	}

	if (hasSingle) {
		const a = agents.find((x) => x.name === params.agent);
		if (!a) {
			return {
				content: [{ type: "text", text: `Unknown: ${params.agent}` }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}
		const rawOutput = params.output !== undefined ? params.output : a.output;
		const effectiveOutput: string | false | undefined = rawOutput === true ? a.output : (rawOutput as string | false | undefined);
		return executeAsyncSingle(id, {
			agent: params.agent!,
			task: params.task!,
			agentConfig: a,
			ctx: asyncCtx,
			cwd: params.cwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			skills: (() => {
				const normalized = normalizeSkillInput(params.skill);
				if (normalized === false) return [];
				if (normalized === undefined) return undefined;
				return normalized;
			})(),
			output: effectiveOutput,
		});
	}

	return null;
}

async function runChainPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const { params, agents, ctx, signal, runId, shareEnabled, sessionDirForIndex, artifactsDir, artifactConfig, onUpdate, sessionRoot } = data;
	const normalized = normalizeSkillInput(params.skill);
	const chainSkills = normalized === false ? [] : (normalized ?? []);
	const chainResult = await executeChain({
		chain: params.chain as ChainStep[],
		task: params.task,
		agents,
		ctx,
		signal,
		runId,
		cwd: params.cwd,
		shareEnabled,
		sessionDirForIndex,
		artifactsDir,
		artifactConfig,
		includeProgress: params.includeProgress,
		clarify: params.clarify,
		onUpdate,
		chainSkills,
		chainDir: params.chainDir,
	});

	if (chainResult.requestedAsync) {
		if (!isAsyncAvailable()) {
			return {
				content: [{ type: "text", text: "Background mode requires jiti for TypeScript execution but it could not be found." }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const id = randomUUID();
		const asyncCtx = { pi: deps.pi, cwd: ctx.cwd, currentSessionId: deps.state.currentSessionId! };
		return executeAsyncChain(id, {
			chain: chainResult.requestedAsync.chain,
			agents,
			ctx: asyncCtx,
			cwd: params.cwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills: chainResult.requestedAsync.chainSkills,
		});
	}

	return chainResult;
}

async function runParallelPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const { params, agents, ctx, signal, runId, sessionDirForIndex, shareEnabled, artifactConfig, artifactsDir, parallelDowngraded, onUpdate, sessionRoot } = data;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const tasks = params.tasks!;

	if (tasks.length > MAX_PARALLEL)
		return {
			content: [{ type: "text", text: `Max ${MAX_PARALLEL} tasks` }],
			isError: true,
			details: { mode: "parallel" as const, results: [] },
		};

	const agentConfigs: AgentConfig[] = [];
	for (const t of tasks) {
		const config = agents.find((a) => a.name === t.agent);
		if (!config) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
				isError: true,
				details: { mode: "parallel" as const, results: [] },
			};
		}
		agentConfigs.push(config);
	}

	let taskTexts = tasks.map((t) => t.task);
	const modelOverrides: (string | undefined)[] = tasks.map((t) => t.model);
	const skillOverrides: (string[] | false | undefined)[] = tasks.map((t) =>
		normalizeSkillInput(t.skill),
	);

	if (params.clarify === true && ctx.hasUI) {
		const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({
			provider: m.provider,
			id: m.id,
			fullId: `${m.provider}/${m.id}`,
		}));

		const behaviors = agentConfigs.map((c, i) =>
			resolveStepBehavior(c, { skills: skillOverrides[i] }),
		);
		const availableSkills = discoverAvailableSkills(ctx.cwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					agentConfigs,
					taskTexts,
					"",
					undefined,
					behaviors,
					availableModels,
					availableSkills,
					done,
					"parallel",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "parallel", results: [] } };
		}

		taskTexts = result.templates;
		for (let i = 0; i < result.behaviorOverrides.length; i++) {
			const override = result.behaviorOverrides[i];
			if (override?.model) modelOverrides[i] = override.model;
			if (override?.skills !== undefined) skillOverrides[i] = override.skills;
		}

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires jiti for TypeScript execution but it could not be found." }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
			const id = randomUUID();
			const asyncCtx = { pi: deps.pi, cwd: ctx.cwd, currentSessionId: deps.state.currentSessionId! };
			const parallelTasks = tasks.map((t, i) => ({
				agent: t.agent,
				task: taskTexts[i]!,
				cwd: t.cwd,
				...(modelOverrides[i] ? { model: modelOverrides[i] } : {}),
				...(skillOverrides[i] !== undefined ? { skill: skillOverrides[i] } : {}),
			}));
			return executeAsyncChain(id, {
				chain: [{ parallel: parallelTasks }],
				agents,
				ctx: asyncCtx,
				cwd: params.cwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				chainSkills: [],
			});
		}
	}

	const behaviors = agentConfigs.map((c) => resolveStepBehavior(c, {}));
	const liveResults: (SingleResult | undefined)[] = new Array(tasks.length).fill(undefined);
	const liveProgress: (AgentProgress | undefined)[] = new Array(tasks.length).fill(undefined);
	const results = await mapConcurrent(tasks, MAX_CONCURRENCY, async (t, i) => {
		const overrideSkills = skillOverrides[i];
		const effectiveSkills = overrideSkills === undefined ? behaviors[i]?.skills : overrideSkills;
		return runSync(ctx.cwd, agents, t.agent, taskTexts[i]!, {
			cwd: t.cwd ?? params.cwd,
			signal,
			runId,
			index: i,
			sessionDir: sessionDirForIndex(i),
			share: shareEnabled,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			maxOutput: params.maxOutput,
			modelOverride: modelOverrides[i],
			skills: effectiveSkills === false ? [] : effectiveSkills,
			onUpdate: onUpdate
				? (p) => {
						const stepResults = p.details?.results || [];
						const stepProgress = p.details?.progress || [];
						if (stepResults.length > 0) liveResults[i] = stepResults[0];
						if (stepProgress.length > 0) liveProgress[i] = stepProgress[0];
						const mergedResults = liveResults.filter((r): r is SingleResult => r !== undefined);
						const mergedProgress = liveProgress.filter((pg): pg is AgentProgress => pg !== undefined);
						onUpdate({
							content: p.content,
							details: {
								mode: "parallel",
								results: mergedResults,
								progress: mergedProgress,
								totalSteps: tasks.length,
							},
						});
					}
				: undefined,
		});
	});
	for (let i = 0; i < results.length; i++) {
		const run = results[i]!;
		recordRun(run.agent, taskTexts[i]!, run.exitCode, run.progressSummary?.durationMs ?? 0);
	}

	for (const r of results) {
		if (r.progress) allProgress.push(r.progress);
		if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);
	}

	const ok = results.filter((r) => r.exitCode === 0).length;
	const downgradeNote = parallelDowngraded ? " (async not supported for parallel)" : "";
	const aggregatedOutput = aggregateParallelOutputs(
		results.map((r) => ({
			agent: r.agent,
			output: r.truncation?.text || getFinalOutput(r.messages),
			exitCode: r.exitCode,
			error: r.error,
		})),
		(i, agent) => `=== Task ${i + 1}: ${agent} ===`,
	);

	const summary = `${ok}/${results.length} succeeded${downgradeNote}`;
	const fullContent = `${summary}\n\n${aggregatedOutput}`;

	return {
		content: [{ type: "text", text: fullContent }],
		details: {
			mode: "parallel",
			results,
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		},
	};
}

async function runSinglePath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const { params, agents, ctx, signal, runId, sessionDirForIndex, shareEnabled, artifactConfig, artifactsDir, onUpdate, sessionRoot } = data;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const agentConfig = agents.find((a) => a.name === params.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}

	let task = params.task!;
	let modelOverride: string | undefined = params.model as string | undefined;
	let skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
	const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
	let effectiveOutput: string | false | undefined = rawOutput === true ? agentConfig.output : (rawOutput as string | false | undefined);

	if (params.clarify === true && ctx.hasUI) {
		const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({
			provider: m.provider,
			id: m.id,
			fullId: `${m.provider}/${m.id}`,
		}));

		const behavior = resolveStepBehavior(agentConfig, { output: effectiveOutput, skills: skillOverride });
		const availableSkills = discoverAvailableSkills(ctx.cwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					[agentConfig],
					[task],
					task,
					undefined,
					[behavior],
					availableModels,
					availableSkills,
					done,
					"single",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "single", results: [] } };
		}

		task = result.templates[0]!;
		const override = result.behaviorOverrides[0];
		if (override?.model) modelOverride = override.model;
		if (override?.output !== undefined) effectiveOutput = override.output;
		if (override?.skills !== undefined) skillOverride = override.skills;

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires jiti for TypeScript execution but it could not be found." }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}
			const id = randomUUID();
			const asyncCtx = { pi: deps.pi, cwd: ctx.cwd, currentSessionId: deps.state.currentSessionId! };
			return executeAsyncSingle(id, {
				agent: params.agent!,
				task,
				agentConfig,
				ctx: asyncCtx,
				cwd: params.cwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				skills: skillOverride === false ? [] : skillOverride,
				output: effectiveOutput,
			});
		}
	}

	const cleanTask = task;
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, params.cwd);
	task = injectSingleOutputInstruction(task, outputPath);

	const effectiveSkills = skillOverride === false
		? []
		: skillOverride === undefined
			? undefined
			: skillOverride;

	const r = await runSync(ctx.cwd, agents, params.agent!, task, {
		cwd: params.cwd,
		signal,
		runId,
		sessionDir: sessionDirForIndex(0),
		share: shareEnabled,
		artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
		artifactConfig,
		maxOutput: params.maxOutput,
		onUpdate,
		modelOverride,
		skills: effectiveSkills,
	});
	recordRun(params.agent!, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);

	if (r.progress) allProgress.push(r.progress);
	if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

	const fullOutput = getFinalOutput(r.messages);
	const finalizedOutput = finalizeSingleOutput({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath,
		exitCode: r.exitCode,
	});

	if (r.exitCode !== 0)
		return {
			content: [{ type: "text", text: r.error || "Failed" }],
			details: {
				mode: "single",
				results: [r],
				progress: params.includeProgress ? allProgress : undefined,
				artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
				truncation: r.truncation,
			},
			isError: true,
		};
	return {
		content: [{ type: "text", text: finalizedOutput.displayOutput || "(no output)" }],
		details: {
			mode: "single",
			results: [r],
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
			truncation: r.truncation,
		},
	};
}

export function createSubagentExecutor(deps: ExecutorDeps): {
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
} {
	const execute = async (
		_id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Details>> => {
		deps.state.baseCwd = ctx.cwd;
		if (params.action) {
			const validActions = ["list", "get", "create", "update", "delete"];
			if (!validActions.includes(params.action)) {
				return {
					content: [{ type: "text", text: `Unknown action: ${params.action}. Valid: ${validActions.join(", ")}` }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				};
			}
			return handleManagementAction(params.action, params, ctx);
		}

		const { blocked, depth, maxDepth } = checkSubagentDepth();
		if (blocked) {
			return {
				content: [
					{
						type: "text",
						text:
							`Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
							"You are running at the maximum subagent nesting depth. " +
							"Complete your current task directly without delegating to further subagents.",
					},
				],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}

		const scope: AgentScope = resolveExecutionAgentScope(params.agentScope);
		const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		deps.state.currentSessionId = parentSessionFile ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const agents = deps.discoverAgents(ctx.cwd, scope).agents;
		const runId = randomUUID().slice(0, 8);
		const shareEnabled = params.share === true;
		const sessionRoot = params.sessionDir
			? path.resolve(deps.expandTilde(params.sessionDir))
			: path.join(
				deps.config.defaultSessionDir
					? path.resolve(deps.expandTilde(deps.config.defaultSessionDir))
					: deps.getSubagentSessionRoot(parentSessionFile),
				runId,
			);
		try {
			fs.mkdirSync(sessionRoot, { recursive: true });
		} catch {}
		const sessionDirForIndex = (idx?: number) =>
			path.join(sessionRoot, `run-${idx ?? 0}`);

		const hasChain = (params.chain?.length ?? 0) > 0;
		const hasTasks = (params.tasks?.length ?? 0) > 0;
		const hasSingle = Boolean(params.agent && params.task);

		const requestedAsync = params.async ?? deps.asyncByDefault;
		const parallelDowngraded = hasTasks && requestedAsync;
		const effectiveAsync = requestedAsync && !hasTasks && (
			hasChain
				? params.clarify === false
				: params.clarify !== true
		);

		const artifactConfig: ArtifactConfig = {
			...DEFAULT_ARTIFACT_CONFIG,
			enabled: params.artifacts !== false,
		};
		const artifactsDir = effectiveAsync ? deps.tempArtifactsDir : getArtifactsDir(parentSessionFile);

		const validationError = validateExecutionInput(params, agents, hasChain, hasTasks, hasSingle);
		if (validationError) return validationError;

		const execData: ExecutionContextData = {
			params,
			ctx,
			signal,
			onUpdate,
			agents,
			runId,
			shareEnabled,
			sessionRoot,
			sessionDirForIndex,
			artifactConfig,
			artifactsDir,
			parallelDowngraded,
			effectiveAsync,
		};

		const asyncResult = runAsyncPath(execData, deps);
		if (asyncResult) return asyncResult;

		if (hasChain && params.chain) {
			return runChainPath(execData, deps);
		}

		if (hasTasks && params.tasks) {
			return runParallelPath(execData, deps);
		}

		if (hasSingle) {
			return runSinglePath(execData, deps);
		}

		return {
			content: [{ type: "text", text: "Invalid params" }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	};

	return { execute };
}
