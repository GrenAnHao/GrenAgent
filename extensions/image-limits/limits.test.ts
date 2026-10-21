import { deflateSync } from "node:zlib";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import imageLimits from "./index.js";
import {
  DEFAULT_IMAGE_LIMITS,
  cachedResize,
  exceedsLimits,
  fitContentImages,
  fitContextImages,
  readImageSize,
  resolveLimits,
  type ImageBlock,
  type ResizeFn,
} from "./limits.js";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** 真实可解码的灰度 PNG。 */
function png(width: number, height: number): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const row = Buffer.alloc(width + 1);
  for (let x = 0; x < width; x++) row[x + 1] = x % 256;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
function jpegHeader(width: number, height: number): string {
  const app1 = Buffer.alloc(2 + 2 + 1000); // 带一大段 APP1，SOF 不在开头
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(2 + 1000, 2);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.alloc(20)]).toString("base64");
}
function gifHeader(width: number, height: number): string {
  const b = Buffer.alloc(16);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b.toString("base64");
}
function webpVp8x(width: number, height: number): string {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  const w = width - 1;
  const h = height - 1;
  b[24] = w & 0xff;
  b[25] = (w >> 8) & 0xff;
  b[26] = (w >> 16) & 0xff;
  b[27] = h & 0xff;
  b[28] = (h >> 8) & 0xff;
  b[29] = (h >> 16) & 0xff;
  return b.toString("base64");
}

const img = (data: string, mimeType = "image/png"): ImageBlock => ({ type: "image", data, mimeType });
const fakeResize: ResizeFn = async (_block, limits) => ({
  data: png(limits.maxWidth, 10),
  mimeType: "image/png",
  width: limits.maxWidth,
  height: 10,
});

describe("readImageSize", () => {
  it("reads PNG, JPEG (SOF after APP1), GIF and WebP VP8X headers", () => {
    expect(readImageSize(png(3906, 3))).toEqual({ width: 3906, height: 3 });
    expect(readImageSize(jpegHeader(2559, 1527))).toEqual({ width: 2559, height: 1527 });
    expect(readImageSize(gifHeader(640, 480))).toEqual({ width: 640, height: 480 });
    expect(readImageSize(webpVp8x(4000, 1200))).toEqual({ width: 4000, height: 1200 });
  });

  it("returns null for data it cannot recognise", () => {
    expect(readImageSize(Buffer.from("not an image at all").toString("base64"))).toBeNull();
    expect(readImageSize("")).toBeNull();
  });
});

describe("exceedsLimits", () => {
  it("flags width, height or base64 size over the limit", () => {
    expect(exceedsLimits(img(png(2001, 2)), DEFAULT_IMAGE_LIMITS)).toBe(true);
    expect(exceedsLimits(img(png(2, 2001)), DEFAULT_IMAGE_LIMITS)).toBe(true);
    expect(exceedsLimits(img(png(2000, 2)), DEFAULT_IMAGE_LIMITS)).toBe(false);
    expect(exceedsLimits(img(png(10, 10)), { ...DEFAULT_IMAGE_LIMITS, maxBytes: 10 })).toBe(true);
  });

  it("model resize options override the defaults", () => {
    const limits = resolveLimits({ maxWidth: 1568, maxHeight: 1568 });
    expect(limits).toEqual({ maxWidth: 1568, maxHeight: 1568, maxBytes: DEFAULT_IMAGE_LIMITS.maxBytes });
    expect(exceedsLimits(img(png(1600, 2)), limits)).toBe(true);
  });
});

describe("fitContentImages", () => {
  it("keeps the same array when nothing exceeds the limit", async () => {
    const content = [{ type: "text", text: "hi" }, img(png(100, 100))];
    const resize = vi.fn(fakeResize);
    expect(await fitContentImages(content, DEFAULT_IMAGE_LIMITS, resize, "omit")).toBe(content);
    expect(resize).not.toHaveBeenCalled();
  });

  it("replaces only the oversized image and keeps block order", async () => {
    const small = img(png(100, 100));
    const content = [{ type: "text", text: "" }, img(png(3906, 3)), small];
    const out = await fitContentImages(content, DEFAULT_IMAGE_LIMITS, fakeResize, "omit");
    expect(out).not.toBe(content);
    expect(out[0]).toBe(content[0]);
    expect(readImageSize((out[1] as ImageBlock).data)).toEqual({ width: 2000, height: 10 });
    expect(out[2]).toBe(small);
  });

  it("keeps the original on failure for input, and omits it for requests", async () => {
    const big = img(png(3906, 3));
    const fail: ResizeFn = async () => null;
    expect(await fitContentImages([big], DEFAULT_IMAGE_LIMITS, fail, "keep")).toEqual([big]);
    const omitted = await fitContentImages([big], DEFAULT_IMAGE_LIMITS, async () => {
      throw new Error("photon missing");
    }, "omit");
    expect(omitted).toEqual([{ type: "text", text: expect.stringContaining("3906x3") }]);
  });
});

describe("fitContextImages", () => {
  it("fixes user, custom and toolResult messages and leaves the rest untouched", async () => {
    const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    const plain = { role: "user", content: "string content" };
    const messages = [
      plain,
      { role: "user", content: [{ type: "text", text: "" }, img(png(3906, 3))], timestamp: 1 },
      assistant,
      { role: "custom", customType: "x", content: [img(png(2160, 1350))] },
      { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "r" }, img(png(10, 10))] },
    ];
    const out = await fitContextImages(messages, DEFAULT_IMAGE_LIMITS, fakeResize);
    expect(out).toBeDefined();
    expect(out![0]).toBe(plain);
    expect(out![2]).toBe(assistant);
    expect(out![4]).toBe(messages[4]);
    expect((out![1] as { timestamp: number }).timestamp).toBe(1);
    expect(readImageSize(((out![1].content as unknown[])[1] as ImageBlock).data)?.width).toBe(2000);
    expect(readImageSize(((out![3].content as unknown[])[0] as ImageBlock).data)?.width).toBe(2000);
    // 原消息没被改动
    expect(readImageSize(((messages[1].content as unknown[])[1] as ImageBlock).data)?.width).toBe(3906);
  });

  it("returns undefined when every image already fits", async () => {
    const messages = [{ role: "user", content: [img(png(10, 10))] }];
    expect(await fitContextImages(messages, DEFAULT_IMAGE_LIMITS, fakeResize)).toBeUndefined();
  });
});

describe("cachedResize", () => {
  it("resizes the same image once per limits", async () => {
    const inner = vi.fn(fakeResize);
    const resize = cachedResize(inner, 2);
    const big = img(png(3906, 3));
    await resize(big, DEFAULT_IMAGE_LIMITS);
    await resize({ ...big }, DEFAULT_IMAGE_LIMITS);
    expect(inner).toHaveBeenCalledTimes(1);
    await resize(big, resolveLimits({ maxWidth: 1000 }));
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

describe("with pi's real resizeImage", () => {
  it("shrinks a 3906px-wide PNG to fit 2000x2000", async () => {
    const out = await resizeImage(Buffer.from(png(3906, 40), "base64"), "image/png", DEFAULT_IMAGE_LIMITS);
    expect(out).not.toBeNull();
    expect(out!.width).toBeLessThanOrEqual(2000);
    expect(readImageSize(out!.data)?.width).toBe(out!.width);
  });
});

describe("extension hooks", () => {
  type Handler = (event: any, ctx: any) => Promise<any>;
  function load() {
    const handlers = new Map<string, Handler>();
    imageLimits({ on: (name: string, fn: Handler) => handlers.set(name, fn) } as never);
    return handlers;
  }

  it("input: transforms oversized images but keeps the text for queued-steer matching", async () => {
    const h = load();
    const result = await h.get("input")!(
      { type: "input", text: "看这张", images: [img(png(3906, 40))], source: "rpc", streamingBehavior: "steer" },
      { model: undefined },
    );
    expect(result.action).toBe("transform");
    expect(result.text).toBe("看这张");
    expect(readImageSize(result.images[0].data)!.width).toBeLessThanOrEqual(2000);
  });

  it("input: continues untouched when images already fit or are absent", async () => {
    const h = load();
    expect(await h.get("input")!({ type: "input", text: "x", source: "rpc" }, {})).toEqual({ action: "continue" });
    expect(
      await h.get("input")!({ type: "input", text: "x", images: [img(png(10, 10))], source: "rpc" }, {}),
    ).toEqual({ action: "continue" });
  });

  it("context: repairs an oversized image already in history", async () => {
    const h = load();
    const messages = [{ role: "user", content: [{ type: "text", text: "" }, img(png(3906, 40))] }];
    const result = await h.get("context")!({ type: "context", messages }, { model: undefined });
    const fixed = result.messages[0].content[1] as ImageBlock;
    expect(readImageSize(fixed.data)!.width).toBeLessThanOrEqual(2000);
  });
});
