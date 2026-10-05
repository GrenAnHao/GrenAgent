import { Button, Flexbox, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Package, Plus, ScrollText, Server, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { probeMcpServer, readMcpPolicy, readMcpToolsCache, writeMcpPolicy } from '../../lib/mcpPolicyIo';
import { pi, type McpConfigScope } from '../../lib/pi';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { useMcpStatusStore, type McpServerStatus } from '../../stores/mcpStatusStore';
import { useSettingsForm } from '../settings/useSettingsForm';
import { AddMcpModal } from './AddMcpModal';
import { AuditModal } from './AuditModal';
import { McpServerCard } from './McpServerCard';
import { NativeSkillsPanel } from './NativeSkillsPanel';
import { PiPackagesPanel } from './PiPackagesPanel';
import {
  listEntries,
  type McpConfig,
  type McpEntry,
} from './mcpConfig';
import { parsePolicyDoc, serializePolicyDoc, setToolPerm, setToolRules, type Perm } from './mcpPolicy';
import { getCacheEntry, getCachedTools, parseToolsCache, toProbeConfigJson, type CacheEntry } from './mcpToolsCache';
import { ToolPermissionModal } from './ToolPermissionModal';
import { useAskConfirm } from '../../components/askConfirm';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** 稳定空数组回退：避免 selector 未命中时每次返回新引用触发 useSyncExternalStore 无限循环。 */
const EMPTY_SERVERS: McpServerStatus[] = [];

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
  tabBar: css`
    display: flex;
    align-items: stretch;
    height: 100%;
    gap: 2px;
  `,
  tab: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 100%;
    padding-inline: 10px;
    margin-block-end: -1px;
    border: 0;
    border-block-end: 2px solid transparent;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    cursor: pointer;
  `,
  tabActive: css`
    border-block-end-color: ${cssVar.colorPrimary};
    color: ${cssVar.colorText};
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
  const ask = useAskConfirm();
  const workspace = useOptionalAgentStoreContext()?.workspace ?? '';
  const { values, setValue, persist, loading, error } = useSettingsForm();
  const [managedEntries, setManagedEntries] = useState<Array<McpEntry & { scope: McpConfigScope }>>([]);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const entries = [...managedEntries].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  const runtimeServers = useMcpStatusStore((state) => state.serversByWorkspace[workspace] ?? EMPTY_SERVERS);
  const existingNames = entries.map((entry) => entry.name);

  const [tab, setTab] = useState<'mcp' | 'packages' | 'skills'>('mcp');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<(McpEntry & { scope: McpConfigScope }) | undefined>(undefined);
  const touchedRef = useRef(false);
  const [policyRaw, setPolicyRaw] = useState<Record<string, unknown>>({});
  const [auditOpen, setAuditOpen] = useState(false);
  const [rulesTarget, setRulesTarget] = useState<string | undefined>(undefined);
  const [toolsCache, setToolsCache] = useState<Record<string, CacheEntry>>({});
  const [probing, setProbing] = useState<Set<string>>(new Set());

  const reloadMcpConfigs = useCallback(async () => {
    setMcpLoading(true);
    setMcpError(null);
    try {
      if (!workspace || typeof pi.listMcpConfigs !== 'function') {
        const fallback = listEntries({ enabled: values.MCP_SERVERS ?? '', disabled: values.MCP_SERVERS_DISABLED ?? '' });
        setManagedEntries(fallback.map((entry) => ({ ...entry, scope: 'settings' as const })));
        return;
      }
      const next = await pi.listMcpConfigs(workspace);
      setManagedEntries(next.map((entry) => ({ ...entry, config: entry.config as McpConfig })));
    } catch (cause) {
      setMcpError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMcpLoading(false);
    }
  }, [workspace, values.MCP_SERVERS, values.MCP_SERVERS_DISABLED]);

  useEffect(() => { void reloadMcpConfigs(); }, [reloadMcpConfigs]);

  const markChanged = () => {
    touchedRef.current = true;
  };

  useEffect(() => {
    if (mcpLoading) return;
    let cancelled = false;
    void readMcpPolicy()
      .then((text) => {
        if (!cancelled) setPolicyRaw(parsePolicyDoc(text));
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
      // An empty cache renders as not probed.
    }
  };

  const probeOne = async (serverName: string, serverConfig: McpConfig) => {
    setProbing((current) => new Set(current).add(serverName));
    try {
      await probeMcpServer(toProbeConfigJson(serverName, serverConfig));
    } catch {
      // The probe command records failures in its cache.
    } finally {
      await reloadCache();
      setProbing((current) => {
        const next = new Set(current);
        next.delete(serverName);
        return next;
      });
    }
  };

  const reloadOne = async (serverName: string) => {
    setProbing((current) => new Set(current).add(serverName));
    setMcpError(null);
    try {
      await pi.reloadMcpServer(workspace, serverName);
    } catch (cause) {
      setMcpError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      await reloadCache();
      setProbing((current) => {
        const next = new Set(current);
        next.delete(serverName);
        return next;
      });
    }
  };

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
      const pending = entries.filter((entry) => entry.enabled && !cache[entry.name]);
      for (const entry of pending) {
        if (cancelled) return;
        await probeOne(entry.name, entry.config);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpLoading]);

  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    if (loading || !touchedRef.current) return;
    const timer = window.setTimeout(() => void persistRef.current(), 600);
    return () => window.clearTimeout(timer);
  }, [values.SKILLS_DISABLED, values.PI_RELOAD_REV, loading]);

  const runMcpMutation = async (operation: () => Promise<void>) => {
    setMcpError(null);
    try { await operation(); await reloadMcpConfigs(); }
    catch (cause) { setMcpError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const handleSubmitForm = (entry: { name: string; config: McpConfig }, targetEnabled: boolean) => {
    const original = editing;
    const scope = original?.scope ?? 'settings';
    void runMcpMutation(async () => {
      await pi.upsertMcpConfig(workspace, scope, entry.name, entry.config, targetEnabled);
      if (original && original.name !== entry.name) await pi.removeMcpConfig(workspace, scope, original.name);
    });
  };
  const handleSubmitImport = (servers: Array<{ name: string; config: McpConfig }>) => {
    const known = new Set(existingNames);
    void runMcpMutation(async () => {
      for (const server of servers) if (!known.has(server.name)) await pi.upsertMcpConfig(workspace, 'settings', server.name, server.config, true);
    });
  };
  const handleToggleMcp = (entry: McpEntry & { scope: McpConfigScope }, enabled: boolean) => {
    void runMcpMutation(() => pi.upsertMcpConfig(workspace, entry.scope, entry.name, entry.config, enabled));
  };
  const handleDeleteMcp = (entry: McpEntry & { scope: McpConfigScope }) => {
    void (async () => {
      const ok = await ask({ title: `确认删除 MCP「${entry.name}」？`, danger: true });
      if (ok) await runMcpMutation(() => pi.removeMcpConfig(workspace, entry.scope, entry.name));
    })();
  };

  return (
    <Flexbox className={styles.panel} data-testid="extensions-panel">
      <div className={styles.header}>
        <div className={styles.tabBar}>
          <button type="button" className={`${styles.tab} ${tab === 'mcp' ? styles.tabActive : ''}`} data-testid="ext-tab-mcp" onClick={() => setTab('mcp')}>
            <Icon icon={Server} size={15} />
            MCP
          </button>
          <button type="button" className={`${styles.tab} ${tab === 'packages' ? styles.tabActive : ''}`} data-testid="ext-tab-packages" onClick={() => setTab('packages')}>
            <Icon icon={Package} size={15} />
            扩展
          </button>
          <button type="button" className={`${styles.tab} ${tab === 'skills' ? styles.tabActive : ''}`} data-testid="ext-tab-skills" onClick={() => setTab('skills')}>
            <Icon icon={Sparkles} size={15} />
            技能
          </button>
        </div>
      </div>

      {(error || mcpError) && <div className={styles.errorBar}>{error || mcpError}</div>}

      <div className={styles.body}>
        <div className={styles.inner}>
          {tab === 'skills' ? (
            <NativeSkillsPanel values={values} setValue={setValue} onChanged={markChanged} />
          ) : tab === 'packages' ? (
            <PiPackagesPanel workspace={workspace} />
          ) : <>
          <div className={styles.heroBar}>
            <div className={styles.hero}>
              <span className={styles.heroIcon}>
                <Icon icon={Server} size={18} />
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
            连接外部 MCP server，其工具以 <code className={styles.code}>mcp__server__tool</code> 暴露给 agent。点「重载」重新连接并刷新工具（即时生效）。
          </div>

          {!mcpLoading && entries.length === 0 ? (
            <div className={styles.empty} data-testid="mcp-empty">
              <Icon icon={Server} size={22} />
              <span>未配置 MCP server，点右上「添加 MCP」</span>
            </div>
          ) : (
            entries.map((entry) => {
              const runtime = runtimeServers.find((server) => server.name === entry.name);
              const runtimeStatus = runtime?.status === 'needs-login' || (runtime?.loginUrl && runtime.status !== 'connected')
                ? 'needs-login'
                : runtime?.status;
              return (
                <McpServerCard
                  key={entry.name}
                  name={entry.name}
                  config={entry.config}
                  enabled={entry.enabled}
                  scope={entry.scope}
                  cachedTools={getCachedTools(toolsCache, entry.name)}
                  runtimeStatus={runtimeStatus}
                  runtimeToolNames={runtime?.toolNames}
                  loginUrl={runtime?.loginUrl}
                  exposure={runtime?.exposure}
                  auth={runtime?.auth}
                  probing={probing.has(entry.name)}
                  probeError={getCacheEntry(toolsCache, entry.name)?.ok === false ? getCacheEntry(toolsCache, entry.name)?.error : undefined}
                  policyRaw={policyRaw}
                  onToggle={(enabled) => handleToggleMcp(entry, enabled)}
                  onEdit={() => {
                    setEditing(entry);
                    setModalOpen(true);
                  }}
                  onDelete={() => handleDeleteMcp(entry)}
                  onReload={() => void reloadOne(entry.name)}
                  onPermChange={onPermChange}
                  onOpenRules={(fullName) => setRulesTarget(fullName)}
                />
              );
            })
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
              onSave={(fullName, perm, rules) =>
                writePolicy(setToolRules(setToolPerm(policyRaw, fullName, perm), fullName, rules))
              }
              onClose={() => setRulesTarget(undefined)}
            />
          ) : null}
          <AuditModal open={auditOpen} onClose={() => setAuditOpen(false)} />
          </>}
        </div>
      </div>
    </Flexbox>
  );
}
