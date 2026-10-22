import { resizeImage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  cachedResize,
  fitContentImages,
  fitContextImages,
  isImageBlock,
  resolveLimits,
  type ImageLimits,
  type ResizeFn,
} from "./limits.js";

// pi 1.3.0 只给 prompt 的图片和工具结果的图片做缩放；steer / followUp 排队的图片原样进历史，
// 一张 3906×1557 的截图就能让之后每次请求都被 Anthropic 拒掉。这里在两处补上：
// input 阶段把新进来的图片缩好（历史里存的就是缩过的），context 阶段兜底已经落进历史的大图。
// 见 .agents/notes/implemented/bug-fix/2026-10-20-steer-image-size-limit.md

const piResize: ResizeFn = async (block, limits) => {
  const resized = await resizeImage(Buffer.from(block.data, "base64"), block.mimeType, limits);
  return resized ? { data: resized.data, mimeType: resized.mimeType, width: resized.width, height: resized.height } : null;
};

type ModelLike = { inputLimits?: { images?: { resize?: Partial<ImageLimits> } } } | undefined;

function limitsFor(model: ModelLike): ImageLimits {
  return resolveLimits(model?.inputLimits?.images?.resize);
}

export default function imageLimits(pi: ExtensionAPI) {
  const resize = cachedResize(piResize);

  pi.on("input", async (event, ctx) => {
    const images = event.images;
    if (!images || images.length === 0) return { action: "continue" as const };
    const fitted = await fitContentImages(images, limitsFor(ctx.model), resize, "keep");
    if (fitted === images) return { action: "continue" as const };
    // 正文不动：撤回排队引导靠正文匹配，pi 自己的 prompt 路径也会再补尺寸说明。
    return { action: "transform" as const, text: event.text, images: fitted.filter(isImageBlock) };
  });

  pi.on("context", async (event, ctx) => {
    const messages = await fitContextImages(event.messages, limitsFor(ctx.model), resize);
    return messages ? { messages } : undefined;
  });
}
