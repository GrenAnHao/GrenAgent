import { createStaticStyles, useThemeMode } from 'antd-style';
import { memo, useEffect, useRef, useState } from 'react';
import { CodeCard } from './CodeCard';
import { languageFromPath } from './codeLanguage';
import { lineCount } from './streamingFileModel';

/**
 * 与最终 diff 卡片同一套壳子：容器自己滚，滚动条 hover 渐显。
 * FileStream 不读 options.unsafeCSS，所以这段样式由我们自己塞进 shadow root。
 */
const streamCSS = `
  :host {
    display: block !important;
    width: 100% !important;
    min-width: 0 !important;
    height: auto !important;
    max-height: min(50vh, 360px) !important;
    --diffs-dark-bg: transparent !important;
    --diffs-light-bg: transparent !important;
  }

  [data-code] {
    display: block !important;
    height: auto !important;
    max-height: min(50vh, 360px) !important;
    padding-top: 0 !important;
    padding-bottom: 0 !important;
    overflow: auto !important;
    scrollbar-width: thin !important;
    scrollbar-color: transparent transparent !important;
    transition: scrollbar-color 180ms ease !important;
  }

  :host(:hover) [data-code] {
    scrollbar-color: color-mix(in srgb, CanvasText 42%, transparent) transparent !important;
  }

  [data-gutter] {
    backdrop-filter: blur(16px) !important;
  }
`;

const styles = createStaticStyles(({ css }) => ({
  host: css`
    display: block;
    width: 100%;
    min-width: 0;
  `,
  plain: css`
    margin: 0;
    padding: 16px;
    max-height: min(50vh, 360px);
    overflow: auto;
    white-space: pre;
    font-family: var(--pi-font-mono);
    font-size: 13px;
  `,
}));

function codeNodeOf(host: HTMLElement): HTMLElement | null {
  return (host.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-code]') as HTMLElement | null) ?? null;
}

const LOBE_THEME = 'lobe-theme';

/**
 * lobe 的 CodeDiff 在它自己那份 @pierre/diffs 上注册了 lobe-theme。打包时我们靠
 * resolve.dedupe 让两边共用一份，但只要哪天副本又分叉（例如 lobe 被 externalize，
 * vitest 里就是这样），主题注册表就不是同一个，解析会直接抛
 * "No valid theme loader registered"。所以先试解析，拿不到就在手上这份副本补注册 ——
 * 用的是 lobe 同一份主题数据，颜色和完成后的 diff 卡片一致。
 */
async function ensureLobeTheme(pierre: typeof import('@pierre/diffs')): Promise<void> {
  try {
    await pierre.resolveTheme(LOBE_THEME);
    return;
  } catch {
    // 这份副本上没注册过，往下补。
  }
  const theme = (await import('@lobehub/ui/es/Highlighter/theme/lobe-theme')).default;
  pierre.registerCustomTheme(LOBE_THEME, () => Promise.resolve(theme));
  await pierre.resolveTheme(LOBE_THEME);
}

type StreamHandle = { cleanUp(): void; setThemeType(type: 'system' | 'light' | 'dark'): void };

/**
 * 生成中的写入正文：真正的逐行追加渲染。
 *
 * 写入全是新增行，diff 没有信息量，所以生成阶段只做代码高亮，完成后才换成 FileDiffBlock 的 diff。
 * 底层用 @pierre/diffs 的 FileStream：正文以 ReadableStream 喂进去，token 到齐就 appendChild 一行，
 * 既不重排已渲染的行，也不会因为半截 token 反复换色——这是 pierre 里唯一带 append 路径的渲染器，
 * FileDiff 只要内容变过就会整列 innerHTML 重排。
 */
export const StreamingCodeView = memo(function StreamingCodeView({
  path,
  content,
}: {
  path: string;
  content: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef(content);
  contentRef.current = content;
  const flushRef = useRef<(() => void) | null>(null);
  const instanceRef = useRef<StreamHandle | null>(null);
  const [failed, setFailed] = useState(false);
  const [streamLive, setStreamLive] = useState(false);
  const streamLiveRef = useRef(false);
  const { isDarkMode } = useThemeMode();
  const darkRef = useRef(isDarkMode);
  darkRef.current = isDarkMode;
  const language = languageFromPath(path);
  const fileName = path.split(/[/\\]/).pop() || path;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    let sent = 0;
    let controller: ReadableStreamDefaultController<string> | undefined;
    let stream: StreamHandle | undefined;
    const teardown = () => {
      flushRef.current = null;
      instanceRef.current = null;
      try {
        controller?.close();
      } catch {
        // 管道已中止时 close 会抛，忽略。
      }
      stream?.cleanUp();
      // cleanUp 只中止管道，不摘掉它自己 append 的 <diffs-container>（StrictMode 双挂载会留下两个）。
      host.replaceChildren();
    };
    void (async () => {
      try {
        // pierre 和 shiki 都很重，按需加载；@lobehub/ui 的 CodeDiff 先加载好，它的模块会注册 lobe-theme。
        // 经 lobeHeavy 中转：直接 import('@lobehub/ui') 会把整包留在首包里。
        const [pierre] = await Promise.all([import('@pierre/diffs'), import('../../lib/lobeHeavy')]);
        if (!alive) return;
        await ensureLobeTheme(pierre);
        if (!alive) return;
        const source = new ReadableStream<string>({
          start(c) {
            controller = c;
          },
        });
        const instance = new pierre.FileStream({
          lang: language === 'text' ? undefined : language,
          theme: { dark: LOBE_THEME, light: LOBE_THEME },
          themeType: darkRef.current ? 'dark' : 'light',
          onPostRender: () => {
            const code = codeNodeOf(host);
            if (code) code.scrollTop = code.scrollHeight;
            if (alive && !streamLiveRef.current) {
              streamLiveRef.current = true;
              setStreamLive(true);
            }
          },
        });
        stream = instance;
        await instance.setup(source, host);
        if (!alive) {
          teardown();
          return;
        }
        const shadow = host.querySelector('diffs-container')?.shadowRoot;
        if (shadow && !shadow.querySelector('style[data-pi-stream]')) {
          const style = document.createElement('style');
          style.dataset.piStream = '';
          style.textContent = streamCSS;
          shadow.appendChild(style);
        }
        const flush = () => {
          const text = contentRef.current;
          if (controller == null || text.length <= sent) return;
          controller.enqueue(text.slice(sent));
          sent = text.length;
        };
        flushRef.current = flush;
        instanceRef.current = instance;
        flush();
      } catch (error) {
        // 退回纯文本，但别静默：初始化失败（主题没注册、语言解析不出来）否则无从排查。
        console.error('StreamingCodeView: 流式高亮初始化失败', error);
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      teardown();
    };
  }, [language]);

  useEffect(() => {
    flushRef.current?.();
  }, [content]);

  useEffect(() => {
    instanceRef.current?.setThemeType(isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  return (
    <CodeCard added={lineCount(content)} contained fileName={fileName}>
      {failed || !streamLive ? (
        <pre className={styles.plain} data-testid="streaming-code-fallback">{content}</pre>
      ) : null}
      {failed ? null : (
        <div ref={hostRef} className={styles.host} data-testid="streaming-code-view" />
      )}
    </CodeCard>
  );
});
