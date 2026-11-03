import {
  createElement,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icons";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { sanitizeDiagramSvg, diagramIsSafeInput } from "./security";
import type { SourceRef } from "./api";
import { resolveWikiLink } from "../../../../../../shared/wikiLinks";
import "./Mermaid.css";

export function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fitted, setFitted] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(800);
  const naturalWidth = useMemo(() => {
    const viewBox = svg.match(/viewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+[\d.]+\s*["']/i);
    const width = viewBox ? Number(viewBox[1]) : 800;
    return Number.isFinite(width) ? Math.max(100, Math.min(10000, width)) : 800;
  }, [svg]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth > 0) setAvailableWidth(Math.max(100, element.clientWidth - 40)); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [svg, showSource, error]);
  useEffect(() => {
    let active = true;
    setSvg("");
    setError(false);
    setZoom(1);
    setFitted(true);
    (async () => {
      try {
        if (!diagramIsSafeInput(code))
          throw new Error(
            "Diagram configuration or remote resources are not allowed",
          );
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          // Mermaid 11.14 gives this root flag priority over flowchart.htmlLabels.
          // Use SVG text: foreignObject is deliberately removed by our sanitizer.
          htmlLabels: false,
          theme: "base",
          themeVariables: {
            primaryColor: "#faf9f6",
            primaryTextColor: "#393b34",
            primaryBorderColor: "#c6c5bc",
            lineColor: "#85877c",
            secondaryColor: "#eeede8",
            tertiaryColor: "#ffffff",
            background: "#eeede8",
            edgeLabelBackground: "#eeede8",
            fontFamily: "system-ui",
          },
          flowchart: { htmlLabels: false },
        });
        const rendered = await mermaid.render(`diagram${id}`, code);
        if (active) setSvg(sanitizeDiagramSvg(rendered.svg));
      } catch {
        if (active) setError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [code, id]);
  return (
    <section className="diagram-frame" aria-label="Mermaid 图表">
      <div className="diagram-toolbar">
        <span>
          <Icon name="branch" size={13} /> mermaid
        </span>
        <div>
          <button type="button" aria-label="适应图表宽度" aria-pressed={fitted && zoom === 1} disabled={showSource || error} onClick={() => {setFitted(true); setZoom(1);}}>适应宽度</button>
          <button type="button" aria-label="图表原始尺寸" aria-pressed={!fitted && zoom === 1} disabled={showSource || error} onClick={() => {setFitted(false); setZoom(1);}}>原始尺寸</button>
          <button
            type="button"
            aria-label={showSource ? "查看图表" : "查看图表源码"}
            aria-pressed={showSource}
            onClick={() => setShowSource(!showSource)}
          >
            <Icon name={showSource ? "branch" : "code"} size={14} />
          </button>
          <button
            type="button"
            aria-label="缩小图表"
            disabled={zoom <= 0.5 || showSource || error}
            onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
          >
            −
          </button>
          <button
            type="button"
            aria-label="重置图表缩放"
            disabled={showSource || error}
            onClick={() => setZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="放大图表"
            disabled={zoom >= 4 || showSource || error}
            onClick={() => setZoom(Math.min(4, zoom + 0.25))}
          >
            +
          </button>
        </div>
      </div>
      {error || showSource ? (
        <pre className="diagram-fallback">
          {error && <small>图表语法无法解析或包含不允许的配置，显示源码</small>}
          <code>{code}</code>
        </pre>
      ) : (
        <div className="mermaid-box" aria-label="依赖关系图" ref={viewport} tabIndex={0}>
          {svg ? (
            <div className="diagram-canvas" style={{ width: (fitted ? Math.min(naturalWidth, availableWidth) : naturalWidth) * zoom }} dangerouslySetInnerHTML={{ __html: svg }} />
          ) : (
            <span className="muted">正在绘制关系图…</span>
          )}
        </div>
      )}
    </section>
  );
}
export function scrollToMarkdownHeading(root: Element | null | undefined, target: string) {
  const slug = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/g, "-");
  const heading = Array.from(root?.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6") || []).find(
    (item) => item.id === target || slug(item.textContent || "") === target,
  );
  heading?.scrollIntoView({ block: "start" });
  heading?.focus({ preventScroll: true });
}
const headingText = (node: any): string => node?.type === "text" ? node.value : (node?.children || []).map(headingText).join("");
export function Markdown({
  value,
  onSource,
  onPage,
  currentPageId,
  headingPrefix = "wiki-heading",
  leadingTitle,
}: {
  value: string;
  headingPrefix?: string;
  leadingTitle?: string;
  onSource: (ref: SourceRef) => void;
  onPage: (id: string, hash?: string) => void;
  currentPageId?: string;
}) {
  const handlers = useRef({ onSource, onPage, currentPageId, headingPrefix, leadingTitle });
  handlers.current = { onSource, onPage, currentPageId, headingPrefix, leadingTitle };
  const components = useMemo<Components>(
    () => ({
      ...Object.fromEntries(
        [1, 2, 3, 4, 5, 6].map((level) => [
          `h${level}`,
          ({ node, children }: any) =>
            createElement(
              `h${level}`,
              {
                id: `${handlers.current.headingPrefix}-${node?.position?.start?.line}`,
                tabIndex: -1,
                "data-title-duplicate": level === 1 && node?.position?.start?.line === 1 && headingText(node) === handlers.current.leadingTitle,
                "aria-hidden": level === 1 && node?.position?.start?.line === 1 && headingText(node) === handlers.current.leadingTitle ? true : undefined,
              },
              children,
            ),
        ]),
      ),
      code({ className, children, node: _node, ...props }) {
        const code = String(children).replace(/\n$/, "");
        if (className === "language-mermaid") return <Mermaid code={code} />;
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      },
      pre({ children }) {
        const props = isValidElement(children)
          ? (children.props as { className?: string })
          : {};
        if (props.className === "language-mermaid") return <>{children}</>;
        const language = props.className?.replace(/^language-/, "") || "code";
        return (
          <div className="code-wrapper">
            <div className="code-label">{language}</div>
            <pre>{children}</pre>
          </div>
        );
      },
      a({ href, children }) {
        if (!href) return <span>{children}</span>;
        const link = resolveWikiLink(href, handlers.current.currentPageId);
        if (link.kind === 'invalid') return <span>{children}</span>;
        if (link.kind === 'source')
          return (
            <button
              type="button"
              className="inline-source"
              onClick={() => handlers.current.onSource({ path: link.path, start_line: link.start ?? 1, end_line: link.end ?? 80 })}
            >
              {children}
              <span> ↗</span>
            </button>
          );
        if (link.kind === 'anchor')
          return (
            <button
              type="button"
              className="inline-page"
              onClick={(event) => {
                scrollToMarkdownHeading(event.currentTarget.closest('.markdown'), link.hash);
              }}
            >
              {children}
            </button>
          );
        if (link.kind === 'page')
          return (
            <button
              type="button"
              className="inline-page"
              onClick={() => link.hash === undefined ? handlers.current.onPage(link.pageId) : handlers.current.onPage(link.pageId, link.hash)}
            >
              {children}
            </button>
          );
        return (
          <a
            href={href}
            target={href && /^https?:/i.test(href) ? "_blank" : undefined}
            rel="noopener noreferrer"
          >
            {children}
          </a>
        );
      },
      img({ alt }) {
        return (
          <span className="image-placeholder">
            [图片：{alt || "外部图片已禁用，避免追踪请求"}]
          </span>
        );
      },
    }),
    [],
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) =>
          url.startsWith("source:") ? url : defaultUrlTransform(url)
        }
        components={components}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
