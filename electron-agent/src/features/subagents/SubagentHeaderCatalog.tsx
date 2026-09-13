import { ActionIcon, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown, ChevronRight, ListTree, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  onPiEvent,
  pi,
  type CatalogRowView,
  type SubagentCatalogEntry,
  type SubagentCatalogView,
} from '../../lib/pi';
import { useSessionStore } from '../../store/session';

export interface SubagentHeaderCatalogProps {
  activeChildId?: string | null;
  onOpen?: (entry: CatalogRowView) => void;
}

type TreeRow = CatalogRowView & { depth: number };

const styles = createStaticStyles(({ css }) => ({
  triggerWrap: css`
    position: relative;
    display: inline-flex;
    cursor: pointer;
  `,
  badge: css`
    position: absolute;
    top: -2px;
    right: -2px;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    color: ${cssVar.colorSuccess};
    background: ${cssVar.colorSuccessBg};
    pointer-events: none;
  `,
  panel: css`
    position: fixed;
    z-index: 1100;
    display: flex;
    flex-direction: column;
    width: 360px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  headerTitle: css`
    flex: 1;
  `,
  count: css`
    font-weight: 400;
    color: ${cssVar.colorTextTertiary};
  `,
  tree: css`
    width: 360px;
    max-height: min(60vh, 520px);
    overflow-y: auto;
    padding: 4px 0;
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 10px;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    &[aria-disabled='true'] {
      cursor: not-allowed;
      opacity: 0.65;
    }
  `,
  rowActive: css`
    background: ${cssVar.colorFillSecondary};
  `,
  rowFocused: css`
    outline: 1px solid ${cssVar.colorBorder};
  `,
  expand: css`
    display: inline-flex;
    flex: 0 0 14px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;
  `,
  expandSpacer: css`
    flex: 0 0 14px;
  `,
  label: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  `,
  meta: css`
    flex: 0 0 auto;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
    white-space: nowrap;
  `,
  diagnostic: css`
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
    white-space: nowrap;
  `,
}));

const DOT: Record<CatalogRowView['activity'], string> = {
  running: '#3dd68c',
  idle: '#d4a017',
  ready: '#6aa8ff',
  settled: '#8b919a',
  unavailable: '#e5534b',
};

export function formatCatalogDuration(durationMs: number): string {
  const ms = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSec = Math.floor(ms / 1000);
  if (ms < 3_600_000) {
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
  const hours = Math.floor(totalSec / 3600);
  const rem = totalSec % 3600;
  const minutes = Math.floor(rem / 60);
  const seconds = rem % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatCatalogTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(n);
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, '');
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

function emptyView(): SubagentCatalogView {
  return { entries: [], diagnostics: [] };
}

function diagnosticRow(id: string, reason: 'corrupt'): CatalogRowView {
  return {
    id,
    sessionPath: '',
    createdAt: 0,
    mode: 'one-shot',
    label: id,
    activity: 'unavailable',
    hasChildren: false,
    diagnostic: reason,
  };
}

function diagnosticRows(view: SubagentCatalogView): CatalogRowView[] {
  return (view.diagnostics ?? []).map((item) => diagnosticRow(item.id, item.reason));
}

async function foldCatalog(sessionPath: string): Promise<SubagentCatalogView> {
  try {
    return await pi.subagentCatalog(sessionPath);
  } catch {
    return emptyView();
  }
}

async function sampleEntry(entry: SubagentCatalogEntry): Promise<CatalogRowView> {
  try {
    return await pi.subagentCatalogRow(entry.sessionPath);
  } catch {
    return {
      ...entry,
      activity: 'unavailable',
      hasChildren: false,
      diagnostic: 'unavailable',
    };
  }
}

async function sampleView(view: SubagentCatalogView): Promise<CatalogRowView[]> {
  const rows = await Promise.all(view.entries.map(sampleEntry));
  return [...rows, ...diagnosticRows(view)];
}

function patchLiveFields(row: CatalogRowView, next: CatalogRowView): CatalogRowView {
  return {
    ...row,
    activity: next.activity,
    tokens: next.tokens,
    durationMs: next.durationMs,
    diagnostic: next.diagnostic,
  };
}

export function SubagentHeaderCatalog({ activeChildId, onOpen }: SubagentHeaderCatalogProps) {
  const parentPath = useSessionStore((s) => s.activeSessionPath);
  const [open, setOpen] = useState(false);
  const [rootRows, setRootRows] = useState<CatalogRowView[]>([]);
  const [childRows, setChildRows] = useState<Record<string, CatalogRowView[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [focusIndex, setFocusIndex] = useState(0);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  const parentPathRef = useRef(parentPath);
  const openRef = useRef(open);
  const rootRowsRef = useRef(rootRows);
  const childRowsRef = useRef(childRows);
  const expandedRef = useRef(expanded);
  const treeRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const loadGen = useRef(0);

  parentPathRef.current = parentPath;
  openRef.current = open;
  rootRowsRef.current = rootRows;
  childRowsRef.current = childRows;
  expandedRef.current = expanded;

  const visibleRows = useMemo(() => {
    const out: TreeRow[] = [];
    const walk = (rows: CatalogRowView[], depth: number) => {
      for (const row of rows) {
        out.push({ ...row, depth });
        if (row.hasChildren && expanded[row.id] && childRows[row.id]) {
          walk(childRows[row.id], depth + 1);
        }
      }
    };
    walk(rootRows, 0);
    return out;
  }, [rootRows, childRows, expanded]);

  const runningCount = useMemo(
    () => visibleRows.filter((row) => row.activity === 'running').length,
    [visibleRows],
  );

  const loadRoot = useCallback(async (sessionPath: string, sampleVisible: boolean) => {
    const gen = ++loadGen.current;
    const view = await foldCatalog(sessionPath);
    if (gen !== loadGen.current || parentPathRef.current !== sessionPath) return;
    if (view.entries.length === 0) {
      setRootRows([]);
      setChildRows({});
      setExpanded({});
      return;
    }
    const sampled = await sampleView(view);
    if (gen !== loadGen.current || parentPathRef.current !== sessionPath) return;
    setRootRows(sampled);
    if (!sampleVisible) return;
    const currentExpanded = expandedRef.current;
    const nextChildren: Record<string, CatalogRowView[]> = {};
    const pending = sampled.slice();
    while (pending.length > 0) {
      const row = pending[pending.length - 1];
      pending.pop();
      if (!row || !row.hasChildren || !currentExpanded[row.id] || !row.sessionPath) continue;
      const kids = await sampleView(await foldCatalog(row.sessionPath));
      if (gen !== loadGen.current) return;
      nextChildren[row.id] = kids;
      for (const kid of kids) pending.push(kid);
    }
    setChildRows(nextChildren);
  }, []);

  useEffect(() => {
    if (!parentPath) {
      loadGen.current += 1;
      setRootRows([]);
      setChildRows({});
      setExpanded({});
      setOpen(false);
      return;
    }
    void loadRoot(parentPath, openRef.current);
  }, [parentPath, loadRoot]);

  useEffect(() => {
    let unsub = () => {};
    void onPiEvent((env) => {
      const event = env.event as { type?: string; sessionPath?: string } | undefined;
      if (event?.type !== 'subagent_catalog_changed') return;
      const path = event.sessionPath ?? env.sessionPath;
      const parent = parentPathRef.current;
      if (!parent || path !== parent) return;
      void loadRoot(parent, openRef.current);
    }).then((fn) => {
      unsub = fn;
    });
    return () => {
      unsub();
    };
  }, [loadRoot]);

  useEffect(() => {
    if (!open) return;
    const running = visibleRows.filter((row) => row.activity === 'running' && row.sessionPath);
    if (running.length === 0) return;
    const timer = window.setInterval(() => {
      void (async () => {
        const updates = await Promise.all(
          running.map(async (row) => {
            try {
              return [row.id, await pi.subagentCatalogRow(row.sessionPath)] as const;
            } catch {
              return [row.id, null] as const;
            }
          }),
        );
        const byId = new Map(updates);
        const apply = (rows: CatalogRowView[]) =>
          rows.map((row) => {
            const next = byId.get(row.id);
            return next ? patchLiveFields(row, next) : row;
          });
        setRootRows((rows) => apply(rows));
        setChildRows((prev) => {
          const next: Record<string, CatalogRowView[]> = {};
          for (const id of Object.keys(prev)) next[id] = apply(prev[id]);
          return next;
        });
      })();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [open, visibleRows]);

  useEffect(() => {
    if (!open) return;
    treeRef.current?.focus();
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const refresh = () => {
    if (!parentPath) return;
    void loadRoot(parentPath, true);
  };

  const openRow = (row: CatalogRowView) => {
    if (row.diagnostic) return;
    onOpen?.(row);
  };

  const toggleExpand = async (row: CatalogRowView) => {
    if (!row.hasChildren || !row.sessionPath) return;
    if (expanded[row.id]) {
      setExpanded((prev) => ({ ...prev, [row.id]: false }));
      return;
    }
    setExpanded((prev) => ({ ...prev, [row.id]: true }));
    if (!childRows[row.id]) {
      const sampled = await sampleView(await foldCatalog(row.sessionPath));
      setChildRows((prev) => ({ ...prev, [row.id]: sampled }));
    }
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setFocusIndex((index) => Math.min(index + 1, Math.max(visibleRows.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setFocusIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = visibleRows[focusIndex];
      if (row) openRow(row);
    }
  };

  if (!parentPath || rootRows.length === 0) return null;

  const title = runningCount > 0 ? `子代理（${runningCount} 运行中）` : '子代理';
  const rootCount = rootRows.length;

  const dropdown = (
    <div
      ref={panelRef}
      className={styles.panel}
      style={{ top: anchor.top, left: anchor.left }}
    >
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          子代理 <span className={styles.count}>· {rootCount}</span>
        </span>
        <ActionIcon icon={RefreshCw} size="small" title="刷新" onClick={refresh} />
      </div>
      <div
        ref={treeRef}
        className={styles.tree}
        role="tree"
        tabIndex={0}
        style={{ width: 360, maxHeight: 'min(60vh, 520px)' }}
        onKeyDown={onTreeKeyDown}
      >
        {visibleRows.map((row, index) => {
          const disabled = Boolean(row.diagnostic);
          const diagnosticText =
            row.diagnostic === 'unavailable' ? '无法读取' : row.diagnostic === 'corrupt' ? '记录损坏' : null;
          return (
            <div
              key={`${row.id}:${row.sessionPath}:${row.depth}:${index}`}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={row.hasChildren ? Boolean(expanded[row.id]) : undefined}
              aria-disabled={disabled || undefined}
              aria-selected={focusIndex === index}
              className={`${styles.row} ${activeChildId && row.id === activeChildId ? styles.rowActive : ''} ${focusIndex === index ? styles.rowFocused : ''}`}
              style={{ paddingLeft: 10 + row.depth * 16 }}
              onClick={() => openRow(row)}
              onMouseEnter={() => setFocusIndex(index)}
            >
              {row.hasChildren ? (
                <button
                  type="button"
                  className={styles.expand}
                  aria-label={expanded[row.id] ? '折叠' : '展开'}
                  onClick={(event) => {
                    event.stopPropagation();
                    void toggleExpand(row);
                  }}
                >
                  <Icon icon={expanded[row.id] ? ChevronDown : ChevronRight} size={12} />
                </button>
              ) : (
                <span className={styles.expandSpacer} />
              )}
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 99,
                  background: DOT[row.activity],
                  flex: '0 0 7px',
                }}
              />
              <span className={styles.label}>{row.label}</span>
              {diagnosticText ? <span className={styles.diagnostic}>{diagnosticText}</span> : (
                <>
                  <span className={styles.meta}>{row.mode}</span>
                  {row.tokens != null ? <span className={styles.meta}>{formatCatalogTokens(row.tokens)}</span> : null}
                  {row.durationMs != null ? <span className={styles.meta}>{formatCatalogDuration(row.durationMs)}</span> : null}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <>
      <div
        ref={triggerRef}
        className={styles.triggerWrap}
        data-testid="subagent-header-catalog"
        title={title}
        onClick={() => {
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect) setAnchor({ top: rect.bottom + 4, left: rect.left });
          setOpen((value) => !value);
        }}
      >
        <ActionIcon icon={ListTree} size="small" active={open} title={title} />
        {runningCount > 0 ? <span className={styles.badge}>{runningCount}</span> : null}
      </div>
      {open ? createPortal(dropdown, document.body) : null}
    </>
  );
}
