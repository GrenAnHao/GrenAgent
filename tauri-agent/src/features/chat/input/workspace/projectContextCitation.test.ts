import { describe, expect, it } from 'vitest';
import { composeMessage } from '../editor/composeMessage';
import { makeProjectContextPastedText } from './projectContextCitation';

describe('makeProjectContextPastedText', () => {
  it('keeps project context content in the outgoing message', () => {
    const item = makeProjectContextPastedText({
      text: 'CodeGraph: WorkspaceBar callers',
      source: 'project:///repo/codegraph',
      label: 'CodeGraph',
    });

    expect(item).toEqual(
      expect.objectContaining({
        text: 'CodeGraph: WorkspaceBar callers',
        source: 'project:///repo/codegraph',
        lines: 1,
        chars: 31,
        referenceOnly: false,
      }),
    );
    expect(composeMessage('', [item])).toContain('CodeGraph: WorkspaceBar callers');
  });
});
