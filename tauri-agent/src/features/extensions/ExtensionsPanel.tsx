import { Button, Flexbox } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Boxes, Plus, ScrollText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { probeMcpServer, readMcpPolicy, readMcpToolsCache, writeMcpPolicy } from '../../lib/mcpPolicyIo';
import { useSettingsForm } from '../settings/useSettingsForm';
import { AddMcpModal } from './AddMcpModal';
import { AuditModal } from './AuditModal';
import { McpServerCard } from './McpServerCard';
import {
  listEntries,
  mergeImport,
  removeServer,
  setEnabled,
  upsertServer,
  type Collections,
  type McpConfig,
  type McpEntry,
} from './mcpConfig';
import { parsePolicyDoc, serializePolicyDoc, setToolPerm, setToolRules, type Perm } from './mcpPolicy';
import { getCacheEntry, getCachedTools, parseToolsCache, toProbeConfigJson, type CacheEntry } from './mcpToolsCache';
import { ToolPermissionModal } from './ToolPermissionModal';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const styles = createStaticStyles(({ css }) => ({
  panel: css`
    height: 100%;
    min-height: 0;
  `,
  header: css`
    position: relative;
    z-index: 1;
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    height: 46px;
    padding-inline: 14px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgContainer};
  `,
  tab: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 100%;
    padding-inline: 10px;
    margin-block-end: -1px;
    border-block-end: 2px solid ${cssVar.colorPrimary};
    color: ${cssVar.colorText};
    font-size: 13px;
    font-weight: 600;
  `,
  errorBar: css`
    flex: 0 0 auto;
    padding: 8px 14px;
    background: ${cssVar.colorErrorBg};
    color: ${cssVar.colorError};
    font-size: 12px;
  `,
  body: css`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 16px 32px;
  `,
  inner: css`
    width: 100%;
    max-width: 680px;
    margin-inline: auto;
  `,
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
    border-radius: 10px;
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
  code: css`
    padding: 1px 5px;
    border-radius: 4px;
    background: ${cssVar.colorFillTertiary};
    font-family: ${mono};
    font-size: 11px;
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
}));

export function ExtensionsPanel() {
  const { values, setValue, persist, loading, error } = useSettingsForm();
  const cols: Collections = {
    enabled: values.MCP_SERVERS ?? '',
    disabled: values.MCP_SERVERS_DISABLED ?? '',
  };
  const entries = listEntries(cols).sort((a, b) => Number(b.enabled) - Number(a.enabled));
  const existingNames = entries.map((e) => e.name);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<McpEntry | undefined>(undefined);
  const touchedRef = useRef(false);
  const [policyRaw, setPolicyRaw] = useState<Record<string, unknown>>({});
  const [auditOpen, setAuditOpen] = useState(false);
  const [rulesTarget, setRulesTarget] = useState<string | undefined>(undefined);
  const [toolsCache, setToolsCache] = useState<Record<string, CacheEntry>>({});
  const [probing, setProbing] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void readMcpPolicy()
      .then((t) => {
        if (!cancelled) setPolicyRaw(parsePolicyDoc(t));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const writePolicy = (next: Record<string, unknown>) => {
    setPolicyRaw(next);
    void writeMcpPolicy(serializePolicyDoc(next)).catch(() => {});
  };
  const onPermChange = (fullName: string, perm: Perm) => writePolicy(setToolPerm(policyRaw, fullName, perm));

  const reloadCache = async () => {
    try {
      setToolsCache(parseToolsCache(await readMcpToolsCache()));
    } catch {
      // ignore: empty cache renders as 未探测
    }
  };

  const probeOne = async (serverName: string, serverConfig: McpConfig) => {
    setProbing((s) => new Set(s).add(serverName));
    try {
      await probeMcpServer(toProbeConfigJson(serverName, serverConfig));
    } catch {
      // probe failure is recorded in cache by the subcommand; ignore here
    } finally {
      await reloadCache();
      setProbing((s) => {
        const next = new Set(s);
        next.delete(serverName);
        return next;
      });
    }
  };

  // 打开面板：读缓存，并对「已启用但还没缓存过」的 server 自动探测一次（顺序执行，避免一次 spawn 一堆 npx）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let cache: Record<string, CacheEntry> = {};
      try {
        cache = parseToolsCache(await readMcpToolsCache());
      } catch {
        cache = {};
      }
      if (cancelled) return;
      setToolsCache(cache);
      const toProbe = listEntries({
        enabled: values.MCP_SERVERS ?? '',
        disabled: values.MCP_SERVERS_DISABLED ?? '',
      }).filter((e) => e.enabled && !cache[e.name]);
      for (const e of toProbe) {
        if (cancelled) return;
        await probeOne(e.name, e.config);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    if (loading || !touchedRef.current) return;
    const timer = window.setTimeout(() => void persistRef.current(), 600);
    return () => window.clearTimeout(timer);
  }, [values.MCP_SERVERS, values.MCP_SERVERS_DISABLED, loading]);

  const writeCols = (next: Collections) => {
    setValue('MCP_SERVERS', next.enabled);
    setValue('MCP_SERVERS_DISABLED', next.disabled);
    touchedRef.current = true;
  };
  const handleSubmitForm = (entry: { name: string; config: McpConfig }, targetEnabled: boolean) =>
    writeCols(upsertServer(cols, entry, targetEnabled ? 'enabled' : 'disabled'));
  const handleSubmitImport = (servers: Array<{ name: string; config: McpConfig }>) =>
    writeCols(mergeImport(cols, servers).cols);
  const handleToggleMcp = (name: string, enabled: boolean) => writeCols(setEnabled(cols, name, enabled));
  const handleDeleteMcp = (name: string) => {
    if (window.confirm(`确认删除 MCP "${name}"？`)) writeCols(removeServer(cols, name));
  };

  return (
    <Flexbox className={styles.panel} data-testid="extensions-panel">
      <div className={styles.header}>
        <span className={styles.tab} data-testid="ext-tab-mcp">
          <Boxes size={15} />
          插件
        </span>
      </div>

      {error && <div className={styles.errorBar}>{error}</div>}

      <div className={styles.body}>
        <div className={styles.inner}>
          <div className={styles.heroBar}>
            <div className={styles.hero}>
              <span className={styles.heroIcon}>
                <Boxes size={18} />
              </span>
              <span className={styles.heroTitle}>
                MCP 服务器
                {entries.length > 0 ? <span className={styles.count}>{entries.length}</span> : null}
              </span>
            </div>
            <Flexbox horizontal align="center" gap={8}>
              <Button
                size="small"
                icon={<ScrollText size={14} />}
                data-testid="mcp-audit-open"
                onClick={() => setAuditOpen(true)}
              >
                审计
              </Button>
              <Button
                type="primary"
                size="small"
                data-testid="mcp-add"
                icon={<Plus size={14} />}
                onClick={() => {
                  setEditing(undefined);
                  setModalOpen(true);
                }}
              >
                添加 MCP
              </Button>
            </Flexbox>
          </div>
          <div className={styles.heroDesc}>
            连接外部 MCP server，其工具以 <code className={styles.code}>mcp__server__tool</code> 暴露给 agent。点「测试连接」获取工具并配置权限（即时生效）。
          </div>

          {entries.length === 0 ? (
            <div className={styles.empty} data-testid="mcp-empty">
              <Boxes size={22} />
              <span>未配置 MCP server，点右上「添加 MCP」</span>
            </div>
          ) : (
            entries.map((e) => (
              <McpServerCard
                key={e.name}
                name={e.name}
                config={e.config}
                enabled={e.enabled}
                cachedTools={getCachedTools(toolsCache, e.name)}
                probing={probing.has(e.name)}
                probeError={getCacheEntry(toolsCache, e.name)?.ok === false ? getCacheEntry(toolsCache, e.name)?.error : undefined}
                policyRaw={policyRaw}
                onToggle={(v) => handleToggleMcp(e.name, v)}
                onEdit={() => {
                  setEditing(e);
                  setModalOpen(true);
                }}
                onDelete={() => handleDeleteMcp(e.name)}
                onProbe={() => void probeOne(e.name, e.config)}
                onPermChange={onPermChange}
                onOpenRules={(full) => setRulesTarget(full)}
              />
            ))
          )}

          <AddMcpModal
            open={modalOpen}
            editing={editing}
            existingNames={existingNames}
            onSubmitForm={handleSubmitForm}
            onSubmitImport={handleSubmitImport}
            onClose={() => setModalOpen(false)}
          />
          {rulesTarget ? (
            <ToolPermissionModal
              open={!!rulesTarget}
              fullName={rulesTarget}
              policyRaw={policyRaw}
              onSave={(full, perm, rules) =>
                writePolicy(setToolRules(setToolPerm(policyRaw, full, perm), full, rules))
              }
              onClose={() => setRulesTarget(undefined)}
            />
          ) : null}
          <AuditModal open={auditOpen} onClose={() => setAuditOpen(false)} />
        </div>
      </div>
    </Flexbox>
  );
}
