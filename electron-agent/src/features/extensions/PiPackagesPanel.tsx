import { Button, Flexbox, Icon, Modal } from '@lobehub/ui';
import { App, Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Package, Store, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { packageRowTestId, truncateError } from '../../../electron/app/piPackageModel';
import { pi, type PackageListItem } from '../../lib/pi';
import { PackageMarketplaceModal } from './PackageMarketplaceModal';

interface PiPackagesPanelProps {
  workspace: string;
}

function packageControlTestId(action: 'enabled' | 'remove', id: string): string {
  return `package-${action}-${id.replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
}

function scopeLabel(scope: PackageListItem['scope']): string {
  return scope === 'project' ? '当前项目' : '用户设置';
}

function rowScopeMeta(item: PackageListItem): string {
  if (item.kind === 'builtin' || item.scope === 'product') return '产品';
  if (item.scope === 'project') return '当前项目';
  return '用户级';
}

const styles = createStaticStyles(({ css }) => ({
  heroBar: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  `,
  hero: css`
    display: flex;
    align-items: center;
    gap: 10px;
  `,
  heroIcon: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    border-radius: 8px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorText};
  `,
  heroTitle: css`
    display: inline-flex;
    align-items: center;
    font-size: 17px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  count: css`
    margin-inline-start: 8px;
    padding: 1px 8px;
    border-radius: 999px;
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    font-weight: 500;
  `,
  heroDesc: css`
    margin-block: 8px 16px;
    font-size: 13px;
    line-height: 1.55;
    color: ${cssVar.colorTextSecondary};
  `,
  error: css`
    margin-block: 8px 0;
    color: ${cssVar.colorError};
    font-size: 12px;
  `,
  list: css`
    display: flex;
    flex-direction: column;
  `,
  card: css`
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 14px;
    margin-block-end: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorBgContainer};
  `,
  identity: css`
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
  `,
  meta: css`
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  `,
  name: css`
    overflow: hidden;
    color: ${cssVar.colorText};
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  summary: css`
    overflow: hidden;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  badge: css`
    padding: 1px 8px;
    border-radius: 6px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextSecondary};
    font-size: 11px;
  `,
  actions: css`
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  `,
  delete: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorErrorBg};
      color: ${cssVar.colorError};
    }
  `,
  empty: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 40px 0;
    border: 1px dashed ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
  confirmBody: css`
    font-size: 13px;
    line-height: 1.55;
    color: ${cssVar.colorText};
  `,
  foot: css`
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-block-start: 16px;
  `,
}));

export function PiPackagesPanel({ workspace }: PiPackagesPanelProps) {
  const { message } = App.useApp();
  const [items, setItems] = useState<PackageListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<PackageListItem | null>(null);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);

  const showError = (cause: unknown) => {
    const text = truncateError(cause instanceof Error ? cause.message : String(cause));
    setError(text);
    message.error(text);
  };

  const reload = useCallback(async () => {
    try {
      setItems(await pi.packageList(workspace));
      setError(null);
    } catch (cause) {
      showError(cause);
    }
  }, [workspace, message]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleEnabled = async (item: PackageListItem, checked: boolean) => {
    if (item.scope === 'product') return;
    try {
      await pi.packageSetEnabled(workspace, item.id, item.scope, checked);
      await reload();
    } catch (cause) {
      showError(cause);
    }
  };

  const handleRemove = async () => {
    if (!pendingRemove || pendingRemove.scope === 'product') return;
    try {
      await pi.packageRemove(workspace, pendingRemove.id, pendingRemove.scope);
      setPendingRemove(null);
      await reload();
    } catch (cause) {
      showError(cause);
    }
  };

  const marketCount = items.filter((item) => item.kind === 'package').length;

  return (
    <>
      <div className={styles.heroBar}>
        <div className={styles.hero}>
          <span className={styles.heroIcon}><Icon icon={Package} size={18} /></span>
          <span className={styles.heroTitle}>
            扩展
            {marketCount > 0 ? <span className={styles.count}>{marketCount}</span> : null}
          </span>
        </div>
        <Flexbox horizontal align="center" gap={8}>
          <Button
            size="small"
            data-testid="package-marketplace-open"
            icon={<Icon icon={Store} size={14} />}
            onClick={() => setMarketplaceOpen(true)}
          >
            浏览市场
          </Button>
        </Flexbox>
      </div>
      <div className={styles.heroDesc}>
        编译进产品的扩展只读展示。市场安装的包可开关或卸载，写入官方 settings 后在会话空闲时加载。
      </div>
      {error ? <div className={styles.error}>{error}</div> : null}
      {items.length === 0 ? (
        <div className={styles.empty}>
          <Icon icon={Package} size={22} />
          <span>未安装市场包，点右上「浏览市场」添加</span>
        </div>
      ) : (
        <div className={styles.list}>
          {items.map((item) => (
            <div
              key={`${item.kind}:${item.scope}:${item.id}`}
              className={styles.card}
              data-testid={packageRowTestId(item.kind, item.id)}
            >
              <div className={styles.identity}>
                <div className={styles.meta}>
                  <span className={styles.name}>{item.title}</span>
                  <span className={styles.summary}>{rowScopeMeta(item)}</span>
                </div>
                {item.kind === 'builtin' ? <span className={styles.badge}>内置</span> : null}
              </div>
              <div className={styles.actions}>
                {item.kind === 'package' ? (
                  <span data-testid={packageControlTestId('enabled', item.id)}>
                    <Switch
                      size="small"
                      checked={item.enabled}
                      disabled={!item.canDisable}
                      onChange={(checked) => void handleEnabled(item, checked)}
                    />
                  </span>
                ) : null}
                {item.canRemove ? (
                  <button
                    type="button"
                    className={styles.delete}
                    data-testid={packageControlTestId('remove', item.id)}
                    title="卸载"
                    onClick={() => setPendingRemove(item)}
                  >
                    <Icon icon={Trash2} size={15} />
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
      <Modal
        open={!!pendingRemove}
        title="确认卸载"
        footer={null}
        onCancel={() => setPendingRemove(null)}
        data-testid="package-remove-confirm"
      >
        {pendingRemove ? (
          <p className={styles.confirmBody}>
            确认卸载「{pendingRemove.title}」？将从 {scopeLabel(pendingRemove.scope)} 移除，并停止加载。
          </p>
        ) : null}
        <div className={styles.foot}>
          <Button data-testid="package-remove-cancel" onClick={() => setPendingRemove(null)}>取消</Button>
          <Button type="primary" danger data-testid="package-remove-ok" onClick={() => void handleRemove()}>确认卸载</Button>
        </div>
      </Modal>
      <PackageMarketplaceModal
        open={marketplaceOpen}
        workspace={workspace}
        installedNames={items.filter((item) => item.kind === 'package').map((item) => item.title)}
        onClose={() => setMarketplaceOpen(false)}
        onInstalled={() => { void reload(); }}
      />
    </>
  );
}
