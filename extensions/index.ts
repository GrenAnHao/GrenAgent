// Aggregate export of all extension factories, for embedding them directly
// into a branded CLI via DefaultResourceLoader's `extensionFactories` option
// (no -e / no pi install needed — they're compiled into the product).

import codeReview from "./code-review/index.js";
import imGateway from "./im-gateway/index.js";
import imageGen from "./image-gen/index.js";
import knowledgeRag from "./knowledge-rag/index.js";
import longTermMemory from "./long-term-memory/index.js";
import multiAgent from "./multi-agent/index.js";
import tts from "./tts/index.js";
import webFetch from "./web-fetch/index.js";

export {
  knowledgeRag,
  longTermMemory,
  webFetch,
  imageGen,
  codeReview,
  multiAgent,
  tts,
  imGateway,
};

// Order roughly by general usefulness; tweak as you like.
export const allExtensions = [
  knowledgeRag,
  longTermMemory,
  webFetch,
  imageGen,
  codeReview,
  multiAgent,
  tts,
  imGateway,
];
