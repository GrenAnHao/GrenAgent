import { App } from 'antd';
import { useEffect } from 'react';
import { onPiUiRequest } from '../../lib/pi';
import { usePlanModeStore } from '../../stores/planModeStore';
import { useGoalStore, type GoalInfo } from '../../stores/goalStore';
import { useMcpStatusStore, type McpServerStatus } from '../../stores/mcpStatusStore';
import { isAgentMode, useModeStore } from '../../stores/modeStore';
import { useUiPromptStore } from '../../stores/uiPromptStore';
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';
import { parseAskUserPayload } from '../../components/QuestionSelector/answers';
import { isApprovalPolicy, useApprovalStore } from '../../stores/approvalStore';
import { useWechatStatusStore, type WechatStatus } from '../../stores/wechatStatusStore';
import { useImMessagesStore, type ImConversation } from '../../stores/imMessagesStore';
import { useVisualStore } from '../../stores/visualStore';

type MessageLevel = 'info' | 'success' | 'warning' | 'error';

/** goal 状态由 sidecar 以 JSON 字符串经 setStatus 推送（condition + paused + react）。 */
function parseGoalStatus(statusText: unknown): GoalInfo | undefined {
  if (typeof statusText !== 'string' || !statusText) return undefined;
  try {
    const parsed = JSON.parse(statusText) as Partial<GoalInfo>;
    if (parsed && typeof parsed.condition === 'string' && parsed.condition) {
      return {
        condition: parsed.condition,
        paused: parsed.paused === true,
        react: Number(parsed.react) || 0,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

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
    let un: undefined | (() => void);
    void onPiUiRequest((e) => {
      const method = e.request.method;
      if (method === 'setStatus') {
        const r = e.request as { statusKey?: unknown; statusText?: unknown };
        const text = typeof r.statusText === 'string' ? r.statusText : undefined;
        if (r.statusKey === 'agent-mode') {
          // 当前模式由 agent-mode 扩展推送（agent/ask/debug/plan），供模式选择器回读高亮。
          if (isAgentMode(r.statusText)) useModeStore.getState().setMode(e.workspace, r.statusText);
        } else if (r.statusKey === 'plan-mode') {
          usePlanModeStore.getState().setStatus(text);
        } else if (r.statusKey === 'goal') {
          useGoalStore.getState().setGoal(parseGoalStatus(r.statusText));
        } else if (r.statusKey === 'mcp') {
          let servers: McpServerStatus[] = [];
          try {
            const parsed = typeof r.statusText === 'string' ? JSON.parse(r.statusText) : [];
            if (Array.isArray(parsed)) servers = parsed as McpServerStatus[];
          } catch {
            servers = [];
          }
          useMcpStatusStore.getState().setServers(servers);
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
          if (isApprovalPolicy(r.statusText)) useApprovalStore.getState().setLevel(e.workspace, r.statusText);
        } else if (r.statusKey === 'visual') {
          try {
            const d = typeof r.statusText === 'string' ? JSON.parse(r.statusText) : null;
            if (d?.action === 'show' && typeof d.html === 'string') {
              useVisualStore.getState().setVisual(d.html, d.mode === 'panel' ? 'panel' : 'inline');
            }
          } catch { /* ignore malformed */ }
        }
        return;
      }
      // notify 是即发提示（命令执行确认 / 扩展告知），用 toast 呈现，否则用户会觉得「没反应」。
      if (method === 'notify') {
        const text = notifyText(e.request as Record<string, unknown>);
        if (text) message[notifyLevel(e.request as Record<string, unknown>)](text);
        return;
      }
      // ask_user 富卡：经 ctx.ui.input 载荷传来，内联渲染到消息流末尾（而非输入框上方）。
      if (method === 'input') {
        const data = parseAskUserPayload((e.request as { title?: unknown }).title);
        if (data) {
          useInlineQuestionStore.getState().setRequest({ workspace: e.workspace, id: e.request.id, data });
          return;
        }
        // visual choice 哨兵：read_visual_choice 阻塞中，标记 pending 并记录 requestId
        try {
          const titleStr = typeof (e.request as { title?: unknown }).title === 'string'
            ? (e.request as { title: string }).title : null;
          const sentinel = titleStr ? JSON.parse(titleStr) : null;
          if (sentinel?.__visualChoice === 1) {
            useVisualStore.getState().setPending(true, e.request.id);
            return;
          }
        } catch { /* not visual */ }
      }
      // 其余交互请求 → 输入框上方内联卡片（PromptRequestCard 渲染并回传），不弹窗。
      if (method === 'confirm' || method === 'select' || method === 'input') {
        useUiPromptStore.getState().setRequest({ workspace: e.workspace, request: e.request });
      }
    }).then((fn) => {
      un = fn;
    });
    return () => un?.();
  }, [message]);

  return null;
}
