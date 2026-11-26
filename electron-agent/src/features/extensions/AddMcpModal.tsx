import { Modal } from '@lobehub/ui';
import { WorkbenchButton as Button } from '../../components/WorkbenchButton';
import { createStaticStyles, cssVar } from 'antd-style';
import { useEffect, useState } from 'react';
import type { McpConfigScope } from '../../lib/pi';
import { isSensitiveField } from './McpConfigValues';
import { KeyValueEditor } from './KeyValueEditor';
import { McpTypeSelect } from './McpTypeSelect';
import {
  configToForm,
  parseMcpImport, parseSingleServer,
  serializeForm,
  validateForm,
  type AuthKind,
  type McpConfig,
  type McpFormValues,
} from './mcpConfig';

interface AddMcpModalProps {
  open: boolean;
  editing?: { name: string; config: McpConfig; enabled: boolean; scope?: McpConfigScope };
  existingNames: string[];
  onSubmitForm: (entry: { name: string; config: McpConfig }, targetEnabled: boolean, scope?: McpConfigScope) => void | Promise<void>;
  onSubmitImport: (servers: Array<{ name: string; config: McpConfig }>, scope?: McpConfigScope) => void | Promise<void>;
  onClose: () => void;
}

type Tab = 'config' | 'json';

const EMPTY_FORM: McpFormValues = {
  type: 'stdio',
  name: '',
  command: '',
  args: '',
  env: [],
  cwd: '',
  url: '',
  auth: 'none',
  token: '',
  headers: [],
};

const styles = createStaticStyles(({ css }) => ({
  seg: css`
    display: flex;
    gap: 4px;
    margin-block-end: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  tab: css`
    padding: 7px 14px;
    border: none;
    border-block-end: 2px solid transparent;
    margin-block-end: -1px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    cursor: pointer;
  `,
  tabActive: css`
    color: ${cssVar.colorText};
    font-weight: 600;
    border-block-end-color: ${cssVar.colorPrimary};
  `,
  field: css`
    margin-block-end: 14px;
  `,
  label: css`
    display: block;
    margin-block-end: 6px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  input: css`
    width: 100%;
    padding: 9px 11px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 9px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    font-family: var(--font-mono);
    font-variant-ligatures: none;
    font-size: 13px;

    &:focus {
      border-color: ${cssVar.colorPrimary};
      outline: none;
    }
  `,
  ta: css`
    width: 100%;
    min-height: 220px;
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    font-family: var(--font-mono);
    font-variant-ligatures: none;
    font-size: 12px;

    &:focus {
      border-color: ${cssVar.colorPrimary};
      outline: none;
    }
  `,
  authRow: css`
    display: flex;
    gap: 8px;
    margin-block-end: 10px;
  `,
  authOpt: css`
    padding: 6px 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 9px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;
  `,
  authActive: css`
    border-color: ${cssVar.colorPrimary};
    color: ${cssVar.colorText};
  `,
  error: css`
    margin-block-end: 10px;
    color: ${cssVar.colorError};
    font-size: 12px;
  `,
  foot: css`
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-block-start: 16px;
  `,
}));

const JSON_PLACEHOLDER = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "<your-token>" }
    }
  }
}`;

export function AddMcpModal({
  open,
  editing,
  existingNames,
  onSubmitForm,
  onSubmitImport,
  onClose,
}: AddMcpModalProps) {
  const [tab, setTab] = useState<Tab>('config');
  const [form, setForm] = useState<McpFormValues>(EMPTY_FORM);
  const [json, setJson] = useState('');
  const [scope, setScope] = useState<McpConfigScope>('settings');
  const [working, setWorking] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [base, setBase] = useState<{name:string; config:McpConfig}>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setJson(''); setBase(editing); setUnlocked(false); setScope(editing?.scope ?? 'settings');
    setTab('config');
    setForm(editing ? configToForm(editing.name, editing.config) : EMPTY_FORM);
  }, [open, editing]);

  const set = <K extends keyof McpFormValues>(k: K, v: McpFormValues[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  const currentEntry = () => {
    const next = serializeForm(form);
    if (!base || form.type !== configToForm(base.name, base.config).type) return next;
    // Keep untouched raw fields exactly as supplied, including empty arrays/maps.
    const baseline = serializeForm(configToForm(base.name, base.config)).config;
    const config: Record<string, unknown> = { ...base.config };
    for (const key of new Set([...Object.keys(baseline), ...Object.keys(next.config)])) {
      const before: unknown = Reflect.get(baseline, key), after: unknown = Reflect.get(next.config, key);
      if (JSON.stringify(before) !== JSON.stringify(after)) { if (after === undefined) delete config[key]; else config[key] = after; }
    }
    return { name: next.name, config: config as unknown as McpConfig };
  };
  const swap = (next: Tab) => {
    if (tab === next || working) return;
    try {
      if (next === 'json') {
        const entry = currentEntry();
        if (entry.name || editing) setJson(JSON.stringify({mcpServers:{[entry.name]:entry.config}}, null, 2));
        setUnlocked(false);
      } else if (json.trim()) {
        const entry = parseSingleServer(json, form.name);
        setBase(entry); setForm(configToForm(entry.name, entry.config));
      }
      setError(null); setTab(next);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const save = async () => {
    if (working) return;
    setWorking(true); setError(null);
    try {
      if (!editing && tab === 'json') {
        const r = parseMcpImport(json);
        if (!r.ok) throw new Error(r.error);
        if (scope === 'settings') await onSubmitImport(r.servers); else await onSubmitImport(r.servers, scope);
      } else {
        const entry = tab === 'json' ? parseSingleServer(json, form.name) : currentEntry();
        const err = validateForm(configToForm(entry.name, entry.config), new Set(existingNames.filter(n => n !== editing?.name)));
        if (err) throw new Error(err);
        if (scope === (editing?.scope ?? 'settings')) await onSubmitForm(entry, editing?.enabled ?? true);
        else await onSubmitForm(entry, editing?.enabled ?? true, scope);
      }
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setWorking(false); }
  };
  // Never put an existing credential in the raw textarea before explicit reveal.
  let masked = json;
  try { masked = JSON.stringify(JSON.parse(json), (k,v) => isSensitiveField(k) && typeof v === 'string' ? '••••••••' : v, 2); } catch { /* unfinished draft */ }
  const locked = !unlocked && masked.includes('••••••••') && masked !== json;
  const showConfig = tab === 'config';

  return (
    <Modal open={open} title={editing ? '编辑 MCP' : '添加 MCP'} footer={null} onCancel={() => !working && onClose()} data-testid="add-mcp-modal">
        <div className={styles.seg}>
          <button type="button" data-testid="mcp-tab-config" className={`${styles.tab} ${showConfig ? styles.tabActive : ''}`} onClick={() => swap('config')}>表单模式</button>
          <button type="button" data-testid="mcp-tab-json" className={`${styles.tab} ${!showConfig ? styles.tabActive : ''}`} onClick={() => swap('json')}>{editing ? 'Raw JSON' : 'JSON 导入'}</button>
        </div>
        <label className={styles.label}>配置来源
          <select className={styles.input} value={scope} onChange={e => setScope(e.target.value as McpConfigScope)}>
            <option value="settings">应用设置</option><option value="global">全局 · ~/.pi/agent/mcp.json</option><option value="project">当前项目 · .pi/mcp.json</option>
          </select>
        </label>
        {editing?.scope && editing.scope !== scope && <p>保存时将移动此配置；若有同名项则保留原位置。</p>}
      {error ? <div className={styles.error}>{error}</div> : null}

      {showConfig ? (
        <>
          <McpTypeSelect value={form.type} onChange={(t) => set('type', t)} />
          <div className={styles.field}>
            <label className={styles.label}>MCP 名称 *</label>
            <input
              className={styles.input}
              data-testid="mcp-name"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="my-server"
            />
          </div>

          {form.type === 'stdio' ? (
            <>
              <div className={styles.field}>
                <label className={styles.label}>命令 *</label>
                <input
                  className={styles.input}
                  data-testid="mcp-command"
                  value={form.command ?? ''}
                  onChange={(e) => set('command', e.target.value)}
                  placeholder="npx"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>参数 args</label>
                <input
                  className={styles.input}
                  data-testid="mcp-args"
                  value={form.args ?? ''}
                  onChange={(e) => set('args', e.target.value)}
                  placeholder="-y @scope/server"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>环境变量 env</label>
                <KeyValueEditor
                  value={form.env ?? []}
                  onChange={(v) => set('env', v)}
                  keyPlaceholder="VAR_NAME"
                  addText="添加变量"
                  testId="mcp-env"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>工作目录 cwd</label>
                <input
                  className={styles.input}
                  data-testid="mcp-cwd"
                  value={form.cwd ?? ''}
                  onChange={(e) => set('cwd', e.target.value)}
                  placeholder="D:/path/to/server"
                />
              </div>
            </>
          ) : (
            <>
              <div className={styles.field}>
                <label className={styles.label}>URL *</label>
                <input
                  className={styles.input}
                  data-testid="mcp-url"
                  value={form.url ?? ''}
                  onChange={(e) => set('url', e.target.value)}
                  placeholder="https://mcp.example.com/sse"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>鉴权</label>
                <div className={styles.authRow}>
                  {(['none', 'bearer'] as AuthKind[]).map((a) => (
                    <span
                      key={a}
                      data-testid={`mcp-auth-${a}`}
                      className={`${styles.authOpt} ${form.auth === a ? styles.authActive : ''}`}
                      onClick={() => set('auth', a)}
                    >
                      {a === 'none' ? '无' : 'Bearer Token'}
                    </span>
                  ))}
                </div>
                {form.auth === 'bearer' ? (
                  <input
                    className={styles.input}
                    type="password" data-testid="mcp-token"
                    value={form.token ?? ''}
                    onChange={(e) => set('token', e.target.value)}
                    placeholder="Bearer 令牌"
                  />
                ) : null}
              </div>
              <div className={styles.field}>
                <label className={styles.label}>请求头 Headers</label>
                <KeyValueEditor
                  value={form.headers ?? []}
                  onChange={(v) => set('headers', v)}
                  keyPlaceholder="Header"
                  addText="添加请求头"
                  testId="mcp-headers"
                />
              </div>
            </>
          )}

          <div className={styles.foot}>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" data-testid="mcp-submit" loading={working} onClick={() => void save()}>
              {editing ? '保存' : '添加'}
            </Button>
          </div>
        </>
      ) : (
        <>
          {locked && <Button size="small" onClick={() => setUnlocked(true)}>显示凭据并编辑 JSON</Button>}
          <textarea
            className={styles.ta}
            data-testid="mcp-json"
            aria-label="服务器 JSON" readOnly={locked} value={locked ? masked : json}
            onChange={(e) => {setUnlocked(true); setJson(e.target.value);}}
            placeholder={JSON_PLACEHOLDER}
          />
          <div className={styles.foot}>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" data-testid="mcp-import" loading={working} onClick={() => void save()}>
              {editing ? '保存' : '导入'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
