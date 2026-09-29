import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

/**
 * 记住上次的原生窗口底色，下次启动建窗口时直接用。窗口出现到首帧画出之间（实测约 0.5s）
 * 露出的就是它；明暗设置存在渲染层 localStorage，主进程只能等渲染层（ThemeBridge）告知。
 */
export class WindowBackgroundStore {
  private readonly path: string;
  private saved: string | undefined;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'window-background.json');
  }

  /** 建窗口前同步读取；没存过或文件无效返回 undefined，由调用方用默认底色。 */
  read(): string | undefined {
    try {
      const color: unknown = JSON.parse(readFileSync(this.path, 'utf8'))?.backgroundColor;
      this.saved = isHexColor(color) ? color : undefined;
    } catch {
      this.saved = undefined;
    }
    return this.saved;
  }

  async save(color: string): Promise<void> {
    if (!isHexColor(color)) throw new Error('backgroundColor must be a hex color');
    // 启动时 ThemeBridge 会连着报几次同一个颜色：先记下再写，后续同色调用直接跳过。
    if (color === this.saved) return;
    this.saved = color;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify({ backgroundColor: color }));
    } catch (error) {
      this.saved = undefined;
      throw error;
    }
  }
}
