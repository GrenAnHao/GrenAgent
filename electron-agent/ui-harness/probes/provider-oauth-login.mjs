/**
 * 供应商 OAuth 登录：真实 ProvidersSettings + 授权弹层，主进程用桩。
 * 覆盖能力发现、互斥方式、账号卡、授权链接/设备码/手动码、进度、取消、错误重试、
 * 登录成功后凭据刷新、绿点、切换确认与退出登录。不发真实网络请求。
 */

const textOf = (selector) => `document.querySelector('${selector}')?.textContent ?? ''`

export default async function (t) {
  // —— 能力发现：只在有 OAuth 的供应商上出现方式选择器 ——
  t.ok('供应商列表渲染', await t.waitFor('[data-testid="prov-item-openai"]'))
  t.ok('OAuth 方式选择器出现', await t.waitFor('[data-testid="prov-oauth-mode-oauth"]'))
  await t.click('[data-testid="prov-item-xai"]')
  t.ok('无 OAuth 能力的供应商不显示方式选择器', await t.waitUntil(`!document.querySelector('[data-testid="prov-oauth-mode"]')`))
  t.ok('无 OAuth 能力仍显示 API Key', await t.waitFor('[data-testid="prov-apikey"]'))
  await t.click('[data-testid="prov-item-openai"]')

  // —— 互斥方式 + 未登录账号卡 ——
  await t.click('[data-testid="prov-oauth-mode-oauth"]')
  t.ok('账号卡出现', await t.waitFor('[data-testid="prov-oauth-card"]'))
  t.ok('未登录时有登录入口', await t.waitFor('[data-testid="prov-oauth-login"]'))
  t.check('登录文案显示为中文', await t.js(textOf('[data-testid="prov-oauth-login"]')), '使用 ChatGPT 订阅登录')

  // —— 授权流程 ——
  await t.click('[data-testid="prov-oauth-login"]')
  t.ok('授权弹层打开', await t.waitFor('[data-testid="prov-oauth-modal"]'))
  await t.act('progress')
  t.ok('进度可见', await t.waitForText('[data-testid="prov-oauth-progress"]', '正在等待授权'))

  await t.act('authUrl')
  t.ok('授权链接可见', await t.waitForText('[data-testid="prov-oauth-url"]', 'https://auth.example/authorize'))
  t.ok('可在浏览器打开', await t.waitFor('[data-testid="prov-oauth-open"]'))
  t.ok('可复制链接', await t.waitFor('[data-testid="prov-oauth-copy-url"]'))

  await t.act('deviceCode')
  t.ok('设备码可见', await t.waitForText('[data-testid="prov-oauth-user-code"]', 'ABCD-1234'))
  t.ok('可复制用户码', await t.waitFor('[data-testid="prov-oauth-copy-code"]'))

  // 手动回调码：先被官方 per-prompt signal 取消，再重新提交一次
  await t.act('prompt')
  t.ok('手动回调码输入出现', await t.waitFor('[data-testid="prov-oauth-manual-input"]'))
  await t.act('promptCancelled')
  t.ok('回调先到时手动输入消失', await t.waitUntil(`!document.querySelector('[data-testid="prov-oauth-manual-input"]')`))
  await t.act('prompt')
  await t.click('[data-testid="prov-oauth-manual-input"]')
  await t.type('pasted-code')
  await t.click('[data-testid="prov-oauth-manual-submit"]')
  t.ok('提交回调码到主进程', await t.waitUntil(`window.__uiEvents.includes('prompt:pasted-code')`))

  // —— 错误与重试 ——
  await t.act('error')
  t.ok('错误区可见', await t.waitFor('[data-testid="prov-oauth-error"]'))
  t.ok('可重新登录', await t.waitFor('[data-testid="prov-oauth-retry"]'))
  await t.click('[data-testid="prov-oauth-retry"]')
  await t.waitUntil(`window.__uiEvents.includes('login:openai:2')`)
  t.check('重试发起第二次登录', (await t.events()).filter((e) => e.startsWith('login:')).length, 2)

  // —— 成功：凭据刷新 + 账号卡 + 绿点 ——
  await t.act('progress')
  await t.act('done')
  t.ok('登录成功提示', await t.waitFor('[data-testid="prov-oauth-finish"]'))
  await t.click('[data-testid="prov-oauth-finish"]')
  t.ok('弹层关闭', await t.waitUntil(`!document.querySelector('[data-testid="prov-oauth-modal"]')`))
  t.ok('账号卡显示已登录', await t.waitForText('[data-testid="prov-oauth-card"]', '已登录（OAuth）'))
  t.ok('退出入口可见', await t.waitFor('[data-testid="prov-oauth-logout"]'))
  t.ok('绿点按凭据类型判定', await t.waitUntil(
    `(document.querySelectorAll('[data-testid="prov-item-openai"] span')[1]?.getAttribute('style') ?? '').includes('success')`,
  ))

  // —— 切换方式需要确认（凭据互斥）——
  await t.click('[data-testid="prov-oauth-mode-api"]')
  t.ok('切换确认条出现', await t.waitFor('[data-testid="prov-oauth-switch-confirm"]'))
  await t.click('[data-testid="prov-oauth-switch-ok"]')
  t.ok('确认后回到 API Key 输入', await t.waitFor('[data-testid="prov-apikey"]'))

  // —— 退出登录 ——
  await t.click('[data-testid="prov-oauth-mode-oauth"]')
  t.ok('账号卡回来', await t.waitFor('[data-testid="prov-oauth-logout"]'))
  await t.click('[data-testid="prov-oauth-logout"]')
  t.ok('退出调用主进程', await t.waitUntil(`window.__uiEvents.includes('logout')`))
  t.ok('退出后回到未登录', await t.waitFor('[data-testid="prov-oauth-login"]'))

  await t.shot('account-card')
}
