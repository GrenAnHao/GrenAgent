import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AnsweredQuestionsCard, parseAnswers } from './AnsweredQuestionsCard';

afterEach(cleanup);

const args = {
  questions: [
    {
      question: '选项卡已弹出。你想让我接下来做什么？',
      options: ['单选示例', '只是测试选项卡能不能正常显示', '其他'],
    },
  ],
};

describe('parseAnswers', () => {
  it('does not treat 补充说明 as the chosen option', () => {
    expect(
      parseAnswers({
        content: [
          {
            type: 'text',
            text: '[我的选择]\n1. 选项卡已弹出。你想让我接下来做什么？：只是测试选项卡能不能正常显示\n补充说明：你能看到图片吗',
          },
        ],
      }),
    ).toEqual(['只是测试选项卡能不能正常显示']);
  });
});

describe('AnsweredQuestionsCard', () => {
  it('shows the selected option and the extra note', () => {
    render(
      <AnsweredQuestionsCard
        args={args}
        result={{
          content: [
            {
              type: 'text',
              text: '[我的选择]\n1. 选项卡已弹出。你想让我接下来做什么？：只是测试选项卡能不能正常显示\n补充说明：你能看到图片吗',
            },
          ],
        }}
      />,
    );
    expect(screen.getByText('只是测试选项卡能不能正常显示')).toBeTruthy();
    expect(screen.getByTestId('answered-questions-extra').textContent).toBe('你能看到图片吗');
  });

  it('renders extra images from the tool result', () => {
    render(
      <AnsweredQuestionsCard
        args={args}
        result={{
          content: [
            { type: 'text', text: '[我的选择]\n1. 选项卡已弹出。你想让我接下来做什么？：只是测试选项卡能不能正常显示' },
            { type: 'image', mimeType: 'image/png', data: 'abc123' },
          ],
        }}
      />,
    );
    const img = screen.getByTestId('answered-questions-image-0') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,abc123');
  });
});
