import { ActionIcon, Flexbox } from '@lobehub/ui';
import { X } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import FileIcon from '../../../../components/FileIcon';
import { useChatInput } from '../ChatInputContext';
import { pastedLabel } from './pastedText';

const styles = createStaticStyles(({ css }) => ({
  chip: css`
    display: flex;
    gap: 6px;
    align-items: center;

    max-width: 220px;
    height: 28px;
    padding: 0 6px 0 8px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorFillTertiary};
  `,
  chipLabel: css`
    overflow: hidden;

    font-size: 12px;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

export function InputChips() {
  const { attachments, removeAttachment, pastedTexts, removePastedText } = useChatInput();
  if (attachments.length === 0 && pastedTexts.length === 0) return null;

  return (
    <Flexbox horizontal gap={8} style={{ flexWrap: 'wrap' }}>
      {attachments.map((a, index) => (
        <div key={`${a.name}-${index}`} style={{ position: 'relative' }}>
          <img
            src={a.url}
            alt={a.name}
            style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, display: 'block' }}
          />
          <ActionIcon
            icon={X}
            size="small"
            title="移除"
            onClick={() => removeAttachment(index)}
            style={{ position: 'absolute', top: -8, right: -8 }}
          />
        </div>
      ))}
      {pastedTexts.map((p) => {
        const fileName = p.source?.split('/').pop() || p.source || '粘贴文本';
        return (
          <div key={p.id} className={styles.chip}>
            <FileIcon fileName={fileName} size={14} variant="raw" />
            <span className={styles.chipLabel} title={p.text.slice(0, 2000)}>
              {pastedLabel(p)}
            </span>
            <ActionIcon icon={X} size="small" title="移除" onClick={() => removePastedText(p.id)} />
          </div>
        );
      })}
    </Flexbox>
  );
}
