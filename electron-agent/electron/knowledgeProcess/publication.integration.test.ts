import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectFiles, type ProjectFacts } from '../../vendor/repo-wiki/packages/core/src/project-files';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ns = 'a'.repeat(24);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-publication-')); roots.push(root);
  const files = new ProjectFiles(root, 'zh');
  const facts: ProjectFacts = { project: { id: 'portable', language: 'zh', name: 'Fixture', next_revision: 1, plan: { include: ['**'], exclude: [], pages: [{ id: 'overview', title: 'Overview', patterns: ['**'], depends_on: [] }] } },
    pages: { [ns]: { overview: { id: 'overview', title: 'Overview', markdown: '# Original\n', baseline: '# Original\n', status: 'ready', revision: 1, sources: [], dependencies: [] } } }, snapshots: { [ns]: { hashes: {}, edges: [], identity: {} } } };
  files.commit(facts); files.load();
  return { root, files, facts };
}
function guard(taskId: string, generation: number) { return { version: 1 as const, taskId, scopeIdentity: 'scope', ledgerId: 'ledger', controllerEpoch: 'epoch', ownerId: 'owner-' + generation, generation }; }
function publication(files: any, facts: ProjectFacts, generation = 1) {
  const result = { version: 1 as const, taskId: 'task-' + generation, claimId: 'claim-' + generation, publicationId: 'publication-' + generation, namespace: ns,
    fence: { ledgerId: 'ledger', controllerEpoch: 'epoch', ownerId: 'owner-' + generation, generation }, intentHash: 'intent', outputSetHash: '' };
  result.outputSetHash = files.publicationOutputHash(facts, result);
  return result;
}
describe('knowledge publication filesystem protocol', () => {
  it('does not recover a journal while a live publisher owns the file lock', () => {
    const { root, files } = fixture();
    const directory = join(root, 'docs/repo-wiki/zh'), project = join(directory, 'project.json');
    const before = readFileSync(project, 'utf8'), after = JSON.stringify({ ...JSON.parse(before), name: 'Concurrent publication' });
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    const journal = join(directory, '.transactions/concurrent'); mkdirSync(join(journal, 'new'), { recursive: true });
    writeFileSync(join(journal, 'new/project.json'), after);
    writeFileSync(join(journal, 'transaction.json'), JSON.stringify({ version: 1, files: [{ path: 'project.json', before: digest(before), after: digest(after) }] }));
    writeFileSync(join(directory, '.write-lock'), JSON.stringify({ pid: process.pid, instance: 'active-publisher' }));
    expect(() => files.recover()).toThrow(/busy/);
    expect(readFileSync(project, 'utf8')).toBe(before);
  });
  it('rejects an old publisher after a new execution fence is installed', () => {
    const { files, facts } = fixture();
    (files as any).installExecutionFence(guard('task-1', 1));
    const claim = publication(files, facts); (files as any).bindPublicationClaim(claim);
    (files as any).installExecutionFence(guard('task-2', 2));
    expect(() => (files as any).commitPublication(facts, claim)).toThrow(/FENCE/);
    expect(files.load().pages[ns].overview.markdown).toBe('# Original\n');
  });
  it('publishes a final receipt, and reads it without overwriting a later human edit', () => {
    const { root, files, facts } = fixture();
    (files as any).installExecutionFence(guard('task-1', 1));
    facts.pages[ns].overview.markdown = '# Generated\n'; facts.pages[ns].overview.baseline = '# Generated\n'; facts.pages[ns].overview.revision = 2;
    const claim = publication(files, facts); (files as any).bindPublicationClaim(claim);
    const receipt = (files as any).commitPublication(facts, claim);
    expect(receipt).toMatchObject({ taskId: 'task-1', publicationId: 'publication-1', outputSetHash: claim.outputSetHash });
    writeFileSync(join(root, 'docs/repo-wiki/zh/namespaces', ns, 'pages/overview.md'), '# Human edit\n');
    const reopened = new ProjectFiles(root, 'zh');
    expect((reopened as any).readPublicationReceipt()).toMatchObject({ taskId: 'task-1', claimId: 'claim-1' });
    expect(reopened.load().pages[ns].overview.markdown).toBe('# Human edit\n');
  });
  it('keeps the generation floor when indexes or task history are absent', () => {
    const { root, files } = fixture();
    (files as any).installExecutionFence(guard('task-8', 8));
    const reopened = new ProjectFiles(root, 'zh');
    expect((reopened as any).readExecutionGuard().generation).toBe(8);
    expect(() => (reopened as any).installExecutionFence({ ...guard('other-ledger', 1), ledgerId: 'new-ledger' })).toThrow(/FENCE/);
    expect((reopened as any).installExecutionFence({ ...guard('new-task', 9), ledgerId: 'new-ledger' }).generation).toBe(9);
  });
  it('rejects changed candidate outputs and preserves the previous publication', () => {
    const { files, facts } = fixture();
    (files as any).installExecutionFence(guard('task-1', 1)); const claim = publication(files, facts); (files as any).bindPublicationClaim(claim);
    facts.pages[ns].overview.markdown = '# Changed after pin\n';
    expect(() => (files as any).commitPublication(facts, claim)).toThrow(/OUTPUT/);
    expect((files as any).readPublicationReceipt()).toBeNull();
  });
  it('recovers a prepared v2 journal before reading its publication receipt', () => {
    const { root, files, facts } = fixture();
    (files as any).installExecutionFence(guard('task-1', 1)); const claim = publication(files, facts); (files as any).bindPublicationClaim(claim);
    const receipt = (files as any).commitPublication(facts, claim);
    const project = join(root, 'docs/repo-wiki/zh/project.json');
    const original = readFileSync(project, 'utf8');
    const journal = join(root, 'docs/repo-wiki/zh/.transactions/prepared'); mkdirSync(join(journal, 'new'), { recursive: true });
    writeFileSync(join(journal, 'new/project.json'), original);
    const { createHash } = require('node:crypto'); const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    writeFileSync(join(journal, 'transaction.json'), JSON.stringify({ version: 2, publication: claim, files: [{ path: 'project.json', before: hash(original), after: hash(original) }] }));
    expect((new ProjectFiles(root, 'zh') as any).readPublicationReceipt()).toEqual(receipt);
  });
});
