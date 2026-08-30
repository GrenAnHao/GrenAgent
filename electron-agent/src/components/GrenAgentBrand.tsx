import { Flexbox } from '@lobehub/ui';
import { PiBrandLogo } from './PiBrandLogo';

interface GrenAgentBrandProps {
  /** π 字标尺寸（px）。 */
  size?: number;
}

/**
 * GrenAgent 头部品牌锁定标：π 字标（accent 色）+ GrenAgent 字样，
 * 沿用全屏加载界面（FullscreenLoading）的配色，作为侧栏标题等处的统一品牌呈现。
 * 这里用静态 PiBrandLogo（不套 BrandLoading 的描边动画），避免常驻头部持续动画分散注意。
 */
export function GrenAgentBrand({ size = 18 }: GrenAgentBrandProps) {
  return (
    <Flexbox horizontal align="center" gap={8}>
      <span style={{ color: 'var(--gren-acc, #4c8bf5)', display: 'inline-flex', lineHeight: 1 }}>
        <PiBrandLogo size={size} />
      </span>
      <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: 1, color: 'var(--gren-fg-muted, #9aa1ac)' }}>
        Gren<span style={{ color: 'var(--gren-fg, #e6e8ec)' }}>Agent</span>
      </span>
    </Flexbox>
  );
}
