import { Flexbox } from '@lobehub/ui';
import { useEffect, useState } from 'react';
import { pi } from '../../lib/pi';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { useMcpStatusStore } from '../../stores/mcpStatusStore';
import type { PiCommand } from '../chat/input/commandTypes';
import { parseCommands } from '../chat/input/commandUtils';
import { useSettingsForm } from '../settings/useSettingsForm';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';
const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

interface McpDisplayServer {
  name: string;
  transport: 'stdio' | 'sse' | '?';
}

/** 从 MCP_SERVERS JSON（标准 `{mcpServers:{...}}` 或裸 map）推导 server 列表。 */
function parseMcpServers(json: string): McpDisplayServer[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    const root = parsed as Record<string, unknown>;
    const wrapped = root.mcpServers;
    const source = (wrapped && typeof wrapped === 'object' ? wrapped : root) as Record<string, unknown>;
    return Object.entries(source).map(([name, raw]) => {
      const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      if (typeof cfg.url === 'string') return { name, transport: 'sse' as const };
      if (typeof cfg.command === 'string') return { name, transport: 'stdio' as const };
      return { name, transport: '?' as const };
    });
  } catch {
    return [];
  }
}

function parseDisabled(csv: string): Set<string> {
  return new Set(
    csv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const saveBtn: React.CSSProperties = {
  padding: '4px 14px',
  borderRadius: 6,
  border,
  cursor: 'pointer',
  background: 'var(--gren-rail-active, rgba(255,255,255,0.08))',
  color: 'inherit',
  fontSize: 12,
};

export function ExtensionsPanel() {
  const { values, setValue, save, saving, error } = useSettingsForm();
  const { workspace } = useAgentStoreContext();
  const liveMcp = useMcpStatusStore((s) => s.servers);
  const liveMcpByName = new Map(liveMcp.map((s) => [s.name, s]));
  const mcpServers = parseMcpServers(values.MCP_SERVERS ?? '');

  const [skills, setSkills] = useState<PiCommand[]>([]);
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

  const disabled = parseDisabled(values.SKILLS_DISABLED ?? '');
  const toggleSkill = (name: string) => {
    const next = new Set(disabled);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setValue('SKILLS_DISABLED', Array.from(next).join(','));
  };

  return (
    <Flexbox data-testid="extensions-panel" style={{ height: '100%', minHeight: 0, overflowY: 'auto' }}>
      <Flexbox
        horizontal
        align="center"
        justify="space-between"
        style={{ padding: '10px 14px', borderBottom: border, flex: '0 0 auto' }}
      >
        <span style={{ fontSize: 13 }}>扩展（MCP / Skills）</span>
        <button data-testid="ext-save" onClick={() => void save()} disabled={saving} style={saveBtn} type="button">
          {saving ? '保存中…' : '保存并重启'}
        </button>
      </Flexbox>
      {error && <div style={{ padding: '6px 14px', fontSize: 12, color: '#f87171' }}>{error}</div>}

      <div style={{ padding: 16, maxWidth: 560 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBlockEnd: 8 }}>MCP 服务器</div>
        <div style={{ fontSize: 12, color: muted, marginBlockEnd: 8 }}>
          连接外部 MCP server，其工具以 <code>mcp__server__tool</code> 暴露给 agent（保存并重启生效）。
        </div>
        {mcpServers.length === 0 ? (
          <div data-testid="mcp-empty" style={{ fontSize: 12, color: muted, marginBlockEnd: 8 }}>
            未配置 MCP server
          </div>
        ) : (
          mcpServers.map((s) => {
            const live = liveMcpByName.get(s.name);
            return (
              <Flexbox
                key={s.name}
                horizontal
                align="center"
                gap={8}
                data-testid={`mcp-server-${s.name}`}
                style={{ border, borderRadius: 8, padding: '8px 11px', marginBlockEnd: 7 }}
              >
                <span style={{ fontSize: 12, flex: 1 }}>{s.name}</span>
                <span style={{ fontSize: 11, color: muted }}>{s.transport}</span>
                {live ? (
                  <span style={{ fontSize: 11, color: live.status === 'connected' ? '#4ade80' : '#f87171' }}>
                    {live.status === 'connected' ? `● ${live.tools} 工具` : '○ 失败'}
                  </span>
                ) : (
                  <span style={{ fontSize: 11, color: muted }}>待连接</span>
                )}
              </Flexbox>
            );
          })
        )}
        <textarea
          data-testid="ext-field-MCP_SERVERS"
          value={values.MCP_SERVERS ?? ''}
          onChange={(e) => setValue('MCP_SERVERS', e.target.value)}
          placeholder='{"mcpServers":{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}}}'
          rows={4}
          style={{
            width: '100%',
            marginBlockStart: 6,
            padding: '6px 8px',
            borderRadius: 6,
            border,
            background: 'transparent',
            color: 'inherit',
            fontFamily: mono,
            fontSize: 12,
            resize: 'vertical',
          }}
        />

        <div style={{ fontSize: 13, fontWeight: 600, marginBlockStart: 16, marginBlockEnd: 8 }}>Skills</div>
        <div style={{ fontSize: 12, color: muted, marginBlockEnd: 8 }}>
          关闭某个 skill 后「保存并重启」生效；可用 <code>/skill:名称</code> 调用。
        </div>
        {skills.length === 0 ? (
          <div data-testid="skills-empty" style={{ fontSize: 12, color: muted }}>
            未发现 skills（workspace 无 .pi/skills 或未加载）
          </div>
        ) : (
          skills.map((sk) => {
            const off = disabled.has(sk.name);
            return (
              <Flexbox
                key={sk.name}
                horizontal
                align="center"
                gap={8}
                data-testid={`skill-${sk.name}`}
                style={{ border, borderRadius: 8, padding: '8px 11px', marginBlockEnd: 7 }}
              >
                <Flexbox style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12 }}>{sk.name}</span>
                  {sk.description ? (
                    <span style={{ fontSize: 11, color: muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {sk.description}
                    </span>
                  ) : null}
                </Flexbox>
                <button
                  data-testid={`skill-toggle-${sk.name}`}
                  onClick={() => toggleSkill(sk.name)}
                  type="button"
                  style={{
                    fontSize: 11,
                    padding: '2px 10px',
                    borderRadius: 6,
                    border,
                    cursor: 'pointer',
                    background: 'transparent',
                    color: off ? muted : '#4ade80',
                  }}
                >
                  {off ? '已禁用' : '已启用'}
                </button>
              </Flexbox>
            );
          })
        )}
      </div>
    </Flexbox>
  );
}
