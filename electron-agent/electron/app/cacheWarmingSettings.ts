import { SettingsManager } from '../../../cli/src/pi-sdk.js';

/** 使用 Pi 自己的全局设置，读取不落盘，显式修改才写。 */
export class CacheWarmingSettingsService {
  constructor(
    private readonly cwd: string,
    private readonly agentDir: string,
    private readonly changed: () => Promise<void>,
  ) {}

  private settings(): SettingsManager {
    const settings = SettingsManager.create(this.cwd, this.agentDir);
    this.checkErrors(settings);
    return settings;
  }

  private checkErrors(settings: SettingsManager): void {
    const errors = settings.drainErrors();
    if (errors.length) throw errors[0].error;
  }

  get(): string {
    return this.settings().getCacheWarmingMode();
  }

  async set(mode: unknown): Promise<void> {
    if (mode !== 'off' && mode !== 'streaming' && mode !== 'idle') throw new Error('无效的缓存预热模式');
    const settings = this.settings();
    settings.setCacheWarmingMode(mode);
    await settings.flush();
    this.checkErrors(settings);
    await this.changed();
  }
}
