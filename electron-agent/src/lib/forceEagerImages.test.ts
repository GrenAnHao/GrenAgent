import { afterEach, describe, expect, it } from 'vitest';

import { forceEagerImages } from './forceEagerImages';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('forceEagerImages', () => {
  let stop: () => void = () => {};

  afterEach(() => {
    stop();
    document.body.innerHTML = '';
  });

  it('把已存在的 lazy 图片改成 eager', () => {
    const img = document.createElement('img');
    img.setAttribute('loading', 'lazy');
    document.body.append(img);
    stop = forceEagerImages();
    expect(img.getAttribute('loading')).toBe('eager');
  });

  it('对动态新增的 lazy 图片改成 eager', async () => {
    stop = forceEagerImages();
    const img = document.createElement('img');
    img.setAttribute('loading', 'lazy');
    document.body.append(img);
    await tick();
    expect(img.getAttribute('loading')).toBe('eager');
  });

  it('对后设 loading=lazy 属性的图片也改成 eager', async () => {
    stop = forceEagerImages();
    const img = document.createElement('img');
    document.body.append(img);
    await tick();
    img.setAttribute('loading', 'lazy');
    await tick();
    expect(img.getAttribute('loading')).toBe('eager');
  });

  it('对嵌套在新增子树里的 lazy 图片也生效', async () => {
    stop = forceEagerImages();
    const wrap = document.createElement('div');
    wrap.innerHTML = '<span><img loading="lazy" alt="mermaid" /></span>';
    document.body.append(wrap);
    await tick();
    expect(wrap.querySelector('img')?.getAttribute('loading')).toBe('eager');
  });

  it('不影响本就 eager 的图片', () => {
    const img = document.createElement('img');
    img.setAttribute('loading', 'eager');
    document.body.append(img);
    stop = forceEagerImages();
    expect(img.getAttribute('loading')).toBe('eager');
  });

  it('disconnect 后不再处理新图片', async () => {
    stop = forceEagerImages();
    stop();
    const img = document.createElement('img');
    img.setAttribute('loading', 'lazy');
    document.body.append(img);
    await tick();
    expect(img.getAttribute('loading')).toBe('lazy');
  });
});
