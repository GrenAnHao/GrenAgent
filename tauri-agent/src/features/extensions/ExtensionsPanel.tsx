import { Button, Flexbox } from '@lobehub/ui';
import { Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Boxes, Plus, RotateCw, ScrollText, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { readMcpPolicy, writeMcpPolicy } from '../../lib/mcpPolicyIo';
import { pi } from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { useMcpStatusStore } from '../../stores/mcpStatusStore';
import type { PiCommand } from '../chat/input/commandTypes';
import { parseCommands } from '../chat/input/commandUtils';
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
import { ToolPermissionModal } from './ToolPermissionModal';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function parseDisabled(csv: string): Set<string> {
  return new Set(
    csv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** 用 skill 名稳定推导一个色相，给头像生成专属渐变（高级感 + 易区分）。 */
function avatarBackground(name: string): string {
  let hue = 0;
  for (let i = 0; i < name.length; i += 1) hue = (hue * 31 + name.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${hue} 62% 56%), hsl(${(hue + 38) % 360} 64% 46%))`;
}

type ExtTab = 'mcp' | 'skills';

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
    justify-content: space-between;
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
    border: none;
    border-block-end: 2px solid transparent;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    cursor: pointer;
    transition:
      color 0.16s ease,
      border-color 0.16s ease;

    &:hover {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  tabActive: css`
    color: ${cssVar.colorText};
    font-weight: 600;
    border-block-end-color: ${cssVar.colorPrimary};
  `,
  restartBtn: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border: 1px solid ${cssVar.colorWarningBorder};
    border-radius: 999px;
    background: ${cssVar.colorWarningBg};
    color: ${cssVar.colorWarning};
    font-size: 12px;
    cursor: pointer;
    transition:
      background 0.16s ease,
      opacity 0.16s ease;

    &:hover {
      background: ${cssVar.colorWarningBgHover};
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
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
  card: css`
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 14px;
    margin-block-end: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
    transition:
      transform 0.16s ease,
      border-color 0.16s ease,
      background 0.16s ease,
      box-shadow 0.16s ease;

    &:hover {
      transform: translateY(-1px);
      border-color: ${cssVar.colorBorder};
      background: ${cssVar.colorFillQuaternary};
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);
    }
  `,
  name: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 13px;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  avatar: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    flex: 0 0 auto;
    border-radius: 10px;
    color: #fff;
    font-size: 15px;
    font-weight: 600;
    text-transform: uppercase;
  `,
  meta: css`
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  `,
  desc: css`
    overflow: hidden;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  empty: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 40px 0;
    border: 1px dashed ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
}));

export function ExtensionsPanel() {
  const { values, setValue, persist, save, saving, loading, error } = useSettingsForm();
  const { workspace } = useAgentStoreContext();
  const liveMcp = useMcpStatusStore((s) => s.servers);
  const liveMcpByName = new Map(liveMcp.map((s) => [s.name, s]));

  const cols: Collections = {
    enabled: values.MCP_SERVERS ?? '',
    disabled: values.MCP_SERVERS_DISABLED ?? '',
  };
  const entries = listEntries(cols).sort((a, b) => Number(b.enabled) - Number(a.enabled));
  const existingNames = entries.map((e) => e.name);

  const [tab, setTab] = useState<ExtTab>('mcp');
  const [skills, setSkills] = useState<PiCommand[]>([]);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<McpEntry | undefined>(undefined);
  const touchedRef = useRef(false);
  const [policyRaw, setPolicyRaw] = useState<Record<string, unknown>>({});
  const [auditOpen, setAuditOpen] = useState(false);
  const [rulesTarget, setRulesTarget] = useState<string | undefined>(undefined);

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

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    void pi
      .getCommands(workspace)
      .then((raw) => {
        if (!cancelled) setSkills(parseCommands(raw).filter((c) => c.apiSource === 'skill'));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  // 改动后静默自动存盘（防抖）：值已落盘，但 MCP/技能靠 env 在 sidecar 启动时注入，
  // 仍需「重启生效」按钮重启才真正生效。
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    if (loading || !touchedRef.current) return;
    const timer = window.setTimeout(() => void persistRef.current(), 600);
    return () => window.clearTimeout(timer);
  }, [values.MCP_SERVERS, values.MCP_SERVERS_DISABLED, values.SKILLS_DISABLED, loading]);

  const markChanged = () => {
    touchedRef.current = true;
    setNeedsRestart(true);
  };

  const writeCols = (next: Collections) => {
    setValue('MCP_SERVERS', next.enabled);
    setValue('MCP_SERVERS_DISABLED', next.disabled);
    markChanged();
  };
  const handleSubmitForm = (entry: { name: string; config: McpConfig }, targetEnabled: boolean) =>
    writeCols(upsertServer(cols, entry, targetEnabled ? 'enabled' : 'disabled'));
  const handleSubmitImport = (servers: Array<{ name: string; config: McpConfig }>) =>
    writeCols(mergeImport(cols, servers).cols);
  const handleToggleMcp = (name: string, enabled: boolean) => writeCols(setEnabled(cols, name, enabled));
  const handleDeleteMcp = (name: string) => {
    if (window.confirm(`确认删除 MCP "${name}"？`)) writeCols(removeServer(cols, name));
  };

  const disabled = parseDisabled(values.SKILLS_DISABLED ?? '');
  const toggleSkill = (name: string) => {
    const next = new Set(disabled);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setValue('SKILLS_DISABLED', Array.from(next).join(','));
    markChanged();
  };

  const restart = async () => {
    await save();
    setNeedsRestart(false);
  };

  return (
    <Flexbox className={styles.panel} data-testid="extensions-panel">
      <div className={styles.header}>
        <div className={styles.tabBar}>
          <button
            type="button"
            data-testid="ext-tab-mcp"
            className={`${styles.tab} ${tab === 'mcp' ? styles.tabActive : ''}`}
            onClick={() => setTab('mcp')}
          >
            <Boxes size={15} />
            插件
          </button>
          <button
            type="button"
            data-testid="ext-tab-skills"
            className={`${styles.tab} ${tab === 'skills' ? styles.tabActive : ''}`}
            onClick={() => setTab('skills')}
          >
            <Sparkles size={15} />
            技能
          </button>
        </div>
        {needsRestart ? (
          <button
            type="button"
            data-testid="ext-restart"
            className={styles.restartBtn}
            onClick={() => void restart()}
            disabled={saving}
            title="改动已自动保存，重启 sidecar 后生效"
          >
            <RotateCw size={13} />
            {saving ? '重启中…' : '重启生效'}
          </button>
        ) : null}
      </div>

      {error && <div className={styles.errorBar}>{error}</div>}

      <div className={styles.body}>
        <div className={styles.inner}>
          {tab === 'mcp' ? (
            <>
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
                连接外部 MCP server，其工具以 <code className={styles.code}>mcp__server__tool</code> 暴露给 agent（改动自动保存，重启后生效）。
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
                    live={liveMcpByName.get(e.name)}
                    policyRaw={policyRaw}
                    onToggle={(v) => handleToggleMcp(e.name, v)}
                    onEdit={() => {
                      setEditing(e);
                      setModalOpen(true);
                    }}
                    onDelete={() => handleDeleteMcp(e.name)}
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
            </>
          ) : (
            <>
              <div className={styles.hero}>
                <span className={styles.heroIcon}>
                  <Sparkles size={18} />
                </span>
                <span className={styles.heroTitle}>
                  Skills
                  {skills.length > 0 ? <span className={styles.count}>{skills.length}</span> : null}
                </span>
              </div>
              <div className={styles.heroDesc}>
                关闭某个 skill 后改动自动保存、重启生效；可用 <code className={styles.code}>/skill:名称</code> 调用。
              </div>

              {skills.length === 0 ? (
                <div className={styles.empty} data-testid="skills-empty">
                  <Sparkles size={22} />
                  <span>未发现 skills（workspace 无 .pi/skills 或未加载）</span>
                </div>
              ) : (
                skills.map((sk) => {
                  const off = disabled.has(sk.name);
                  return (
                    <div key={sk.name} className={styles.card} data-testid={`skill-${sk.name}`}>
                      <span className={styles.avatar} style={{ background: avatarBackground(sk.name) }}>
                        {sk.name.slice(0, 1)}
                      </span>
                      <div className={styles.meta}>
                        <span className={styles.name}>{sk.name}</span>
                        {sk.description ? <span className={styles.desc}>{sk.description}</span> : null}
                      </div>
                      <Switch
                        size="small"
                        checked={!off}
                        onChange={() => toggleSkill(sk.name)}
                        data-testid={`skill-toggle-${sk.name}`}
                      />
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>
      </div>
    </Flexbox>
  );
}
