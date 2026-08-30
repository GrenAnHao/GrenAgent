import type { FC, SVGProps } from 'react';

interface PiBrandLogoProps extends Omit<SVGProps<SVGSVGElement>, 'size'> {
  size?: number | string;
}

/**
 * GrenAgent 品牌字标（π 几何造型）。
 * 作为 @lobehub/ui BrandLoading 的 text 组件使用：BrandLoading 会把
 * className="lobe-brand-loading" 透传到此 <svg>，全局样式据此对内部 <path>
 * 施加描边(draw)+ 填充(fill)动画，因此这里只需提供闭合 path 即可。
 */
export const PiBrandLogo: FC<PiBrandLogoProps> = ({ size = '1em', style, ...rest }) => (
  <svg
    fill="currentColor"
    fillRule="evenodd"
    height={size}
    style={{ flex: 'none', lineHeight: 1, ...style }}
    viewBox="0 0 240 220"
    xmlns="http://www.w3.org/2000/svg"
    {...rest}
  >
    <title>GrenAgent</title>
    <path d="M40 56 H200 V84 H40 Z M74 84 H102 V190 H74 Z M150 84 H178 V190 H150 Z" />
  </svg>
);
