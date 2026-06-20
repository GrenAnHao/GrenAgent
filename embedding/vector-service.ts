// vector-service.ts —— 核心向量服务（TypeScript，最终打包为 CommonJS）
// 在普通 node 环境与 SEA（单可执行）环境中均可运行。

import path = require('node:path');
import Module = require('node:module');

type SeaApi = {
  isSea?: () => boolean;
};

type TransformerEnv = {
  cacheDir: string;
  remoteHost?: string;
};

type TensorLike = {
  data: Iterable<number> | ArrayLike<number>;
  dims?: number[];
};

type FeatureExtractor = (
  text: string | string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<TensorLike>;

type Transformers = {
  env: TransformerEnv;
  pipeline: (
    task: 'feature-extraction',
    model: string,
    options: { quantized: boolean },
  ) => Promise<FeatureExtractor>;
};

// ---------- 1) SEA 环境检测 ----------
let sea: SeaApi | null = null;
try { sea = require('node:sea') as SeaApi; } catch (_) { sea = null; }
export const isSea = !!(sea && typeof sea.isSea === 'function' && sea.isSea());

// SEA 中 __dirname 指向 blob 内部（只读），改用可执行文件所在目录做运行时根目录。
export const APP_ROOT = isSea ? path.dirname(process.execPath) : __dirname;

const realRequire = Module.createRequire(path.join(APP_ROOT, 'package.json'));
(globalThis as typeof globalThis & { __seaRequire?: NodeRequire }).__seaRequire = realRequire;

// ---------- 2) 模型 ----------
/** transformers.js 模型 ID（ONNX 权重由 Xenova 维护）。 */
export const DEFAULT_MODEL_ID = 'Xenova/bge-small-zh-v1.5';
/** OpenAI 兼容响应里的 model 字段（Pi settings 里填这个或任意字符串均可）。 */
export const DEFAULT_OPENAI_MODEL = process.env.EMBED_OPENAI_MODEL || 'bge-small-zh-v1.5';

const MODEL_ID = process.env.EMBED_MODEL || DEFAULT_MODEL_ID;

let pipe: FeatureExtractor | null = null;

async function getPipeline(): Promise<FeatureExtractor> {
  if (pipe) return pipe;

  const { pipeline, env } = require('@huggingface/transformers') as Transformers;
  env.cacheDir = path.join(APP_ROOT, '.models');

  const endpoint = process.env.HF_ENDPOINT;
  if (endpoint && !['0', 'false', ''].includes(endpoint.toLowerCase())) {
    env.remoteHost = endpoint.replace(/\/$/, '');
  }

  pipe = await pipeline('feature-extraction', MODEL_ID, { quantized: true });
  return pipe;
}

function tensorToVectors(out: TensorLike, count: number): number[][] {
  const flat = Array.from(out.data as ArrayLike<number>);
  const dims = out.dims;
  // 批量：[batch, dim]；单条：[dim] 或 [1, dim]。
  if (count === 1) {
    const dim = dims && dims.length >= 2 ? dims[dims.length - 1] : flat.length;
    return [flat.slice(flat.length - dim)];
  }
  const dim = dims && dims.length >= 2 ? dims[dims.length - 1] : Math.floor(flat.length / count);
  const vectors: number[][] = [];
  for (let i = 0; i < count; i += 1) vectors.push(flat.slice(i * dim, (i + 1) * dim));
  return vectors;
}

/**
 * 批量文本 → L2 归一化向量。空串会被跳过；若全部为 empty 则抛错。
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const cleaned = texts.map((t) => (t ?? '').trim()).filter(Boolean);
  if (cleaned.length === 0) throw new Error('input must contain at least one non-empty string');

  const extractor = await getPipeline();
  if (cleaned.length === 1) {
    const out = await extractor(cleaned[0], { pooling: 'mean', normalize: true });
    return tensorToVectors(out, 1);
  }

  // transformers.js 支持数组输入；失败时逐条回退（兼容旧行为）。
  try {
    const out = await extractor(cleaned, { pooling: 'mean', normalize: true });
    const vectors = tensorToVectors(out, cleaned.length);
    if (vectors.length === cleaned.length) return vectors;
  } catch {
    /* fall through */
  }

  const vectors: number[][] = [];
  for (const text of cleaned) {
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    vectors.push(...tensorToVectors(out, 1));
  }
  return vectors;
}

/** 单条便捷封装（legacy /embed）。 */
export async function getEmbedding(text: string): Promise<number[]> {
  const [vector] = await getEmbeddings([text]);
  return vector;
}
