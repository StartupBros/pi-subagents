/**
 * Integration tests for the shared runtime model fallback policy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createTempDir, removeTempDir, tryImport } from "../support/helpers.ts";

const runtimeFallback = await tryImport<any>("./runtime-model-fallback.ts");
const available = !!runtimeFallback;

const buildModelCandidates = runtimeFallback?.buildModelCandidates;
const classifyRuntimeModelFailure = runtimeFallback?.classifyRuntimeModelFailure;
const getCooldownSkipReason = runtimeFallback?.getCooldownSkipReason;
const updateCooldownStore = runtimeFallback?.updateCooldownStore;

describe("runtime model fallback policy", { skip: !available ? "runtime-model-fallback not importable" : undefined }, () => {
	it("builds candidates in override -> session -> agent -> fallback order with dedupe", () => {
		const candidates = buildModelCandidates({
			context: {
				availableModels: [
					{ provider: "anthropic", id: "claude-sonnet-4-5", fullId: "anthropic/claude-sonnet-4-5" },
					{ provider: "openai", id: "gpt-4.1", fullId: "openai/gpt-4.1" },
				],
				currentSessionModel: "gpt-4.1",
				config: {
					preferCurrentSessionModel: true,
					fallbackModels: ["claude-sonnet-4-5", "gpt-4.1"],
				},
			},
			modelOverride: "claude-sonnet-4-5",
			agentModel: "gpt-4.1",
			agentThinking: "high",
		});

		assert.deepEqual(
			candidates.map((candidate: any) => [candidate.source, candidate.model]),
			[
				["override", "claude-sonnet-4-5:high"],
				["session", "gpt-4.1:high"],
			],
		);
	});

	it("omits current session model when preferCurrentSessionModel is false", () => {
		const candidates = buildModelCandidates({
			context: {
				availableModels: [{ provider: "openai", id: "gpt-4.1", fullId: "openai/gpt-4.1" }],
				currentSessionModel: "openai/gpt-4.1",
				config: { preferCurrentSessionModel: false, fallbackModels: ["openai/gpt-4.1", "openai/gpt-4.1-mini"] },
			},
			agentModel: "openai/gpt-4.1",
		});

		assert.deepEqual(
			candidates.map((candidate: any) => candidate.source),
			["agent", "fallback"],
		);
	});

	it("classifies provider/runtime failures conservatively", () => {
		assert.equal(
			classifyRuntimeModelFailure({ error: "429 rate limit exceeded by provider" }).classification,
			"retryable-runtime",
		);
		assert.equal(
			classifyRuntimeModelFailure({ error: "bash failed (exit 1): No such file or directory" }).classification,
			"deterministic",
		);
		assert.equal(
			classifyRuntimeModelFailure({ error: "weird unexplained issue" }).classification,
			"unknown",
		);
	});

	it("tracks cooldown by model and never skips explicit overrides", () => {
		const dir = createTempDir();
		try {
			const cooldownPath = path.join(dir, "cooldowns.json");
			updateCooldownStore(
				cooldownPath,
				{ model: "openai/gpt-4.1", source: "agent", normalizedModel: "openai/gpt-4.1" },
				{ classification: "retryable-runtime", reason: "429 rate limit", cooldownScope: "model" },
				{ cooldownMinutes: 10 },
			);
			const store = runtimeFallback.readCooldownStore(cooldownPath);
			assert.ok(getCooldownSkipReason({ model: "openai/gpt-4.1", source: "fallback", normalizedModel: "openai/gpt-4.1" }, store));
			assert.equal(
				getCooldownSkipReason({ model: "openai/gpt-4.1", source: "override", normalizedModel: "openai/gpt-4.1" }, store),
				null,
			);
		} finally {
			removeTempDir(dir);
		}
	});
});
