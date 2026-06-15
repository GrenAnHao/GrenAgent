import { ActionIcon, Flexbox, Icon, ScrollArea, Skeleton } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { openPath } from '@tauri-apps/plugin-opener';
import {
  BookPlus,
  Brain,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe,
  Image as ImageIcon,
  ListChecks,
  Network,
  Search,
  Square,
  Volume2,
} from 'lucide-react';
import { useState, type CSSProperties, type FC, type ReactNode } from 'react';
import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';
import { LazyMarkdown } from '../chat/LazyMarkdown';
import { useDockStore } from '../../stores/dockStore';
import { extractText, getArgString, getDetails } from './toolUtils';

export interface ExtensionCardProps {
  toolName: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--gren-fg-muted, #9aa1ac)' };

function OpenFileButton({ path, toolName, title }: { path: string; toolName: string; title: string }) {
  if (!path) return null;
  return (
    <ActionIcon
      data-testid={`open-file-${toolName}`}
      icon={ExternalLink}
      size="small"
      title={title}
      onClick={() => void openPath(path)}
    />
  );
}

const KbSearchCard: FC<ExtensionCardProps> = ({ result }) => {
  const details = getDetails(result);
  const hits = Array.isArray(details?.hits)
    ? (details!.hits as Array<{ source?: unknown; score?: unknown }>)
    : [];
  const text = extractText(result);
  return (
    <Flexbox gap={6} data-testid="card-kb_search">
      {hits.length > 0 && (
        <Flexbox gap={2}>
          {hits.map((h, i) => (
            <Flexbox horizontal align="center" gap={6} key={i}>
              <Icon icon={Search} size={13} />
              <span style={{ fontSize: 12 }}>{asString(h.source)}</span>
              {h.score != null && <span style={labelStyle}>score {asString(h.score)}</span>}
            </Flexbox>
          ))}
        </Flexbox>
      )}
      {text ? <LazyMarkdown>{text}</LazyMarkdown> : null}
    </Flexbox>
  );
};

const KbAddCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  return (
    <Flexbox horizontal align="center" gap={6} data-testid="card-kb_add">
      <Icon icon={BookPlus} size={14} />
      <span style={{ fontSize: 12 }}>
        已索引 {asString(d?.source)} 为 {asString(d?.chunks ?? 0)} 块（{d?.embedded ? 'embedded' : 'keyword'}）
      </span>
    </Flexbox>
  );
};

const MemoryCard: FC<ExtensionCardProps> = ({ toolName, result }) => {
  const d = getDetails(result);
  const text = extractText(result);
  if (toolName === 'memory_save') {
    const category = asString(d?.category);
    return (
      <Flexbox horizontal align="center" gap={6} data-testid="card-memory_save">
        <Icon icon={Brain} size={14} />
        <span style={{ fontSize: 12 }}>
          已保存到{d?.scope === 'global' ? '全局' : '项目'}记忆{category ? `（${category}）` : ''}
        </span>
      </Flexbox>
    );
  }
  return (
    <Flexbox gap={6} data-testid="card-memory_recall">
      <Flexbox horizontal align="center" gap={6}>
        <Icon icon={Brain} size={14} />
        <span style={{ fontSize: 12 }}>召回记忆</span>
      </Flexbox>
      {text ? <LazyMarkdown>{text}</LazyMarkdown> : null}
    </Flexbox>
  );
};

const GenerateImageCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  const path = asString(d?.path);
  const meta = [asString(d?.model), asString(d?.size)].filter(Boolean).join(' ');
  return (
    <Flexbox horizontal align="center" gap={8} data-testid="card-generate_image">
      <Icon icon={ImageIcon} size={14} />
      <span style={{ fontSize: 12 }}>{basename(path)}</span>
      {meta ? <span style={labelStyle}>{meta}</span> : null}
      <OpenFileButton path={path} toolName="generate_image" title="打开图片" />
    </Flexbox>
  );
};

const SpawnAgentCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  const text = extractText(result);
  const countRaw = d?.count;
  const count = typeof countRaw === 'number' ? countRaw : undefined;
  const failedRaw = d?.failed;
  const failed = typeof failedRaw === 'number' ? failedRaw : undefined;
  return (
    <Flexbox gap={6} data-testid="card-spawn_agent">
      {count != null && (
        <Flexbox horizontal align="center" gap={6}>
          <Icon icon={Network} size={14} />
          <span style={{ fontSize: 12 }}>
            {count} 个子 agent{failed ? `，${failed} 个失败` : ''}
          </span>
        </Flexbox>
      )}
      {text ? <LazyMarkdown>{text}</LazyMarkdown> : null}
    </Flexbox>
  );
};

// 对齐 lobehub web-browsing 单页抓取卡：三态共用同一卡片容器（边框/圆角/宽度一致），
// 只换内部内容 —— 加载（骨架）/ 失败（红字 + 抓取模式）/ 成功（标题 + 描述 + 字数·抓取）。
// 整页正文不灌进对话流，成功态点卡片在右侧面板全览。
const fetchStyles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
  `,
  card: css`
    overflow: hidden;
    width: 100%;
    max-width: 360px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorBgContainer};
    transition: border-color 0.2s;

    &:hover {
      border-color: ${cssVar.colorBorder};
    }
  `,
  desc: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorTextTertiary};
  `,
  errText: css`
    overflow-wrap: anywhere;
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorError};
  `,
  footer: css`
    display: flex;
    gap: 16px;
    padding: 6px 12px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
    background: ${cssVar.colorFillQuaternary};
  `,
  footerLabel: css`
    color: ${cssVar.colorTextQuaternary};
  `,
  title: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  titleRow: css`
    display: flex;
    overflow: hidden;
    align-items: center;
    gap: 6px;
  `,
  url: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

const FetchUrlCard: FC<ExtensionCardProps> = ({ args, result, status }) => {
  const openPage = useDockStore((s) => s.openPage);
  const d = getDetails(result);
  const url = asString(d?.url) || getArgString(args, 'url');
  const content = extractText(result);
  const crawler = asString(d?.crawler);
  const errorMsg = asString(d?.error);

  const isLoading = status === 'running' && !d;
  const isError =
    !isLoading && (status === 'error' || !!errorMsg || (d?.chars == null && content.startsWith('抓取失败')));
  const isSuccess = !isLoading && !isError;

  const title = asString(d?.title) || url;
  const chars = typeof d?.chars === 'number' ? (d.chars as number) : undefined;
  const preview = content.replace(/\s+/g, ' ').trim().slice(0, 160);
  const showFooter = !isLoading && (chars != null || crawler);

  // 三态共用同一 card 容器，只切换内部内容与可点击性。
  return (
    <div
      className={fetchStyles.card}
      role={isSuccess ? 'button' : undefined}
      tabIndex={isSuccess ? 0 : undefined}
      style={isSuccess ? { cursor: 'pointer' } : undefined}
      data-testid="card-fetch_url"
      onClick={isSuccess ? () => openPage({ url, content, title, chars, crawler }) : undefined}
    >
      <div className={fetchStyles.body}>
        <div className={fetchStyles.titleRow}>
          <Icon icon={Globe} size={13} />
          <span className={isSuccess ? fetchStyles.title : fetchStyles.url}>
            {isSuccess ? title : url || '抓取中…'}
          </span>
          {isSuccess ? (
            <ActionIcon
              icon={ExternalLink}
              size="small"
              title="在浏览器打开"
              onClick={(e) => {
                e.stopPropagation();
                void openPath(url);
              }}
            />
          ) : null}
        </div>

        {isLoading ? (
          <Flexbox gap={6}>
            <Skeleton.Block active style={{ height: 12, width: '92%' }} />
            <Skeleton.Block active style={{ height: 12, width: '48%' }} />
          </Flexbox>
        ) : isError ? (
          <div className={fetchStyles.errText}>{errorMsg || content || '抓取失败'}</div>
        ) : preview ? (
          <div className={fetchStyles.desc}>{preview}</div>
        ) : null}
      </div>

      {showFooter ? (
        <div className={fetchStyles.footer}>
          {chars != null ? (
            <span>
              <span className={fetchStyles.footerLabel}>字数 </span>
              {chars}
            </span>
          ) : null}
          {crawler ? (
            <span>
              <span className={fetchStyles.footerLabel}>抓取 </span>
              {crawler}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const SpeakCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  const path = asString(d?.path);
  const voice = asString(d?.voice);
  return (
    <Flexbox horizontal align="center" gap={8} data-testid="card-speak">
      <Icon icon={Volume2} size={14} />
      <span style={{ fontSize: 12 }}>{basename(path)}</span>
      {voice ? <span style={labelStyle}>{voice}</span> : null}
      <OpenFileButton path={path} toolName="speak" title="打开音频" />
    </Flexbox>
  );
};

const TodoCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  const todos = Array.isArray(d?.todos)
    ? (d!.todos as Array<{ id?: unknown; text?: unknown; done?: unknown }>)
    : [];
  const done = todos.filter((t) => t.done).length;
  return (
    <Flexbox gap={6} data-testid="card-todo">
      <Flexbox horizontal align="center" gap={6}>
        <Icon icon={ListChecks} size={14} />
        <span style={{ fontSize: 12 }}>{todos.length ? `${done}/${todos.length} 完成` : '暂无待办'}</span>
      </Flexbox>
      {todos.length > 0 && (
        <Flexbox gap={2}>
          {todos.map((t, i) => (
            <Flexbox horizontal align="center" gap={6} key={i}>
              <Icon icon={t.done ? CheckSquare : Square} size={13} />
              <span
                style={{
                  fontSize: 12,
                  ...(t.done ? { color: 'var(--gren-fg-muted, #9aa1ac)', textDecoration: 'line-through' } : {}),
                }}
              >
                #{asString(t.id)} {asString(t.text)}
              </span>
            </Flexbox>
          ))}
        </Flexbox>
      )}
    </Flexbox>
  );
};

const searchCardStyles = createStaticStyles(({ css }) => ({
  wrap: css`
    overflow: hidden;
    width: 100%;
    max-width: 520px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorBgContainer};
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;

    &:hover {
      background: ${cssVar.colorFillQuaternary};
    }
  `,
  headerLeft: css`
    display: flex;
    overflow: hidden;
    flex: 1;
    gap: 8px;
    align-items: center;
    min-width: 0;
  `,
  headerTitle: css`
    overflow: hidden;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  query: css`
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  faviconStack: css`
    display: flex;
    flex-shrink: 0;
    align-items: center;
  `,
  favicon: css`
    width: 16px;
    height: 16px;
    margin-inline: -3px;
    padding: 2px;
    border-radius: 999px;
    background: ${cssVar.colorBgContainer};
  `,
  body: css`
    padding: 0 0 12px;
  `,
  scrollRoot: css`
    border-radius: 0;
    background: transparent;
  `,
  resultsScroll: css`
    max-height: min(42vh, 340px);
    padding-inline: 12px;
  `,
  resultsList: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-block-end: 4px;
    padding-inline-end: 4px;
  `,
  item: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorFillQuaternary};
    text-decoration: none;
    transition: border-color 0.2s, background 0.2s;

    &:hover {
      border-color: ${cssVar.colorBorder};
      background: ${cssVar.colorBgContainer};
    }
  `,
  itemTitle: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.45;
    color: ${cssVar.colorText};
  `,
  itemSnippet: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorTextTertiary};
  `,
  itemMeta: css`
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 11px;
    color: ${cssVar.colorTextQuaternary};
  `,
  errText: css`
    padding: 10px 12px;
    font-size: 12px;
    color: ${cssVar.colorError};
  `,
  loadingRow: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px 12px;
  `,
}));

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function faviconUrl(url: string): string {
  return `https://icons.duckduckgo.com/ip3/${hostFromUrl(url)}.ico`;
}

const searchExpandVariants = {
  collapsed: { height: 0, opacity: 0 },
  open: { height: 'auto', opacity: 1 },
} as const;

const SearchResultsPanel: FC<{
  query?: string;
  provider?: string;
  results: Array<{ title?: unknown; url?: unknown; snippet?: unknown }>;
  status: ExtensionCardProps['status'];
  error?: string;
  testId: string;
}> = ({ query, provider, results, status, error, testId }) => {
  const [expanded, setExpanded] = useState(false);
  const items = results
    .map((r) => ({
      title: asString(r.title) || asString(r.url),
      url: asString(r.url),
      snippet: asString(r.snippet),
    }))
    .filter((r) => r.url);

  if (status === 'running' && items.length === 0) {
    return (
      <div className={searchCardStyles.wrap} data-testid={testId}>
        <div className={searchCardStyles.header}>
          <div className={searchCardStyles.headerLeft}>
            <Icon icon={Search} size={14} />
            <span className={searchCardStyles.headerTitle}>
              搜索：<span className={searchCardStyles.query}>{query || '…'}</span>
            </span>
          </div>
        </div>
        <div className={searchCardStyles.loadingRow}>
          {[0, 1, 2].map((i) => (
            <Skeleton.Block active key={i} style={{ borderRadius: 8, height: 64, width: '100%' }} />
          ))}
        </div>
      </div>
    );
  }

  if (error || items.length === 0) {
    const text = error || '未找到结果';
    return (
      <div className={searchCardStyles.wrap} data-testid={testId}>
        <div className={searchCardStyles.errText}>{text}</div>
      </div>
    );
  }

  return (
    <div className={searchCardStyles.wrap} data-testid={testId}>
      <div className={searchCardStyles.header} onClick={() => setExpanded((v) => !v)}>
        <div className={searchCardStyles.headerLeft}>
          <Icon icon={Search} size={14} />
          <span className={searchCardStyles.headerTitle}>
            搜索：<span className={searchCardStyles.query}>{query || 'web'}</span>
            {provider ? ` · ${provider}` : ''}（{items.length}）
          </span>
          {!expanded ? (
            <div className={searchCardStyles.faviconStack}>
              {items.slice(0, 6).map((item, index) => (
                <img
                  key={item.url}
                  alt=""
                  className={searchCardStyles.favicon}
                  src={faviconUrl(item.url)}
                  style={{ zIndex: 10 - index }}
                />
              ))}
            </div>
          ) : null}
        </div>
        <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} />
      </div>
      {expanded ? (
        <AnimatePresence initial={false}>
          <m.div
            key="search-results"
            animate="open"
            exit="collapsed"
            initial="collapsed"
            style={{ overflow: 'hidden', width: '100%' }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            variants={searchExpandVariants}
          >
            <div className={searchCardStyles.body}>
              <ScrollArea
                disableContentFit
                scrollFade
                className={searchCardStyles.scrollRoot}
                contentProps={{
                  style: {
                    color: 'inherit',
                    display: 'block',
                    fontSize: 'inherit',
                    gap: 0,
                    lineHeight: 'inherit',
                    paddingInlineEnd: 4,
                  },
                }}
                scrollbarProps={{
                  style: { marginInlineEnd: 2 },
                }}
                viewportProps={{
                  className: searchCardStyles.resultsScroll,
                }}
              >
                <Flexbox className={searchCardStyles.resultsList} gap={8}>
                  {items.map((item) => (
                    <a
                      key={item.url}
                      className={searchCardStyles.item}
                      href={item.url}
                      rel="noopener noreferrer"
                      target="_blank"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className={searchCardStyles.itemTitle}>{item.title}</div>
                      {item.snippet ? <div className={searchCardStyles.itemSnippet}>{item.snippet}</div> : null}
                      <div className={searchCardStyles.itemMeta}>
                        <img alt="" src={faviconUrl(item.url)} width={12} height={12} style={{ borderRadius: 2 }} />
                        <span>{hostFromUrl(item.url)}</span>
                      </div>
                    </a>
                  ))}
                </Flexbox>
              </ScrollArea>
            </div>
          </m.div>
        </AnimatePresence>
      ) : null}
    </div>
  );
};

const WebSearchCard: FC<ExtensionCardProps> = ({ args, result, status }) => {
  const d = getDetails(result);
  const query = asString(d?.query) || getArgString(args, 'query');
  const provider = asString(d?.provider);
  const error = asString(d?.error);
  const results = Array.isArray(d?.results) ? (d!.results as Array<{ title?: unknown; url?: unknown; snippet?: unknown }>) : [];
  return (
    <SearchResultsPanel
      query={query}
      provider={provider}
      results={results}
      status={status}
      error={error || (status === 'error' ? extractText(result) : undefined)}
      testId="card-web_search"
    />
  );
};

const MultiSearchCard: FC<ExtensionCardProps> = ({ args, result, status }) => {
  const d = getDetails(result);
  const query = asString(d?.query) || getArgString(args, 'query');
  const engines = Array.isArray(d?.engines) ? (d!.engines as unknown[]).map(asString).filter(Boolean).join(', ') : 'multi';
  const error = asString(d?.error);
  const results = Array.isArray(d?.results) ? (d!.results as Array<{ title?: unknown; url?: unknown; snippet?: unknown }>) : [];
  return (
    <SearchResultsPanel
      query={query}
      provider={engines}
      results={results}
      status={status}
      error={error}
      testId="card-search"
    />
  );
};

const FetchArticleCard: FC<ExtensionCardProps & { testId: string }> = ({ args, result, status, testId }) => {
  const d = getDetails(result);
  const url = asString(d?.url) || getArgString(args, 'url');
  const errorMsg = asString(d?.error);
  const content = extractText(result);
  const chars = typeof d?.chars === 'number' ? (d.chars as number) : content.length;
  const isLoading = status === 'running' && !d;
  const isError = !isLoading && (status === 'error' || !!errorMsg);

  return (
    <div className={fetchStyles.card} data-testid={testId}>
      <div className={fetchStyles.body}>
        <div className={fetchStyles.titleRow}>
          <Icon icon={Globe} size={13} />
          <span className={fetchStyles.url}>{url || '抓取中…'}</span>
        </div>
        {isLoading ? (
          <Flexbox gap={6}>
            <Skeleton.Block active style={{ height: 12, width: '92%' }} />
            <Skeleton.Block active style={{ height: 12, width: '70%' }} />
          </Flexbox>
        ) : isError ? (
          <div className={fetchStyles.errText}>{errorMsg || content || '抓取失败'}</div>
        ) : (
          <div className={fetchStyles.desc}>{content.replace(/\s+/g, ' ').trim().slice(0, 160)}</div>
        )}
      </div>
      {!isLoading && !isError && chars > 0 ? (
        <div className={fetchStyles.footer}>
          <span>
            <span className={fetchStyles.footerLabel}>字数 </span>
            {chars}
          </span>
        </div>
      ) : null}
    </div>
  );
};

const EXTENSION_CARD_RENDERERS: Record<string, FC<ExtensionCardProps>> = {
  kb_search: KbSearchCard,
  kb_add: KbAddCard,
  memory_save: MemoryCard,
  memory_recall: MemoryCard,
  generate_image: GenerateImageCard,
  spawn_agent: SpawnAgentCard,
  fetch_url: FetchUrlCard,
  web_search: WebSearchCard,
  search: MultiSearchCard,
  fetch_csdn_article: (p) => <FetchArticleCard {...p} testId="card-fetch_csdn_article" />,
  fetch_juejin_article: (p) => <FetchArticleCard {...p} testId="card-fetch_juejin_article" />,
  fetch_linuxdo_article: (p) => <FetchArticleCard {...p} testId="card-fetch_linuxdo_article" />,
  fetch_github_readme: (p) => <FetchArticleCard {...p} testId="card-fetch_github_readme" />,
  fetch_web_content: (p) => <FetchArticleCard {...p} testId="card-fetch_web_content" />,
  speak: SpeakCard,
  todo: TodoCard,
};

export function renderExtensionCard(props: ExtensionCardProps): ReactNode | null {
  const Renderer = EXTENSION_CARD_RENDERERS[props.toolName.toLowerCase()];
  if (!Renderer) return null;
  return <Renderer {...props} />;
}
