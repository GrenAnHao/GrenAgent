import type { ImageAttachment } from '../ChatInputContext';

/** 读 File 为图片附件：data 为纯 base64（pi 要求），url 保留 dataURL 供预览。 */
export function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      const data = comma >= 0 ? url.slice(comma + 1) : url;
      resolve({
        type: 'image',
        mimeType: file.type || 'image/png',
        data,
        name: file.name,
        url,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 由后端 read_file_binary 返回的 base64 构造图片附件（拖入工作区内图片时用）。 */
export function binaryToImageAttachment(
  name: string,
  mimeType: string,
  base64: string,
): ImageAttachment {
  return {
    type: 'image',
    mimeType,
    data: base64,
    name,
    url: `data:${mimeType};base64,${base64}`,
  };
}
