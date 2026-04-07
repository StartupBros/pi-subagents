import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ExtensionConfig, RuntimeModelExecutionContext } from "./types.ts";
import { normalizeModelId } from "./runtime-model-fallback.ts";

export function getAvailableModelsSnapshot(ctx: ExtensionContext): RuntimeModelExecutionContext["availableModels"] {
	return ctx.modelRegistry.getAvailable().map((model) => ({
		provider: model.provider,
		id: model.id,
		fullId: `${model.provider}/${model.id}`,
	}));
}

export function getCurrentSessionModelSnapshot(
	ctx: ExtensionContext,
	availableModels: RuntimeModelExecutionContext["availableModels"],
): string | undefined {
	const currentModel = (ctx as ExtensionContext & { model?: { provider?: string; id?: string; fullId?: string } }).model;
	if (!currentModel) return undefined;
	if (typeof currentModel.fullId === "string" && currentModel.fullId.length > 0) return currentModel.fullId;
	if (currentModel.provider && currentModel.id) return `${currentModel.provider}/${currentModel.id}`;
	if (currentModel.id) return normalizeModelId(currentModel.id, availableModels);
	return undefined;
}

export function buildRuntimeModelContext(
	ctx: ExtensionContext,
	config: ExtensionConfig,
	cooldownRoot: string,
): RuntimeModelExecutionContext {
	const availableModels = getAvailableModelsSnapshot(ctx);
	return {
		availableModels,
		currentSessionModel: getCurrentSessionModelSnapshot(ctx, availableModels),
		config: {
			preferCurrentSessionModel: config.preferCurrentSessionModel,
			fallbackModels: config.fallbackModels,
			cooldownMinutes: config.cooldownMinutes,
		},
		cooldownPath: path.join(cooldownRoot, "runtime-model-fallback-cooldowns.json"),
	};
}
