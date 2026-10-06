import anthropicDefinition from "./anthropic.ts";
import deepseekDefinition from "./deepseek.ts";
import geminiDefinition from "./gemini.ts";
import gemmaDefinition from "./gemma.ts";
import glmDefinition from "./glm.ts";
import harmonyDefinition from "./harmony.ts";
import hermesDefinition from "./hermes.ts";
import kimiDefinition from "./kimi.ts";
import minimaxDefinition from "./minimax.ts";
import qwen3Definition from "./qwen3.ts";
import type { Dialect, DialectDefinition, InbandScanner, InbandScannerOptions } from "./types";
import xmlDefinition from "./xml.ts";

const DIALECT_DEFINITIONS: Record<Dialect, DialectDefinition> = {
	glm: glmDefinition,
	hermes: hermesDefinition,
	kimi: kimiDefinition,
	xml: xmlDefinition,
	anthropic: anthropicDefinition,
	deepseek: deepseekDefinition,
	minimax: minimaxDefinition,
	harmony: harmonyDefinition,
	qwen3: qwen3Definition,
	gemini: geminiDefinition,
	gemma: gemmaDefinition,
};

export function getDialectDefinition(dialect: Dialect): DialectDefinition {
	return DIALECT_DEFINITIONS[dialect];
}

export function createInbandScanner(dialect: Dialect, options: InbandScannerOptions = {}): InbandScanner {
	return getDialectDefinition(dialect).createScanner(options);
}
