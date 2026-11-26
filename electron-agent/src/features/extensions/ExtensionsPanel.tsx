import { App as AntApp, Tooltip } from 'antd';
import { Flexbox, Icon } from '@lobehub/ui';
import { WorkbenchButton as Button } from '../../components/WorkbenchButton';
import { createStaticStyles, cssVar } from 'antd-style';
import { BookCheck, ChevronRight, Plus, ScrollText, Server, Sparkles, SquareSlash } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { probeMcpServer, readMcpPolicy, readMcpToolsCache, writeMcpPolicy } from '../../lib/mcpPolicyIo';
import { pi, type McpConfigScope } from '../../lib/pi';
import { invoke } from '../../platform/runtime';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { useMcpStatusStore, type McpServerStatus } from '../../stores/mcpStatusStore';
import { useSettingsForm } from '../settings/useSettingsForm';
import { AddMcpModal } from './AddMcpModal';
import { AuditModal } from './AuditModal';
import { CommandsPanel } from './CommandsPanel';
import { ExtensionPageHeader } from './ExtensionPageHeader';
import { workspaceBudget } from './mcpBudget';
import { McpWorkbench } from './McpWorkbench';
import { NativeSkillsPanel } from './NativeSkillsPanel';
import { RulesPanel } from './RulesPanel';
import {
  listEntries,
  type McpConfig,
  type McpEntry,
} from './mcpConfig';
import { getToolPerm, parsePolicyDoc, serializePolicyDoc, setToolPerm, setToolRules, type Perm } from './mcpPolicy';
import { parseToolsCache, toProbeConfigJson, type CacheEntry } from './mcpToolsCache';
import { ToolPermissionModal } from './ToolPermissionModal';
import { useAskConfirm } from '../../components/askConfirm';

/** 稳定空数组回退：避免 selector 未命中时每次返回新引用触发 useSyncExternalStore 无限循环。 */
const EMPTY_SERVERS: McpServerStatus[] = [];

const styles = createStaticStyles(({ css }) => ({
  budgetHelp: css`
    white-space: nowrap;
    text-decoration: underline dotted ${cssVar.colorTextTertiary};
    text-underline-offset: 3px;
    cursor: help;
  `,
  panel: css`
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
    min-height: 0;
    container-type: size;
    container-name: extensions-module;
    background: var(--gren-content-bg, ${cssVar.colorBgLayout});
  `,
  layout: css`
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;

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

    @container extensions-module (width > 900px) {
      border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
    }

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
    font-size: var(--gren-font-body);
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
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-size: var(--gren-font-body);
    cursor: pointer;

    &:hover { background: ${cssVar.colorFillTertiary}; }
  `,
  tabActive: css`
    background: ${cssVar.colorPrimaryBg};
    border-color: ${cssVar.colorPrimaryBorder};
    color: ${cssVar.colorPrimary};
    font-weight: 500;
    &:hover { background: ${cssVar.colorPrimaryBgHover}; }
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
    font-size: var(--gren-font-secondary);

    > span:last-child { color: ${cssVar.colorText}; }
    @container extensions-module (max-width: 900px) { display: none; }
  `,
  errorBar: css`
    flex: 0 0 auto;
    padding: 10px 32px;
    background: ${cssVar.colorErrorBg};
    color: ${cssVar.colorError};
    font-size: var(--gren-font-body);
  `,
  body: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    padding: 20px 22px;
    container-type: inline-size;
    container-name: extension-content;

    @container extensions-module (max-width: 540px) { padding: 20px 14px; }
    @container extensions-module (max-height: 560px) { padding-block: 8px; }
  `,
  inner: css`
    display: flex;
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
    flex-direction: column;
    width: 100%;
    max-width: 1280px;
    min-width: 0;
    margin-inline: auto;
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
    font-size: var(--gren-font-body);
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
  const budget = useMemo(() => workspaceBudget(managedEntries, runtimeServers, toolsCache, policyRaw), [managedEntries, runtimeServers, toolsCache, policyRaw]);
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

  const writes = useRef(Promise.resolve());
  const { message } = AntApp.useApp();
  const writePolicy = (update: (raw: Record<string, unknown>) => Record<string, unknown>, feedback?: string) => {
    writes.current = writes.current.then(async () => {
      const text = await readMcpPolicy();
      if (text.trim()) JSON.parse(text);
      const next = update(parsePolicyDoc(text));
      await writeMcpPolicy(serializePolicyDoc(next));
      setMcpError(null);
      setPolicyRaw(next);
      if (feedback) void message.success(feedback);
    }).catch(cause => setMcpError(`权限未保存：${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const onPermChange = (name: string, perm: Perm) => writePolicy(raw => setToolPerm(raw, name, perm));
  const onPermChangeMany = (names: string[], perm: Perm, confirmedMixed = false) => writePolicy(raw => {
    if (!confirmedMixed && names.length > 10 && new Set(names.map(n => getToolPerm(raw,n))).size > 1) {
      setPolicyRaw(raw);
      throw new Error('权限已变化，请重新打开批量设置并确认覆盖。');
    }
    const tools = { ...(raw.tools as Record<string, object> | undefined) };
    for (const name of names) tools[name] = { ...tools[name], permission: perm };
    return { ...raw, tools };
  }, `已更新 ${names.length} 个工具的权限`);

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
  const handleSubmitForm = async (entry: { name: string; config: McpConfig }, targetEnabled: boolean, requestedScope?: McpConfigScope) => {
    const original = editing, scope = requestedScope ?? original?.scope ?? 'settings';
    if (original && original.scope !== scope) await pi.moveMcpConfig(workspace, original.scope, original.name, scope, entry.name, entry.config, targetEnabled);
    else {
      await pi.upsertMcpConfig(workspace, scope, entry.name, entry.config, targetEnabled);
      if (original && original.name !== entry.name) await pi.removeMcpConfig(workspace, scope, original.name);
    }
    await reloadMcpConfigs();
  };
  const handleSubmitImport = async (servers: Array<{ name: string; config: McpConfig }>, scope: McpConfigScope = 'settings') => {
    const known = new Set(existingNames);
    for (const server of servers) if (!known.has(server.name)) { await pi.upsertMcpConfig(workspace, scope, server.name, server.config, true); known.add(server.name); }
    await reloadMcpConfigs();
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
            <RulesPanel workspace={workspace} onResourcesChanged={bumpResources} />
          ) : tab === 'skills' ? (
            <NativeSkillsPanel key={workspace} workspace={workspace} values={values} setValue={setValue} onChanged={markChanged} />
          ) : <>
          <ExtensionPageHeader id="mcp" onRefresh={async () => { await Promise.all([reloadMcpConfigs(), reloadCache(), readMcpPolicy().then((raw) => setPolicyRaw(parsePolicyDoc(raw)))]); }} onDirectory={() => invoke('open_mcp_directory')} title="MCP" count={entries.length} description={
            <span data-testid="mcp-global-budget">
              已启用 {budget.enabled} 服务 · {budget.partial ? '已知 ' : '共 '}{budget.available} 个可用工具 · <span title="包含缓存中已知的可用工具定义。">定义合计 ≈ <span className="font-mono">{budget.permitted} tokens</span></span> · {' '}
              <Tooltip trigger={['hover', 'focus']} title="codemode 模式下工具定义按需检索调用，不常驻占用会话初始 System Prompt 前缀。这里只统计在线且直接暴露的工具定义。">
                <span tabIndex={0} className={styles.budgetHelp}>预估常驻开销 ≈ <span className="font-mono">{budget.direct} tokens</span></span>
              </Tooltip>
            </span>
          } actions={<>
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
              key={workspace} inspect={pi.inspectMcpServer} workspace={workspace} entries={entries} budgets={budget.byServer} runtimeServers={runtimeServers} toolsCache={toolsCache} probing={probing} policyRaw={policyRaw}
              onToggle={handleToggleMcp}
              onEdit={(entry) => {
                    setEditing(entry);
                    setModalOpen(true);
              }}
              onDelete={handleDeleteMcp} onReload={reloadOne} onPermChange={onPermChange} onPermChangeMany={onPermChangeMany} onOpenRules={setRulesTarget}
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
                writePolicy(raw => setToolRules(setToolPerm(raw, fullName, perm), fullName, rules))
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
