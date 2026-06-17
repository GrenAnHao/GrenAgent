import { useCallback, useEffect, useRef, useState } from 'react';
import { Select } from '@lobehub/ui/base-ui';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { pi } from '../../../../lib/pi';
import { defaultThinkingLevelMap, type ThinkingLevel, type ThinkingLevelMap } from '../../../settings/providerConfigAdapter';

// pi 内部全部档位（顺序与 RPC set_thinking_level 接受值一致）。
const CANONICAL_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

interface RpcModel {
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}
interface RpcSessionState {
  thinkingLevel?: string;
  model?: RpcModel | null;
}

// 照搬 pi 对「当前模型」实际支持的档位，避免给出会被运行时钳回 off 的档位：
//  - 非推理模型：只有 off；
//  - 有 thinkingLevelMap（内置模型自带元数据 / 自定义模型勾「推理」时写入）：按它过滤（null = 隐藏）；
//  - 否则按供应商 API 协议回退到该协议的标准档位；再不行回退通用安全集。
function availableLevels(model: RpcModel | null | undefined): ThinkingLevel[] {
  if (!model || model.reasoning === false) return ['off'];
  const map = model.thinkingLevelMap ?? defaultThinkingLevelMap(model.api);
  if (map) return CANONICAL_LEVELS.filter((l) => map[l] !== null);
  return ['off', 'low', 'medium', 'high'];
}

export default function ThinkingAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const [level, setLevel] = useState('off');
  const [model, setModel] = useState<RpcModel | null>(null);
  const [ready, setReady] = useState(false);
  // 单调递增的加载令牌：用户一旦选档就 +1，使在途的 loadLevel 结果失效，
  // 避免「打开时的 getState」晚到后把刚选的值覆盖回旧值。
  const loadSeq = useRef(0);

  const loadLevel = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const state = (await pi.getState(workspace)) as RpcSessionState;
      if (seq !== loadSeq.current) return true;
      if (state?.thinkingLevel) setLevel(state.thinkingLevel);
      setModel(state?.model ?? null);
      setReady(true);
      return true;
    } catch {
      setReady(false);
      return false;
    }
  }, [workspace]);

  useEffect(() => {
    if (!workspaceReady) {
      setReady(false);
      return;
    }
    void loadLevel();
  }, [workspace, workspaceReady, loadLevel]);

  const onChange = (next: string) => {
    loadSeq.current++;
    setLevel(next);
    void pi.setThinkingLevel(workspace, next);
  };

  // 每次打开都重新拉取：切换模型后可用档位随之更新。
  const onOpenChange = (open: boolean) => {
    if (open) void loadLevel();
  };

  const levels = availableLevels(model);
  // 当前档位若不在集合内（罕见，如刚切模型），补一个回显项避免下拉空白。
  const values = levels.includes(level as ThinkingLevel) ? levels : [...levels, level as ThinkingLevel];
  const options = values.map((l) => ({ label: l, value: l }));

  return (
    <Select
      size="small"
      popupMatchSelectWidth={false}
      disabled={!workspaceReady || !ready}
      value={level}
      options={options}
      placeholder="推理"
      style={{ width: 'auto', maxWidth: 120 }}
      onChange={onChange}
      onOpenChange={onOpenChange}
    />
  );
}
