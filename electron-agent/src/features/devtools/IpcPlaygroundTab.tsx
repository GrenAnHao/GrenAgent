import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Play, Trash2 } from 'lucide-react';
import { invoke } from '../../platform/runtime';
import { devApi } from '../../lib/devRuntime';
import { styles } from './devtoolsStyles';
import { formatClock, formatDuration, oneLine, prettyJson } from './devtoolsFormat';

interface CallRecord {
  id: number;
  command: string;
  args: string;
  ok: boolean;
  ms: number;
  output: string;
  at: number;
}

const HISTORY_LIMIT = 25;

/** 常用命令预设：填好参数模板，省得每次手敲 JSON。 */
const PRESETS: Array<{ label: string; command: string; args: (workspace: string) => string }> = [
  { label: 'agent 状态', command: 'agent_get_state', args: (w) => JSON.stringify({ workspace: w }, null, 2) },
  { label: '会话消息', command: 'agent_get_messages', args: (w) => JSON.stringify({ workspace: w }, null, 2) },
  { label: '会话统计', command: 'agent_get_session_stats', args: (w) => JSON.stringify({ workspace: w }, null, 2) },
  { label: '可用命令', command: 'dev_list_commands', args: () => '{}' },
  { label: '运行时信息', command: 'dev_runtime_info', args: () => '{}' },
  { label: '设置', command: 'get_settings', args: () => '{}' },
  { label: '全量会话', command: 'list_all_sessions', args: () => '{}' },
  { label: '用量报告', command: 'usage_report', args: () => '{}' },
  { label: 'AgentData 状态', command: 'agentData_status', args: () => '{}' },
];

export function IpcPlaygroundTab({ workspace }: { workspace: string }) {
  const [commands, setCommands] = useState<string[]>([]);
  const [command, setCommand] = useState('dev_runtime_info');
  const [argsText, setArgsText] = useState('{}');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; ms: number; output: string } | null>(null);
  const [history, setHistory] = useState<CallRecord[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void devApi
      .commands()
      .then((list) => setCommands(list))
      .catch(() => setCommands([]));
  }, []);

  const suggestions = useMemo(() => {
    const filter = command.trim().toLowerCase();
    if (!filter) return commands.slice(0, 60);
    return commands.filter((name) => name.toLowerCase().includes(filter)).slice(0, 60);
  }, [commands, command]);

  const run = useCallback(async () => {
    let args: Record<string, unknown> = {};
    try {
      const parsed = argsText.trim() ? JSON.parse(argsText) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数必须是 JSON 对象');
      args = parsed as Record<string, unknown>;
    } catch (e) {
      setError(`参数不是合法 JSON 对象：${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    setError(null);
    setRunning(true);
    const started = performance.now();
    let ok = true;
    let output: string;
    try {
      output = prettyJson(await invoke<unknown>(command, args));
    } catch (e) {
      ok = false;
      output = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    const ms = performance.now() - started;

    setResult({ ok, ms, output });
    setRunning(false);
    const record: CallRecord = { id: nextId.current++, command, args: argsText, ok, ms, output, at: Date.now() };
    setHistory((prev) => [record, ...prev].slice(0, HISTORY_LIMIT));
  }, [argsText, command]);

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setCommand(preset.command);
    setArgsText(preset.args(workspace));
  };

  return (
    <div className={styles.scroll} data-testid="dev-ipc-tab">
      <div className={styles.error} role="note" style={{ background: 'transparent', borderStyle: 'dashed', color: 'inherit' }}>
        直接调用主进程 IPC 命令（等同于渲染进程的 invoke）。只读命令随便试，写操作（set_settings / delete_* / agent_prompt 等）会真实生效。
      </div>
      {error ? <div className={styles.error} role="alert">{error}</div> : null}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <h3 className={styles.heading}>命令</h3>
          <span className={styles.hint}>已注册 {commands.length} 个</span>
        </div>
        <input
          className={styles.input}
          style={{ width: '100%' }}
          list="dev-ipc-commands"
          value={command}
          placeholder="例如 agent_get_state"
          onChange={(e) => setCommand(e.target.value)}
          data-testid="dev-ipc-command"
        />
        <datalist id="dev-ipc-commands">
          {suggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <h3 className={styles.heading}>参数（JSON）</h3>
          <span className={styles.hint}>Ctrl / ⌘ + Enter 执行</span>
        </div>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={argsText}
          spellCheck={false}
          onChange={(e) => setArgsText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void run();
            }
          }}
          data-testid="dev-ipc-args"
        />
      </div>

      <div className={styles.toolbar} style={{ padding: 0, flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={() => void run()} disabled={running || !command.trim()}>
          <Play size={13} />
          {running ? '执行中…' : '执行'}
        </button>
        {PRESETS.map((preset) => (
          <button key={preset.command + preset.label} type="button" className={styles.button} onClick={() => applyPreset(preset)}>
            {preset.label}
          </button>
        ))}
      </div>

      {result ? (
        <div className={styles.section} style={{ marginBlockStart: 16 }}>
          <div className={styles.sectionTitle}>
            <h3 className={styles.heading}>结果</h3>
            <span className={styles.hint}>
              <span className={`${styles.tag} ${result.ok ? styles.tagOk : styles.tagError}`} style={{ marginInlineEnd: 8 }}>
                {result.ok ? 'OK' : 'ERROR'}
              </span>
              {formatDuration(result.ms)}
            </span>
          </div>
          <pre className={styles.rowBody} style={{ maxHeight: 420 }} data-testid="dev-ipc-result">{result.output}</pre>
        </div>
      ) : null}

      <div className={styles.section} style={{ marginBlockStart: 16 }}>
        <div className={styles.sectionTitle}>
          <h3 className={styles.heading}>调用历史</h3>
          <span className={styles.hint}>
            {history.length} 条
            {history.length ? (
              <button
                type="button"
                className={styles.iconButton}
                style={{ marginInlineStart: 8, width: 22, height: 22 }}
                aria-label="清空调用历史"
                title="清空调用历史"
                onClick={() => {
                  setHistory([]);
                  setExpanded(null);
                }}
              >
                <Trash2 size={12} />
              </button>
            ) : null}
          </span>
        </div>
        {history.length === 0 ? (
          <div className={styles.state}>还没有调用记录</div>
        ) : (
          <div className={styles.list}>
            {history.map((record) => (
              <div key={record.id} className={styles.row}>
                <div
                  className={`${styles.rowHead} ${styles.clickable}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setExpanded(expanded === record.id ? null : record.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpanded(expanded === record.id ? null : record.id);
                    }
                  }}
                >
                  <span className={styles.rowTime}>{formatClock(record.at)}</span>
                  <span className={`${styles.tag} ${record.ok ? styles.tagOk : styles.tagError}`}>{record.ok ? 'OK' : 'ERR'}</span>
                  <span className={`${styles.rowSummary} ${styles.mono}`}>{record.command}</span>
                  <span className={styles.hint}>{formatDuration(record.ms)}</span>
                  <button
                    type="button"
                    className={styles.iconButton}
                    style={{ width: 22, height: 22 }}
                    aria-label="回填这条调用"
                    title="回填到上方表单"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCommand(record.command);
                      setArgsText(record.args);
                      textareaRef.current?.focus();
                    }}
                  >
                    <ArrowRight size={12} />
                  </button>
                </div>
                {expanded === record.id ? (
                  <>
                    <pre className={styles.rowBody}>参数：{record.args}</pre>
                    <pre className={styles.rowBody}>{record.output}</pre>
                  </>
                ) : (
                  <div className={`${styles.hint} ${styles.mono} ${styles.nowrap}`}>{oneLine(record.output)}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
