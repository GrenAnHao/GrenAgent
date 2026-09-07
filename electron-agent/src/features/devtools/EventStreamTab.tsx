import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Trash2 } from 'lucide-react';
import { listen, type UnlistenFn } from '../../platform/runtime';
import { styles } from './devtoolsStyles';
import { formatClock, oneLine, prettyJson, summarize } from './devtoolsFormat';

const CHANNELS = ['pi://event', 'pi://ui-request', 'pi://exit'] as const;
type Channel = (typeof CHANNELS)[number];

const BUFFER_LIMIT = 300;

interface StreamEvent {
  id: number;
  channel: Channel;
  at: number;
  type: string;
  workspace: string;
  payload: unknown;
}

function summarizePayload(payload: unknown): unknown {
  return summarize(payload, { maxDepth: 5, maxItems: 12, maxString: 400 });
}

/** 各通道的 payload 都是「{ workspace, ... }」封套，取出业务对象与它的 type。 */
function unwrap(channel: Channel, payload: unknown): { workspace: string; type: string; body: unknown } {
  if (!payload || typeof payload !== 'object') return { workspace: '', type: '-', body: payload };
  const envelope = payload as Record<string, unknown>;
  const workspace = typeof envelope.workspace === 'string' ? envelope.workspace : '';
  if (channel === 'pi://exit') return { workspace, type: `exit(${String(envelope.code)})`, body: payload };
  const body = channel === 'pi://ui-request' ? envelope.request : envelope.event;
  if (body && typeof body === 'object' && typeof (body as Record<string, unknown>).type === 'string') {
    return { workspace, type: (body as Record<string, unknown>).type as string, body };
  }
  return { workspace, type: channel, body };
}

export function EventStreamTab() {
  const [enabled, setEnabled] = useState<Record<Channel, boolean>>({
    'pi://event': true,
    'pi://ui-request': false,
    'pi://exit': false,
  });
  const [paused, setPaused] = useState(false);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const nextId = useRef(1);

  const subscriptionKey = CHANNELS.map((channel) => `${channel}:${enabled[channel] ? 1 : 0}`).join('|');

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    for (const channel of CHANNELS) {
      if (!enabled[channel]) continue;
      void listen<unknown>(channel, (event) => {
        if (disposed || pausedRef.current) return;
        const { workspace, type, body } = unwrap(channel, event.payload);
        const record: StreamEvent = {
          id: nextId.current++,
          channel,
          at: Date.now(),
          type,
          workspace,
          payload: body,
        };
        setEvents((prev) => {
          const next = [record, ...prev];
          if (next.length > BUFFER_LIMIT) return next.slice(0, BUFFER_LIMIT);
          return next;
        });
      }).then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });
    }
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [subscriptionKey]);

  const visible = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) return events;
    return events.filter((item) =>
      `${item.channel} ${item.type} ${item.workspace}`.toLowerCase().includes(keyword),
    );
  }, [events, filter]);

  return (
    <div className={styles.root} data-testid="dev-events-tab" style={{ flex: 1, minHeight: 0 }}>
      <div className={styles.toolbar} style={{ flexWrap: 'wrap', gap: 10 }}>
        {CHANNELS.map((channel) => (
          <label key={channel} className={styles.hint} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <input
              type="checkbox"
              checked={enabled[channel]}
              onChange={(e) => setEnabled((prev) => ({ ...prev, [channel]: e.target.checked }))}
            />
            <span className={styles.mono}>{channel}</span>
          </label>
        ))}
        <span className={styles.toolbarSpacer} />
        <input
          className={styles.input}
          style={{ width: 180 }}
          placeholder="过滤 type / workspace"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          className={styles.iconButton}
          aria-label={paused ? '继续接收事件' : '暂停接收事件'}
          title={paused ? '继续接收事件' : '暂停接收事件'}
          onClick={() => setPaused((value) => !value)}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="清空事件"
          title="清空事件"
          onClick={() => {
            setEvents([]);
            setExpanded(null);
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className={styles.scroll} style={{ paddingBlockStart: 12 }}>
        {visible.length === 0 ? (
          <div className={styles.state}>
            {paused ? '已暂停' : '等待事件…（勾选上方通道后，发起一次对话即可看到 pi://event 流）'}
          </div>
        ) : (
          <div className={styles.list}>
            {visible.map((item) => (
              <div key={item.id} className={styles.row}>
                <div
                  className={`${styles.rowHead} ${styles.clickable}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpanded(expanded === item.id ? null : item.id);
                    }
                  }}
                >
                  <span className={styles.rowTime}>{formatClock(item.at)}</span>
                  <span className={styles.tag}>{item.channel}</span>
                  <span className={`${styles.rowSummary} ${styles.mono}`}>{item.type}</span>
                  {item.workspace ? <span className={`${styles.hint} ${styles.mono}`}>{item.workspace.split(/[\\/]/).pop()}</span> : null}
                </div>
                {expanded === item.id ? (
                  <pre className={styles.rowBody}>{prettyJson(summarizePayload(item.payload))}</pre>
                ) : (
                  <div className={`${styles.hint} ${styles.mono} ${styles.nowrap}`}>{oneLine(summarizePayload(item.payload))}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
