import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { applyFastPayload, supportsFastMode } from '../_shared/fast-mode.js';
import { readRequestedPreferences } from '../_shared/session-preferences.js';

export default function fastMode(pi: ExtensionAPI) {
  pi.on('before_provider_request', async (event, ctx) => {
    if (!ctx.model) return;
    // A live catalog refresh can revoke Fast while the session retains its old model snapshot.
    const model = ctx.modelRegistry.find(ctx.model.provider, ctx.model.id);
    if (!model || !supportsFastMode(model)) return;
    // The request belongs to this session, even while another session is foregrounded.
    // Missing legacy values are off; never consult the shared per-model preference file.
    const preferences = readRequestedPreferences(ctx.sessionManager.getEntries());
    if (preferences.fastMode !== true) return;
    return applyFastPayload(event.payload, model.api, true);
  });
}
