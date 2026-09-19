import { ActionIcon, Flexbox } from '@lobehub/ui';
import { X } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, type ClipboardEvent } from 'react';
import type { ImageAttachment } from '../../features/chat/input/ChatInputContext';
import { fileToImageAttachment } from '../../features/chat/input/editor/imageAttachment';

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    margin: 8px 14px 10px;
  `,
  label: css`
    margin-block-end: 6px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  textarea: css`
    width: 100%;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    font-family: inherit;
    font-size: 13px;
    line-height: 1.5;
    resize: vertical;
    outline: none;

    &::placeholder {
      color: ${cssVar.colorTextTertiary};
    }
    &:focus {
      border-color: ${cssVar.colorInfo};
    }
  `,
  thumb: css`
    position: relative;
    flex: none;
  `,
}));

interface ExtraContentProps {
  text: string;
  onTextChange: (value: string) => void;
  images: ImageAttachment[];
  onImagesChange: (items: ImageAttachment[]) => void;
  allowImages?: boolean;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  'data-testid'?: string;
}

export const ExtraContent = memo(function ExtraContent({
  text,
  onTextChange,
  images,
  onImagesChange,
  allowImages = true,
  placeholder = '补充说明',
  label = '补充说明',
  disabled = false,
  'data-testid': testId = 'question-extra',
}: ExtraContentProps) {
  const addImages = useCallback(
    (files: File[]) => {
      void Promise.all(files.map(fileToImageAttachment)).then((items) => {
        onImagesChange([...images, ...items]);
      });
    },
    [images, onImagesChange],
  );

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      if (!allowImages || disabled) return;
      const imageFiles = Array.from(e.clipboardData.items)
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => f !== null);
      if (imageFiles.length === 0) return;
      e.preventDefault();
      addImages(imageFiles);
    },
    [addImages, allowImages, disabled],
  );

  return (
    <div className={styles.wrap} data-testid={testId}>
      <div className={styles.label}>{label}</div>
      <textarea
        className={styles.textarea}
        data-testid={`${testId}-text`}
        disabled={disabled}
        onChange={(e) => onTextChange(e.target.value)}
        onPaste={onPaste}
        placeholder={placeholder}
        rows={2}
        value={text}
      />
      {allowImages && !disabled && images.length > 0 ? (
        <Flexbox horizontal gap={8} style={{ flexWrap: 'wrap', marginTop: 8 }}>
          {images.map((img, index) => (
            <div className={styles.thumb} key={`${img.name}-${index}`}>
              <img
                alt={img.name}
                src={img.url}
                style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, display: 'block' }}
              />
              <ActionIcon
                icon={X}
                size="small"
                title="移除"
                onClick={() => onImagesChange(images.filter((_, i) => i !== index))}
                style={{ position: 'absolute', top: -8, right: -8 }}
              />
            </div>
          ))}
        </Flexbox>
      ) : null}
    </div>
  );
});
