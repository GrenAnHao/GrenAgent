import { Button, Icon, Modal } from '@lobehub/ui';
import { Radio } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { pinNpmSource, truncateError } from '../../../electron/app/piPackageModel';
import { pi, type MarketplaceHit, type PackageInstallScope } from '../../lib/pi';

interface PackageMarketplaceModalProps {
  open: boolean;
  workspace: string;
  installedNames: string[];
  onClose: () => void;
  onInstalled: () => void;
}

const styles = createStaticStyles(({ css }) => ({
  search: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    margin-block-end: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorTextTertiary};
  `,
  searchInput: css`
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: ${cssVar.colorText};
    font-size: 13px;
    outline: none;
  `,
  total: css`
    margin-block-end: 10px;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
  `,
  error: css`
    margin-block-end: 10px;
    color: ${cssVar.colorError};
    font-size: 12px;
  `,
  list: css`
    display: flex;
    flex-direction: column;
    max-height: 420px;
    overflow-y: auto;
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
  confirmBody: css`
    font-size: 13px;
    line-height: 1.55;
    color: ${cssVar.colorText};
  `,
  warn: css`
    margin-block: 10px 0;
    color: ${cssVar.colorError};
    font-size: 13px;
    line-height: 1.55;
  `,
  scope: css`
    margin-block-start: 14px;
  `,
  scopeLabel: css`
    display: block;
    margin-block-end: 8px;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
  `,
  scopeHint: css`
    margin-block-start: 6px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
  foot: css`
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-block-start: 16px;
  `,
}));

function searchErrorText(cause: unknown): string {
  return `市场搜索失败：${truncateError(cause instanceof Error ? cause.message : String(cause))}`;
}

export function PackageMarketplaceModal({
  open,
  workspace,
  installedNames,
  onClose,
  onInstalled,
}: PackageMarketplaceModalProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MarketplaceHit[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<MarketplaceHit | null>(null);
  const [scope, setScope] = useState<PackageInstallScope>('user');
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const searchGen = useRef(0);
  const projectDisabled = !workspace;

  const runSearch = async (nextQuery: string) => {
    const gen = ++searchGen.current;
    try {
      const result = await pi.packageSearch(nextQuery);
      if (gen !== searchGen.current) return;
      setHits(result.objects);
      setTotal(result.total);
      setError(null);
    } catch (cause) {
      if (gen !== searchGen.current) return;
      setError(searchErrorText(cause));
    }
  };

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setPending(null);
    setScope('user');
    setInstalling(null);
    setInstallError(null);
    void runSearch('');
  }, [open]);

  const confirmInstall = async () => {
    if (!pending) return;
    setInstalling(pending.name);
    setInstallError(null);
    try {
      await pi.packageInstall(workspace, pending.name, pending.version, scope);
      setPending(null);
      onInstalled();
    } catch (cause) {
      setInstallError(truncateError(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <>
      <Modal
        open={open}
        title="扩展市场"
        width={640}
        footer={null}
        onCancel={onClose}
        data-testid="package-marketplace-modal"
      >
        <div className={styles.search}>
          <Icon icon={Search} size={14} />
          <input
            className={styles.searchInput}
            data-testid="package-marketplace-search"
            value={query}
            placeholder="搜索扩展包"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runSearch(query);
            }}
          />
        </div>
        {error ? <div className={styles.error}>{error}</div> : null}
        {total !== null ? (
          <div className={styles.total} data-testid="package-marketplace-total">
            共 {total} 个结果，展示前 20 个
          </div>
        ) : null}
        <div className={styles.list}>
          {hits.map((hit) => {
            const installed = installedNames.includes(hit.name);
            return (
              <div key={`${hit.name}@${hit.version}`} className={styles.card}>
                <div className={styles.meta}>
                  <span className={styles.name}>{hit.name}</span>
                  <span className={styles.summary}>
                    {hit.version}
                    {hit.publisher ? ` · ${hit.publisher}` : ''}
                    {hit.description ? ` · ${hit.description}` : ''}
                  </span>
                </div>
                <Button
                  size="small"
                  type={installed ? 'default' : 'primary'}
                  disabled={installed || installing === hit.name || (scope === 'project' && projectDisabled)}
                  loading={installing === hit.name}
                  data-testid={`package-install-${hit.name}`}
                  onClick={() => {
                    setScope('user');
                    setInstallError(null);
                    setPending(hit);
                  }}
                >
                  {installed ? '已安装' : '安装'}
                </Button>
              </div>
            );
          })}
        </div>
      </Modal>
      <Modal
        open={!!pending}
        title="确认安装"
        footer={null}
        zIndex={1100}
        onCancel={() => {
          if (installing) return;
          setPending(null);
        }}
      >
        {pending ? (
          <div data-testid="package-install-confirm" className={styles.confirmBody}>
            <p>
              确认安装「{pending.name}」{pending.version}？来源 {pinNpmSource(pending.name, pending.version)}。
            </p>
            <p className={styles.warn}>该包将以本机完整权限运行，可执行任意代码。</p>
            <div className={styles.scope}>
              <span className={styles.scopeLabel}>范围</span>
              <Radio.Group
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              >
                <Radio value="user">用户级</Radio>
                <Radio value="project" disabled={projectDisabled}>当前项目</Radio>
              </Radio.Group>
              {projectDisabled ? <div className={styles.scopeHint}>先打开一个项目</div> : null}
            </div>
            {installError ? <div className={styles.error}>{installError}</div> : null}
            <div className={styles.foot}>
              <Button
                data-testid="package-install-cancel"
                disabled={installing}
                onClick={() => setPending(null)}
              >
                取消
              </Button>
              <Button
                type="primary"
                loading={installing}
                data-testid="package-install-ok"
                onClick={() => void confirmInstall()}
              >
                确认安装
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
