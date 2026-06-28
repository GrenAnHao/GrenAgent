import { useRef, type CSSProperties } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { Icon } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { AlertTriangle, Loader2, RefreshCw, X } from 'lucide-react';
import { App } from 'antd';
import { ChatListView } from './ChatListView';
import { ChatListSkeleton } from './ChatListSkeleton';
import { ChatInput } from './ChatInput';
import { EmptyChatPrompt } from './EmptyChatPrompt';
import type { PromptImage } from './input/ChatInputContext';
import { isExecutiveCommandMessage } from './input/commandClassification';
import { pi } from '../../lib/pi';
import { isUnder, pathsEquivalent } from '../../lib/pathUtils';
import { syncSidebarOnSend } from '../../lib/sidebarSessionSync';
import { markScratchUsed } from '../../lib/startupConversation';
import { createStartupPerf } from '../../lib/startupPerf';
import { useSessionStore } from '../../store/session';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { commandLanes } from '../../lib/commandLanes';
import { awaitStreamingEnd } from '../../lib/streamingGate';

const SLIDE_EASE = [0.22, 1, 0.36, 1] as const;
const SLIDE_DURATION = 0.68;

const composeTransition = {
  layout: { duration: SLIDE_DURATION, ease: SLIDE_EASE },
};

// layoutId 按 workspace 区分：同一对话内「空 → 发出首条」共享 id 才做居中→贴底的滑动形变；
// 切换到别的对话时 id 不同、不再跨对话形变（否则会把 A 的居中框硬morph到 B 的贴底框，
// 而 B 的消息/骨架异步加载会打断形变，表现为「卡一下再瞬间到底」）。
const composeShellLayoutId = (workspace: string) => `chat-compose-shell-${workspace}`;

// 输入区「黄金宽度」：空对话居中，宽度取内容区的黄金比例 1/φ≈0.618，但不窄于 600px（窄窗也保持舒展
// 不再缩成细条）、不宽于 1080px（防超宽屏拉太长）；当窗口收窄到连 600px 都放不下时退为 100% 贴边铺满，
// 而不是压缩输入框。发出首条后随 layoutId 形变非线性展开铺满并滑到底部。
const EMPTY_COMPOSE_WIDTH = 'min(100%, 1080px, max(600px, 61.8%))';

const errorBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  margin: '0 16px 8px',
  padding: '8px 12px',
  borderRadius: 8,
  fontSize: 12,
  lineHeight: 1.5,
  color: cssVar.colorError,
  background: cssVar.colorErrorBg,
  border: `1px solid ${cssVar.colorErrorBorder}`,
};
const errorTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  wordBreak: 'break-word',
  whiteSpace: 'pre-wrap',
};
const errorCloseStyle: CSSProperties = {
  display: 'inline-flex',
  flex: '0 0 auto',
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
};
const retryBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  margin: '0 16px 8px',
  padding: '8px 12px',
  borderRadius: 8,
  fontSize: 12,
  lineHeight: 1.5,
  color: cssVar.colorWarning,
  background: cssVar.colorWarningBg,
  border: `1px solid ${cssVar.colorWarningBorder}`,
};

/** 发送失败时的自动重试次数（不含首次发送）。 */
const MAX_SEND_RETRIES = 5;
const EMPTY_TURN_MSG =
  '本轮没有返回任何内容：模型/供应商可能返回为空或出错。请检查该供应商的 Base URL、模型 ID 与 API Key；也可在启动 app 的终端查看 [pi stderr] 日志。';
/** 重试退避：第 n 次重试前等待，线性增长并封顶 4s。 */
const retryDelayMs = (attempt: number) => Math.min(800 * attempt, 4000);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function ChatView() {
  const { workspace, store, workspaceReady } = useAgentStoreContext();
  const { message: messageApi } = App.useApp();
  const worksDir = useSessionStore((s) => s.worksDir);
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const draftConversationCwd = useSessionStore((s) => s.draftConversationCwd);
  const messages = store.useStore((s) => s.messages);
  const lastError = store.useStore((s) => s.lastError);
  const retrying = store.useStore((s) => s.retrying);
  const compacting = store.useStore((s) => s.compacting);
  const isEmpty = messages.length === 0;
  const isConversation = Boolean(worksDir && isUnder(workspace, worksDir));
  const isDraftConversation = Boolean(draftConversationCwd && pathsEquivalent(draftConversationCwd, workspace));
  const showEmptyLayout = isEmpty && workspaceReady;
  // 用户是否点了「停止」：abort 可能以抛错 / lastError / 空轮等多种形式体现，统一靠这个标记判定。
  const userAbortedRef = useRef(false);

  const handleSend = async (
    message: string,
    images?: PromptImage[],
    behavior?: 'steer' | 'followUp',
  ) => {
    const text = message.trim();
    if (!text && !images?.length) return;
    // 新一轮发送：清掉上一轮可能遗留的「用户中断」标记。
    userAbortedRef.current = false;

    // 执行性命令（/dream 等）：不产生对话轮次。跳过乐观气泡与 awaitingResponse，
    // 改瞬态 toast，仍 pi.prompt 让 Pi 执行——切换/重载后不再有幽灵气泡。
    if (text && isExecutiveCommandMessage(text)) {
      const cmd = text.split(/\s/, 1)[0];
      try {
        await pi.prompt(workspace, text, undefined, images);
        messageApi.info(`已执行 ${cmd}`);
      } catch (e) {
        messageApi.error(`${cmd} 执行失败：${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    // 执行中发送：引导（steer）当前回合或排队（followUp）下一轮。乐观插入用户消息
    // （live 事件流不回显 user 消息），交给 pi 把消息注入正在跑的回合；不跑「无返回」兜底检查。
    if (behavior) {
      store.useStore.setState({ lastError: undefined, retrying: undefined });
      // steering=true：标记为引导消息，避免误触发「准备响应中」占位（AI 已在响应中）。
      store.pushUserMessage(text, images, behavior === 'steer');
      for (let attempt = 0; attempt <= MAX_SEND_RETRIES; attempt++) {
        try {
          await pi.prompt(workspace, text, behavior, images);
          store.useStore.setState({ retrying: undefined });
          return;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // 用户主动中断（abort）不算错误，不弹错误条。
          if (userAbortedRef.current || /abort/i.test(msg)) {
            store.useStore.setState({ retrying: undefined, aborting: false });
            return;
          }
          if (attempt === MAX_SEND_RETRIES) {
            store.useStore.setState({
              lastError: `已重试 ${MAX_SEND_RETRIES} 次仍失败：${msg}`,
              retrying: undefined,
            });
            return;
          }
          store.useStore.setState({
            retrying: { attempt: attempt + 1, max: MAX_SEND_RETRIES },
            lastError: undefined,
          });
          await sleep(retryDelayMs(attempt + 1));
        }
      }
      return;
    }

    store.useStore.setState({ lastError: undefined, retrying: undefined });
    if (text || images?.length) store.pushUserMessage(text, images);
    // 发送即置「准备响应中」：桥接到后端首个 agent_start 之间的冷启动/会话预备窗口，消除无反馈空档。
    store.useStore.setState({ awaitingResponse: true });
    // 发送路径性能埋点：拆出 openWorkspace / newSession / getState / promptToStream 各耗时
    //（DEV 控制台 [PERF-startup] send:<ws>），用于定位「新对话/久置后发送」的延迟究竟卡在哪。
    const sendPerf = createStartupPerf(`send:${workspace}`);

    const ensureSessionForSend = async () => {
      if (!isDraftConversation && activeSessionPath) return;
      if (!isConversation) return;
      const st = useSessionStore.getState();
      sendPerf.start('openWorkspace');
      const openResult = await pi.openWorkspace(workspace);
      sendPerf.end('openWorkspace');
      if (!openResult.sessionFile) {
        sendPerf.start('newSession');
        await pi.newSession(workspace);
        sendPerf.end('newSession');
      }
      sendPerf.start('getState');
      const state = (await pi.getState(workspace)) as { sessionFile?: string };
      sendPerf.end('getState');
      const path = state.sessionFile ?? openResult.sessionFile;
      if (path) {
        st.setActiveSession(path);
        st.setWorkspaceSessionPath(workspace, path);
        st.upsertOptimisticSession({
          id: `opt-${path}`,
          path,
          cwd: workspace,
          timestamp: new Date().toISOString(),
          name: text || null,
        });
      }
      st.clearDraftConversation(workspace);
      // 该空白对话已被使用（已落盘会话）→ 清除复用记忆，下次「新建对话」改为新建而非复用它。
      markScratchUsed(workspace);
    };

    try {
      sendPerf.start('ensureSession');
      await ensureSessionForSend();
      sendPerf.end('ensureSession');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      store.useStore.setState({ lastError: msg, isStreaming: false, awaitingResponse: false });
      sendPerf.report();
      return;
    }
    if (text) void syncSidebarOnSend(workspace, text);

    // 发送一轮：成功返回 ok；失败带错误信息（区分用户主动 abort，不计入重试）。
    // 失败判定含三类：pi.prompt 抛错、本轮产生错误事件(lastError)、本轮无任何助手/工具输出。
    // retryable 只在没有进入实际 turn 时为 true；一旦后端开始处理，就避免前端重发造成历史重复。
    const runOnce = async (): Promise<
      { ok: true } | { ok: false; error: string; aborted?: boolean; retryable: boolean }
    > => {
      const beforeCount = store.useStore.getState().messages.length;
      let turnStarted = store.useStore.getState().isStreaming;
      let streamTimed = turnStarted;
      sendPerf.start('promptToStream');
      const unsub = store.useStore.subscribe((s) => {
        if (s.isStreaming) {
          turnStarted = true;
          if (!streamTimed) {
            streamTimed = true;
            sendPerf.end('promptToStream');
          }
        }
      });
      try {
        store.useStore.setState({ lastError: undefined });
        await commandLanes.run(workspace, async () => {
          await pi.prompt(workspace, text, undefined, images);
          await awaitStreamingEnd(
            store.useStore,
            /^\//.test(text.trim()) ? { startTimeoutMs: 2000 } : undefined,
          );
        });
        const cur = store.useStore.getState();
        const retryable = !turnStarted && cur.messages.length === beforeCount;
        // 用户点了停止：无论中断以何种形式体现（lastError / 空轮 / 静默停流），都按中断收手，
        // 不报错、不重试；abort 也可能经事件流写入 lastError（而非 pi.prompt 抛出），一并识别。
        if (userAbortedRef.current || (cur.lastError && /abort/i.test(cur.lastError))) {
          return { ok: false, error: cur.lastError ?? 'aborted', aborted: true, retryable: false };
        }
        if (cur.lastError) return { ok: false, error: cur.lastError, retryable };
        const last = cur.messages[cur.messages.length - 1];
        // 「空轮」仅当一轮确实跑过却无任何输出（agent_start 已把 awaitingResponse 清掉）。
        // 若 awaitingResponse 仍为 true，说明首响应（agent_start）尚未到达——这是慢启动而非空轮，
        // 不可误判失败：否则会闪出「发送失败，正在重试」红条并重发 prompt（潜在重复轮次）。
        if (!text.startsWith('/') && !cur.isStreaming && !cur.awaitingResponse && last?.kind === 'user') {
          return { ok: false, error: EMPTY_TURN_MSG, retryable };
        }
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const cur = store.useStore.getState();
        const retryable = !turnStarted && cur.messages.length === beforeCount;
        if (userAbortedRef.current || /abort/i.test(msg)) {
          return { ok: false, error: msg, aborted: true, retryable: false };
        }
        return { ok: false, error: msg, retryable };
      } finally {
        unsub();
      }
    };

    // 出现异常不直接报错：自动重试最多 5 次，期间在会话中显示「正在重试」。
    let result = await runOnce();
    let retriesDone = 0;
    for (
      let attempt = 1;
      !result.ok && !result.aborted && result.retryable && attempt <= MAX_SEND_RETRIES;
      attempt++
    ) {
      store.useStore.setState({
        retrying: { attempt, max: MAX_SEND_RETRIES },
        isStreaming: false,
        lastError: undefined,
      });
      await sleep(retryDelayMs(attempt));
      result = await runOnce();
      retriesDone = attempt;
    }
    store.useStore.setState({ retrying: undefined, awaitingResponse: false });
    sendPerf.report();

    if (!result.ok && result.aborted) {
      // 中断不是错误：清掉流式态、事件流可能写入的中断错误与中断标记，避免残留红色错误条。
      store.useStore.setState({ isStreaming: false, lastError: undefined, aborting: false, awaitingResponse: false });
    } else if (!result.ok) {
      // 仅在确实重试过时才提示「已重试 N 次」；turn 已开始即失败（未重试）直接显示错误，避免误导。
      const prefix = retriesDone > 0 ? `已重试 ${retriesDone} 次仍失败：` : '';
      store.useStore.setState({
        lastError: `${prefix}${result.error}`,
        isStreaming: false,
        awaitingResponse: false,
      });
    }
  };

  const dismissError = () => store.useStore.setState({ lastError: undefined });

  const errorBanner = lastError ? (
    <div style={errorBannerStyle}>
      <Icon icon={AlertTriangle} size={14} />
      <span style={errorTextStyle}>{lastError}</span>
      <button type="button" aria-label="关闭" onClick={dismissError} style={errorCloseStyle}>
        <Icon icon={X} size={14} />
      </button>
    </div>
  ) : null;

  const retryIndicator = retrying ? (
    <div style={retryBannerStyle} data-testid="send-retry-indicator">
      <Icon icon={RefreshCw} spin size={14} />
      <span style={{ flex: 1, minWidth: 0 }}>
        发送失败，正在重试（{retrying.attempt}/{retrying.max}）…
      </span>
    </div>
  ) : null;

  const compactingIndicator = compacting ? (
    <div style={retryBannerStyle} data-testid="compaction-indicator">
      <Icon icon={Loader2} spin size={14} />
      <span style={{ flex: 1, minWidth: 0 }}>正在压缩上下文…</span>
    </div>
  ) : null;

  const handleAbort = async () => {
    // 标记用户主动中断：runOnce 据此把本轮判为中断（不报错、不重试），无论中断如何体现。
    userAbortedRef.current = true;
    // 置 aborting：reducer 据此丢弃 abort 触发的 "request aborted" 类报错，避免红条闪一下。
    store.useStore.setState({ aborting: true });
    await pi.abort(workspace);
  };

  return (
    <LayoutGroup id="chat-compose">
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        {showEmptyLayout ? (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'stretch',
            }}
          >
            <motion.div
              layout
              layoutId={composeShellLayoutId(workspace)}
              transition={composeTransition}
              style={{
                width: EMPTY_COMPOSE_WIDTH,
                marginInline: 'auto',
              }}
              data-testid="chat-input-region"
            >
              <AnimatePresence>
                <motion.div
                  key="empty-prompt"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -16 }}
                  transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
                >
                  <EmptyChatPrompt workspace={workspace} isConversation={isConversation} />
                </motion.div>
              </AnimatePresence>
              {retryIndicator}
              {compactingIndicator}
              {errorBanner}
              <ChatInput onSend={handleSend} onAbort={handleAbort} />
            </motion.div>
          </div>
        ) : (
          <>
            <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
              {workspaceReady ? <ChatListView /> : <ChatListSkeleton />}
            </div>
            {/* 重试 / 错误条放在 layout 形变容器「外面」：放进去时它一出现就撑高容器，触发 layoutId
                形变动画把输入框弹动一下。作为兄弟节点插在输入框上方，高度变化由上方 flex:1 的消息区吸收，
                输入框位置不动、不再弹动。 */}
            {retryIndicator}
            {compactingIndicator}
            {errorBanner}
            <motion.div
              layout
              layoutId={composeShellLayoutId(workspace)}
              transition={composeTransition}
              style={{ flex: 'none', width: '100%' }}
              data-testid="chat-input-region"
            >
              <ChatInput onSend={handleSend} onAbort={handleAbort} />
            </motion.div>
          </>
        )}
      </div>
    </LayoutGroup>
  );
}
