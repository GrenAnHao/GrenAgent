import { App } from 'antd';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';

export const isSensitiveField = (key: string) => /key|token|secret|authorization|password|credential|cookie/i.test(key);
const styles = createStaticStyles(({ css }) => ({
  row: css`display:grid; grid-template-columns:minmax(60px,1fr) minmax(0,2fr) auto; align-items:center; gap:8px; padding:3px 0; font-size:12px; code {overflow-wrap:anywhere;} > span {display:flex; align-items:center;}`,
  action: css`display:inline-flex; align-items:center; justify-content:center; width:26px; height:24px; border:0; border-radius:5px; background:none; color:${cssVar.colorTextSecondary}; cursor:pointer; &:hover {background:${cssVar.colorFillSecondary};}`,
}));
export async function copyText(text: string, message: ReturnType<typeof App.useApp>['message'], success = '已复制') {
  try { await navigator.clipboard.writeText(text); void message.success(success); }
  catch { void message.error('无法写入剪贴板'); }
}
export function McpConfigValue({ field, value }: { field: string; value: unknown }) {
  const [revealed, setRevealed] = useState(false);
  const { message } = App.useApp();
  const secret = isSensitiveField(field), valid = typeof value === 'string';
  return <div className={styles.row}><code>{field}</code><code>{!valid ? '格式无效' : secret && !revealed ? '••••••••' : value || '（空）'}</code><span>
    {secret && valid && <button type="button" className={styles.action} title={revealed ? '隐藏' : '显示'} aria-label={`${revealed ? '隐藏' : '显示'} ${field}`} aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>{revealed ? <EyeOff size={13}/> : <Eye size={13}/>}</button>}
    {valid && <button type="button" className={styles.action} title="复制值" aria-label={`复制 ${field}`} onClick={() => void copyText(value, message)}><Copy size={13}/></button>}
  </span></div>;
}
