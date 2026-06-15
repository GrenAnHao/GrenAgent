import { createStaticStyles, cssVar } from 'antd-style';
import { Check, Router, Terminal } from 'lucide-react';

type McpType = 'stdio' | 'remote';

interface McpTypeSelectProps {
  value: McpType;
  onChange: (v: McpType) => void;
}

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    gap: 12px;
    margin-block-end: 16px;
  `,
  card: css`
    position: relative;
    flex: 1;
    padding: 12px 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
    cursor: pointer;
    transition: border-color 0.16s ease;

    &:hover {
      border-color: ${cssVar.colorPrimaryHover};
    }
  `,
  active: css`
    border-color: ${cssVar.colorPrimary};
  `,
  tick: css`
    position: absolute;
    inset-block-start: 10px;
    inset-inline-end: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
    color: ${cssVar.colorBgContainer};
  `,
  title: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  desc: css`
    margin-block-start: 5px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

const OPTIONS: Array<{ value: McpType; label: string; desc: string; Icon: typeof Terminal }> = [
  { value: 'stdio', label: 'STDIO', desc: '本地命令启动（npx / uvx…）', Icon: Terminal },
  { value: 'remote', label: 'REMOTE', desc: '远程 URL（HTTP / SSE）', Icon: Router },
];

export function McpTypeSelect({ value, onChange }: McpTypeSelectProps) {
  return (
    <div className={styles.row}>
      {OPTIONS.map(({ value: v, label, desc, Icon }) => (
        <div
          key={v}
          data-testid={`mcp-type-${v}`}
          className={`${styles.card} ${value === v ? styles.active : ''}`}
          onClick={() => onChange(v)}
        >
          {value === v ? (
            <span className={styles.tick}>
              <Check size={12} />
            </span>
          ) : null}
          <div className={styles.title}>
            <Icon size={16} />
            {label}
          </div>
          <div className={styles.desc}>{desc}</div>
        </div>
      ))}
    </div>
  );
}
