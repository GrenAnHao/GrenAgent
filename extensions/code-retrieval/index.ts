import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { codeGraphIndexHint } from './prompt.js';
import { registerCodeGraphTools } from './tools.js';

export default function codeRetrieval(pi: ExtensionAPI): void {
  registerCodeGraphTools(pi);
  pi.on?.('before_agent_start', (_event, ctx) => ({
    message: { customType: 'codegraph', content: codeGraphIndexHint(ctx.cwd), display: false },
  }));
}
