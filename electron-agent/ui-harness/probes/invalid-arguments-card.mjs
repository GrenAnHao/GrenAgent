/**
 * 参数不是合法 JSON 的工具调用（pi 1.3.0）：不画成空命令的 bash 卡，而是一行「<工具> 参数无法解析 · 未执行」，
 * 展开看解析错误和模型原样发来的参数。实时、历史回放、MCP 工具三种来源一致；普通失败仍走原来的卡片。
 */

const at = (id) => `[data-case="${id}"]`

async function clickRow(t, sel) {
  await t.js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`)
  await t.sleep(50)
  return t.click(sel, 20)
}

export default async function (t) {
  const { cases, rawBash, reasonBash, rawMcp } = await t.data()
  for (const id of cases) await t.waitFor(`${at(id)} [data-testid="tool-execution"]`)
  await t.shot('collapsed')

  for (const id of ['live-bash', 'history-bash']) {
    const c = at(id)
    t.check(`${id}：画成参数无法解析的卡`, await t.count(`${c} [data-testid="invalid-arguments-card"]`), 1)
    t.check(`${id}：没有空的终端块`, await t.count(`${c} [data-testid="terminal-output"]`), 0)
    t.ok(`${id}：标题写出工具名`, ((await t.text(`${c} [data-testid="invalid-arguments-card"]`)) ?? '').includes('bash 参数无法解析'))
    t.check(`${id}：折叠行给出解析错误`, (await t.text(`${c} [data-testid="invalid-arguments-reason"]`))?.trim(), reasonBash)
    t.check(`${id}：标明未执行`, (await t.text(`${c} [data-testid="invalid-arguments-meta"]`))?.trim(), '未执行')
    t.check(`${id}：行状态是失败`, await t.js(`document.querySelector('${c} [data-testid="invalid-arguments-card"] [data-status]')?.dataset.status`), 'error')
    t.check(`${id}：默认收起`, await t.countVisible(`${c} [data-testid="invalid-arguments-received"]`), 0)

    await clickRow(t, `${c} [data-testid="invalid-arguments-card"] > [data-testid="tool-execution"] > div`)
    await t.waitFor(`${c} [data-testid="invalid-arguments-received"]`)
    t.check(`${id}：展开后是模型原样发来的参数`, await t.text(`${c} [data-testid="invalid-arguments-received"]`), rawBash)
    t.ok(`${id}：展开后有完整错误`, ((await t.text(`${c} [data-testid="invalid-arguments-reason-full"]`)) ?? '').includes('position 36'))
    const reasonBox = await t.rect(`${c} [data-testid="invalid-arguments-reason-full"]`)
    const rawBox = await t.rect(`${c} [data-testid="invalid-arguments-received"]`)
    t.ok(`${id}：错误在上、原参数在下`, reasonBox != null && rawBox != null && reasonBox.y < rawBox.y)
  }
  await t.shot('bash-expanded')

  const mcp = at('live-mcp')
  t.check('MCP：同样画成参数无法解析的卡', await t.count(`${mcp} [data-testid="invalid-arguments-card"]`), 1)
  t.check('MCP：服务器标签', await t.text(`${mcp} [data-role="mcp-server"]`), 'antd')
  t.check('MCP：标题不出现 mcp__ 原名', ((await t.text(mcp)) ?? '').includes('mcp__'), false)
  await clickRow(t, `${mcp} [data-testid="invalid-arguments-card"] > [data-testid="tool-execution"] > div`)
  await t.waitFor(`${mcp} [data-testid="invalid-arguments-received"]`)
  t.check('MCP：原参数', await t.text(`${mcp} [data-testid="invalid-arguments-received"]`), rawMcp)

  const plain = at('ordinary-failure')
  t.check('对照：普通失败不是参数卡', await t.count(`${plain} [data-testid="invalid-arguments-card"]`), 0)
  t.ok('对照：普通失败仍是 bash 卡', ((await t.text(`${plain} [data-testid="tool-execution"]`)) ?? '').includes('执行命令'))

  // 错误底色跟主题走
  const darkBg = await t.style(`${at('live-bash')} [data-testid="invalid-arguments-reason-full"]`, ['background-color'])
  await t.setTheme('light')
  await t.sleep(200)
  const lightBg = await t.style(`${at('live-bash')} [data-testid="invalid-arguments-reason-full"]`, ['background-color'])
  t.ok('浅色：错误块底色随主题变化', darkBg?.backgroundColor !== lightBg?.backgroundColor)
  await t.shot('light')
}
