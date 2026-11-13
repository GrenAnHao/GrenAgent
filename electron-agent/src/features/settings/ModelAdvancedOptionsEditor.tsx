import { Button, Input } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { parseSamplingJson, patchOptionPath, validateProviderModelOptions, type ProviderModelOptions } from '../../../../extensions/_shared/provider-model-options';
import { inputLimitSupport } from '../../../../extensions/_shared/model-input-limit-policy';

export interface AdvancedDrafts { _advancedDrafts?: Record<string, string>; _advancedErrors?: Record<string, string> }
const styles = createStaticStyles(({ css }) => ({
  root: css`min-width:0;container-type:inline-size;color:${cssVar.colorText};`,
  fields: css`
    display:grid;
    grid-template-columns:repeat(2,minmax(0,1fr));
    gap:12px;
    margin-block-end:12px;
    @container (max-width:560px) { grid-template-columns:1fr; }
  `,
  field: css`display:flex;flex-direction:column;gap:6px;min-width:0;`,
  label: css`font-size:var(--pi-font-size,14px);font-weight:600;line-height:1.55;`,
  json: css`
    font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
    font-size:12px;
    line-height:1.6;
    &::placeholder { font-family:${cssVar.fontFamily}; }
  `,
  help: css`font-size:12px;line-height:1.55;color:${cssVar.colorTextDescription};margin:4px 0 10px;`,
  error: css`font-size:12px;color:${cssVar.colorError};margin-block:4px;`,
}));
const numericFields = [
  ['inputLimits.images.maxPerMessage', '每条消息图片数（张）'],
  ['inputLimits.images.maxPerRequest', '每次请求图片数（张）'],
  ['inputLimits.maxRequestBytes', '序列化请求上限（bytes）'],
  ['inputLimits.images.resize.maxWidth', '缩图最大宽度（px）'],
  ['inputLimits.images.resize.maxHeight', '缩图最大高度（px）'],
  ['inputLimits.images.resize.maxBytes', '缩图 base64 上限（bytes）'],
  ['inputLimits.images.resize.jpegQuality', 'JPEG 质量（1–100）'],
  ['promptCache.short', '短缓存寿命（秒）'], ['promptCache.long', '长缓存寿命（秒）'],
] as const;
function at(value: unknown, path: string): unknown { return path.split('.').reduce((node: any, key) => node?.[key], value); }

export function ModelAdvancedOptionsEditor({ value, inherited, api, testId, onChange }: {
  value: ProviderModelOptions & AdvancedDrafts; inherited?: ProviderModelOptions; api?: string; testId: string;
  onChange: (patch: ProviderModelOptions & AdvancedDrafts) => void;
}) {
  const errors = value._advancedErrors ?? {};
  const drafts = value._advancedDrafts ?? {};
  const support = inputLimitSupport(api);
  const update = (path: string, text: string, json: boolean) => {
    const nextErrors = { ...errors };
    let next = value;
    try {
      const parsed = json ? parseSamplingJson(text, path) : text.trim() ? Number(text) : undefined;
      next = patchOptionPath(value, path.split('.'), parsed);
      validateProviderModelOptions(next);
      delete nextErrors[path];
    } catch (error) { nextErrors[path] = error instanceof Error ? error.message : String(error); next = value; }
    const root = path.split('.')[0];
    onChange({ ...next, [root]: (next as Record<string, unknown>)[root], _advancedDrafts: { ...drafts, [path]: text }, _advancedErrors: nextErrors });
  };
  const field = (path: string, label: string, json = false) => {
    const saved = at(value, path);
    const fromSdk = at(inherited, path);
    const text = drafts[path] ?? (saved === undefined ? '' : json ? JSON.stringify(saved, null, 2) : String(saved));
    const quota = ['inputLimits.images.maxPerMessage', 'inputLimits.images.maxPerRequest', 'inputLimits.maxRequestBytes'].includes(path);
    const unsupported = quota && !(path === 'inputLimits.maxRequestBytes' ? support.bytes : support.counts);
    return <label key={path} className={styles.field}>
      <span className={styles.label}>{label}</span>
      {json ? <Input.TextArea className={styles.json} data-testid={`${testId}-${path}`} value={text} rows={4} variant="filled" status={errors[path] ? 'error' : undefined} placeholder="留空继承 SDK" onChange={(event) => update(path, event.target.value, true)} />
        : <Input data-testid={`${testId}-${path}`} disabled={unsupported} value={text} variant="filled" status={errors[path] ? 'error' : undefined} placeholder={fromSdk === undefined ? '继承 SDK' : `继承：${String(fromSdk)}`} onChange={(event) => update(path, event.target.value, false)} />}
      {errors[path] ? <div role="alert" className={styles.error}>{errors[path]}</div> : null}
      {path.startsWith('promptCache.') ? <div className={styles.help}>{saved !== undefined ? `覆盖：${String(saved)} 秒` : fromSdk !== undefined ? `继承目录：${String(fromSdk)} 秒` : '未提供可继承寿命：未知'}</div> : null}
      {quota ? <div className={styles.help}>{saved === undefined && fromSdk !== undefined ? '目录声明不等于桌面预检覆盖；未显式设置时保持 SDK 原路径。' : null}{unsupported ? support.explanation : path === 'inputLimits.maxRequestBytes' ? '显式覆盖才由桌面预检最终 HTTP body 的 UTF-8 未压缩 JSON，不含 HTTP 头；超限拒绝。' : '显式覆盖才由桌面预检本次最终请求，超限拒绝，不删附件。'}{unsupported && saved !== undefined ? <Button size="small" onClick={() => update(path, '', false)}>清除此限制</Button> : null}</div> : null}
    </label>;
  };
  return <section className={styles.root} data-testid={testId}>
    <p className={styles.help}>{api?.includes('openai') ? '采样按基础值 → 当前思考档 → 调用方显式参数合并；使用 JSON 对象，数字与布尔值原样保留。' : `当前协议 ${api ?? '未指定'} 不消费采样参数；已有值保留，当前不生效。`}</p>
    <div className={styles.fields}>
      {field('samplingParams', '基础采样 JSON', true)}
      {field('samplingParamsByThinkingLevel', '分档采样 JSON', true)}
    </div>
    <p className={styles.help}>分档键：off / minimal / low / medium / high / xhigh / max。</p>
    <div className={styles.fields}>{numericFields.map(([path, label]) => field(path, label))}</div>
    <p className={styles.help}>留空只清除此字段覆盖。图片缩放仅处理新进入历史的附件，不修改已有图片。缓存寿命支持有限正数秒（含小数）；只有已知寿命的档位才可能被 SDK 预热，仍受预热模式与费用判断控制。</p>
  </section>;
}
