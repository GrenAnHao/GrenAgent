// 发往模型的图片尺寸上限：读图片头拿宽高，超限的才交给 resize。
// 纯函数部分不依赖 pi，resize 由调用方注入，便于测试。

export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageLimits {
  maxWidth: number;
  maxHeight: number;
  /** base64 之后的字节数上限，和 pi 的 resizeImage 用同一口径。 */
  maxBytes: number;
}

/** 与 pi 1.3.0 `image-resize-core` 的默认值一致：2000×2000、4.5MB base64。 */
export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: 4.5 * 1024 * 1024,
};

export interface ResizeOutcome {
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

export type ResizeFn = (block: ImageBlock, limits: ImageLimits) => Promise<ResizeOutcome | null>;

export function resolveLimits(override: Partial<ImageLimits> | undefined): ImageLimits {
  return {
    maxWidth: positive(override?.maxWidth) ?? DEFAULT_IMAGE_LIMITS.maxWidth,
    maxHeight: positive(override?.maxHeight) ?? DEFAULT_IMAGE_LIMITS.maxHeight,
    maxBytes: positive(override?.maxBytes) ?? DEFAULT_IMAGE_LIMITS.maxBytes,
  };
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// JPEG 的 SOF 段可能排在几十 KB 的 EXIF 后面，读前 256KB 足够。
const HEADER_BYTES = 256 * 1024;

/** 只解码 base64 开头一段，读 PNG / JPEG / GIF / WebP 的宽高；认不出返回 null。 */
export function readImageSize(base64: string): { width: number; height: number } | null {
  const chars = Math.min(base64.length, Math.ceil(HEADER_BYTES / 3) * 4);
  const b = Buffer.from(base64.slice(0, chars - (chars % 4)), "base64");
  if (b.length < 10) return null;

  // PNG：8 字节签名，IHDR 里宽高是大端 32 位。
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    if (b.length < 24) return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }

  // GIF：逻辑屏幕宽高，小端 16 位。
  if (b.toString("latin1", 0, 4) === "GIF8") {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }

  // JPEG：顺着段走到 SOFn（C0–CF，去掉 C4 DHT / C8 / CC DAC）。
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      // 没有长度字段的独立标记（RSTn、SOI、TEM）。
      if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }

  // WebP：RIFF....WEBP 后面是 VP8 / VP8L / VP8X 三种之一。
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" && b.length >= 30) {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8 ") {
      return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L") {
      const width = 1 + (((b[22] & 0x3f) << 8) | b[21]);
      const height = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
      return { width, height };
    }
    if (chunk === "VP8X") {
      const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { width, height };
    }
  }
  return null;
}

/** 超过宽、高或 base64 体积任一上限就要缩。宽高读不出来时只看体积。 */
export function exceedsLimits(block: ImageBlock, limits: ImageLimits): boolean {
  if (block.data.length > limits.maxBytes) return true;
  const size = readImageSize(block.data);
  if (!size) return false;
  return size.width > limits.maxWidth || size.height > limits.maxHeight;
}

export function omittedText(block: ImageBlock): TextBlock {
  const size = readImageSize(block.data);
  const dims = size ? ` ${size.width}x${size.height}` : "";
  return {
    type: "text",
    text: `[Image omitted: ${block.mimeType}${dims} exceeds the inline image limit and could not be resized.]`,
  };
}

/**
 * 把一组内容块里超限的图片换成缩过的。没有要换的返回原数组（引用不变），调用方据此判断有没有改动。
 * `onFail` 决定缩不下来时怎么办：输入阶段保留原图（交给 pi 自己再处理），请求阶段换成文字说明。
 */
export async function fitContentImages<T extends { type: string }>(
  content: readonly T[],
  limits: ImageLimits,
  resize: ResizeFn,
  onFail: "keep" | "omit",
): Promise<readonly (T | ImageBlock | TextBlock)[]> {
  let out: Array<T | ImageBlock | TextBlock> | undefined;
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!isImageBlock(block) || !exceedsLimits(block, limits)) {
      out?.push(block);
      continue;
    }
    let replacement: ImageBlock | TextBlock | undefined;
    try {
      const resized = await resize(block, limits);
      if (resized) replacement = { type: "image", data: resized.data, mimeType: resized.mimeType };
    } catch {
      replacement = undefined;
    }
    if (!replacement && onFail === "omit") replacement = omittedText(block);
    if (!replacement) {
      out?.push(block);
      continue;
    }
    out ??= content.slice(0, i) as Array<T | ImageBlock | TextBlock>;
    out.push(replacement);
  }
  return out ?? content;
}

export function isImageBlock(block: unknown): block is ImageBlock {
  const b = block as Partial<ImageBlock> | null;
  return !!b && b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string";
}

/**
 * 请求前过一遍整段上下文：user / custom / toolResult 里凡是数组形式的 content 都查。
 * 只改发往模型的副本；没有改动时返回 undefined。
 */
export async function fitContextImages<M>(
  messages: readonly M[],
  limits: ImageLimits,
  resize: ResizeFn,
): Promise<M[] | undefined> {
  let out: M[] | undefined;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as M & { content?: unknown };
    const content = msg?.content;
    if (!Array.isArray(content) || !content.some(isImageBlock)) {
      out?.push(messages[i]);
      continue;
    }
    const fitted = await fitContentImages(content as Array<{ type: string }>, limits, resize, "omit");
    if (fitted === content) {
      out?.push(messages[i]);
      continue;
    }
    out ??= messages.slice(0, i);
    out.push({ ...msg, content: fitted } as M);
  }
  return out;
}

/** 按原图内容记住缩放结果：老会话里的大图每次请求都会被看到，同一进程里只缩一次。 */
export function cachedResize(resize: ResizeFn, capacity = 64): ResizeFn {
  // 键直接用 base64 字符串本身（V8 会缓存字符串的哈希），不拼新串，免得每次查表都复制几 MB。
  const cache = new Map<string, { limitsKey: string; mimeType: string; result: ResizeOutcome | null }>();
  return async (block, limits) => {
    const limitsKey = `${limits.maxWidth}x${limits.maxHeight}/${limits.maxBytes}`;
    const hit = cache.get(block.data);
    if (hit && hit.limitsKey === limitsKey && hit.mimeType === block.mimeType) {
      cache.delete(block.data);
      cache.set(block.data, hit);
      return hit.result;
    }
    const result = await resize(block, limits);
    cache.delete(block.data);
    cache.set(block.data, { limitsKey, mimeType: block.mimeType, result });
    if (cache.size > capacity) cache.delete(cache.keys().next().value as string);
    return result;
  };
}
