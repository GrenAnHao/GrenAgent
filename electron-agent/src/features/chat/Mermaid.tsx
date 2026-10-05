import { ActionIcon, Icon, Mermaid as LobeMermaid } from '@lobehub/ui';
import type { MenuProps } from 'antd';
import { ConfigProvider, Dropdown } from 'antd';
import { createStaticStyles, cssVar, useTheme } from 'antd-style';
import { renderMermaidSVG, THEMES } from 'beautiful-mermaid';
import { Braces, Check, Copy, FileCode, FileImage, Loader2, Sparkles, TriangleAlert } from 'lucide-react';
import { Component, memo, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';

import { pi } from '../../lib/pi';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { useMermaidFixStore } from '../../stores/mermaidFixStore';
import { autoFixMermaid } from './mermaidAutofix';
import { MermaidLoading, mermaidBoxStyles } from './MermaidLoading';
import { sanitizeMermaidCode } from './sanitizeMermaid';

type MermaidApi = typeof import('mermaid').default;

let mermaidPromise: Promise<MermaidApi> | null = null;
const loadMermaid = (): Promise<MermaidApi> => {
  mermaidPromise ??= import('mermaid').then((module) => module.default);
  return mermaidPromise;
};

let renderSequence = 0;

const styles = createStaticStyles(({ css }) => ({
  diagramFrame: css`
    width: 100%;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorBgContainer};
    font-size-adjust: none;
    box-shadow:
      0 1px 0 -1px ${cssVar.colorBorder},
      0 1px 2px -0.5px ${cssVar.colorBorder},
      0 2px 2px -1px ${cssVar.colorBorderSecondary},
      0 3px 6px -4px ${cssVar.colorBorderSecondary};
  `,
  // 放大预览是 antd Image 的独立图层，透明画布叠在深色遮罩上看不清，给整张预览图铺上卡片底色。
  previewCanvas: css`
    .ant-image-preview-img {
      background: ${cssVar.colorBgContainer};
    }
  `,
  fixedBadge: css`
    position: absolute;
    inset-block-start: 8px;
    inset-inline-end: 8px;
    z-index: 2;
    padding: 1px 6px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 5px;
    background: ${cssVar.colorBgElevated};
    color: ${cssVar.colorWarning};
    font-size: 11px;
  `,
  actionHost: css`
    position: relative;
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
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: baseline;
    gap: 8px;
    overflow: hidden;
    font-weight: 600;
    white-space: nowrap;
  `,
  errorBrief: css`
    min-width: 0;
    overflow: hidden;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    font-weight: 400;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  errorMsg: css`
    max-height: 120px;
    margin: 0;
    overflow: auto;
    padding: 8px 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    color: ${cssVar.colorError};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  `,
  errorCode: css`
    max-height: 260px;
    margin: 0;
    overflow: auto;
    padding: 8px 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    color: ${cssVar.colorTextSecondary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  `,
  aiFixFeedback: css`
    padding: 6px 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    color: ${cssVar.colorError};
    font-size: 12px;
    line-height: 1.5;
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

// 只包住 LobeMermaid，预览根节点带上 previewCanvas，不影响应用里其他图片预览。
const PREVIEW_IMAGE_CONFIG = { classNames: { popup: { root: styles.previewCanvas } } };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function prepareMermaid(code: string): Promise<{ code: string; autofixed: boolean }> {
  const mermaid = await loadMermaid();
  mermaid.initialize({ securityLevel: 'loose', startOnLoad: false });
  let current = sanitizeMermaidCode(code);
  let autofixed = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await mermaid.parse(current);
      return { code: current, autofixed };
    } catch (error) {
      const fixed = autoFixMermaid(current);
      if (!fixed || fixed === current) throw error;
      current = sanitizeMermaidCode(fixed);
      autofixed = true;
    }
  }
  throw new Error('Mermaid 语法修复超过最大重试次数');
}

type PrepareOutcome = { code: string; autofixed: boolean } | { error: string };

// 预检（动态加载 mermaid + parse）是异步的，而 virtua 会卸载离屏条目、回到缓冲区时重新挂载。
// 每次挂载都从空状态重跑预检的话，图表会先退回「Loading diagram…」占位再长回真实高度：
// 含图的长消息在视口上方反复变矮/变高，virtua 跟着修正 scrollTop，列表就会自己往上弹。
// 按源码记住预检结果，重挂载首帧直接渲染上次的图（或错误卡），条目高度保持不变。
const PREPARE_CACHE_LIMIT = 200;
const prepareOutcomes = new Map<string, PrepareOutcome>();

function rememberOutcome(source: string, outcome: PrepareOutcome): void {
  if (prepareOutcomes.size >= PREPARE_CACHE_LIMIT) {
    const oldest = prepareOutcomes.keys().next().value;
    if (oldest !== undefined) prepareOutcomes.delete(oldest);
  }
  prepareOutcomes.set(source, outcome);
}

async function renderExportSvg(code: string, dark: boolean): Promise<string> {
  try {
    // Keep exports on the same engine as the LobeHub component. Otherwise the
    // visible diagram uses beautiful-mermaid while copied output uses Mermaid.js,
    // producing different layouts and node sizes.
    return renderMermaidSVG(code, THEMES[dark ? 'zinc-dark' : 'zinc-light']);
  } catch {
    // LobeHub falls back to Mermaid.js for diagram types beautiful-mermaid does
    // not support. Mirror that fallback so those diagrams remain exportable.
    const mermaid = await loadMermaid();
    mermaid.initialize({ securityLevel: 'loose', startOnLoad: false, theme: dark ? 'dark' : 'neutral' });
    renderSequence += 1;
    const result = await mermaid.render(`mermaid-export-${renderSequence.toString(36)}`, code);
    return result.svg;
  }
}

function svgWithPixelSize(svg: string, scale: number): { svg: string; width: number; height: number } | null {
  const viewBox = /viewBox="([^\"]+)"/.exec(svg);
  if (!viewBox) return null;
  const values = viewBox[1].trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || !(values[2] > 0) || !(values[3] > 0)) return null;
  const width = Math.round(values[2] * scale);
  const height = Math.round(values[3] * scale);
  const sized = svg.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    const cleaned = attrs
      .replace(/\swidth="[^\"]*"/i, '')
      .replace(/\sheight="[^\"]*"/i, '')
      .replace(/max-width:\s*[^;"']*;?/gi, '');
    return `<svg${cleaned} width="${width}" height="${height}">`;
  });
  return { svg: sized, width, height };
}

async function svgToPngBlob(svg: string, background: string | null): Promise<Blob> {
  const dpr = window.devicePixelRatio || 1;
  const viewBox = /viewBox="([^\"]+)"/.exec(svg);
  const values = viewBox ? viewBox[1].trim().split(/[\s,]+/).map(Number) : [];
  const baseWidth = values.length === 4 && values[2] > 0 ? values[2] : 800;
  const baseHeight = values.length === 4 && values[3] > 0 ? values[3] : 600;
  const scale = Math.min(Math.max(1, dpr * 2), 4096 / Math.max(baseWidth, baseHeight));
  const width = Math.max(1, Math.round(baseWidth * scale));
  const height = Math.max(1, Math.round(baseHeight * scale));
  const sized = svgWithPixelSize(svg, scale);
  const image = document.createElement('img');
  image.decoding = 'async';
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized?.svg ?? svg)}`;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('SVG 光栅化失败'));
  });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建 canvas 上下文');
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(image, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG 编码失败'))), 'image/png');
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

class MermaidRenderBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo): void {}

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function MermaidErrorCard({
  code,
  error,
  onFix,
  aiFixing,
  aiError,
}: {
  code: string;
  error: string;
  onFix: () => void;
  aiFixing: boolean;
  aiError: string;
}) {
  const [open, setOpen] = useState(false);
  const context = useOptionalAgentStoreContext();
  const brief = aiError || error.split('\n')[0];
  return (
    <div className={styles.errorCard}>
      <div className={styles.errorHead} onClick={() => setOpen((value) => !value)}>
        <Icon icon={TriangleAlert} size={14} style={{ flex: 'none', color: cssVar.colorWarning }} />
        <span className={styles.errorTitle}>
          Mermaid 图表渲染失败
          {brief ? <span className={styles.errorBrief}>{brief}</span> : null}
        </span>
        {context ? (
          aiFixing ? (
            <span className={styles.fixingIcon} title="正在让 AI 修复…">
              <Icon icon={Loader2} size={16} spin />
            </span>
          ) : (
            <ActionIcon
              icon={Sparkles}
              size="small"
              title={aiError ? '重试让 AI 修复' : '让 AI 修复'}
              onClick={(event) => {
                event.stopPropagation();
                onFix();
              }}
            />
          )
        ) : null}
        <ActionIcon
          icon={Copy}
          size="small"
          title="复制图表代码"
          onClick={(event) => {
            event.stopPropagation();
            void navigator.clipboard?.writeText(code);
          }}
        />
        <Icon icon={TriangleAlert} size={14} style={{ flex: 'none', color: cssVar.colorTextTertiary }} />
      </div>
      {aiError ? <div className={styles.aiFixFeedback}>{aiError}</div> : null}
      {open ? (
        <>
          {error ? <pre className={styles.errorMsg}>{error}</pre> : null}
          <pre className={styles.errorCode}>
            <code>{code}</code>
          </pre>
        </>
      ) : null}
    </div>
  );
}

export const Mermaid = memo(({ code }: { code: string; streaming?: boolean }) => {
  const theme = useTheme();
  const context = useOptionalAgentStoreContext();
  const persistedFix = useMermaidFixStore((state) => state.fixes[code]);
  const source = persistedFix?.code ?? code;
  const settled = prepareOutcomes.get(source);
  const [prepared, setPrepared] = useState(settled && 'code' in settled ? settled.code : '');
  const [error, setError] = useState(settled && 'error' in settled ? settled.error : '');
  const [autofixed, setAutofixed] = useState(settled && 'code' in settled ? settled.autofixed : false);
  const [aiFixing, setAiFixing] = useState(false);
  const [aiError, setAiError] = useState('');
  const [copied, setCopied] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const errorRef = useRef(settled && 'error' in settled ? settled.error : '');

  useEffect(() => {
    const apply = (outcome: PrepareOutcome) => {
      if ('error' in outcome) {
        errorRef.current = outcome.error;
        setPrepared('');
        setAutofixed(false);
        setError(outcome.error);
        return;
      }
      setError('');
      setPrepared(outcome.code);
      setAutofixed(outcome.autofixed);
      if (outcome.autofixed && outcome.code !== source) useMermaidFixStore.getState().setFix(code, outcome.code, false);
    };
    setAiError('');
    const cached = prepareOutcomes.get(source);
    if (cached) {
      apply(cached);
      return;
    }
    let alive = true;
    setPrepared('');
    setError('');
    setAutofixed(false);
    void prepareMermaid(source)
      .then(
        (result): PrepareOutcome => result,
        (reason: unknown): PrepareOutcome => ({ error: errorMessage(reason) }),
      )
      .then((outcome) => {
        rememberOutcome(source, outcome);
        if (alive) apply(outcome);
      });
    return () => {
      alive = false;
    };
  }, [code, source]);

  const flashCopied = useCallback((message: string) => {
    setCopied(message);
    window.setTimeout(() => setCopied(''), 1500);
  }, []);

  const copyText = useCallback(
    (value: string, message: string) => {
      void navigator.clipboard?.writeText(value).then(() => flashCopied(message));
    },
    [flashCopied],
  );

  const copyPng = useCallback(async () => {
    const svg = await renderExportSvg(prepared, theme.isDarkMode);
    const blob = await svgToPngBlob(svg, '#ffffff');
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      flashCopied('已复制图片');
    } else {
      downloadBlob(blob, `mermaid-${Date.now()}.png`);
      flashCopied('已下载图片');
    }
  }, [flashCopied, prepared, theme.isDarkMode]);

  const actionsRender = useCallback(
    ({ originalNode }: { originalNode: ReactNode }) => {
      const items: MenuProps['items'] = [
        { icon: <Icon icon={FileImage} size={14} />, key: 'png', label: '复制图片', onClick: () => void copyPng() },
        {
          icon: <Icon icon={FileCode} size={14} />,
          key: 'svg',
          label: '复制 SVG',
          onClick: () => void renderExportSvg(prepared, theme.isDarkMode).then((svg) => copyText(svg, '已复制 SVG')),
        },
        { icon: <Icon icon={Braces} size={14} />, key: 'code', label: '复制代码', onClick: () => copyText(prepared, '已复制代码') },
      ];
      return (
        <>
          {originalNode}
          <Dropdown menu={{ items }} open={menuOpen} onOpenChange={setMenuOpen} trigger={['click']}>
            <ActionIcon icon={copied ? Check : Copy} size="small" title={copied || '复制'} />
          </Dropdown>
        </>
      );
    },
    [copyPng, copyText, copied, menuOpen, prepared, theme.isDarkMode],
  );

  const requestAiFix = useCallback(async () => {
    if (!context || aiFixing) return;
    setAiFixing(true);
    setAiError('');
    try {
      const fixed = await pi.fixMermaid(context.workspace, code, errorRef.current);
      const trimmed = fixed?.trim() ?? '';
      if (!trimmed) throw new Error('模型未返回有效内容');
      if (trimmed === source.trim()) throw new Error('模型返回的代码与当前版本相同，未能修复');
      useMermaidFixStore.getState().setFix(code, trimmed, true);
    } catch (reason: unknown) {
      setAiError(errorMessage(reason));
    } finally {
      setAiFixing(false);
    }
  }, [aiFixing, code, context, source]);

  if (error) {
    return (
      <div className={mermaidBoxStyles.root}>
        <MermaidErrorCard code={source} error={error} onFix={() => void requestAiFix()} aiFixing={aiFixing} aiError={aiError} />
      </div>
    );
  }
  if (!prepared) return <MermaidLoading />;

  const fixed = Boolean(persistedFix?.ai || autofixed || persistedFix);
  const fallback = (
    <MermaidErrorCard code={source} error="LobeHub Mermaid 无法渲染此图表类型" onFix={() => void requestAiFix()} aiFixing={aiFixing} aiError={aiError} />
  );
  return (
    <div className={mermaidBoxStyles.root}>
      <div className={styles.diagramFrame}>
        <div className={styles.actionHost}>
          <MermaidRenderBoundary fallback={fallback}>
            <ConfigProvider image={PREVIEW_IMAGE_CONFIG}>
              <LobeMermaid
                fullFeatured
                copyable={false}
                defaultExpand
                actionsRender={actionsRender}
                // lobe-theme keeps the SVG canvas transparent and follows antd's
                // CSS variables; the enlarged preview gets its canvas from previewCanvas.
                theme="lobe-theme"
                styles={{ content: { background: cssVar.colorBgContainer } }}
                variant="filled"
              >
                {prepared}
              </LobeMermaid>
            </ConfigProvider>
          </MermaidRenderBoundary>
          {fixed ? <span className={styles.fixedBadge}>{persistedFix?.ai ? '已由 AI 修复' : '已自动修正语法'}</span> : null}
        </div>
      </div>
    </div>
  );
});

Mermaid.displayName = 'Mermaid';
