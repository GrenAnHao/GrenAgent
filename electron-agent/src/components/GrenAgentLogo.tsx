import type { SVGProps } from 'react';
import iconSource from '../../brand/source/grenagent-icon.svg?raw';
import logoSource from '../../brand/source/grenagent-logo.svg?raw';

// Only the committed, reviewed SVG artwork enters this markup; paths and transforms stay in the source files.
const artwork = (source: string) => source.slice(source.indexOf('>') + 1, source.lastIndexOf('</svg>'));
const iconArtwork = artwork(iconSource);
const logoArtwork = artwork(logoSource);

interface GrenAgentIconProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
  /** Compatibility with previous callers; the approved G keeps its square source canvas. */
  tight?: boolean;
}

export function GrenAgentIcon({ size = '1em', tight: _tight, style, ...rest }: GrenAgentIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 352 352"
      width={size}
      height={size}
      fill="currentColor"
      role="img"
      aria-label="GrenAgent"
      style={{ flex: 'none', lineHeight: 1, color: 'var(--gren-fg, currentColor)', ...style }}
      {...rest}
      dangerouslySetInnerHTML={{ __html: iconArtwork }}
    />
  );
}

/** Full approved lockup, including the outlined wordmark; no installed font is required. */
export function GrenAgentLogo({ width = 136, style, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1514 378"
      width={width}
      fill="currentColor"
      role="img"
      aria-label="GrenAgent"
      style={{ display: 'block', flex: 'none', height: 'auto', color: 'var(--gren-fg, currentColor)', ...style }}
      {...rest}
      dangerouslySetInnerHTML={{ __html: logoArtwork }}
    />
  );
}
