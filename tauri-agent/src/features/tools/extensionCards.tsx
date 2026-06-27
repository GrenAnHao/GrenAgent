import { ActionIcon, Flexbox, Icon, Image, ScrollArea, Skeleton } from '@lobehub/ui';
import { createStaticStyles, cssVar, keyframes } from 'antd-style';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  BookPlus,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Network,
  Pause,
  Play,
  Search,
  Volume2,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';
import { LazyMarkdown } from '../chat/LazyMarkdown';
import { useDockStore } from '../../stores/dockStore';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { files } from '../../lib/files';
import { extractText, getArgString, getDetails } from './toolUtils';

export interface ExtensionCardProps {
  toolName: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** 朗读文本 → 一句话标题（取首句/前 N 字），让语音卡片显示语义标题而非 speech_<时间戳>.wav。 */
function deriveAudioTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const sentence = (t.match(/^[^。！？.!?\n]*[。！？.!?]?/)?.[0] ?? t).trim() || t;
  const chars = [...sentence];
  return chars.length > 28 ? `${chars.slice(0, 28).join('')}…` : sentence;
}

const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--gren-fg-muted, #9aa1ac)' };

// 在系统文件管理器中定位该文件。用 revealItemInDir 而非 openPath：reveal 在 opener:default
// 权限内（无需改 capabilities / 重建 Tauri），openPath 则需额外 allow-open-path 并重建。
function RevealFileButton({ path, toolName, title }: { path: string; toolName: string; title: string }) {
  if (!path) return null;
  return (
    <ActionIcon
      data-testid={`reveal-file-${toolName}`}
      icon={FolderOpen}
      size="small"
      title={title}
      onClick={() => {
        revealItemInDir(path).catch(() => {});
      }}
    />
  );
}

/** 文件扩展名 → 音频 MIME。后端 read_file_binary 已识别常见音频类型，这里再按后缀兜一层（防御未知扩展/旧缓存）。 */
function audioMime(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'ogg' || ext === 'opus') return 'audio/ogg';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'aac' || ext === 'm4a') return 'audio/mp4';
  if (ext === 'webm') return 'audio/webm';
  return 'audio/wav';
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const playerStyles = createStaticStyles(({ css }) => ({
  player: css`
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  `,
  playBtn: css`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: 999px;
    /* 用中性填充层 + 正文色图标，保证任意主题（含浅色 primary）下都清晰、与卡片底色分层。 */
    background: ${cssVar.colorFill};
    color: ${cssVar.colorText};
    cursor: pointer;
    transition:
      background 0.15s,
      color 0.15s;

    &:hover {
      color: ${cssVar.colorPrimary};
    }
  `,
  track: css`
    position: relative;
    flex: 1;
    min-width: 0;
    height: 4px;
    border-radius: 999px;
    /* 比卡片底色更明显的轨道，避免暗色下与背景糊在一起。 */
    background: ${cssVar.colorFillSecondary};
    cursor: pointer;
  `,
  fill: css`
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    border-radius: 999px;
    background: ${cssVar.colorPrimary};
  `,
  time: css`
    flex: none;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorTextTertiary};
  `,
}));

function fmtTime(s: number): string {
  const v = Number.isFinite(s) && s > 0 ? s : 0;
  const m = Math.floor(v / 60);
  const sec = Math.floor(v % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/**
 * 自定义内联音频播放器：经 read_file_binary 把本地音频读成 base64 → Blob URL，喂给隐藏的 <audio>，
 * UI 自绘「播放/暂停 + 细进度条 + 时间」，去掉原生控件那条又宽又丑的工具条与 ⋮ 菜单。
 * 未开 asset 协议，故不能直接用文件路径；Blob URL 比 data URL 省内存且卸载时回收。
 */
const AudioPlayer: FC<{ workspace: string; path: string }> = ({ workspace, path }) => {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setSrc(null);
    setFailed(false);
    void files
      .readBinary(workspace, path)
      .then((bin) => {
        if (!alive) return;
        url = URL.createObjectURL(new Blob([base64ToBytes(bin.data)], { type: audioMime(path) }));
        setSrc(url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [workspace, path]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };

  const seek = (e: MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    a.currentTime = ratio * duration;
    setCurrent(a.currentTime);
  };

  if (failed) return <span style={labelStyle}>音频加载失败</span>;
  if (!src) return <Skeleton.Block active style={{ borderRadius: 999, height: 28, width: '100%' }} />;

  const pct = duration ? (current / duration) * 100 : 0;
  return (
    <div className={playerStyles.player}>
      <button
        type="button"
        className={playerStyles.playBtn}
        title={playing ? '暂停' : '播放'}
        onClick={toggle}
      >
        <Icon icon={playing ? Pause : Play} size={14} />
      </button>
      <div className={playerStyles.track} onClick={seek}>
        <div className={playerStyles.fill} style={{ width: `${pct}%` }} />
      </div>
      <span className={playerStyles.time}>
        {fmtTime(current)} / {fmtTime(duration)}
      </span>
      <audio
        ref={audioRef}
        preload="metadata"
        src={src}
        style={{ display: 'none' }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setFailed(true)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />
    </div>
  );
};

const shimmer = keyframes`
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
`;

const genImageStyles = createStaticStyles(({ css }) => ({
  // 卡片宽度贴合图片：fit-content 收缩到内容（图片）宽；头部用 width:0 + min-width:100% 填满卡片宽度
  // 但不撑大它，于是整卡宽度由图片决定（竖图也不再留大片空白）。
  card: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: fit-content;
    max-width: 100%;
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
  `,
  head: css`
    display: flex;
    align-items: center;
    gap: 8px;
    width: 0;
    min-width: 100%;
  `,
  title: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  meta: css`
    flex: none;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
    color: ${cssVar.colorTextSecondary};
    background: ${cssVar.colorFillTertiary};
  `,
  actions: css`
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
  `,
  grid: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  `,
  // 图片悬停：外框轻微阴影 + 内图轻微放大（外框 overflow:hidden 裁切，放大有「呼吸」质感）。
  imgWrap: css`
    overflow: hidden;
    border-radius: 8px;
    transition: box-shadow 0.2s ease;

    &:hover {
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
    }
  `,
  imgZoom: css`
    transition: transform 0.25s ease;

    &:hover {
      transform: scale(1.04);
    }
  `,
  loadingFrame: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    background: linear-gradient(
      100deg,
      ${cssVar.colorFillSecondary} 30%,
      ${cssVar.colorFillTertiary} 50%,
      ${cssVar.colorFillSecondary} 70%
    );
    background-size: 200% 100%;
    animation: ${shimmer} 1.4s ease-in-out infinite;
  `,
  skeleton: css`
    border-radius: 8px;
    background: linear-gradient(
      100deg,
      ${cssVar.colorFillSecondary} 30%,
      ${cssVar.colorFillTertiary} 50%,
      ${cssVar.colorFillSecondary} 70%
    );
    background-size: 200% 100%;
    animation: ${shimmer} 1.4s ease-in-out infinite;
  `,
  failed: css`
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    background: ${cssVar.colorFillQuaternary};
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

// size「1024x1024」→ 宽高比（缺省 1:1）。
function ratioOf(size: string): number {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(size.trim());
  if (!m) return 1;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : 1;
}

// 按宽高比把图片装进 maxW×maxH 盒子，返回实际像素尺寸：骨架/加载帧/最终图同尺寸，卡片据此贴合、无抖动。
function frameSize(ratio: number, maxW: number, maxH: number): { width: number; height: number } {
  let width = maxW;
  let height = width / ratio;
  if (height > maxH) {
    height = maxH;
    width = height * ratio;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

// 读磁盘图片成 Blob 触发浏览器下载（WebView2 走默认下载目录），无需额外 Tauri 命令。
async function downloadImage(workspace: string, path: string): Promise<void> {
  try {
    const bin = await files.readBinary(workspace, path);
    const url = URL.createObjectURL(new Blob([base64ToBytes(bin.data)], { type: bin.mime_type || 'image/png' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = basename(path);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* 下载失败静默：用户仍可用「文件夹中显示」拿到原图 */
  }
}

/**
 * 生成图片缩略图：read_file_binary 读成 Blob URL 喂给带预览的 @lobehub <Image>（点击放大/缩放，
 * 多图在 PreviewGroup 内可左右切换）。未开 asset 协议故不能直接用文件路径；Blob 比 data URL 省内存。
 * 刚生成的文件可能尚未写完（读到空/半截 → 图裂），故读失败 / 图 onError 时短退避重试几次再判失败。
 */
const ImageThumb: FC<{ workspace: string; path: string; w: number; h: number }> = ({ workspace, path, w, h }) => {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const triesRef = useRef(0);

  useEffect(() => {
    triesRef.current = 0;
    setFailed(false);
  }, [workspace, path]);

  const bumpRetry = useCallback(() => {
    setSrc(null);
    if (triesRef.current >= 3) {
      setFailed(true);
      return;
    }
    triesRef.current += 1;
    setTimeout(() => setReloadKey((k) => k + 1), 500);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    void files
      .readBinary(workspace, path)
      .then((bin) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([base64ToBytes(bin.data)], { type: bin.mime_type || 'image/png' }));
        setSrc(url);
      })
      .catch(() => {
        if (!cancelled) bumpRetry();
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [workspace, path, reloadKey, bumpRetry]);

  if (failed) {
    return (
      <div className={genImageStyles.failed} style={{ width: w, height: h }}>
        图片加载失败
      </div>
    );
  }
  if (!src) {
    return <div className={genImageStyles.skeleton} style={{ width: w, height: h }} />;
  }
  return (
    // 包一层 draggable，让带预览遮罩的 antd Image 也能被拖起（遮罩与 img 是兄弟节点，
    // 没有 draggable 祖先时拖拽根本起不来）；拖到输入框即作为图片附件插入。
    <div draggable style={{ display: 'inline-flex', cursor: 'grab' }}>
      <Image
        alt={basename(path)}
        src={src}
        maxWidth={w}
        maxHeight={h}
        classNames={{ wrapper: genImageStyles.imgWrap, image: genImageStyles.imgZoom }}
        onError={bumpRetry}
      />
    </div>
  );
};

const KbSearchCard: FC<ExtensionCardProps> = ({ result }) => {
  const details = getDetails(result);
  const hits = Array.isArray(details?.hits)
    ? (details!.hits as Array<{ source?: unknown; score?: unknown }>)
    : [];
  const text = extractText(result);
  return (
    <Flexbox gap={6} data-testid="card-kb_search">
      {hits.length > 0 && (
        <Flexbox gap={2}>
          {hits.map((h, i) => (
            <Flexbox horizontal align="center" gap={6} key={i}>
              <Icon icon={Search} size={13} />
              <span style={{ fontSize: 12 }}>{asString(h.source)}</span>
              {h.score != null && <span style={labelStyle}>score {asString(h.score)}</span>}
            </Flexbox>
          ))}
        </Flexbox>
      )}
      {text ? <LazyMarkdown>{text}</LazyMarkdown> : null}
    </Flexbox>
  );
};

const KbAddCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  return (
    <Flexbox horizontal align="center" gap={6} data-testid="card-kb_add">
      <Icon icon={BookPlus} size={14} />
      <span style={{ fontSize: 12 }}>
        已索引 {asString(d?.source)} 为 {asString(d?.chunks ?? 0)} 块（{d?.embedded ? 'embedded' : 'keyword'}）
      </span>
    </Flexbox>
  );
};

const MemoryCard: FC<ExtensionCardProps> = ({ toolName, result, status }) => {
  const d = getDetails(result);
  const text = extractText(result);
  if (toolName === 'memory_save') {
    const category = asString(d?.category);
    // 失败（embedding 未配 / 网络等）时不能谎报「已保存」：按错误态显示并附错误首行。
    // 之前固定渲染「已保存」，即使工具红叉也照样写——与实际不符。
    if (status === 'error') {
      const brief = text.split('\n')[0];
      return (
        <Flexbox horizontal align="center" gap={6} data-testid="card-memory_save">
          <Icon icon={Brain} size={14} />
          <span style={{ fontSize: 12, color: cssVar.colorError }}>
            记忆保存失败{brief ? `：${brief}` : ''}
          </span>
        </Flexbox>
      );
    }
    return (
      <Flexbox horizontal align="center" gap={6} data-testid="card-memory_save">
        <Icon icon={Brain} size={14} />
        <span style={{ fontSize: 12 }}>
          已保存到{d?.scope === 'global' ? '全局' : '项目'}记忆{category ? `（${category}）` : ''}
        </span>
      </Flexbox>
    );
  }
  return (
    <Flexbox gap={6} data-testid="card-memory_recall">
      <Flexbox horizontal align="center" gap={6}>
        <Icon icon={Brain} size={14} />
        <span style={{ fontSize: 12 }}>召回记忆</span>
      </Flexbox>
      {text ? <LazyMarkdown>{text}</LazyMarkdown> : null}
    </Flexbox>
  );
};

const GenerateImageCard: FC<ExtensionCardProps> = ({ args, result, status }) => {
  const { workspace } = useAgentStoreContext();
  const d = getDetails(result);
  // 兼容单图(path)与多图(paths)：统一成数组。
  const rawPaths = Array.isArray(d?.paths) ? (d?.paths as unknown[]) : asString(d?.path) ? [d?.path] : [];
  const paths = rawPaths.map(asString).filter(Boolean);
  const prompt = getArgString(args, 'prompt');
  const refCount = Number(d?.references) || 0;
  const meta = [asString(d?.model), asString(d?.size), refCount > 0 ? `参考图×${refCount}` : '']
    .filter(Boolean)
    .join(' · ');
  const ratio = ratioOf(asString(d?.size));
  // 生成中（工具仍在跑、还没产出 path）：给等比加载帧，而非孤零零一个图标。
  const loading = status === 'running' || (paths.length === 0 && status !== 'error');
  const errored = status === 'error' && paths.length === 0;
  const multi = paths.length > 1;
  // 标题用提示词（加粗单行截断），文件名收进 hover tooltip。
  const title = prompt || (loading ? '图片生成中…' : '生成图片');
  const filename = paths[0] ? basename(paths[0]) : undefined;
  const single = frameSize(ratio, 480, 440);
  const cell = frameSize(ratio, 200, 200);

  return (
    <div className={genImageStyles.card} data-testid="card-generate_image">
      <div className={genImageStyles.head}>
        <Icon icon={loading ? Loader2 : ImageIcon} size={15} spin={loading} />
        <span className={genImageStyles.title} title={filename}>
          {title}
        </span>
        {!loading && meta ? <span className={genImageStyles.meta}>{meta}</span> : null}
        {!loading && paths.length > 0 ? (
          <div className={genImageStyles.actions}>
            <ActionIcon
              data-testid="download-generate_image"
              icon={Download}
              size="small"
              title="下载图片"
              onClick={() => void Promise.all(paths.map((p) => downloadImage(workspace, p)))}
            />
            <RevealFileButton path={paths[0]} toolName="generate_image" title="在文件夹中显示" />
          </div>
        ) : null}
      </div>
      {loading ? (
        <div className={genImageStyles.loadingFrame} style={{ width: single.width, height: single.height }}>
          <Icon icon={Loader2} size={18} spin />
          正在生成图片…
        </div>
      ) : errored ? (
        <span style={labelStyle}>图片生成失败</span>
      ) : paths.length > 0 ? (
        <Image.PreviewGroup>
          {multi ? (
            <div className={genImageStyles.grid}>
              {paths.map((p) => (
                <ImageThumb key={p} workspace={workspace} path={p} w={cell.width} h={cell.height} />
              ))}
            </div>
          ) : (
            <ImageThumb key={paths[0]} workspace={workspace} path={paths[0]} w={single.width} h={single.height} />
          )}
        </Image.PreviewGroup>
      ) : (
        <span style={labelStyle}>（无图片输出）</span>
      )}
    </div>
  );
};

const SpawnAgentCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  const text = extractText(result);
  const countRaw = d?.count;
  const count = typeof countRaw === 'number' ? countRaw : undefined;
  const failedRaw = d?.failed;
  const failed = typeof failedRaw === 'number' ? failedRaw : undefined;
  return (
    <Flexbox gap={6} data-testid="card-spawn_agent">
      {count != null && (
        <Flexbox horizontal align="center" gap={6}>
          <Icon icon={Network} size={14} />
          <span style={{ fontSize: 12 }}>
            {count} 个子 agent{failed ? `，${failed} 个失败` : ''}
          </span>
        </Flexbox>
      )}
      {text ? <LazyMarkdown>{text}</LazyMarkdown> : null}
    </Flexbox>
  );
};

// 对齐 lobehub web-browsing 单页抓取卡：三态共用同一卡片容器（边框/圆角/宽度一致），
// 只换内部内容 —— 加载（骨架）/ 失败（红字 + 抓取模式）/ 成功（标题 + 描述 + 字数·抓取）。
// 整页正文不灌进对话流，成功态点卡片在右侧面板全览。
const fetchStyles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
  `,
  card: css`
    overflow: hidden;
    width: 100%;
    max-width: 360px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    transition: border-color 0.2s;

    &:hover {
      border-color: ${cssVar.colorBorder};
    }
  `,
  desc: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorTextTertiary};
  `,
  errText: css`
    overflow-wrap: anywhere;
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorError};
  `,
  footer: css`
    display: flex;
    gap: 16px;
    padding: 6px 12px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
    background: ${cssVar.colorFillQuaternary};
  `,
  footerLabel: css`
    color: ${cssVar.colorTextQuaternary};
  `,
  title: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  titleRow: css`
    display: flex;
    overflow: hidden;
    align-items: center;
    gap: 6px;
  `,
  url: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

const FetchUrlCard: FC<ExtensionCardProps> = ({ args, result, status }) => {
  const openPage = useDockStore((s) => s.openPage);
  const d = getDetails(result);
  const url = asString(d?.url) || getArgString(args, 'url');
  const content = extractText(result);
  const crawler = asString(d?.crawler);
  const errorMsg = asString(d?.error);

  const isLoading = status === 'running' && !d;
  const isError =
    !isLoading && (status === 'error' || !!errorMsg || (d?.chars == null && content.startsWith('抓取失败')));
  const isSuccess = !isLoading && !isError;

  const title = asString(d?.title) || url;
  const chars = typeof d?.chars === 'number' ? (d.chars as number) : undefined;
  const preview = content.replace(/\s+/g, ' ').trim().slice(0, 160);
  const showFooter = !isLoading && (chars != null || crawler);

  // 三态共用同一 card 容器，只切换内部内容与可点击性。
  return (
    <div
      className={fetchStyles.card}
      role={isSuccess ? 'button' : undefined}
      tabIndex={isSuccess ? 0 : undefined}
      style={isSuccess ? { cursor: 'pointer' } : undefined}
      data-testid="card-fetch_url"
      onClick={isSuccess ? () => openPage({ url, content, title, chars, crawler }) : undefined}
    >
      <div className={fetchStyles.body}>
        <div className={fetchStyles.titleRow}>
          <Icon icon={Globe} size={13} />
          <span className={isSuccess ? fetchStyles.title : fetchStyles.url}>
            {isSuccess ? title : url || '抓取中…'}
          </span>
          {isSuccess ? (
            <ActionIcon
              icon={ExternalLink}
              size="small"
              title="在浏览器打开"
              onClick={(e) => {
                e.stopPropagation();
                void openPath(url);
              }}
            />
          ) : null}
        </div>

        {isLoading ? (
          <Flexbox gap={6}>
            <Skeleton.Block active style={{ height: 12, width: '92%' }} />
            <Skeleton.Block active style={{ height: 12, width: '48%' }} />
          </Flexbox>
        ) : isError ? (
          <div className={fetchStyles.errText}>{errorMsg || content || '抓取失败'}</div>
        ) : preview ? (
          <div className={fetchStyles.desc}>{preview}</div>
        ) : null}
      </div>

      {showFooter ? (
        <div className={fetchStyles.footer}>
          {chars != null ? (
            <span>
              <span className={fetchStyles.footerLabel}>字数 </span>
              {chars}
            </span>
          ) : null}
          {crawler ? (
            <span>
              <span className={fetchStyles.footerLabel}>抓取 </span>
              {crawler}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const speakCardStyles = createStaticStyles(({ css }) => ({
  card: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
    max-width: 340px;
    min-width: 0;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
  `,
  head: css`
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  `,
  name: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  voice: css`
    flex: none;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

const SpeakCard: FC<ExtensionCardProps> = ({ args, result, status }) => {
  const { workspace } = useAgentStoreContext();
  const d = getDetails(result);
  const path = asString(d?.path);
  const voice = asString(d?.voice);
  // 标题用朗读文本的首句（语义化），文件名退到 hover 提示 + 文件夹按钮；取不到文本再回退文件名。
  const title = deriveAudioTitle(getArgString(args, 'text')) || basename(path);
  // 生成中（工具仍在跑、还没产出 path）：给个明确的加载态（转圈 + 文案 + 骨架条），
  // 而不是只剩一个孤零零的喇叭图标，避免「啪」地从空到有的生硬切换。
  const loading = status === 'running' || (!path && status !== 'error');

  return (
    <div className={speakCardStyles.card} data-testid="card-speak">
      <div className={speakCardStyles.head}>
        <Icon icon={loading ? Loader2 : Volume2} size={14} spin={loading} />
        {loading ? (
          <span className={speakCardStyles.name}>语音生成中…</span>
        ) : (
          <>
            <span className={speakCardStyles.name} title={basename(path)}>
              {title}
            </span>
            {voice ? <span className={speakCardStyles.voice}>{voice}</span> : null}
            <RevealFileButton path={path} toolName="speak" title="在文件夹中显示" />
          </>
        )}
      </div>
      {loading ? (
        <Skeleton.Block active style={{ borderRadius: 999, height: 28, width: '100%' }} />
      ) : path ? (
        <AudioPlayer workspace={workspace} path={path} />
      ) : (
        <span style={labelStyle}>（无音频输出）</span>
      )}
    </div>
  );
};

// 参考 lobe 的任务列表视觉（TaskStatusIcon 圆形图标族 + 语义色）：未完成用空心虚线圆、
// 完成用绿色勾选圆，配细进度条。默认全部展开、不可折叠。
const todoCardStyles = createStaticStyles(({ css }) => ({
  card: css`
    overflow: hidden;
    width: 100%;
    max-width: 520px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  title: css`
    flex-shrink: 0;
  `,
  count: css`
    overflow: hidden;
    min-width: 0;
    margin-inline-start: auto;
    font-size: 12px;
    font-weight: normal;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  `,
  track: css`
    height: 3px;
    background: ${cssVar.colorFillSecondary};
  `,
  bar: css`
    height: 100%;
    border-radius: 0 2px 2px 0;
    background: ${cssVar.colorSuccess};
    transition: width 0.3s ease;
  `,
  list: css`
    display: flex;
    flex-direction: column;
    padding: 6px 0 8px;
  `,
  item: css`
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 12px;
    font-size: 13px;
    line-height: 1.55;
    color: ${cssVar.colorTextSecondary};
  `,
  done: css`
    color: ${cssVar.colorTextQuaternary};
    text-decoration: line-through;
  `,
}));

const TodoCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  let todos = Array.isArray(d?.todos)
    ? (d!.todos as Array<{ id?: unknown; text?: unknown; done?: unknown }>).map((t) => ({
        text: asString(t.text),
        done: Boolean(t.done),
      }))
    : [];
  // details 缺失时（部分实时事件未带 details）从 content 文本兜底解析。
  if (todos.length === 0) {
    const text = extractText(result);
    const fromList = text
      .split('\n')
      .flatMap((line) => {
        const m = line.match(/^\[([x ])\]\s*#(\d+):\s*(.+)$/i);
        if (!m) return [];
        return [{ done: m[1].toLowerCase() === 'x', text: m[3]!.trim() }];
      });
    if (fromList.length > 0) {
      todos = fromList;
    } else {
      const added = text.match(/^Added todo #\d+:\s*(.+)$/i);
      if (added) todos = [{ done: false, text: added[1]!.trim() }];
    }
  }
  const total = todos.length;
  const done = todos.filter((t) => t.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  // 空状态：把兜底文本（如 "Cleared 5 todos"）并入 header 右侧 count 位置，
  // 整张卡片收成一条干净横条，不再单独占一行。
  const hint = total === 0 ? extractText(result).trim() : '';
  const status = total ? `${done} / ${total}` : hint || '空';
  return (
    <div className={todoCardStyles.card} data-testid="card-todo">
      <div className={todoCardStyles.header}>
        <Icon icon={ListChecks} size={15} />
        <span className={todoCardStyles.title}>待办</span>
        <span className={todoCardStyles.count} title={status}>
          {status}
        </span>
      </div>
      {total > 0 && (
        <>
          <div className={todoCardStyles.track}>
            <div className={todoCardStyles.bar} style={{ width: `${pct}%` }} />
          </div>
          <div className={todoCardStyles.list}>
            {todos.map((t, i) => (
              <div className={todoCardStyles.item} key={i}>
                <Icon
                  icon={t.done ? CircleCheck : CircleDashed}
                  size={15}
                  style={{
                    flexShrink: 0,
                    marginTop: 1,
                    color: t.done ? cssVar.colorSuccess : cssVar.colorTextQuaternary,
                  }}
                />
                <span className={t.done ? todoCardStyles.done : undefined}>{t.text}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

const searchCardStyles = createStaticStyles(({ css }) => ({
  wrap: css`
    overflow: hidden;
    width: 100%;
    max-width: 520px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;

    &:hover {
      background: ${cssVar.colorFillQuaternary};
    }
  `,
  headerLeft: css`
    display: flex;
    overflow: hidden;
    flex: 1;
    gap: 8px;
    align-items: center;
    min-width: 0;
  `,
  headerTitle: css`
    overflow: hidden;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  query: css`
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  faviconStack: css`
    display: flex;
    flex-shrink: 0;
    align-items: center;
  `,
  favicon: css`
    width: 16px;
    height: 16px;
    margin-inline: -3px;
    padding: 2px;
    border-radius: 999px;
    background: ${cssVar.colorBgContainer};
  `,
  body: css`
    padding: 0 0 12px;
  `,
  scrollRoot: css`
    border-radius: 0;
    background: transparent;
  `,
  resultsScroll: css`
    max-height: min(42vh, 340px);
    padding-inline: 12px;
  `,
  resultsList: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-block-end: 4px;
    padding-inline-end: 4px;
  `,
  item: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorFillQuaternary};
    text-decoration: none;
    transition: border-color 0.2s, background 0.2s;

    &:hover {
      border-color: ${cssVar.colorBorder};
      background: ${cssVar.colorBgContainer};
    }
  `,
  itemTitle: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.45;
    color: ${cssVar.colorText};
  `,
  itemSnippet: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorTextTertiary};
  `,
  itemMeta: css`
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 11px;
    color: ${cssVar.colorTextQuaternary};
  `,
  errText: css`
    padding: 10px 12px;
    font-size: 12px;
    color: ${cssVar.colorError};
  `,
  loadingRow: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px 12px;
  `,
}));

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function faviconUrl(url: string): string {
  return `https://icons.duckduckgo.com/ip3/${hostFromUrl(url)}.ico`;
}

const searchExpandVariants = {
  collapsed: { height: 0, opacity: 0 },
  open: { height: 'auto', opacity: 1 },
} as const;

const SearchResultsPanel: FC<{
  query?: string;
  provider?: string;
  results: Array<{ title?: unknown; url?: unknown; snippet?: unknown }>;
  status: ExtensionCardProps['status'];
  error?: string;
  testId: string;
}> = ({ query, provider, results, status, error, testId }) => {
  const [expanded, setExpanded] = useState(false);
  const items = results
    .map((r) => ({
      title: asString(r.title) || asString(r.url),
      url: asString(r.url),
      snippet: asString(r.snippet),
    }))
    .filter((r) => r.url);

  if (status === 'running' && items.length === 0) {
    return (
      <div className={searchCardStyles.wrap} data-testid={testId}>
        <div className={searchCardStyles.header}>
          <div className={searchCardStyles.headerLeft}>
            <Icon icon={Search} size={14} />
            <span className={searchCardStyles.headerTitle}>
              搜索：<span className={searchCardStyles.query}>{query || '…'}</span>
            </span>
          </div>
        </div>
        <div className={searchCardStyles.loadingRow}>
          {[0, 1, 2].map((i) => (
            <Skeleton.Block active key={i} style={{ borderRadius: 8, height: 64, width: '100%' }} />
          ))}
        </div>
      </div>
    );
  }

  if (error || items.length === 0) {
    const text = error || '未找到结果';
    return (
      <div className={searchCardStyles.wrap} data-testid={testId}>
        <div className={searchCardStyles.errText}>{text}</div>
      </div>
    );
  }

  return (
    <div className={searchCardStyles.wrap} data-testid={testId}>
      <div
        aria-expanded={expanded}
        className={searchCardStyles.header}
        data-testid={`${testId}-toggle`}
        onClick={() => setExpanded((v) => !v)}
      >
        <div className={searchCardStyles.headerLeft}>
          <Icon icon={Search} size={14} />
          <span className={searchCardStyles.headerTitle}>
            搜索：<span className={searchCardStyles.query}>{query || 'web'}</span>
            {provider ? ` · ${provider}` : ''}（{items.length}）
          </span>
          {!expanded ? (
            <div className={searchCardStyles.faviconStack}>
              {items.slice(0, 6).map((item, index) => (
                <img
                  key={item.url}
                  alt=""
                  className={searchCardStyles.favicon}
                  src={faviconUrl(item.url)}
                  style={{ zIndex: 10 - index }}
                />
              ))}
            </div>
          ) : null}
        </div>
        <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} />
      </div>
      {expanded ? (
        <AnimatePresence initial={false}>
          <m.div
            key="search-results"
            animate="open"
            exit="collapsed"
            initial="collapsed"
            style={{ overflow: 'hidden', width: '100%' }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            variants={searchExpandVariants}
          >
            <div className={searchCardStyles.body}>
              <ScrollArea
                disableContentFit
                scrollFade
                className={searchCardStyles.scrollRoot}
                contentProps={{
                  style: {
                    color: 'inherit',
                    display: 'block',
                    fontSize: 'inherit',
                    gap: 0,
                    lineHeight: 'inherit',
                    paddingInlineEnd: 4,
                  },
                }}
                scrollbarProps={{
                  style: { marginInlineEnd: 2 },
                }}
                viewportProps={{
                  className: searchCardStyles.resultsScroll,
                }}
              >
                <Flexbox className={searchCardStyles.resultsList} gap={8}>
                  {items.map((item) => (
                    <a
                      key={item.url}
                      className={searchCardStyles.item}
                      href={item.url}
                      rel="noopener noreferrer"
                      target="_blank"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className={searchCardStyles.itemTitle}>{item.title}</div>
                      {item.snippet ? <div className={searchCardStyles.itemSnippet}>{item.snippet}</div> : null}
                      <div className={searchCardStyles.itemMeta}>
                        <img alt="" src={faviconUrl(item.url)} width={12} height={12} style={{ borderRadius: 2 }} />
                        <span>{hostFromUrl(item.url)}</span>
                      </div>
                    </a>
                  ))}
                </Flexbox>
              </ScrollArea>
            </div>
          </m.div>
        </AnimatePresence>
      ) : null}
    </div>
  );
};

const WebSearchCard: FC<ExtensionCardProps> = ({ args, result, status }) => {
  const d = getDetails(result);
  const query = asString(d?.query) || getArgString(args, 'query');
  const provider = asString(d?.provider);
  const error = asString(d?.error);
  const results = Array.isArray(d?.results) ? (d!.results as Array<{ title?: unknown; url?: unknown; snippet?: unknown }>) : [];
  return (
    <SearchResultsPanel
      query={query}
      provider={provider}
      results={results}
      status={status}
      error={error || (status === 'error' ? extractText(result) : undefined)}
      testId="card-web_search"
    />
  );
};

const MultiSearchCard: FC<ExtensionCardProps> = ({ args, result, status }) => {
  const d = getDetails(result);
  const query = asString(d?.query) || getArgString(args, 'query');
  const engines = Array.isArray(d?.engines) ? (d!.engines as unknown[]).map(asString).filter(Boolean).join(', ') : 'multi';
  const error = asString(d?.error);
  const results = Array.isArray(d?.results) ? (d!.results as Array<{ title?: unknown; url?: unknown; snippet?: unknown }>) : [];
  return (
    <SearchResultsPanel
      query={query}
      provider={engines}
      results={results}
      status={status}
      error={error}
      testId="card-search"
    />
  );
};

const FetchArticleCard: FC<ExtensionCardProps & { testId: string }> = ({ args, result, status, testId }) => {
  const d = getDetails(result);
  const url = asString(d?.url) || getArgString(args, 'url');
  const errorMsg = asString(d?.error);
  const content = extractText(result);
  const chars = typeof d?.chars === 'number' ? (d.chars as number) : content.length;
  const isLoading = status === 'running' && !d;
  const isError = !isLoading && (status === 'error' || !!errorMsg);

  return (
    <div className={fetchStyles.card} data-testid={testId}>
      <div className={fetchStyles.body}>
        <div className={fetchStyles.titleRow}>
          <Icon icon={Globe} size={13} />
          <span className={fetchStyles.url}>{url || '抓取中…'}</span>
        </div>
        {isLoading ? (
          <Flexbox gap={6}>
            <Skeleton.Block active style={{ height: 12, width: '92%' }} />
            <Skeleton.Block active style={{ height: 12, width: '70%' }} />
          </Flexbox>
        ) : isError ? (
          <div className={fetchStyles.errText}>{errorMsg || content || '抓取失败'}</div>
        ) : (
          <div className={fetchStyles.desc}>{content.replace(/\s+/g, ' ').trim().slice(0, 160)}</div>
        )}
      </div>
      {!isLoading && !isError && chars > 0 ? (
        <div className={fetchStyles.footer}>
          <span>
            <span className={fetchStyles.footerLabel}>字数 </span>
            {chars}
          </span>
        </div>
      ) : null}
    </div>
  );
};

const EXTENSION_CARD_RENDERERS: Record<string, FC<ExtensionCardProps>> = {
  kb_search: KbSearchCard,
  kb_add: KbAddCard,
  memory_save: MemoryCard,
  memory_recall: MemoryCard,
  generate_image: GenerateImageCard,
  spawn_agent: SpawnAgentCard,
  fetch_url: FetchUrlCard,
  web_search: WebSearchCard,
  search: MultiSearchCard,
  fetch_csdn_article: (p) => <FetchArticleCard {...p} testId="card-fetch_csdn_article" />,
  fetch_juejin_article: (p) => <FetchArticleCard {...p} testId="card-fetch_juejin_article" />,
  fetch_linuxdo_article: (p) => <FetchArticleCard {...p} testId="card-fetch_linuxdo_article" />,
  fetch_github_readme: (p) => <FetchArticleCard {...p} testId="card-fetch_github_readme" />,
  fetch_web_content: (p) => <FetchArticleCard {...p} testId="card-fetch_web_content" />,
  speak: SpeakCard,
  todo: TodoCard,
};

export function renderExtensionCard(props: ExtensionCardProps): ReactNode | null {
  const Renderer = EXTENSION_CARD_RENDERERS[props.toolName.toLowerCase()];
  if (!Renderer) return null;
  return <Renderer {...props} />;
}
