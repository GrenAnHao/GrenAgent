import { createStaticStyles, cssVar } from 'antd-style';
import { FileCheck } from 'lucide-react';
import { memo, useState } from 'react';
import { readInjectedRules } from '@extensions/context-rules/injectionNotice';
import { MutedLine } from './conv/MutedLine';

const styles = createStaticStyles(({ css }) => ({
  host: css`
    padding-inline-start: 4px;
  `,
  rules: css`
    max-height: 200px;
    overflow: auto;
    margin: 0;
    padding: 2px 0 4px 19px;
    list-style: none;
    font-size: var(--pi-font-size-secondary, 13px);
    color: ${cssVar.colorTextSecondary};

    & li {
      display: flex;
      gap: 10px;
      align-items: baseline;
      padding-block: 2px;
      overflow-wrap: anywhere;
    }
  `,
  scope: css`
    flex-shrink: 0;
    color: ${cssVar.colorTextTertiary};
  `,
  file: css`
    color: ${cssVar.colorTextTertiary};
    margin-inline-start: 6px;
  `,
}));

export const RuleInjectionPill = memo(function RuleInjectionPill({ details }: { details: unknown }) {
  const [open, setOpen] = useState(false);
  const rules = readInjectedRules(details);
  if (!rules.length) return null;
  return (
    <div data-testid="rule-injection-pill" className={styles.host}>
      <MutedLine icon={FileCheck} text="已注入规则" count={rules.length} open={open} onToggle={() => setOpen((value) => !value)} />
      {open && (
        <ul className={styles.rules}>
          {rules.map(({ id, title, scope }) => (
            <li key={`${scope}:${id}`}>
              <span className={styles.scope}>{scope === 'global' ? '全局' : '项目'}</span>
              <span>{title}{title !== id && <span className={styles.file}>{id}.md</span>}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
