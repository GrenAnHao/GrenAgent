import { ActionIcon, Flexbox } from '@lobehub/ui';
import { openPath } from '@tauri-apps/plugin-opener';
import { Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi, type ImageItem } from '../../lib/pi';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

function formatTime(ms: number): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function ImageCard({ workspace, item }: { workspace: string; item: ImageItem }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void pi
      .createImage(workspace, item.name)
      .then((b64) => {
        if (alive) setSrc(`data:image/png;base64,${b64}`);
      })
      .catch(() => {
        if (alive) setSrc(null);
      });
    return () => {
      alive = false;
    };
  }, [workspace, item.name]);

  return (
    <button
      data-testid={`cr-card-${item.name}`}
      title="打开原图"
      onClick={() => void openPath(item.name)}
      style={{
        border,
        borderRadius: 10,
        overflow: 'hidden',
        cursor: 'pointer',
        background: 'var(--gren-bg-1, #16181c)',
        padding: 0,
        textAlign: 'left',
        color: 'inherit',
      }}
    >
      <div
        style={{
          height: 96,
          background: 'var(--gren-bg-2, #1e2127)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {src ? (
          <img
            data-testid={`cr-thumb-${item.name}`}
            src={src}
            alt={item.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span style={{ fontSize: 11, color: muted }}>加载…</span>
        )}
      </div>
      <div style={{ padding: '7px 9px' }}>
        <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.name}
        </div>
        <div style={{ fontSize: 11, color: muted, marginBlockStart: 2 }}>{formatTime(item.modifiedMs)}</div>
      </div>
    </button>
  );
}

export function CreatePanel() {
  const { workspace } = useAgentStoreContext();
  const [items, setItems] = useState<ImageItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [promptText, setPromptText] = useState('');

  const onGenerate = useCallback(() => {
    const t = promptText.trim();
    if (!t) return;
    void pi.prompt(workspace, `请生成一张图片：${t}`);
    setPromptText('');
  }, [workspace, promptText]);

  useEffect(() => {
    let alive = true;
    setError(null);
    void pi
      .createList(workspace)
      .then((list) => {
        if (alive) setItems(list);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [workspace]);

  return (
    <Flexbox data-testid="create-panel" style={{ height: '100%', minHeight: 0 }}>
      <div style={{ padding: '10px 14px', borderBottom: border, flex: '0 0 auto', fontSize: 13 }}>
        <span data-testid="cr-header">{items.length} 张图片</span>
      </div>
      {error ? (
        <div style={{ padding: 14, fontSize: 12, color: muted }}>读取失败：{error}</div>
      ) : items.length === 0 ? (
        <div data-testid="cr-empty" style={{ padding: 14, fontSize: 12, color: muted }}>
          暂无生成的图片
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: 14,
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12,
            alignContent: 'start',
          }}
        >
          {items.map((it) => (
            <ImageCard key={it.name} workspace={workspace} item={it} />
          ))}
        </div>
      )}
      <Flexbox
        horizontal
        align="center"
        gap={8}
        style={{ borderTop: border, padding: '9px 12px', flex: '0 0 auto' }}
      >
        <input
          data-testid="cr-prompt"
          value={promptText}
          placeholder="描述要生成的图…（也可在对话里 /生图）"
          onChange={(e) => setPromptText(e.target.value)}
          style={{
            flex: 1,
            padding: '7px 10px',
            borderRadius: 8,
            border,
            background: 'transparent',
            color: 'inherit',
            fontSize: 12,
          }}
        />
        <ActionIcon data-testid="cr-generate" icon={Sparkles} size="small" title="生成" onClick={onGenerate} />
      </Flexbox>
    </Flexbox>
  );
}
