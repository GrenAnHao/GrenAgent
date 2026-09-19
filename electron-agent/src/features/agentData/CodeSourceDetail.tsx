import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Typography } from 'antd';
import { files } from '../../lib/files';
import { isUnder, pathsEquivalent } from '../../lib/pathUtils';
import { openPath } from '../../platform/runtime';
import { codeStyles as styles } from './codeStyles';

export interface CodeSourceDetailProps { workspace: string; file: string; line?: number; visible?: boolean; onClose?: () => void }
interface ReadSource { key: string; content: string; absolute: string; relative: string }

export function CodeSourceDetail({ workspace, file, line, visible = true, onClose }: CodeSourceDetailProps) {
  const key = `${workspace}\0${file}`;
  const [source, setSource] = useState<ReadSource>();
  const [readState, setReadState] = useState<{ key: string; loading: boolean; error?: string }>({ key, loading: false });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [jump, setJump] = useState<{ key: string; indexedLine?: number; line: number; version: number }>();
  const [jumpInput, setJumpInput] = useState('');
  const [actionError, setActionError] = useState<{ key: string; message: string }>();
  const targetElement = useRef<HTMLDivElement>(null);
  const lastScroll = useRef<string | undefined>(undefined);
  const epoch = useRef(0);
  const currentSource = source?.key === key ? source : undefined;
  const state = readState.key === key ? readState : undefined;
  const lines = currentSource ? currentSource.content.split(/\r?\n/) : [];
  const currentJump = jump?.key === key && jump.indexedLine === line ? jump : undefined;
  const requestedLine = currentJump?.line ?? line;
  const hasLine = typeof requestedLine === 'number' && Number.isInteger(requestedLine) && requestedLine > 0;
  const target = hasLine && requestedLine <= lines.length ? requestedLine : undefined;

  useEffect(() => {
    setJump(undefined);
    setJumpInput('');
    setActionError(undefined);
  }, [key, line]);

  useEffect(() => {
    const version = ++epoch.current;
    if (!visible) return;
    setReadState({ key, loading: true });
    const path = sourcePath(workspace, file);
    if (!path) {
      setReadState({ key, loading: false, error: '无法确认该文件位于当前项目内，未打开文件。' });
      return;
    }
    void files.read(workspace, file)
      .then((content) => {
        if (version !== epoch.current) return;
        setSource({ key, content, ...path });
        setReadState({ key, loading: false });
      })
      .catch((cause) => {
        if (version === epoch.current) setReadState({ key, loading: false, error: `源码读取失败：${errorText(cause)}` });
      });
    return () => { epoch.current++; };
  }, [key, workspace, file, visible, refreshVersion]);

  useEffect(() => {
    if (!visible || !target || !currentSource) return;
    const scrollKey = `${key}\0${target}\0${currentJump?.version ?? 0}`;
    if (lastScroll.current === scrollKey) return;
    targetElement.current?.scrollIntoView?.({ block: 'center' });
    lastScroll.current = scrollKey;
  }, [key, target, currentJump?.version, currentSource, visible]);

  function jumpToLine() {
    const next = Number(jumpInput);
    if (!/^\d+$/.test(jumpInput.trim()) || !Number.isInteger(next) || next < 1 || next > lines.length) {
      setActionError({ key, message: `请输入 1 至 ${lines.length} 之间的整数行号。` });
      return;
    }
    setActionError(undefined);
    setJump({ key, indexedLine: line, line: next, version: (jump?.version ?? 0) + 1 });
  }

  const validatedSource = !state?.loading && !state?.error ? currentSource : undefined;
  async function openFile() {
    if (!validatedSource) return;
    try { await openPath(validatedSource.absolute); }
    catch (cause) { setActionError({ key, message: `打开文件失败：${errorText(cause)}` }); }
  }
  async function copyPath() {
    if (!validatedSource) return;
    try { await navigator.clipboard.writeText(validatedSource.relative); }
    catch (cause) { setActionError({ key, message: `复制路径失败：${errorText(cause)}` }); }
  }

  return <section className={styles.card} aria-label="源码预览">
    <div className={styles.heading}><Typography.Title level={5} style={{ margin: 0 }}>{currentSource?.relative ?? file}</Typography.Title>{onClose ? <Button onClick={onClose}>关闭源码</Button> : null}</div>
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>项目根目录：{workspace}</Typography.Text>
    <div className={styles.toolbar}>
      <Button disabled={!visible || state?.loading} onClick={() => setRefreshVersion((value) => value + 1)}>重新读取源码</Button>
      {validatedSource ? <>
        <Button onClick={() => void copyPath()}>复制相对路径</Button>
        <Button onClick={() => void openFile()}>使用系统打开文件</Button>
      </> : null}
    </div>
    <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>行号定位在本预览中完成；系统打开文件不保证定位行号。</Typography.Paragraph>
    {state?.error ? <Alert type="error" showIcon title={`${state.error}${currentSource ? ' 当前显示上次成功读取的内容。' : ''}`} /> : null}
    {actionError?.key === key ? <Alert type="error" showIcon title={actionError.message} /> : null}
    {state?.loading ? <Typography.Text type="secondary" role="status">{currentSource ? '正在重新读取源码…' : '正在读取源码…'}</Typography.Text> : null}
    {!hasLine ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>未提供行号</Typography.Text> : null}
    {hasLine && currentSource && !target ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>索引行号已超出文件范围</Typography.Text> : null}
    {currentSource ? <>
      <div className={styles.toolbar}>
        <Input style={{ flex: '0 1 120px' }} aria-label="行号" inputMode="numeric" value={jumpInput} onChange={(event) => setJumpInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') jumpToLine(); }} />
        <Button onClick={jumpToLine}>跳转到行</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{lines.length} 行 · 只读</Typography.Text>
      </div>
      <pre className={styles.source} aria-label="源码内容">{lines.map((text, index) => <div key={index} data-testid={`code-source-line-${index + 1}`} aria-current={target === index + 1 ? 'location' : undefined} ref={target === index + 1 ? targetElement : undefined}>
        <span data-line-number aria-hidden="true">{index + 1}</span><code>{text || ' '}</code>
      </div>)}</pre>
    </> : null}
  </section>;
}

function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }

function sourcePath(workspace: string, file: string): { absolute: string; relative: string } | undefined {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
  const root = normalize(workspace).replace(/\/+$/, '');
  const requested = normalize(file);
  const isAbsolute = (value: string) => /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/|\/)/i.test(value);
  if (!root || !isAbsolute(root) || !requested || /[\0-\x1f]/.test(requested)) return undefined;
  if (requested.split('/').includes('..') || root.split('/').includes('..')) return undefined;
  if (/^[a-z]:(?!\/)/i.test(requested) || /:/.test(requested.replace(/^[a-z]:/i, ''))) return undefined;
  const absolute = isAbsolute(requested) ? requested : `${root}/${requested.replace(/^(?:\.\/)+/, '')}`;
  if (!isUnder(absolute, root) || pathsEquivalent(absolute, root)) return undefined;
  return { absolute, relative: absolute.slice(root.length + 1) };
}
