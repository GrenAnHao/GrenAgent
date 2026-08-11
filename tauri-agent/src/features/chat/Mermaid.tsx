import { ActionIcon, Icon, Image } from '@lobehub/ui';
import type { MenuProps } from 'antd';
import { Dropdown } from 'antd';
import { createStaticStyles, cssVar, cx, useTheme } from 'antd-style';
import {
  Braces,
  Check,
  ChevronRight,
  Copy,
  FileCode,
  FileImage,
  Loader2,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { pi } from '../../lib/pi';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { autoFixMermaid } from './mermaidAutofix';
import { sanitizeMermaidCode } from './sanitizeMermaid';
import { useMermaidFixStore } from '../../stores/mermaidFixStore';

type MermaidApi = typeof import('mermaid').default;

let mermaidPromise: Promise<MermaidApi> | null = null;
const loadMermaid = () => {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  return mermaidPromise;
};

let renderSeq = 0;

// 已渲染 SVG 缓存（按主题 + 源码）：mermaid 组件被虚拟列表离屏卸载后，滚回视口重新挂载时同步命中、
// 直接显示，不再异步重画、不闪「Loading」，配合下方固定高度彻底消除滚动跳动。流式中间态不入缓存。
const svgCache = new Map<string, { svg: string; autofixed: boolean }>();
const cacheKeyOf = (dark: boolean, source: string) => `${dark ? 'd' : 'l'}|${source}`;

// 固定展示高度：mermaid 以统一标准高度渲染，容器高度不随图内容 / 加载态变化，虚拟列表测高稳定，
// 不再因「Loading(矮) → SVG(高)」或图与图之间的高度差异而滚动跳动。图在框内等比适配，点击放大看细节。
const MERMAID_BOX_HEIGHT = 'min(56vh, 440px)';

// 容器宽度变化超过该阈值（px）才触发重绘，过滤滚动条出现/字体回流等微小抖动。
const RESIZE_THRESHOLD = 24;

// 宽度连续变化（如拖动窗口/侧栏）时，静默该时长后才重绘一次，避免拖动过程中每帧完整重渲卡顿。
const RESIZE_DEBOUNCE_MS = 200;

/**
 * 给 SVG 写入按 scale 放大的显式像素 width/height、去掉 max-width，返回新 SVG 及目标像素尺寸。
 * mermaid 输出的 SVG 常带 width="100%" / max-width:Xpx，脱离容器后无参照会塌缩；显式像素尺寸
 * 既让官方 Image 预览有正确自然尺寸，也让转 PNG 时按目标分辨率光栅化矢量（高清）。
 */
function svgWithPixelSize(
  svg: string,
  scale: number,
): { svg: string; width: number; height: number } | null {
  const vb = /viewBox="([^"]+)"/.exec(svg);
  if (!vb) return null;
  const nums = vb[1].trim().split(/[\s,]+/).map(Number);
  if (nums.length !== 4 || !(nums[2] > 0) || !(nums[3] > 0)) return null;
  const width = Math.round(nums[2] * scale);
  const height = Math.round(nums[3] * scale);
  const out = svg.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
    const cleaned = attrs
      .replace(/\swidth="[^"]*"/i, '')
      .replace(/\sheight="[^"]*"/i, '')
      .replace(/max-width:\s*[^;"']*;?/gi, '');
    return `<svg${cleaned} width="${width}" height="${height}">`;
  });
  return { svg: out, width, height };
}

/**
 * 把 mermaid 的 inline SVG 转成给官方 Image 预览用的 data URL（2x 超采样，全屏预览够清晰）。
 */
function svgToDataUrl(svg: string): string {
  const sized = svgWithPixelSize(svg, 2);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized ? sized.svg : svg)}`;
}

/**
 * 矢量 SVG -> 高清位图 PNG Blob。按 viewBox 逻辑尺寸 ×(devicePixelRatio × 2) 设定目标像素，让
 * 浏览器按目标分辨率重采样矢量（而非把小图放大）得到高清图；单边上限 4096px 防超大图爆内存。
 * background 非空时先填实底——透明 PNG 粘到微信等浅色界面会看不清，填白可保证通用可读。
 */
async function svgToPngBlob(svg: string, background: string | null): Promise<Blob> {
  const dpr = window.devicePixelRatio || 1;
  const vb = /viewBox="([^"]+)"/.exec(svg);
  const nums = vb ? vb[1].trim().split(/[\s,]+/).map(Number) : [];
  const baseW = nums.length === 4 && nums[2] > 0 ? nums[2] : 800;
  const baseH = nums.length === 4 && nums[3] > 0 ? nums[3] : 600;
  const MAX_SIDE = 4096;
  const longest = Math.max(baseW, baseH);
  let scale = Math.max(1, dpr * 2);
  if (longest * scale > MAX_SIDE) scale = MAX_SIDE / longest;
  const targetW = Math.max(1, Math.round(baseW * scale));
  const targetH = Math.max(1, Math.round(baseH * scale));
  const sized = svgWithPixelSize(svg, scale);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized ? sized.svg : svg)}`;

  // 注意：此处不能用 new Image()——本文件从 @lobehub/ui 导入了同名的 Image 组件，会命名冲突。
  const img = document.createElement('img');
  img.decoding = 'async';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('SVG 光栅化失败'));
    img.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 上下文');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, targetW, targetH);
  }
  ctx.drawImage(img, 0, 0, targetW, targetH);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png');
  });
}

/** 把 Blob 触发为文件下载（剪贴板图片不可用时的兜底）。 */
function downloadPngBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mermaid-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 创建一个宽度受限的隐藏测量容器交给 mermaid.render：mermaid 用它测量文本/布局，使 gantt 等
 * 「按可用宽度排布」的图按对话当前宽度重新计算，而非用 body 全宽。用后即弃（调用方负责移除）。
 */
function makeMeasureHost(width: number): HTMLDivElement {
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.left = '-99999px';
  host.style.top = '0';
  host.style.width = `${width}px`;
  host.style.visibility = 'hidden';
  host.style.pointerEvents = 'none';
  document.body.appendChild(host);
  return host;
}

/**
 * 渲染 + 本地自动修复：先按原样渲染，失败则用 autoFixMermaid 尝试修复后重渲染（最多几轮，
 * 防止死循环）。返回是否经过了本地修复（autofixed），都修不好则抛出最后一次错误交给上层降级。
 */
async function renderWithAutofix(
  mermaid: MermaidApi,
  raw: string,
  host?: Element,
): Promise<{ svg: string; autofixed: boolean; code: string }> {
  let cur = raw;
  let lastErr: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      await mermaid.parse(cur);
      renderSeq += 1;
      const { svg } = await mermaid.render(`mermaid-${renderSeq.toString(36)}`, cur, host);
      return { svg, autofixed: cur !== raw, code: cur };
    } catch (e) {
      lastErr = e;
      const next = autoFixMermaid(cur);
      if (!next || next === cur) break;
      cur = next;
    }
  }
  throw lastErr;
}

const styles = createStaticStyles(({ css }) => ({
  root: css`
    width: 100%;
    min-width: 0;
    margin: 8px 0;
  `,
  wrap: css`
    position: relative;
    display: flex;
    justify-content: flex-start;
    overflow: auto;

    &:hover .mermaidCopyBtn {
      opacity: 1;
    }
  `,
  fig: css`
    width: 100%;
    min-width: 0;
    height: ${MERMAID_BOX_HEIGHT};
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: zoom-in;

    & svg {
      display: block;
      width: auto;
      height: auto;
      /* 固定高度框内等比适配：宽/高都不超过框，大图缩小、竖高图不溢出；点击放大看细节。 */
      max-width: 100%;
      max-height: 100%;
    }
  `,
  loading: css`
    display: flex;
    align-items: center;
    justify-content: center;
    height: ${MERMAID_BOX_HEIGHT};
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
  `,
  fixedBadge: css`
    position: absolute;
    inset-block-start: 6px;
    inset-inline-end: 6px;
    z-index: 2;
    padding: 1px 6px;
    border-radius: 5px;
    font-size: 11px;
    color: ${cssVar.colorWarning};
    background: ${cssVar.colorBgElevated};
    border: 1px solid ${cssVar.colorBorderSecondary};
  `,
  copyBtn: css`
    position: absolute;
    inset-block-start: 6px;
    inset-inline-start: 6px;
    z-index: 2;
    opacity: 0;
    background: ${cssVar.colorBgElevated};
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 6px;
    transition: opacity 0.15s ease;
  `,
  errorCard: css`
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorFillQuaternary};
  `,
  errorHead: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    cursor: pointer;
    user-select: none;
    font-size: 13px;
    color: ${cssVar.colorText};

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  errorTitle: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: baseline;
    gap: 8px;
    font-weight: 600;
    white-space: nowrap;
  `,
  errorBrief: css`
    overflow: hidden;
    min-width: 0;
    font-size: 12px;
    font-weight: 400;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  errorMsg: css`
    margin: 0;
    max-height: 120px;
    overflow: auto;
    padding: 8px 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorError};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  errorCode: css`
    margin: 0;
    max-height: 260px;
    overflow: auto;
    padding: 8px 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorTextSecondary};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  aiFixFeedback: css`
    padding: 6px 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorError};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  fixingIcon: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

/**
 * 直接把 mermaid 渲染成 inline SVG（dangerouslySetInnerHTML），绕开 @lobehub/ui 的
 * "SVG -> blob: -> antd Image(loading=lazy)" 链路。inline SVG 的文字是真实文本，
 * 在对话流里可直接选中复制；图左对齐并占满对话宽度。点击图走 lobehub/antd 官方图片查看器
 * 放大（受控 preview）；右上角下拉菜单可复制高清 PNG（白底，便于粘到微信等平台）/ SVG / 源码。
 * 容器宽度变化时按新宽度重绘以适配布局：拖动等连续变化做防抖只在静默后重绘一次；流式期间布局
 * 还在动则跳过重排，等流式结束再按最终宽度对齐一次，兼顾「自适应」与「不卡顿」。
 * 渲染失败先本地自动修复重试，仍失败则降级为可折叠错误卡片，并在有工作区上下文时提供
 * 「让 AI 修复」——走后端非流式一次性请求拿到修正代码后就地替换重绘，不污染对话历史。
 */
export const Mermaid = memo(({ code, streaming }: { code: string; streaming?: boolean }) => {
  const theme = useTheme();
  const ctx = useOptionalAgentStoreContext();
  // 初始即尝试命中已渲染缓存：滚回视口 / 重挂载时同步显示，不闪 Loading、不产生高度突变。
  const initCached = svgCache.get(
    cacheKeyOf(theme.isDarkMode, useMermaidFixStore.getState().fixes[code]?.code ?? code),
  );
  const [svg, setSvg] = useState(initCached?.svg ?? '');
  const [autofixed, setAutofixed] = useState(initCached?.autofixed ?? false);
  const [failed, setFailed] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [errOpen, setErrOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  // 复制成功后短暂显示的提示文案（''=无）；按钮图标据此在 Check/Copy 间切换。
  const [copiedHint, setCopiedHint] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [aiFixing, setAiFixing] = useState(false);
  const [aiError, setAiError] = useState('');
  const [resizeTick, setResizeTick] = useState(0);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const lastWidthRef = useRef(0);
  const failedRef = useRef(false);
  const errMsgRef = useRef('');

  // 持久化修复缓存（按原始 code 存）：AI 修复与本地 autofix 的结果都写这里，切会话/重载后据此用
  // 修复版渲染、不再重现崩坏（pi 无法原地改历史消息，故在前端渲染层兜住）。code 变即自动切到对应缓存。
  const persistedFix = useMermaidFixStore((s) => s.fixes[code]);
  const aiFixed = persistedFix?.ai === true;
  const source = persistedFix?.code ?? code;

  errMsgRef.current = errMsg;

  useEffect(() => {
    let alive = true;
    // 命中已渲染缓存：同步显示、跳过异步重画与 Loading（滚回视口不闪、容器高度恒定、不跳）。
    const cached = svgCache.get(cacheKeyOf(theme.isDarkMode, source));
    if (cached) {
      setSvg(cached.svg);
      setAutofixed(cached.autofixed);
      setFailed(false);
      setErrMsg('');
      lastWidthRef.current = wrapRef.current?.clientWidth ?? 0;
      return;
    }
    setFailed(false);
    setErrMsg('');
    setAutofixed(false);
    const width = wrapRef.current?.clientWidth ?? 0;
    lastWidthRef.current = width;
    const host = width > 0 ? makeMeasureHost(width) : undefined;
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          fontFamily: theme.fontFamily,
          securityLevel: 'loose',
          startOnLoad: false,
          theme: theme.isDarkMode ? 'dark' : 'neutral',
        });
        const cleaned = sanitizeMermaidCode(source);
        const { svg: out, autofixed: fx, code: rendered } = await renderWithAutofix(mermaid, cleaned, host);
        if (!out.trim()) throw new Error('Mermaid 返回空 SVG');
        // 缓存渲染结果供滚回视口时同步复用；流式中间态每帧 code 变、不入缓存（避免污染 + Map 膨胀）。
        if (!streaming) svgCache.set(cacheKeyOf(theme.isDarkMode, source), { svg: out, autofixed: fx });
        if (alive) {
          setSvg(out);
          setAutofixed(fx);
          failedRef.current = false;
        }
        // 本地 autofix 成功：把修复结果按原始 code 持久化，切会话/重载直接命中、不再重崩重修。
        if (fx && rendered && rendered !== code) {
          useMermaidFixStore.getState().setFix(code, rendered, false);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setSvg('');
          setFailed(true);
          failedRef.current = true;
          const msg = e instanceof Error ? e.message : String(e);
          setErrMsg(msg);
          // 已有持久修复（多为 AI 修复）却仍渲染失败：提示修复无效。
          if (persistedFix && persistedFix.code === source) {
            setAiError(`修复后的代码仍无法渲染：${msg.split('\n')[0]}`);
            setErrOpen(true);
          }
        }
      })
      .finally(() => {
        host?.remove();
      });
    return () => {
      alive = false;
    };
  }, [code, source, persistedFix, theme.isDarkMode, theme.fontFamily, resizeTick, streaming]);

  // 监听容器宽度，按新宽度重绘以适配布局。三处节流避免无谓重渲：
  // 1) 仅宽度变化超阈值才重绘（过滤滚动条/字体回流抖动）；
  // 2) 连续变化（拖动）做 trailing debounce，停下后才渲一次，不在拖动过程每帧重渲；
  // 3) 流式期间整体跳过（布局还在动），待 streaming 转 false 时按最终宽度对齐一次。
  // 失败态始终不重绘，避免错误卡片反复闪烁。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // 流式刚结束：若流式期间宽度已偏移，补一次对齐重绘（lastWidthRef 由主渲染 effect 同步维护）。
    if (!streaming && !failedRef.current) {
      const w = Math.round(el.clientWidth);
      if (w > 0 && Math.abs(w - lastWidthRef.current) >= RESIZE_THRESHOLD) {
        setResizeTick((t) => t + 1);
      }
    }
    let timer = 0;
    const ro = new ResizeObserver((entries) => {
      if (streaming || failedRef.current) return;
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w <= 0) return;
      if (Math.abs(w - lastWidthRef.current) < RESIZE_THRESHOLD) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setResizeTick((t) => t + 1), RESIZE_DEBOUNCE_MS);
    });
    ro.observe(el);
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
    };
  }, [streaming]);

  const dataUrl = useMemo(() => (svg ? svgToDataUrl(svg) : ''), [svg]);

  // 内联展示用：写入按 viewBox 的显式像素尺寸并去掉 max-width，配合 CSS width/height:auto +
  // max-width/max-height，让竖向高图等比缩小到限高内（而非被强制满宽后超高）。
  const displaySvg = useMemo(() => {
    if (!svg) return '';
    const sized = svgWithPixelSize(svg, 1);
    return sized ? sized.svg : svg;
  }, [svg]);

  // 点击图：仅当用户没有正在选中文字时才放大，保证「在对话流里拖选复制图内文字」不被打断。
  const onFigureClick = useCallback(() => {
    if (window.getSelection()?.toString()) return;
    setZoomed(true);
  }, []);

  // 复制成功后让按钮短暂变 Check 并显示对应文案，1.5s 后复位。
  const flashCopied = useCallback((hint: string) => {
    setCopiedHint(hint);
    window.setTimeout(() => setCopiedHint(''), 1500);
  }, []);

  // 复制纯文本（SVG 标记 / mermaid 源码）。
  const copyText = useCallback(
    (text: string, hint: string) => {
      if (!text) return;
      void navigator.clipboard
        ?.writeText(text)
        .then(() => flashCopied(hint))
        .catch(() => undefined);
    },
    [flashCopied],
  );

  // 复制为高清 PNG 图片（用于粘到微信等平台）：用 neutral 浅色主题重渲一份白底友好的图，并关掉
  // htmlLabels 避免 foreignObject 让 canvas 被污染（否则 toBlob 会因 tainted 抛错 / 丢字）；
  // 按 DPR×2 高分辨率光栅化后填白底。剪贴板图片不可用时兜底为下载 PNG。手势安全：clipboard.write
  // 在点击同步栈调用，Blob 以 Promise 形式交给 ClipboardItem。
  const handleCopy = useCallback(() => {
    const blobPromise = (async () => {
      const mermaid = await loadMermaid();
      const cleaned = sanitizeMermaidCode(source);
      let exportSvg = svg;
      try {
        renderSeq += 1;
        const { svg: lightSvg } = await mermaid.render(
          `mermaid-copy-${renderSeq.toString(36)}`,
          `%%{init:{"theme":"neutral","htmlLabels":false,"flowchart":{"htmlLabels":false}}}%%\n${cleaned}`,
        );
        exportSvg = lightSvg;
      } catch {
        // neutral 重渲失败则回退当前已显示的 svg。
      }
      return svgToPngBlob(exportSvg, '#ffffff');
    })();

    const onCopied = () => flashCopied('已复制图片');

    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      navigator.clipboard
        .write([new ClipboardItem({ 'image/png': blobPromise })])
        .then(onCopied)
        .catch(() => {
          void blobPromise.then(downloadPngBlob).catch(() => undefined);
        });
    } else {
      void blobPromise
        .then((b) => {
          downloadPngBlob(b);
          onCopied();
        })
        .catch(() => undefined);
    }
  }, [source, svg, flashCopied]);

  // 失败后的 AI 修复：走后端非流式一次性请求拿到修正代码，就地覆盖重绘，不往对话发消息。
  const requestAiFix = useCallback(async () => {
    if (!ctx || aiFixing) return;
    setAiFixing(true);
    setAiError('');
    const renderError = errMsgRef.current;
    try {
      const fixed = await pi.fixMermaid(ctx.workspace, code, renderError);
      const trimmed = fixed?.trim() ?? '';
      if (!trimmed) {
        setAiError('模型未返回有效内容');
        setErrOpen(true);
        return;
      }
      if (trimmed === source.trim()) {
        setAiError('模型返回的代码与当前版本相同，未能修复');
        setErrOpen(true);
        return;
      }
      // 持久化 AI 修复结果（按原始 code），source 随之更新触发重渲染；切会话/重载也直接命中。
      useMermaidFixStore.getState().setFix(code, trimmed, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAiError(msg || 'AI 修复请求失败');
      setErrOpen(true);
    } finally {
      setAiFixing(false);
    }
  }, [ctx, aiFixing, code, source]);

  let body: ReactNode;
  if (failed) {
    const brief = aiError || errMsg.split('\n')[0];
    body = (
      <div className={styles.errorCard}>
        <div className={styles.errorHead} onClick={() => setErrOpen((v) => !v)}>
          <Icon
            icon={TriangleAlert}
            size={14}
            style={{ flex: 'none', color: cssVar.colorWarning }}
          />
          <span className={styles.errorTitle}>
            Mermaid 图表渲染失败
            {brief ? <span className={styles.errorBrief}>{brief}</span> : null}
          </span>
          {ctx ? (
            aiFixing ? (
              <span className={styles.fixingIcon} title="正在让 AI 修复…">
                <Icon icon={Loader2} size={16} spin />
              </span>
            ) : (
              <ActionIcon
                icon={Sparkles}
                size="small"
                title={aiError ? '重试让 AI 修复' : '让 AI 修复'}
                onClick={(e) => {
                  e.stopPropagation();
                  void requestAiFix();
                }}
              />
            )
          ) : null}
          <ActionIcon
            icon={Copy}
            size="small"
            title="复制图表代码"
            onClick={(e) => {
              e.stopPropagation();
              void navigator.clipboard?.writeText(code);
            }}
          />
          <Icon
            icon={ChevronRight}
            size={14}
            style={{
              flex: 'none',
              color: cssVar.colorTextTertiary,
              transform: errOpen ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.15s ease',
            }}
          />
        </div>
        {aiError ? <div className={styles.aiFixFeedback}>{aiError}</div> : null}
        {errOpen ? (
          <>
            {errMsg ? <pre className={styles.errorMsg}>{errMsg}</pre> : null}
            <pre className={styles.errorCode}>
              <code>{source}</code>
            </pre>
          </>
        ) : null}
      </div>
    );
  } else if (!svg) {
    body = <div className={styles.loading}>Loading diagram…</div>;
  } else {
    const copyMenuItems: MenuProps['items'] = [
      {
        icon: <Icon icon={FileImage} size={14} />,
        key: 'png',
        label: '复制图片',
        onClick: () => handleCopy(),
      },
      {
        icon: <Icon icon={FileCode} size={14} />,
        key: 'svg',
        label: '复制 SVG',
        onClick: () => copyText(svg, '已复制 SVG'),
      },
      {
        icon: <Icon icon={Braces} size={14} />,
        key: 'code',
        label: '复制代码',
        onClick: () => copyText(source, '已复制代码'),
      },
    ];
    body = (
      <div className={styles.wrap}>
        <div
          className={styles.fig}
          dangerouslySetInnerHTML={{ __html: displaySvg }}
          onClick={onFigureClick}
        />
        {aiFixed ? (
          <span className={styles.fixedBadge}>已由 AI 修复</span>
        ) : autofixed || persistedFix ? (
          <span className={styles.fixedBadge}>已自动修正语法</span>
        ) : null}
        <Dropdown
          menu={{ items: copyMenuItems }}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          placement="bottomLeft"
          trigger={['click']}
        >
          <ActionIcon
            className={cx('mermaidCopyBtn', styles.copyBtn)}
            icon={copiedHint ? Check : Copy}
            size="small"
            style={menuOpen ? { opacity: 1 } : undefined}
            title={copiedHint || '复制'}
          />
        </Dropdown>
        {dataUrl ? (
          <Image
            alt=""
            src={dataUrl}
            style={{ display: 'none' }}
            preview={{ onVisibleChange: (v: boolean) => setZoomed(v), visible: zoomed } as import('antd/es/image').PreviewConfig}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.root} ref={wrapRef}>
      {body}
    </div>
  );
});

Mermaid.displayName = 'Mermaid';
