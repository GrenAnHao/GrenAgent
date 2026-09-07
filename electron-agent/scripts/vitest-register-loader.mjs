/**
 * 通过 `--import` 在每个测试进程启动时注册解析钩子。
 * 钩子跑在独立的 loader 线程里，必须是单独模块，所以这里只做注册。
 */
import { register } from 'node:module';

register('./vitest-json-attribute-hooks.mjs', import.meta.url);
