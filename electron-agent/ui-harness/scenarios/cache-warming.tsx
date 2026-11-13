import { useState } from 'react';
import { App } from 'antd';
import { SettingsPanel } from '../../src/features/settings/SettingsPanel';
import { AgentStoreContext } from '../../src/stores/AgentStoreContext';
import type { AgentStoreApi } from '../../src/stores/agent';
import { initialAgentState, type AgentState } from '../../src/stores/agentReducer';
import { exposeActions, installBridge, track } from '../stubs';

let mode = 'idle';
let settings: Record<string, string> = { AUTO_TITLE: '1' };
let remount = () => {};
installBridge({
  subscribe: async () => () => {},
  invoke: async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'request_observation':return args.action==='list'?[]:{availability:'unavailable'};
      case 'get_model_compaction_budgets':return {revision:0,models:[]};
      case 'get_settings': return { ...settings };
      case 'set_settings':
        settings = { ...(args.settings as Record<string, string>) };
        track('settings-save');
        return;
      case 'get_cache_warming': track('warming-read'); return mode;
      case 'set_cache_warming':
        mode = args.mode as string;
        track(`warming:${mode}`);
        return;
      case 'get_provider_config': return { modelsJson: '{}', authJson: '{}', agentDir: '/agent' };
      case 'list_models_global': return [];
      default: throw new Error(`Unexpected command: ${command}`);
    }
  },
});
exposeActions({remount: () => remount(), saved: () => ({ mode, settings }) });
const context = {
  workspace: '/repo',
  store: {
    useStore: (selector: (state: AgentState) => unknown) => selector(initialAgentState()),
    getLoadedSessionPath: () => null,
  } as unknown as AgentStoreApi,
  workspaceReady: true,
  setWorkspaceReady: () => {},
  appBooted: true,
};

export default function CacheWarmingScenario() {
  const [epoch, setEpoch] = useState(0);
  remount = () => setEpoch((n) => n + 1);
  return (
    <App>
      <AgentStoreContext.Provider value={context}>
        <main style={{ height: '100vh', background: 'var(--gren-content-bg)', color: 'var(--gren-text)' }}>
          <SettingsPanel key={epoch} />
        </main>
      </AgentStoreContext.Provider>
    </App>
  );
}
