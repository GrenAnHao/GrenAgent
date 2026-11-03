import { scanKnowledgeSnapshot } from 'file:///D:/OneDrive/Project%20Files/Pi/electron-agent/vendor/repo-wiki/packages/core/src/scanner.ts';
const scan = await scanKnowledgeSnapshot('D:/System Dir/Downloads/note-pocock-flow', { language: 'zh' });
console.log(JSON.stringify({ git: scan.git, branch: scan.identity.branch, commit: String(scan.identity.commit ?? '').slice(0, 8), files: scan.files.length, partial: scan.coverage.partial }));

