import { Image } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import type { ContentImage } from './toolUtils';

const styles = createStaticStyles(({ css }) => ({
  frame: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    min-width: 0;
  `,
  shot: css`
    overflow: hidden;
    width: fit-content;
    max-width: 100%;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
  `,
}));

/** 读取图片文件时把结果里的图像画出来，点击可放大。 */
export const FileImageRead = memo(function FileImageRead({
  images,
  alt,
}: {
  images: ContentImage[];
  alt: string;
}) {
  if (images.length === 0) return null;
  return (
    <div className={styles.frame} data-testid="file-read-images">
      <Image.PreviewGroup>
        {images.map((img, index) => (
          <div className={styles.shot} key={`${img.mimeType}-${index}`}>
            <Image
              alt={images.length > 1 ? `${alt} ${index + 1}` : alt}
              data-testid="file-read-image"
              maxHeight={480}
              objectFit="contain"
              src={`data:${img.mimeType};base64,${img.data}`}
              style={{ maxWidth: '100%' }}
            />
          </div>
        ))}
      </Image.PreviewGroup>
    </div>
  );
});
