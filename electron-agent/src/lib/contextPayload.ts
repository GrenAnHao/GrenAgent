import { files } from './files';
import { isImageFile, isProbablyTextFile } from './language';

export interface PiImageAttachment {
  type: 'image';
  mimeType: string;
  data: string;
}

export interface PromptPayload {
  message: string;
  images: PiImageAttachment[];
}

/** pi RPC 模式下的文件附加上下文（与 CLI `<file name="...">` 格式一致）。 */
export async function buildFileContextPrefix(
  workspace: string,
  paths: string[],
): Promise<{ textPrefix: string; images: PiImageAttachment[] }> {
  if (paths.length === 0) return { textPrefix: '', images: [] };

  const parts: string[] = [];
  const images: PiImageAttachment[] = [];

  for (const path of paths) {
    try {
      if (isImageFile(path)) {
        const bin = await files.readBinary(workspace, path);
        images.push({
          type: 'image',
          mimeType: bin.mime_type,
          data: bin.data,
        });
        continue;
      }

      if (!isProbablyTextFile(path)) {
        parts.push(`<file name="${path}">[二进制文件，未作为文本嵌入]</file>`);
        continue;
      }

      const content = await files.read(workspace, path);
      parts.push(`<file name="${path}">\n${content}\n</file>`);
    } catch (e) {
      parts.push(`<file name="${path}">[读取失败: ${e}]</file>`);
    }
  }

  const textPrefix = parts.length > 0 ? `${parts.join('\n')}\n\n` : '';
  return { textPrefix, images };
}

export function mergePromptWithFileContext(filePrefix: string, userText: string): string {
  const trimmed = userText.trim();
  if (!filePrefix.trim()) return trimmed;
  if (!trimmed) return filePrefix.trimEnd();
  return `${filePrefix}${trimmed}`;
}

export async function buildPromptPayload(
  workspace: string,
  paths: string[],
  userText: string,
): Promise<PromptPayload> {
  const { textPrefix, images } = await buildFileContextPrefix(workspace, paths);
  return {
    message: mergePromptWithFileContext(textPrefix, userText),
    images,
  };
}
