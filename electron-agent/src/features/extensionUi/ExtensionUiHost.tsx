import { App } from 'antd';
import { useEffect } from 'react';
import { onPiEvent, onPiUiRequest } from '../../lib/pi';
import { usePlanModeStore } from '../../stores/planModeStore';
import { applyGoalStatus } from './goalStatus';
import { useMcpStatusStore, type McpServerStatus } from '../../stores/mcpStatusStore';
import { isAgentMode, useModeStore } from '../../stores/modeStore';
import { useUiPromptStore } from '../../stores/uiPromptStore';
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';
import { parseAskUserPayload } from '../../components/QuestionSelector/answers';
import { isApprovalPolicy, useApprovalStore } from '../../stores/approvalStore';
import { useWechatStatusStore, type WechatStatus } from '../../stores/wechatStatusStore';
import { useImMessagesStore, type ImConversation } from '../../stores/imMessagesStore';
import { settleVisualOnTurnEnd, useVisualStore, type VisualOwner } from '../../stores/visualStore';
import { agentStoreRegistry } from '../../stores/agentStoreRegistry';
import { parseWaitingUiPrompt } from '../../stores/waitingUiPrompt';
import { isGoalReceiptNotify } from './goalReceiptNotify';
import { dismissUiRequest, stashInlineQuestion, stashUiPrompt } from '../../stores/backgroundUiRequests';
import { pathsEquivalent } from '../../lib/pathUtils';
import type { PiUiRequestEnvelope } from '../../lib/pi';

/** 请求来自同项目里不在画面上的会话时返回它的路径；当前会话或无法判断时返回 undefined。 */
export function backgroundSessionPathOf(e: PiUiRequestEnvelope): string | undefined {
  if (!e.sessionPath) return undefined;
  const store = agentStoreRegistry.get(e.workspace);
  if (!store) return undefined;
  const loaded = store.getLoadedSessionPath();
  if (loaded) return pathsEquivalent(loaded, e.sessionPath) ? undefined : e.sessionPath;
  // 画面是还没绑定的草稿：请求只能来自已经停到后台的会话（草稿首发前不会有交互请求）。
  return store.hasLiveActivity() ? undefined : e.sessionPath;
}

/**
 * 视觉设计属于发起它的会话：信封带 sessionPath 就记到那一份，不带（启动早期）当成该工作区画面上的会话，
 * 这和 backgroundSessionPathOf 对「没带 sessionPath」的判断一致。
 */
export function visualOwnerOf(e: PiUiRequestEnvelope): VisualOwner {
  const sessionPath = e.sessionPath ?? agentStoreRegistry.get(e.workspace)?.getLoadedSessionPath() ?? null;
  return { sessionPath: sessionPath || null, workspace: e.workspace };
}

type MessageLevel = 'info' | 'success' | 'warning' | 'error';

/** notify 文本字段名因 sidecar 而异，按优先级取第一个非空字符串。 */
function notifyText(request: Record<string, unknown>): string | undefined {
  for (const key of ['message', 'title', 'text', 'content']) {
    const v = request[key];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/** notify 级别字段名因 sidecar 而异，归一到 antd message 的四个级别，默认 info。 */
function notifyLevel(request: Record<string, unknown>): MessageLevel {
  for (const key of ['level', 'type', 'severity', 'kind']) {
    const v = request[key];
    if (v === 'success' || v === 'warning' || v === 'error' || v === 'info') return v;
  }
  return 'info';
}

/**
 * 分发 Pi 扩展经 `pi://ui-request` 发来的 UI 请求：
 *  - setStatus → 写对应 zustand store（模式 / plan / goal / mcp）
 *  - notify    → toast 提示
 *  - confirm / select / input → 写 uiPromptStore，由 ChatInput 上方的 PromptRequestCard
 *    内联渲染为选项卡片（不再弹 Modal）。用户应答仍经 `extension_ui_response` 回传，
 *    否则 sidecar 端 ctx.ui.* 的 promise 永不 resolve、该回合会挂起。
 *
 * 本组件只做事件分发（无可见 UI），故 return null。
 */
export function ExtensionUiHost() {
  const { message } = App.useApp();

  useEffect(() => {
    let disposed = false;
    const unsubs: Array<() => void> = [];
    const register = (subscription: Promise<() => void>) => {
      void subscription.then((un) => {
        if (disposed) un();
        else unsubs.push(un);
      });
    };

    register(onPiUiRequest((e) => {
      // Goal workers are headless; their UI requests must never surface in the
      // interactive session's prompt cards or modal flow.
      if (e.source === 'goal') return;
      const method = e.request.method;
      // 宿主不再等这条请求（超时、撤回、已答复）：卡片不管在画面上、排队还是后台暂存都收掉。
      if (method === 'dismiss') {
        dismissUiRequest(e.request.id);
        useVisualStore.getState().dismissRequest(e.request.id);
        return;
      }
      if (method === 'setStatus') {
        const r = e.request as { statusKey?: unknown; statusText?: unknown };
        const text = typeof r.statusText === 'string' ? r.statusText : undefined;
        if (r.statusKey === 'agent-mode') {
          // 模式按会话：带 sessionPath 的记到那份会话；没有会话身份的（启动早期）当项目默认。
          if (isAgentMode(r.statusText)) {
            if (e.sessionPath) useModeStore.getState().setSessionMode(e.sessionPath, r.statusText);
            else useModeStore.getState().setMode(e.workspace, r.statusText);
          }
        } else if (r.statusKey === 'agent-mode-default') {
          if (isAgentMode(r.statusText)) useModeStore.getState().setMode(e.workspace, r.statusText);
        } else if (r.statusKey === 'plan-mode') {
          usePlanModeStore.getState().setStatus(text);
        } else if (r.statusKey === 'goal') {
          applyGoalStatus(r.statusText, e.sessionId, e.sessionPath);
        } else if (r.statusKey === 'mcp') {
          let servers: McpServerStatus[] = [];
          try {
            const parsed = typeof r.statusText === 'string' ? JSON.parse(r.statusText) : [];
            if (Array.isArray(parsed)) servers = parsed as McpServerStatus[];
          } catch {
            servers = [];
          }
          const statusStore = useMcpStatusStore.getState();
          if (statusStore.setWorkspaceServers) statusStore.setWorkspaceServers(e.workspace, servers);
          else statusStore.setServers(servers);
        } else if (r.statusKey === 'wechat') {
          try {
            const parsed = typeof r.statusText === 'string' ? (JSON.parse(r.statusText) as WechatStatus) : null;
            if (parsed && typeof parsed.status === 'string') useWechatStatusStore.getState().setWechat(parsed);
          } catch {
            /* ignore malformed status */
          }
        } else if (r.statusKey === 'wechat-messages') {
          try {
            const parsed = typeof r.statusText === 'string' ? JSON.parse(r.statusText) : [];
            if (Array.isArray(parsed)) {
              useImMessagesStore.getState().setConversations(parsed as ImConversation[]);
            }
          } catch {
            /* ignore malformed payload */
          }
        } else if (r.statusKey === 'approval-policy') {
          if (isApprovalPolicy(r.statusText)) {
            if (e.sessionPath) useApprovalStore.getState().setSessionLevel(e.sessionPath, r.statusText);
            else useApprovalStore.getState().setLevel(e.workspace, r.statusText);
          }
        } else if (r.statusKey === 'approval-policy-default') {
          if (isApprovalPolicy(r.statusText)) useApprovalStore.getState().setLevel(e.workspace, r.statusText);
        } else if (r.statusKey === 'ui-prompt') {
          if (backgroundSessionPathOf(e)) return;
          agentStoreRegistry.get(e.workspace)?.useStore.setState({
            waitingUiPrompt: parseWaitingUiPrompt(r.statusText),
          });
        } else if (r.statusKey === 'visual') {
          try {
            const d = typeof r.statusText === 'string' ? JSON.parse(r.statusText) : null;
            if (d?.action === 'show' && typeof d.html === 'string') {
              useVisualStore.getState().setVisual(visualOwnerOf(e), d.html, d.mode === 'panel' ? 'panel' : 'inline');
            }
          } catch { /* ignore malformed */ }
        }
        return;
      }
      // notify 是即发提示（命令执行确认 / 扩展告知），用 toast 呈现，否则用户会觉得「没反应」。
      if (method === 'notify') {
        const text = notifyText(e.request as Record<string, unknown>);
        if (text && !isGoalReceiptNotify(text)) {
          message[notifyLevel(e.request as Record<string, unknown>)](text);
        }
        return;
      }
      // 同项目另一个在跑的会话发来的交互请求先按会话暂存，切到它时再显示。
      const backgroundPath = backgroundSessionPathOf(e);
      // ask_user 富卡：经 ctx.ui.input 载荷传来，内联渲染到消息流末尾（而非输入框上方）。
      if (method === 'input') {
        const data = parseAskUserPayload((e.request as { title?: unknown }).title);
        if (data) {
          const item = {
            workspace: e.workspace,
            id: e.request.id,
            data,
            mode: 'live' as const,
            ...(e.sessionPath ? { sessionPath: e.sessionPath } : {}),
          };
          if (backgroundPath) stashInlineQuestion(backgroundPath, item);
          else useInlineQuestionStore.getState().setRequest(item);
          return;
        }
        // visual choice 哨兵：read_visual_choice 阻塞中，按发起会话标记 pending 并记录 requestId（后台会话也要记，切回去才点得动）
        try {
          const titleStr = typeof (e.request as { title?: unknown }).title === 'string'
            ? (e.request as { title: string }).title : null;
          const sentinel = titleStr ? JSON.parse(titleStr) : null;
          if (sentinel?.__visualChoice === 1) {
            useVisualStore.getState().setPending(visualOwnerOf(e), true, e.request.id);
            return;
          }
        } catch { /* not visual */ }
      }
      // 其余交互请求 → 输入框上方内联卡片（PromptRequestCard 渲染并回传），不弹窗。
      if (method === 'confirm' || method === 'select' || method === 'input') {
        const item = { workspace: e.workspace, request: e.request, ...(e.sessionPath ? { sessionPath: e.sessionPath } : {}) };
        if (backgroundPath) stashUiPrompt(backgroundPath, item);
        else useUiPromptStore.getState().setRequest(item);
      }
    }));
    // 视觉设计确认没有 dismiss（read_visual_choice 超时只是工具自己返回），回合结束时收掉。
    register(onPiEvent(settleVisualOnTurnEnd));
    return () => {
      disposed = true;
      for (const un of unsubs.splice(0)) un();
    };
  }, [message]);

  return null;
}
