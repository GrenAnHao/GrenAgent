import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { QuestionSelector, type QuestionSelectorQuestion } from './index';

afterEach(cleanup);

const single: QuestionSelectorQuestion[] = [
  { id: 'q1', title: '单题', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
];
const multiQ: QuestionSelectorQuestion[] = [
  { id: 'q1', title: '第一题', options: [{ id: 'a', label: 'A' }] },
  { id: 'q2', title: '第二题', options: [{ id: 'c', label: 'C' }] },
];

describe('QuestionSelector', () => {
  it('single question shows 确定 and no step nav', () => {
    render(
      <QuestionSelector
        questions={single}
        selected={{ q1: ['a'] }}
        onToggle={() => {}}
        onContinue={() => {}}
        onSkip={() => {}}
      />,
    );
    expect(screen.getByTestId('question-selector-continue')).toBeTruthy();
    expect(screen.queryByTestId('question-selector-next')).toBeNull();
  });

  it('multi question shows step nav and reaches 提交 on last page', () => {
    render(
      <QuestionSelector
        questions={multiQ}
        selected={{ q1: ['a'], q2: ['c'] }}
        onToggle={() => {}}
        onContinue={() => {}}
        onSkip={() => {}}
      />,
    );
    expect((screen.getByTestId('question-selector-prev') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('question-selector-next'));
    expect(screen.getByTestId('question-selector-submit')).toBeTruthy();
  });

  it('next is disabled until current question answered', () => {
    render(
      <QuestionSelector questions={multiQ} selected={{}} onToggle={() => {}} onContinue={() => {}} onSkip={() => {}} />,
    );
    expect((screen.getByTestId('question-selector-next') as HTMLButtonElement).disabled).toBe(true);
  });
});
