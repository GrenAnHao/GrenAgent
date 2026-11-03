import { Button, Flexbox, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { BookCheck, ChevronRight, Plus, ScrollText, Server, Sparkles, SquareSlash } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { probeMcpServer, readMcpPolicy, readMcpToolsCache, writeMcpPolicy } from '../../lib/mcpPolicyIo';
import { pi, type McpConfigScope } from '../../lib/pi';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { useMcpStatusStore, type McpServerStatus } from '../../stores/mcpStatusStore';
import { useSettingsForm } from '../settings/useSettingsForm';
import { AddMcpModal } from './AddMcpModal';
import { AuditModal } from './AuditModal';
import { CommandsPanel } from './CommandsPanel';
import { ExtensionPageHeader } from './ExtensionPageHeader';
import { McpWorkbench } from './McpWorkbench';
import { NativeSkillsPanel } from './NativeSkillsPanel';
import { RulesPanel } from './RulesPanel';
import {
  listEntries,
  type McpConfig,
  type McpEntry,
} from './mcpConfig';
import { parsePolicyDoc, serializePolicyDoc, setToolPerm, setToolRules, type Perm } from './mcpPolicy';
import { parseToolsCache, toProbeConfigJson, type CacheEntry } from './mcpToolsCache';
import { ToolPermissionModal } from './ToolPermissionModal';
import { useAskConfirm } from '../../components/askConfirm';

/** 稳定空数组回退：避免 selector 未命中时每次返回新引用触发 useSyncExternalStore 无限循环。 */
const EMPTY_SERVERS: McpServerStatus[] = [];

const styles = createStaticStyles(({ css }) => ({
  panel: css`
    height: 100%;
    min-width: 0;
    min-height: 0;
    container-type: inline-size;
    container-name: extensions-module;
    background: var(--gren-content-bg, ${cssVar.colorBgLayout});
  `,
  layout: css`
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;

    @container extensions-module (max-width: 900px) { flex-direction: column; }
  `,
  header: css`
    display: flex;
    flex: 0 0 140px;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
    padding: 22px 12px;
    background: var(--gren-sidebar-bg, ${cssVar.colorBgContainer});

    @container extensions-module (max-width: 900px) {
      flex: 0 0 auto;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    }
  `,
  navTitle: css`
    padding-inline: 10px;
    color: ${cssVar.colorText};
    font-size: 13px;
    font-weight: 500;

    @container extensions-module (max-width: 430px) { display: none; }
  `,
  tabBar: css`
    display: flex;
    flex-direction: column;
    gap: 4px;

    @container extensions-module (max-width: 900px) { flex-direction: row; flex-wrap: wrap; gap: 2px; }
  `,
  tab: css`
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 8px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-size: 13px;
    cursor: pointer;

    &:hover { background: ${cssVar.colorFillTertiary}; }
  `,
  tabActive: css`
    background: ${cssVar.colorPrimaryBg};
    color: ${cssVar.colorText};
    font-weight: 500;
  `,
  content: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  `,
  breadcrumb: css`
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
    min-height: 46px;
    padding-inline: 24px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;

    > span:last-child { color: ${cssVar.colorText}; }
    @container extensions-module (max-width: 900px) { display: none; }
  `,
  errorBar: css`
    flex: 0 0 auto;
    padding: 10px 32px;
    background: ${cssVar.colorErrorBg};
    color: ${cssVar.colorError};
    font-size: 13px;
  `,
  body: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 26px 24px 28px;
    container-type: inline-size;
    container-name: extension-content;

    &[data-page='mcp'] { overflow: hidden; }

    @container extensions-module (max-width: 540px) { padding: 20px 14px; }
  `,
  inner: css`
    display: flex;
    flex: 1 0 auto;
    flex-direction: column;
    width: 100%;
    max-width: 1280px;
    min-width: 0;
    margin-inline: auto;

    [data-page='mcp'] > & {
      flex: 1 1 0;
      min-height: 0;
    }

    /* 技能页：页头和工具行不动，只有技能目录滚动；目录保底高度放不下时才整页滚动。 */
    [data-page='skills'] > & {
      flex: 1 1 0px;
    }
  `,
  empty: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 48px 0;
    border: 1px dashed ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
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

  const [tab, setTab] = useState<'mcp' | 'skills' | 'commands' | 'rules'>('mcp');
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

  const bumpResources = () => {
    setValue('PI_RELOAD_REV', String(Date.now()));
    markChanged();
  };

  useEffect(() => {
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
  // 一次写入整组，避免逐个调用 onPermChange 时都基于同一份旧 policyRaw、只留下最后一个。
  const onPermChangeMany = (fullNames: string[], perm: Perm) =>
    writePolicy(fullNames.reduce((raw, fullName) => setToolPerm(raw, fullName, perm), policyRaw));

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
      <div className={styles.layout}>
      <nav className={styles.header} aria-label="扩展页面">
        <span className={styles.navTitle}>扩展</span>
        <div className={styles.tabBar}>
          <button type="button" className={`${styles.tab} ${tab === 'mcp' ? styles.tabActive : ''}`} aria-current={tab === 'mcp' ? 'page' : undefined} data-testid="ext-tab-mcp" onClick={() => setTab('mcp')}>
            <Icon icon={Server} size={16} />
            MCP
          </button>
          <button type="button" className={`${styles.tab} ${tab === 'skills' ? styles.tabActive : ''}`} aria-current={tab === 'skills' ? 'page' : undefined} data-testid="ext-tab-skills" onClick={() => setTab('skills')}>
            <Icon icon={Sparkles} size={16} />
            技能
          </button>
          <button type="button" className={`${styles.tab} ${tab === 'commands' ? styles.tabActive : ''}`} aria-current={tab === 'commands' ? 'page' : undefined} data-testid="ext-tab-commands" onClick={() => setTab('commands')}>
            <Icon icon={SquareSlash} size={16} />
            命令
          </button>
          <button type="button" className={`${styles.tab} ${tab === 'rules' ? styles.tabActive : ''}`} aria-current={tab === 'rules' ? 'page' : undefined} data-testid="ext-tab-rules" onClick={() => setTab('rules')}>
            <Icon icon={BookCheck} size={16} />
            规则
          </button>
        </div>
      </nav>

      <div className={styles.content}>
      <div className={styles.breadcrumb}><span>扩展</span><ChevronRight size={12} /><span>{{ mcp: 'MCP', skills: '技能', commands: '命令', rules: '规则' }[tab]}</span></div>

      {(error || mcpError) && <div className={styles.errorBar}>{error || mcpError}</div>}

      <div className={styles.body} data-testid="extensions-body" data-page={tab}>
        <div className={styles.inner}>
          {tab === 'commands' ? (
            <CommandsPanel workspace={workspace} onResourcesChanged={bumpResources} />
          ) : tab === 'rules' ? (
            <RulesPanel workspace={workspace} />
          ) : tab === 'skills' ? (
            <NativeSkillsPanel values={values} setValue={setValue} onChanged={markChanged} />
          ) : <>
          <ExtensionPageHeader title="MCP" count={entries.length} description="连接外部工具，管理工具权限。开关与权限即时生效。" actions={<>
              <Button
                icon={<ScrollText size={15} />}
                data-testid="mcp-audit-open"
                onClick={() => setAuditOpen(true)}
              >
                审计
              </Button>
              <Button
                type="primary"
                data-testid="mcp-add"
                icon={<Plus size={15} />}
                onClick={() => {
                  setEditing(undefined);
                  setModalOpen(true);
                }}
              >
                添加 MCP
              </Button>
            </>} />

          {!mcpLoading && entries.length === 0 ? (
            <div className={styles.empty} data-testid="mcp-empty">
              <Icon icon={Server} size={24} />
              <span>未配置 MCP server，点右上「添加 MCP」</span>
            </div>
          ) : (
            <McpWorkbench
              workspace={workspace} entries={entries} runtimeServers={runtimeServers} toolsCache={toolsCache} probing={probing} policyRaw={policyRaw}
              onToggle={handleToggleMcp}
              onEdit={(entry) => {
                    setEditing(entry);
                    setModalOpen(true);
              }}
              onDelete={handleDeleteMcp} onReload={(name) => void reloadOne(name)} onPermChange={onPermChange} onPermChangeMany={onPermChangeMany} onOpenRules={setRulesTarget}
            />
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
      </div>
      </div>
    </Flexbox>
  );
}
