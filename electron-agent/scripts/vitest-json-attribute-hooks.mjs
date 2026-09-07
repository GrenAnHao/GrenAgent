/**
 * Node 模块解析 / 加载钩子：让「为打包器发布、未适配 Node 原生 ESM」的依赖能在测试里被加载。
 *
 * 测试中 node_modules 默认被 externalize，由 Node 原生 ESM 加载，而 @lobehub 这类面向打包器
 * 发布的包依赖打包器更宽松的解析规则，于是在 import 阶段就整体失败。补两条差异即可：
 *
 * 1. JSON 入口：Node 22 起 ESM 导入 JSON 必须写 `with { type: 'json' }`。@emoji-mart/data 的
 *    main 就是 sets/15/native.json，而 @lobehub/ui 的 barrel 里 EmojiPicker 写的是裸导入。
 *    校验读的是 import 语句上声明的属性，光在 resolve 阶段补 importAttributes 不起作用，
 *    所以在 load 阶段把 JSON 翻译成等价 ES 模块。已正确声明属性的导入不受影响。
 *
 * 2. CJS 式解析：Node 原生 ESM 不支持目录导入和省略扩展名，@lobehub/icons 的
 *    `from './features'` 就属于这类。解析失败时按 CJS 的顺序回退一次。
 *
 * 只作用于测试进程，不改变生产构建——生产走 Vite/electron-vite，本来就按打包器规则解析。
 */
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FALLBACK_SUFFIXES = ['.js', '.mjs', '.cjs', '/index.js', '/index.mjs', '/index.cjs'];

async function exists(url) {
  try {
    await stat(fileURLToPath(url));
    return true;
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const code = error?.code;
    if (code !== 'ERR_UNSUPPORTED_DIR_IMPORT' && code !== 'ERR_MODULE_NOT_FOUND') throw error;
    // 相对/绝对说明符才做回退：裸说明符交给 Node 的包解析，避免掩盖真正的依赖缺失。
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw error;

    const base = error.url ?? new URL(specifier, context.parentURL).href;
    for (const suffix of FALLBACK_SUFFIXES) {
      const candidate = base.replace(/\/$/, '') + suffix;
      if (await exists(candidate)) {
        return { url: candidate, format: 'module', shortCircuit: true };
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.json') && context.importAttributes?.type !== 'json') {
    const text = await readFile(fileURLToPath(url), 'utf8');
    // 用 JSON.parse 而非直接内联字面量：JSON 里的 "__proto__" 等键在对象字面量中语义不同。
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default JSON.parse(${JSON.stringify(text)});`,
    };
  }
  return nextLoad(url, context);
}
