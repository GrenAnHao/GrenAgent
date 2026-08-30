import { createStaticStyles, cssVar } from 'antd-style';
import { Minus, Plus } from 'lucide-react';

export type KvPairs = Array<[string, string]>;

interface KeyValueEditorProps {
  value: KvPairs;
  onChange: (next: KvPairs) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addText?: string;
  testId?: string;
}

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    gap: 8px;
    margin-block-end: 8px;
  `,
  input: css`
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 9px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;

    &:focus {
      border-color: ${cssVar.colorPrimary};
      outline: none;
    }
  `,
  rm: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    flex: 0 0 auto;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 9px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;
  `,
  add: css`
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: transparent;
    color: ${cssVar.colorPrimary};
    font-size: 12px;
    cursor: pointer;
  `,
}));

export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = 'KEY',
  valuePlaceholder = 'value',
  addText = '添加',
  testId = 'kv',
}: KeyValueEditorProps) {
  const setAt = (i: number, idx: 0 | 1, v: string) => {
    const next = value.map((p) => [...p] as [string, string]);
    next[i][idx] = v;
    onChange(next);
  };
  return (
    <div data-testid={testId}>
      {value.map((pair, i) => (
        <div key={i} className={styles.row}>
          <input
            className={styles.input}
            data-testid={`${testId}-key-${i}`}
            placeholder={keyPlaceholder}
            value={pair[0]}
            onChange={(e) => setAt(i, 0, e.target.value)}
          />
          <input
            className={styles.input}
            data-testid={`${testId}-val-${i}`}
            placeholder={valuePlaceholder}
            value={pair[1]}
            onChange={(e) => setAt(i, 1, e.target.value)}
          />
          <button
            type="button"
            className={styles.rm}
            data-testid={`${testId}-rm-${i}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <Minus size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={styles.add}
        data-testid={`${testId}-add`}
        onClick={() => onChange([...value, ['', '']])}
      >
        <Plus size={13} />
        {addText}
      </button>
    </div>
  );
}
