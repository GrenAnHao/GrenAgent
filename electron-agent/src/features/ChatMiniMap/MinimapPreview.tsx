import { memo } from 'react';
import { previewStyles } from './styles';
import type { MinimapIndicator } from './types';

interface MinimapPreviewProps {
  indicator: MinimapIndicator;
}

/** 悬停气泡内容：用户那句话做标题，紧随其后的助手回复摘要做正文。 */
export const MinimapPreview = memo<MinimapPreviewProps>(({ indicator }) => (
  <>
    <div className={previewStyles.title}>{indicator.title || '（空消息）'}</div>
    {indicator.reply ? <div className={previewStyles.body}>{indicator.reply}</div> : null}
  </>
));

MinimapPreview.displayName = 'MinimapPreview';
