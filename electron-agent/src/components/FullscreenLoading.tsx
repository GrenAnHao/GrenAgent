import { Flexbox } from '@lobehub/ui';
import { BrandLoading } from '@lobehub/ui/brand';
import { useEffect, useState, type CSSProperties } from 'react';
import { PiBrandLogo } from './PiBrandLogo';

interface FullscreenLoadingProps {
  visible: boolean;
}

/**
 * 全屏首启加载界面：BrandLoading 套用 GrenAgent 字标的描边动画。
 * visible=false 时透明度淡出，过渡结束后从 DOM 卸载（避免遮挡交互）。
 * 背景色对齐 --gren-* 主题变量，与 index.html 的静态占位无缝衔接。
 */
export function FullscreenLoading({ visible }: FullscreenLoadingProps) {
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  if (!mounted) return null;

  return (
    <Flexbox
      align="center"
      data-testid="fullscreen-loading"
      gap={22}
      justify="center"
      onTransitionEnd={() => {
        if (!visible) setMounted(false);
      }}
      style={{
        WebkitAppRegion: 'drag',
        background: 'var(--gren-bg-1, #0b0d12)',
        inset: 0,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        position: 'fixed',
        transition: 'opacity 0.45s ease',
        zIndex: 9999,
      } as CSSProperties}
    >
      {/* 内容设 pointer-events:none，让点击/拖动穿透到带 drag-region 的容器，整屏可拖窗口。 */}
      <div style={{ color: 'var(--gren-acc, #4c8bf5)', pointerEvents: 'none' }}>
        <BrandLoading size={88} text={PiBrandLogo} />
      </div>
      <div
        style={{
          color: 'var(--gren-fg-muted, #9aa1ac)',
          fontSize: 14,
          fontWeight: 500,
          letterSpacing: 5,
          pointerEvents: 'none',
        }}
      >
        GREN<span style={{ color: 'var(--gren-fg, #e6e8ec)' }}>AGENT</span>
      </div>
    </Flexbox>
  );
}
