import { SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { watchConfig } from "../../extensions/_shared/runtime-config.js";

/** 模式只存在 Pi settings.json；沿用桌面设置热更新通知同步已经打开的会话。 */
export function attachCacheWarmingControl(
  session: Pick<AgentSession, "settingsManager" | "setCacheWarmingMode" | "dispose">,
  cwd: string,
  agentDir: string,
  watch: (cb: () => void) => () => void = watchConfig,
): void {
  const off = watch(() => {
    const settings = SettingsManager.create(cwd, agentDir);
    const errors = settings.drainErrors();
    if (errors.length) throw errors[0].error;
    const mode = settings.getCacheWarmingMode();
    if (mode !== session.settingsManager.getCacheWarmingMode()) session.setCacheWarmingMode(mode);
  });
  const dispose = session.dispose.bind(session);
  session.dispose = () => {
    off();
    dispose();
  };
}
