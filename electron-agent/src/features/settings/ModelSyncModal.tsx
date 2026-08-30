import { Modal } from '@lobehub/ui';
import { Checkbox, Empty, Input, Spin } from 'antd';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { useEffect, useMemo, useState } from 'react';
import { pi } from '../../lib/pi';

const styles = createStaticStyles(({ css }) => ({
  search: css`
    margin-block-end: 12px;
  `,
  bar: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-block-end: 8px;
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  list: css`
    min-height: 180px;
    max-height: 360px;
    overflow-y: auto;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    cursor: pointer;
    border-block-end: 1px solid ${cssVar.colorFillQuaternary};
    &:last-child {
      border-block-end: none;
    }
    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  rowDisabled: css`
    cursor: default;
    color: ${cssVar.colorTextQuaternary};
    &:hover {
      background: transparent;
    }
  `,
  id: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  `,
  added: css`
    flex: 0 0 auto;
    font-size: 12px;
    color: ${cssVar.colorTextQuaternary};
  `,
  center: css`
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 180px;
  `,
  error: css`
    padding: 24px 16px;
    text-align: center;
    font-size: 13px;
    color: ${cssVar.colorError};
    word-break: break-word;
  `,
}));

interface ModelSyncModalProps {
  open: boolean;
  baseUrl: string;
  apiKey: string;
  api: string;
  /** 已在当前供应商模型列表中的 id：标记「已添加」且不可重复勾选。 */
  existingIds: string[];
  onClose: () => void;
  onConfirm: (ids: string[]) => void;
}

/**
 * 「同步模型」弹窗：打开时拉取供应商可用模型列表，支持搜索、全选、批量勾选，
 * 确认后把勾选的新模型 id 交给调用方追加（不再一键全量同步）。
 */
export function ModelSyncModal({
  open,
  baseUrl,
  apiKey,
  api,
  existingIds,
  onClose,
  onConfirm,
}: ModelSyncModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 每次打开都重新拉取并重置选择/搜索状态（同一供应商多次打开拿到最新模型）。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setIds([]);
    setSelected(new Set());
    setSearch('');
    void (async () => {
      try {
        const list = await pi.fetchProviderModels(baseUrl, apiKey, api);
        if (alive) setIds(list);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, baseUrl, apiKey, api]);

  const existing = useMemo(() => new Set(existingIds), [existingIds]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? ids.filter((id) => id.toLowerCase().includes(q)) : ids;
  }, [ids, search]);
  // 可勾选项 = 过滤结果里尚未添加的（已添加项不参与全选与计数）。
  const selectable = useMemo(() => filtered.filter((id) => !existing.has(id)), [filtered, existing]);
  const allSelected = selectable.length > 0 && selectable.every((id) => selected.has(id));
  const someSelected = selectable.some((id) => selected.has(id));

  const toggle = (id: string) => {
    if (existing.has(id)) return;
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((s) => {
      if (allSelected) {
        const next = new Set(s);
        selectable.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...s, ...selectable]);
    });
  };

  const confirm = () => {
    onConfirm([...selected]);
    onClose();
  };

  return (
    <Modal
      open={open}
      title="同步模型"
      width={520}
      onCancel={onClose}
      onOk={confirm}
      okText={selected.size > 0 ? `添加 ${selected.size} 个` : '添加'}
      okButtonProps={{ disabled: selected.size === 0 }}
      cancelText="取消"
    >
      <Input
        className={styles.search}
        data-testid="sync-search"
        allowClear
        placeholder="搜索模型 ID"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {loading ? (
        <div className={styles.center}>
          <Spin />
        </div>
      ) : error ? (
        <div className={styles.error} data-testid="sync-error">
          拉取模型失败：{error}
        </div>
      ) : ids.length === 0 ? (
        <div className={styles.center}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未获取到模型" />
        </div>
      ) : (
        <>
          <div className={styles.bar}>
            <Checkbox
              data-testid="sync-select-all"
              checked={allSelected}
              indeterminate={!allSelected && someSelected}
              disabled={selectable.length === 0}
              onChange={toggleAll}
            >
              全选
            </Checkbox>
            <span>
              共 {filtered.length} 个 · 已选 {selected.size} 个
            </span>
          </div>
          <div className={styles.list} data-testid="sync-list">
            {filtered.length === 0 ? (
              <div className={styles.center}>
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无匹配模型" />
              </div>
            ) : (
              filtered.map((id) => {
                const isAdded = existing.has(id);
                return (
                  <div
                    key={id}
                    className={isAdded ? cx(styles.row, styles.rowDisabled) : styles.row}
                    onClick={() => toggle(id)}
                  >
                    <Checkbox
                      checked={isAdded || selected.has(id)}
                      disabled={isAdded}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggle(id)}
                    />
                    <span className={styles.id} title={id}>
                      {id}
                    </span>
                    {isAdded ? <span className={styles.added}>已添加</span> : null}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
