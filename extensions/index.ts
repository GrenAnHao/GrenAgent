// Aggregate export of all extension factories, for embedding them directly
// into a branded CLI via DefaultResourceLoader's `extensionFactories` option
// (no -e / no pi install needed — they're compiled into the product).

import autoTitle from "./auto-title/index.js";
import compactionPolicy from "./compaction-policy/index.js";
import loopGuard from "./loop-guard/index.js";
import rulebook from "./rulebook/index.js";
import astTools from "./ast-tools/index.js";
import github from "./github/index.js";
import batchTools from "./batch-tools/index.js";
import diagnostics from "./diagnostics/index.js";
import afterToolFeedback from "./after-tool-feedback/index.js";
import imGateway from "./im-gateway/index.js";
import imPlatforms from "./im-platforms/index.js";
import goal, { pluginManifest as goalManifest } from "./goal/index.js";
import imageGen from "./image-gen/index.js";
import sessionMemory from "./session-memory/index.js";
import mcp, { pluginManifest as mcpManifest } from "./mcp/index.js";
import mcpPolicy from "./mcp-policy/index.js";
import multiAgent from "./multi-agent/index.js";
import lsp from "./lsp/index.js";
import agentMode from "./agent-mode/index.js";
import debugTools from "./debug-tools/index.js";
import codeExec from "./code-exec/index.js";
import hashline from "./hashline/index.js";
import dap from "./dap/index.js";
import fableBehavior from "./fable-behavior/index.js";
import diagramHint from "./diagram-hint/index.js";
import safety from "./safety/index.js";
import approval from "./approval/index.js";
import sandbox from "./sandbox/index.js";
import todo from "./todo/index.js";
import tts from "./tts/index.js";
import visualCompanion from "./visual-companion/index.js";
import webFetch from "./web-fetch/index.js";
import webSearch, { pluginManifest as webSearchManifest } from "./web-search/index.js";
import resourceManager from "./resource-manager/index.js";
import memory from "./memory/index.js";
import codeRetrieval from "./code-retrieval/index.js";
import wikiRag from "./wiki-rag/index.js";
import { memoryManifest, wikiRagManifest, codeRetrievalManifest } from "./agent-data-manifests.js";

export {
  safety,
  approval,
  sandbox,
  loopGuard,
  rulebook,
  compactionPolicy,
  autoTitle,  todo,
  agentMode,
  debugTools,
  dap,
  diagramHint,
  fableBehavior,
  goal,
  sessionMemory,
  webFetch,
  webSearch,
  resourceManager,
  mcp,
  mcpPolicy,
  imageGen,  diagnostics,
  multiAgent,
  lsp,
  astTools,
  github,
  batchTools,
  codeExec,
  hashline,
  tts,
  visualCompanion,
  imGateway,
  imPlatforms,
  afterToolFeedback,
  memory,
  codeRetrieval,
  wikiRag,
};

// Order roughly by general usefulness; safety first so guardrails intercept earliest.
export const allExtensions = [
  safety,
  approval,
  sandbox,
  loopGuard,
  rulebook,
  compactionPolicy,
  autoTitle,  todo,
  agentMode,
  debugTools,
  dap,
  diagramHint,
  fableBehavior,
  goal,
  sessionMemory,
  webFetch,
  webSearch,
  resourceManager,
  mcp,
  mcpPolicy,
  imageGen,  diagnostics,
  multiAgent,
  lsp,
  astTools,
  github,
  batchTools,
  codeExec,
  hashline,
  tts,
  visualCompanion,
  imGateway,
  imPlatforms,
  afterToolFeedback,
  memory,
  codeRetrieval,
  wikiRag,
];

// 名→工厂映射（与 allExtensions 同序）：供 sidecar 按 EXTENSIONS_PROFILE 过滤加载（真对话模式裁重扩展）。
// 扩展工厂本身无稳定 name，故在此显式标注，名称对齐各扩展目录名。
export const namedExtensions: Array<{ name: string; factory: (typeof allExtensions)[number] }> = [
  { name: "safety", factory: safety },
  { name: "approval", factory: approval },
  { name: "sandbox", factory: sandbox },
  { name: "loop-guard", factory: loopGuard },
  { name: "rulebook", factory: rulebook },
  { name: "compaction-policy", factory: compactionPolicy },
  { name: "auto-title", factory: autoTitle },
  { name: "todo", factory: todo },
  { name: "agent-mode", factory: agentMode },
  { name: "debug-tools", factory: debugTools },
  { name: "dap", factory: dap },
  { name: "diagram-hint", factory: diagramHint },
  { name: "fable-behavior", factory: fableBehavior },
  { name: "goal", factory: goal },
  { name: "session-memory", factory: sessionMemory },
  { name: "web-fetch", factory: webFetch },
  { name: "web-search", factory: webSearch },
  { name: "resource-manager", factory: resourceManager },
  { name: "mcp", factory: mcp },
  { name: "mcp-policy", factory: mcpPolicy },
  { name: "image-gen", factory: imageGen },
  { name: "diagnostics", factory: diagnostics },
  { name: "multi-agent", factory: multiAgent },
  { name: "lsp", factory: lsp },
  { name: "ast-tools", factory: astTools },
  { name: "github", factory: github },
  { name: "batch-tools", factory: batchTools },
  { name: "code-exec", factory: codeExec },
  { name: "hashline", factory: hashline },
  { name: "tts", factory: tts },
  { name: "visual-companion", factory: visualCompanion },
  { name: "im-gateway", factory: imGateway },
  { name: "im-platforms", factory: imPlatforms },
  { name: "after-tool-feedback", factory: afterToolFeedback },
  { name: "memory", factory: memory },
  { name: "code-retrieval", factory: codeRetrieval },
  { name: "wiki-rag", factory: wikiRag },
];

export type ExtensionCapability = "agent" | "tool" | "mcp" | "provider" | "ui" | "event-subscriber";
export interface ExtensionManifest {
  id: string;
  version: string;
  apiVersion: string;
  capabilities: readonly ExtensionCapability[];
  permissions?: Readonly<Record<string, string>>;
}

const builtinManifests = new Map<string, ExtensionManifest>([
  [goalManifest.id, goalManifest],
  [webSearchManifest.id, webSearchManifest],
  [mcpManifest.id, mcpManifest],
  [memoryManifest.id, memoryManifest],
  [wikiRagManifest.id, wikiRagManifest],
  [codeRetrievalManifest.id, codeRetrievalManifest],
]);

// Adapter keeps the legacy static factory array intact while exposing lifecycle metadata.
export const manifestExtensions = namedExtensions.map((entry) => ({
  ...entry,
  manifest: builtinManifests.get(entry.name),
}));

export function selectAllowedExtensions(allowedIds: readonly string[]) {
  const allowed = new Set(allowedIds);
  return manifestExtensions.filter((entry) => allowed.has(entry.name));
}
