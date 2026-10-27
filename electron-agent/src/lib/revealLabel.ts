/** 「在系统文件管理器里定位」按平台叫法：Windows 资源管理器 / macOS Finder / 其余写「打开所在文件夹」。 */
export function revealInFolderLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (ua.includes('Windows')) return '在文件资源管理器中显示';
  if (ua.includes('Mac') || ua.includes('Macintosh')) return '在 Finder 中显示';
  return '打开所在文件夹';
}
