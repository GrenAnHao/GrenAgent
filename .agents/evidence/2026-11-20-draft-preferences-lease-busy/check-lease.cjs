const { createHash } = require('node:crypto');
const { readdirSync, statSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const agentDir = 'c:/users/rxstudio/pi/agent';
const leasesDir = join(agentDir, 'session-operation-leases');
const target = 'c:/users/rxstudio/pi/agent/sessions/--d--onedrive-project-files-pi-/2026-11-20t01-14-26-587z_01a1f684-6386-746c-ae6b-9cb96677a2eb.jsonl';
const norm = target.split('\\').join('/').replace(/\/+$/, '').toLowerCase();
const hash = createHash('sha256').update(norm).digest('hex').slice(0, 40);
console.log('target normalized:', norm);
console.log('lock dir for errored path:', hash, 'exists:', existsSync(join(leasesDir, hash)));
const now = Date.now();
if (existsSync(leasesDir)) {
  for (const name of readdirSync(leasesDir)) {
    const st = statSync(join(leasesDir, name));
    const age = Math.round((now - st.mtimeMs) / 1000);
    console.log(name.slice(0, 40), 'dir=' + st.isDirectory(), 'mtimeAgeSec=' + age);
  }
} else {
  console.log('no leases dir');
}
