import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from './harness.config.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 场景构建产物目录（系统临时目录下）。按这份代码的路径取哈希分开放：
 * 主仓库和 git worktree 同时跑时，共用一个目录会互相覆盖产物，
 * 表现为「页面没就绪」（场景不在对方的构建里）或断言跑在别人的代码上。
 */
const checkout = createHash('sha1').update(here).digest('hex').slice(0, 8)

export const distDir = join(tmpdir(), `${config.id}-ui-harness-${checkout}`)

/** 截图目录 */
export const shotDir = join(tmpdir(), `${config.id}-ui-shots`)
