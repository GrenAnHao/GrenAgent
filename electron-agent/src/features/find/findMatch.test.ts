import { afterEach, describe, expect, it } from 'vitest';
import { cachedVisibleItemText, collectText, compileQuery, countMatches, findRanges, MAX_MATCHES, stripMarkdownForFind, visibleItemText } from './findMatch';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('compileQuery / countMatches', () => {
  it('空查询和全空白查询没有查询', () => {
    expect(compileQuery('')).toBeNull();
    expect(compileQuery('   ')).toBeNull();
  });

  it('按字面匹配：正则元字符不当语法', () => {
    expect(countMatches('a.b a*b a(b) [x]', '.')).toBe(1);
    expect(countMatches('a.b a*b', 'a*b')).toBe(1);
    expect(countMatches('f(x) f(y)', 'f(')).toBe(2);
    expect(countMatches('[x] [y]', '[')).toBe(2);
  });

  it('不区分大小写，命中不重叠', () => {
    expect(countMatches('Login LOGIN login', 'login')).toBe(3);
    expect(countMatches('aaaa', 'aa')).toBe(2);
  });

  it('中文、emoji 能命中', () => {
    expect(countMatches('查找查找功能', '查找')).toBe(2);
    expect(countMatches('ok 😀 ok 😀', '😀')).toBe(2);
  });

  it('命中数封顶', () => {
    expect(countMatches('a'.repeat(MAX_MATCHES + 100), 'a')).toBe(MAX_MATCHES);
  });
});

describe('stripMarkdownForFind', () => {
  it('去掉语法壳但保留可见文字；标识符里的下划线不动', () => {
    const md = '## 标题\n\n- **粗体** 和 `code` 与 [链接文字](http://x.test/login)\n\n```ts\nconst login_user = 1\n```\n\n> 引用 ![图](a.png)';
    const plain = stripMarkdownForFind(md);
    expect(plain).toContain('标题');
    expect(plain).toContain('粗体 和 code 与 链接文字');
    expect(plain).toContain('const login_user = 1');
    expect(plain).not.toContain('http://x.test');
    expect(plain).not.toContain('```');
    expect(plain).toContain('引用 图');
  });
});

describe('visibleItemText', () => {
  it('用户消息和助手正文（含代码块）算；思考和工具卡不算', () => {
    expect(visibleItemText({ kind: 'user', id: 'u', text: '你好 login' } as never)).toBe('你好 login');
    const turn = {
      kind: 'turn',
      id: 't',
      segments: [
        { kind: 'thinking', id: 'a', content: '内部推理 login', streaming: false },
        { kind: 'text', id: 'b', content: '正文 login\n```ts\nlogin()\n```', streaming: false },
        { kind: 'tool', id: 'c', toolName: 'bash', args: { command: 'echo login' }, result: 'login', status: 'done' },
      ],
    };
    const text = visibleItemText(turn as never);
    expect(countMatches(text, 'login')).toBe(2);
    expect(text).not.toContain('内部推理');
  });

  it('没有文字的种类是空串', () => {
    expect(visibleItemText({ kind: 'compaction', id: 'c' } as never)).toBe('');
  });

  it('正文引用没变时沿用上次剥离的结果，换了正文才重算', () => {
    const cache = new Map();
    const segment = { kind: 'text', id: 'b', content: '**login** 还在', streaming: false };
    const item = { kind: 'turn', id: 't', segments: [segment] };
    const first = cachedVisibleItemText(item as never, cache);
    const again = cachedVisibleItemText({ kind: 'turn', id: 't', segments: [segment] } as never, cache);
    expect(again).toBe(first);
    const edited = cachedVisibleItemText(
      { kind: 'turn', id: 't', segments: [{ ...segment, content: '**login** 改了' }] } as never,
      cache,
    );
    expect(edited).not.toBe(first);
    expect(edited).toContain('改了');
  });
});

describe('collectText / findRanges（DOM）', () => {
  const mount = (html: string) => {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.append(root);
    return root;
  };

  it('文本片段内的部分匹配：Range 只框住命中的那几个字', () => {
    const root = mount('<p>please login now, Login again</p>');
    const ranges = findRanges(collectText(root), 'login');
    expect(ranges.map((range) => range.toString())).toEqual(['login', 'Login']);
  });

  it('跨行内元素的词也能命中，原有标签不被改动', () => {
    const root = mount('<p>par<b>tial</b> and <a href="#x">par</a>tial</p>');
    const ranges = findRanges(collectText(root), 'partial');
    expect(ranges.map((range) => range.toString())).toEqual(['partial', 'partial']);
    expect(root.innerHTML).toBe('<p>par<b>tial</b> and <a href="#x">par</a>tial</p>');
  });

  it('不跨块命中：段落之间隔着换行', () => {
    const root = mount('<p>ab</p><p>cd</p>');
    expect(findRanges(collectText(root), 'bc')).toHaveLength(0);
    expect(findRanges(collectText(root), 'cd')).toHaveLength(1);
  });

  it('代码块里的文字能命中（pre / code）', () => {
    const root = mount('<pre><code><span>const</span> <span>login</span> = 1</code></pre>');
    expect(findRanges(collectText(root), 'login')).toHaveLength(1);
  });

  it('跳过 data-find-ignore（查找栏自己）、脚本、样式', () => {
    const root = mount('<div data-find-ignore>login</div><style>.login{}</style><p>login</p>');
    expect(findRanges(collectText(root), 'login')).toHaveLength(1);
  });

  it('一个节点里相邻的多处命中、命中贴着节点边界', () => {
    const root = mount('<p>loginlogin</p><p>x<i>login</i></p>');
    expect(findRanges(collectText(root), 'login').map((range) => range.toString())).toEqual(['login', 'login', 'login']);
  });
});
