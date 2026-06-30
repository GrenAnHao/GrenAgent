// Lightweight ANSI/SGR parsing + status parsing for the Code Intelligence panel.
//
// parseAnsi/stripAnsi are generic terminal-output helpers (used to render any raw
// command output in the panel; harmless on plain text/JSON). parseCodegraphStatus
// turns the normalized JSON status from the `code_intel_status` Tauri command
// (codebase-memory `cli list_projects`) into the stat cards. (The old codegraph
// engine emitted ANSI status text; codebase-memory returns JSON.)

export interface AnsiSegment {
  text: string;
  bold: boolean;
  dim: boolean;
  /** Resolved foreground colour (terminal-dark palette) or undefined for default. */
  color?: string;
}

// One Dark-flavoured 16-colour palette, tuned to read well on a dark terminal
// background. Index = SGR foreground code (30-37 normal, 90-97 bright).
const FG: Record<number, string> = {
  30: '#5c6370',
  31: '#e06c75',
  32: '#98c379',
  33: '#e5c07b',
  34: '#61afef',
  35: '#c678dd',
  36: '#56b6c2',
  37: '#abb2bf',
  90: '#636d83',
  91: '#ff8088',
  92: '#a9e08e',
  93: '#f0d08a',
  94: '#73b8ff',
  95: '#d790e8',
  96: '#66c7d2',
  97: '#ffffff',
};

const ESC = 27;

/** Parse a string with ANSI SGR codes into a flat list of styled segments. */
export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let buf = '';
  let bold = false;
  let dim = false;
  let color: string | undefined;

  const flush = () => {
    if (buf) segments.push({ text: buf, bold, dim, color });
    buf = '';
  };

  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    // CSI sequence: ESC [ ... <final-letter>
    if (code === ESC && input[i + 1] === '[') {
      let j = i + 2;
      while (j < input.length && !/[A-Za-z]/.test(input[j])) j += 1;
      const final = input[j];
      if (final === 'm') {
        flush();
        const params = input.slice(i + 2, j);
        const codes = params === '' ? [0] : params.split(';').map((p) => Number.parseInt(p, 10));
        for (const c of codes) {
          if (c === 0) {
            bold = false;
            dim = false;
            color = undefined;
          } else if (c === 1) bold = true;
          else if (c === 2) dim = true;
          else if (c === 22) {
            bold = false;
            dim = false;
          } else if (c === 39) color = undefined;
          else if (FG[c]) color = FG[c];
        }
      }
      // Skip the whole CSI sequence (colour or otherwise: cursor moves, clears…).
      i = j + 1;
      continue;
    }
    // Drop any stray ESC byte that isn't a CSI introducer.
    if (code === ESC) {
      i += 1;
      continue;
    }
    buf += input[i];
    i += 1;
  }
  flush();
  return segments;
}

/** Strip all ANSI escape sequences, leaving clean plain text. */
export function stripAnsi(input: string): string {
  return parseAnsi(input)
    .map((s) => s.text)
    .join('');
}

export interface CodeGraphStat {
  label: string;
  value: string;
}

export interface CodeGraphStatus {
  /** Headline numeric metrics for the stat-card grid. */
  stats: CodeGraphStat[];
  /** Secondary key/value details (backend, journal…). */
  details: CodeGraphStat[];
  project?: string;
  /** True when we could parse real index metrics (i.e. an indexed workspace). */
  indexed: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

/**
 * Parse the normalized status JSON emitted by the `code_intel_status` Tauri
 * command (backed by codebase-memory `cli list_projects`) into structured
 * metrics. Tolerant of both the normalized shape
 * ({indexed, project, nodes, edges, sizeBytes, rootPath}) and the raw
 * `index_repository` result ({project, status, nodes, edges}). Returns an
 * empty/indexed=false result for error strings or non-JSON so callers can fall
 * back to rendering the raw output.
 */
export function parseCodegraphStatus(raw: string): CodeGraphStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { stats: [], details: [], indexed: false };
  }
  if (!parsed || typeof parsed !== 'object') return { stats: [], details: [], indexed: false };
  const o = parsed as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  const nodes = num(o.nodes);
  const edges = num(o.edges);
  const size = num(o.sizeBytes) ?? num(o.size_bytes);
  const project = str(o.project) ?? str(o.name);
  const rootPath = str(o.rootPath) ?? str(o.root_path);
  const statusStr = str(o.status);
  const indexedFlag =
    o.indexed === true || statusStr === 'indexed' || statusStr === 'ready' || (nodes !== undefined && nodes > 0);

  const stats: CodeGraphStat[] = [];
  if (nodes !== undefined) stats.push({ label: 'Nodes', value: nodes.toLocaleString() });
  if (edges !== undefined) stats.push({ label: 'Edges', value: edges.toLocaleString() });
  if (size !== undefined) stats.push({ label: 'DB Size', value: formatBytes(size) });

  const details: CodeGraphStat[] = [];
  if (rootPath) details.push({ label: 'Root', value: rootPath });

  return { stats, details, project, indexed: indexedFlag && stats.length > 0 };
}
