const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']);
const BINARY_EXTS = new Set([...IMAGE_EXTS, 'pdf', 'zip', 'exe', 'dll']);

export function isImageFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTS.has(ext);
}

export function isProbablyTextFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return !BINARY_EXTS.has(ext);
}
