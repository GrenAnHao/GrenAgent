import { ActionIcon, Flexbox, Icon, SearchResultCards } from '@lobehub/ui';
import { openPath } from '@tauri-apps/plugin-opener';
import {
  BookPlus,
  Brain,
  CheckSquare,
  ExternalLink,
  Globe,
  Image as ImageIcon,
  ListChecks,
  Network,
  Search,
  Square,
  Volume2,
} from 'lucide-react';
import type { CSSProperties, FC, ReactNode } from 'react';
import { LazyMarkdown } from '../chat/LazyMarkdown';
import { extractText, getDetails } from './toolUtils';

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

const FetchUrlCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  const url = asString(d?.url);
  const status = d?.status;
  const text = extractText(result);
  return (
    <Flexbox gap={6} data-testid="card-fetch_url">
      {url ? (
        <Flexbox horizontal align="center" gap={6}>
          <Icon icon={Globe} size={14} />
          <span style={{ fontSize: 12 }}>{url}</span>
          {status != null && <span style={labelStyle}>{asString(status)}</span>}
        </Flexbox>
      ) : null}
      {text ? <LazyMarkdown>{text}</LazyMarkdown> : null}
    </Flexbox>
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

const WebSearchCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  const results = Array.isArray(d?.results)
    ? (d!.results as Array<{ title?: unknown; url?: unknown }>)
    : [];

  if (results.length === 0) {
    const text = extractText(result);
    return (
      <div data-testid="card-web_search">{text ? <LazyMarkdown>{text}</LazyMarkdown> : null}</div>
    );
  }

  // lobehub 真 SearchResultCards：ScrollShadow 横滑 + 真结果卡（favicon + 标题 + 域名）。
  const dataSource = results
    .map((r) => ({ title: asString(r.title) || asString(r.url), url: asString(r.url) }))
    .filter((item) => item.url);

  return (
    <div data-testid="card-web_search">
      <SearchResultCards dataSource={dataSource} />
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
  speak: SpeakCard,
  todo: TodoCard,
};

export function renderExtensionCard(props: ExtensionCardProps): ReactNode | null {
  const Renderer = EXTENSION_CARD_RENDERERS[props.toolName.toLowerCase()];
  if (!Renderer) return null;
  return <Renderer {...props} />;
}
