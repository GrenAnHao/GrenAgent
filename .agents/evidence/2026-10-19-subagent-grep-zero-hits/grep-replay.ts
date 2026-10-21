import { readFileSync } from 'node:fs';
import { parseGrepOutput } from '../../electron-agent/src/lib/searchResults';
const dir = 'C:/Users/rxstudio/.pi/agent/sessions/';
const files = process.argv.slice(2);
let n = 0, zero = 0, realEmpty = 0;
for (const f of files) for (const l of readFileSync(dir + f, 'utf8').split('\n')) {
  if (!l) continue; let e: any; try { e = JSON.parse(l); } catch { continue; }
  const m = e.message; if (m?.role !== 'toolResult' || m.toolName !== 'grep') continue;
  const t = (m.content || []).map((c: any) => c.text || '').join('');
  n++;
  if (/^No matches found/.test(t.trim())) { realEmpty++; continue; }
  if (parseGrepOutput(t).total === 0) { zero++; console.log('STILL 0:', t.slice(0, 200)); }
}
console.log({ grepResults: n, realNoMatch: realEmpty, parsedAsZero: zero });
