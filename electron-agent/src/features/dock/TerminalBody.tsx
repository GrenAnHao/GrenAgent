import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTheme } from 'antd-style';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { terminal } from '../../lib/terminal';
import { useDockStore, type TerminalPayload } from '../../stores/dockStore';
import { dockTabStyles } from './dockTabStyles';
import type { DockBodyProps } from './TabBodyRenderer';

export function TerminalBody({ tab, active }: DockBodyProps) {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const theme = useTheme();
  const setTerminalStatus = useDockStore((s) => s.setTerminalStatus);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const disposeRef = useRef<{ dispose: () => void } | null>(null);
  const shellIdRef = useRef<string | undefined>((tab.payload as TerminalPayload).shellId);
  const pendingRef = useRef<string[]>([]);

  const xtermTheme = useMemo(
    () => ({
      background: theme.colorBgContainer,
      cursor: theme.colorPrimary,
      foreground: theme.colorText,
      selectionBackground: theme.colorFillSecondary,
    }),
    [theme.colorBgContainer, theme.colorFillSecondary, theme.colorPrimary, theme.colorText],
  );

  const write = useCallback((data: string) => {
    // 原始 PTY 流原样写入：TUI 的光标定位/换行靠转义序列，二次改写字节会错位。
    if (termRef.current) termRef.current.write(data);
    else pendingRef.current.push(data);
  }, []);

  // 把 xterm 当前行列同步给 PTY，否则 TUI 按 PTY 的旧尺寸作画 → 错位花屏。
  const syncPtySize = useCallback(() => {
    const term = termRef.current;
    const sid = shellIdRef.current;
    if (!term || !sid) return;
    void terminal.shellResize(sid, term.rows, term.cols).catch(() => {
      /* resize 失败不致命，忽略 */
    });
  }, []);

  // fit 前确认容器有尺寸：keep-alive 的隐藏 tab 是 display:none（0 尺寸），此时 xterm
  // 渲染器没有 dimensions，直接 fit() 会抛 TypeError（Viewport 读 dimensions）崩掉整页。
  const safeFit = useCallback(() => {
    const host = hostRef.current;
    const fit = fitRef.current;
    if (!host || !fit) return;
    if (host.clientWidth === 0 || host.clientHeight === 0) return;
    try {
      fit.fit();
      syncPtySize();
    } catch {
      /* 尺寸异常时 xterm 偶发抛错，吞掉避免整页崩 */
    }
  }, [syncPtySize]);

  // 创建 xterm（仅一次），卸载时销毁。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || termRef.current) return;
    const term = new XTerm({
      allowTransparency: false,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      cursorStyle: 'block',
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      theme: xtermTheme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    safeFit();
    const d = term.onData((data) => {
      const sid = shellIdRef.current;
      if (!sid) return;
      void terminal.shellWrite(sid, data).catch((err) => write(`\r\n[write error] ${String(err)}\r\n`));
    });
    disposeRef.current = d;
    if (pendingRef.current.length) {
      pendingRef.current.forEach((c) => term.write(c));
      pendingRef.current = [];
    }
    return () => {
      d.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      disposeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 懒启动 shell：workspace 就绪且当前 tab 仍是 idle。
  useEffect(() => {
    if (!workspaceReady) return;
    if ((tab.payload as TerminalPayload).status !== 'idle') return;
    let cancelled = false;
    setTerminalStatus(tab.id, 'starting');
    void terminal
      .shellStart(workspace)
      .then(({ session_id }) => {
        if (cancelled) {
          void terminal.shellStop(session_id);
          return;
        }
        shellIdRef.current = session_id;
        setTerminalStatus(tab.id, 'running', session_id);
        // PTY 以默认 24x100 开启，会话就绪后立即纠正为 xterm 实际行列。
        syncPtySize();
      })
      .catch((err) => {
        write(`\r\n[shell error] ${String(err)}\r\n`);
        setTerminalStatus(tab.id, 'error');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceReady, workspace, tab.id]);

  // 监听本 shell 的输出/退出。
  useEffect(() => {
    // listen() 是异步的：cleanup 可能早于 promise resolve 执行（StrictMode 双挂载 / 快速卸载）。
    // 用 disposed 标志确保 resolve 时若已清理则立刻注销，避免泄漏出永不注销的重复监听器
    // （重复监听会把每个输出字节写入 xterm 两次：终端重复、打字回显翻倍、TUI 错位）。
    let un: (() => void) | undefined;
    let disposed = false;
    void terminal
      .onShellOutput((event) => {
        if (!event.session_id || event.session_id !== shellIdRef.current) return;
        if (event.type === 'output' && event.data) write(event.data);
        if (event.type === 'exit') {
          write(`\r\n[shell exited ${event.exit_code ?? 0}]\r\n`);
          shellIdRef.current = undefined;
          setTerminalStatus(tab.id, 'exited');
        }
      })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        un = fn;
      });
    return () => {
      disposed = true;
      un?.();
    };
  }, [tab.id, setTerminalStatus, write]);

  // 卸载（tab 关闭）时停止 shell。
  useEffect(() => {
    return () => {
      const sid = shellIdRef.current;
      if (sid) void terminal.shellStop(sid);
    };
  }, []);

  // 主题变化时刷新。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme;
    term.refresh(0, term.rows - 1);
  }, [xtermTheme]);

  // 激活时 refit + focus。
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      safeFit();
      termRef.current?.focus();
    });
  }, [active, safeFit]);

  // 容器尺寸变化时 refit（仅激活态）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      if (active) safeFit();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [active, safeFit]);

  return <div ref={hostRef} className={dockTabStyles.terminalHost} />;
}
