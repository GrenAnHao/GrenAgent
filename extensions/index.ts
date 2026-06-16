// Aggregate export of all extension factories, for embedding them directly
// into a branded CLI via DefaultResourceLoader's `extensionFactories` option
// (no -e / no pi install needed — they're compiled into the product).

import autoTitle from "./auto-title/index.js";
import checkpoint from "./checkpoint/index.js";
import compactionPolicy from "./compaction-policy/index.js";
import loopGuard from "./loop-guard/index.js";
import codeReview from "./code-review/index.js";
import codeSearch from "./code-search/index.js";
import diagnostics from "./diagnostics/index.js";
import imGateway from "./im-gateway/index.js";
import goal from "./goal/index.js";
import imageGen from "./image-gen/index.js";
import knowledgeRag from "./knowledge-rag/index.js";
import longTermMemory from "./long-term-memory/index.js";
import sessionMemory from "./session-memory/index.js";
import mcp from "./mcp/index.js";
import mcpPolicy from "./mcp-policy/index.js";
import multiAgent from "./multi-agent/index.js";
import codeIntel from "./code-intel/index.js";
import planMode from "./plan-mode/index.js";
import safety from "./safety/index.js";
import todo from "./todo/index.js";
import tts from "./tts/index.js";
import webFetch from "./web-fetch/index.js";
import sessionSearch from "./session-search/index.js";
import webSearch from "./web-search/index.js";

export {
  safety,
  loopGuard,
  compactionPolicy,
  autoTitle,
  checkpoint,
  todo,
  planMode,
  goal,
  knowledgeRag,
  longTermMemory,
  sessionMemory,
  webFetch,
  webSearch,
  sessionSearch,
  mcp,
  mcpPolicy,
  imageGen,
  codeReview,
  diagnostics,
  multiAgent,
  codeIntel,
  codeSearch,
  tts,
  imGateway,
};

// Order roughly by general usefulness; safety first so guardrails intercept earliest.
export const allExtensions = [
  safety,
  loopGuard,
  compactionPolicy,
  autoTitle,
  checkpoint,
  todo,
  planMode,
  goal,
  knowledgeRag,
  longTermMemory,
  sessionMemory,
  webFetch,
  webSearch,
  sessionSearch,
  mcp,
  mcpPolicy,
  imageGen,
  codeReview,
  diagnostics,
  multiAgent,
  codeIntel,
  codeSearch,
  tts,
  imGateway,
];
