import { Button, Modal } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useEffect, useState } from 'react';
import { KeyValueEditor } from './KeyValueEditor';
import { McpTypeSelect } from './McpTypeSelect';
import {
  configToForm,
  parseMcpImport,
  serializeForm,
  validateForm,
  type AuthKind,
  type McpConfig,
  type McpFormValues,
} from './mcpConfig';

interface AddMcpModalProps {
  open: boolean;
  editing?: { name: string; config: McpConfig; enabled: boolean };
  existingNames: string[];
  onSubmitForm: (entry: { name: string; config: McpConfig }, targetEnabled: boolean) => void;
  onSubmitImport: (servers: Array<{ name: string; config: McpConfig }>) => void;
  onClose: () => void;
}

type Tab = 'config' | 'json';

const EMPTY_FORM: McpFormValues = {
  type: 'stdio',
  name: '',
  command: '',
  args: '',
  env: [],
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
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
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
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setJson('');
    setTab('config');
    setForm(editing ? configToForm(editing.name, editing.config) : EMPTY_FORM);
  }, [open, editing]);

  const set = <K extends keyof McpFormValues>(k: K, v: McpFormValues[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  const submitConfig = () => {
    const names = new Set(existingNames.filter((n) => n !== editing?.name));
    const err = validateForm(form, names);
    if (err) {
      setError(err);
      return;
    }
    onSubmitForm(serializeForm(form), editing ? editing.enabled : true);
    onClose();
  };

  const submitJson = () => {
    const r = parseMcpImport(json);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onSubmitImport(r.servers);
    onClose();
  };

  const showConfig = tab === 'config' || !!editing;

  return (
    <Modal open={open} title={editing ? '编辑 MCP' : '添加 MCP'} footer={null} onCancel={onClose} data-testid="add-mcp-modal">
      {!editing ? (
        <div className={styles.seg}>
          <button
            type="button"
            data-testid="mcp-tab-config"
            className={`${styles.tab} ${tab === 'config' ? styles.tabActive : ''}`}
            onClick={() => setTab('config')}
          >
            快速配置
          </button>
          <button
            type="button"
            data-testid="mcp-tab-json"
            className={`${styles.tab} ${tab === 'json' ? styles.tabActive : ''}`}
            onClick={() => setTab('json')}
          >
            JSON 导入
          </button>
        </div>
      ) : null}

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
                    data-testid="mcp-token"
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
            <Button type="primary" data-testid="mcp-submit" onClick={submitConfig}>
              {editing ? '保存' : '添加'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <textarea
            className={styles.ta}
            data-testid="mcp-json"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            placeholder={JSON_PLACEHOLDER}
          />
          <div className={styles.foot}>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" data-testid="mcp-import" onClick={submitJson}>
              导入
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
