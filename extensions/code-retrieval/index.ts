import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { codeGraphIndexHint } from './prompt.js';
import { registerCodeGraphTools } from './tools.js';

export default function codeRetrieval(pi: ExtensionAPI): void {
  registerCodeGraphTools(pi);
  // 只在用户输入开的一轮提示；triggerTurn 的自定义消息（后台任务唤醒、goal 续跑等）沿用上一条提示。
  pi.on?.('before_agent_start', (event, ctx) => event.messageType === 'custom' ? undefined : ({
    message: { customType: 'codegraph', content: codeGraphIndexHint(ctx.cwd), display: false },
  }));
}
