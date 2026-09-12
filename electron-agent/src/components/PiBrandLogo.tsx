import type { FC, SVGProps } from 'react';

interface PiBrandLogoProps extends Omit<SVGProps<SVGSVGElement>, 'size'> {
  size?: number | string;
  /** 按路径真实轮廓裁切，去掉 240×220 上下留白。启动页动画必须保持默认 viewBox。 */
  tight?: boolean;
}

export const PiBrandLogo: FC<PiBrandLogoProps> = ({ size = '1em', style, tight = false, ...rest }) => (
  <svg
    fill="currentColor"
    fillRule="evenodd"
    height={size}
    style={{ flex: 'none', lineHeight: 1, ...style }}
    viewBox={tight ? '40 56 160 134' : '0 0 240 220'}
    xmlns="http://www.w3.org/2000/svg"
    {...rest}
  >
    <title>GrenAgent</title>
    <path d="M40 56 H200 V84 H40 Z M74 84 H102 V190 H74 Z M150 84 H178 V190 H150 Z" />
  </svg>
);
