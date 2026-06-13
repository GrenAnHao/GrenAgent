import { Flexbox } from '@lobehub/ui';
import { useSettingsForm } from '../settings/useSettingsForm';
import { SettingFieldInput } from '../settings/SettingField';
import { CONNECTION_FIELDS } from '../settings/settingsSchema';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';
const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const PLATFORMS = [
  { name: 'Slack', hint: '用 Slack Events API/Bolt 适配器把消息 POST 到网关 /message，回复回 replyUrl。' },
  { name: '飞书 / Feishu', hint: '用飞书机器人回调把消息转发到网关 /message。' },
  { name: 'Telegram', hint: '用 Telegram Bot webhook 把消息转发到网关 /message。' },
];

interface McpDisplayServer {
  name: string;
  transport: 'stdio' | 'sse' | '?';
}

/** 从 MCP_SERVERS JSON 推导 server 列表（容错；实时连接状态留增强）。 */
function parseMcpServers(json: string): McpDisplayServer[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    const root = parsed as Record<string, unknown>;
    // Standard `{ "mcpServers": {...} }` (like .cursor/mcp.json) or a bare map.
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

export function ConnectionsPanel() {
  const { values, setValue, save, saving, loading, error } = useSettingsForm();
  const enabled = values.IM_GATEWAY === '1' || values.IM_GATEWAY?.toLowerCase() === 'true';
  const port = (values.IM_GATEWAY_PORT ?? '').trim() || '8765';
  const hasToken = (values.IM_GATEWAY_TOKEN ?? '').trim().length > 0;
  const mcpServers = parseMcpServers(values.MCP_SERVERS ?? '');

  return (
    <Flexbox
      data-testid="connections-panel"
      style={{ height: '100%', minHeight: 0, overflowY: 'auto' }}
    >
      <Flexbox
        horizontal
        align="center"
        justify="space-between"
        style={{ padding: '10px 14px', borderBottom: border, flex: '0 0 auto' }}
      >
        <Flexbox horizontal align="center" gap={8} style={{ fontSize: 13 }}>
          <span>IM 网关</span>
          <span style={{ fontSize: 12, color: enabled ? '#4ade80' : muted }}>
            {enabled ? `● 已启用 :${port}` : '○ 未启用'}
          </span>
        </Flexbox>
        <button
          data-testid="conn-save"
          onClick={() => void save()}
          disabled={saving}
          style={{
            padding: '4px 14px',
            borderRadius: 6,
            border,
            cursor: 'pointer',
            background: 'var(--gren-rail-active, rgba(255,255,255,0.08))',
            color: 'inherit',
            fontSize: 12,
          }}
        >
          {saving ? '保存中…' : '保存并重启'}
        </button>
      </Flexbox>
      {error && <div style={{ padding: '6px 14px', fontSize: 12, color: '#f87171' }}>{error}</div>}

      <div style={{ padding: 16, maxWidth: 560 }}>
        {/* 网关信息卡（由配置推导，重启后实际生效） */}
        <div style={{ border, borderRadius: 10, padding: '12px 14px', marginBlockEnd: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBlockEnd: 8 }}>{loading ? '加载中…' : '网关'}</div>
          <Flexbox horizontal gap={10} style={{ fontSize: 12, marginBlockEnd: 4 }}>
            <span style={{ color: muted, width: 72, flex: '0 0 auto' }}>监听地址</span>
            <span style={{ fontFamily: mono }}>http://127.0.0.1:{port}</span>
          </Flexbox>
          <Flexbox horizontal gap={10} style={{ fontSize: 12, marginBlockEnd: 4 }}>
            <span style={{ color: muted, width: 72, flex: '0 0 auto' }}>Webhook</span>
            <span style={{ fontFamily: mono }}>POST /message</span>
          </Flexbox>
          <Flexbox horizontal gap={10} style={{ fontSize: 12 }}>
            <span style={{ color: muted, width: 72, flex: '0 0 auto' }}>Token</span>
            <span style={{ color: hasToken ? 'inherit' : muted }}>{hasToken ? '已设置' : '（未设置，公开访问）'}</span>
          </Flexbox>
        </div>

        {CONNECTION_FIELDS.map((f) => (
          <SettingFieldInput
            key={f.key}
            field={f}
            value={values[f.key] ?? ''}
            onChange={(v) => setValue(f.key, v)}
            testIdPrefix="conn-field"
          />
        ))}

        <div style={{ marginBlockStart: 8, fontSize: 13, fontWeight: 600 }}>平台接入</div>
        <div style={{ fontSize: 12, color: muted, marginBlockEnd: 8 }}>
          网关监听 <code>POST /message {'{ text, replyUrl? }'}</code>，回复回 replyUrl。
        </div>
        {PLATFORMS.map((p) => (
          <Flexbox
            key={p.name}
            gap={3}
            style={{ border, borderRadius: 8, padding: '8px 11px', marginBlockEnd: 7 }}
          >
            <Flexbox horizontal align="center" gap={8}>
              <span style={{ fontSize: 12, flex: 1 }}>{p.name}</span>
              <span style={{ fontSize: 11, color: muted }}>未配置</span>
            </Flexbox>
            <span style={{ fontSize: 11, color: muted }}>{p.hint}</span>
          </Flexbox>
        ))}

        <div style={{ marginBlockStart: 14, fontSize: 13, fontWeight: 600 }}>MCP 服务器</div>
        <div style={{ fontSize: 12, color: muted, marginBlockEnd: 8 }}>
          连接外部 MCP server，其工具以 <code>mcp__server__tool</code> 暴露给 agent（保存并重启生效）。
        </div>
        {mcpServers.length === 0 ? (
          <div data-testid="mcp-empty" style={{ fontSize: 12, color: muted, marginBlockEnd: 8 }}>
            未配置 MCP server
          </div>
        ) : (
          mcpServers.map((s) => (
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
            </Flexbox>
          ))
        )}
        <textarea
          data-testid="conn-field-MCP_SERVERS"
          value={values.MCP_SERVERS ?? ''}
          onChange={(e) => setValue('MCP_SERVERS', e.target.value)}
          placeholder='{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}}'
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
      </div>
    </Flexbox>
  );
}
