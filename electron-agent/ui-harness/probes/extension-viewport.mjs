const id = name => '[data-testid="' + name + '"]'
const rule = n => id('rule-open-project-/projects/workspace-' + n + '/AGENTS.md')
const el = sel => 'document.querySelector(' + JSON.stringify(sel) + ')'
const scroll = (t, sel) => t.js(el(sel) + '.scrollTop')
async function bottom(t, sel, label) {
  await t.wheel(sel, 100000)
  t.ok(label, await t.waitUntil('((n) => n.scrollTop > 0 && n.scrollHeight - n.clientHeight - n.scrollTop < 2)(' + el(sel) + ')'))
}
async function anchors(t, selectors) {
  const coords = []
  for (const selector of selectors) coords.push((await t.rect(selector)).y)
  return coords
}
async function bounded(t, frame, label) {
  const result = await t.js('(() => {const frame=' + el(frame) + ', body=' + el(id('extensions-body')) + ', root=' + el(id('extensions-panel')) + ';' +
    'const parents=[]; for(let p=frame.parentElement;p;p=p.parentElement) if(p.scrollTop!==0 || p.scrollHeight>p.clientHeight+2) parents.push([p.dataset.testid||p.tagName,p.scrollTop,p.scrollHeight,p.clientHeight]);' +
    'return {parents, bottom:frame.getBoundingClientRect().bottom, limit:body.getBoundingClientRect().bottom-parseFloat(getComputedStyle(body).paddingBottom), height:frame.clientHeight, root:root.clientHeight};})()')
  t.check(label + '：外层无纵向滚动范围或位移', result.parents, [])
  t.checkNear(label + '：卡片底边贴合工作区留白', result.bottom, result.limit, 2)
  t.ok(label + '：正文有可操作空间', result.height > 55)
}
export default async function(t) {
  await t.act('setLongLibraries')
  await t.resize(1200, 650)
  await t.click(id('ext-tab-rules'))
  await t.waitFor(rule(0))
  const page = id('extension-page-header'), left = id('rule-list-scroll'), preview = id('builtin-preview')
  const pins = [page, id('rule-new'), id('rule-search'), id('rule-filter-project'), id('rule-detail-title'), id('rule-file-budget'), id('builtin-edit'), '[aria-label="复制文件路径"]']
  await t.waitForText(preview, '约定 100')
  const wide = await anchors(t,pins)
  await bounded(t,id('rule-workbench'),'长 AGENTS.md')
  await bottom(t,preview,'滚轮到达正文末段')
  t.check('滚正文不动目录',await scroll(t,left),0)
  await bottom(t,left,'滚轮到达最后一份仓库文件')
  t.check('两栏滚到底后页头、筛选和详情操作位置不变',await anchors(t,pins),wide)
  t.ok('正文仍停在末段',await scroll(t,preview)>0)
  await bounded(t,id('rule-workbench'),'两栏均到底')
  await t.shot('rules-both-scrolled')
  await t.click(rule(47))
  t.check('换文件后正文从头显示',await scroll(t,preview),0)
  await t.click(id('builtin-edit'))
  const source = id('builtin-body'), save = id('builtin-save')
  const editPins = [page,id('rule-search'),id('rule-detail-title'),save]
  const before = await anchors(t,editPins)
  await bottom(t,source,'源码编辑器可独立滚到底')
  t.check('源码滚动时保存按钮不动',await anchors(t,editPins),before)
  await t.click(source); await t.key('End',['control']); await t.insertText('\n末行验证')
  await t.resize(520,430)
  await bounded(t,id('rule-workbench'),'窄短窗编辑')
  t.ok('窄短窗源码未被裁掉',(await t.rect(source)).h >= 32)
  await t.click(save)
  t.ok('窄短窗保存后显示新正文',await t.waitForText(preview,'末行验证'))
  await bottom(t,preview,'窄短窗末段也可到达')
  await t.click(id('rule-back'))
  t.ok('返回后筛选仍可用',await t.countVisible(id('rule-search')) === 1)
  await t.setTheme('light')
  await t.clickReady(id('ext-tab-commands'), {timeoutMs: 6500}); await t.waitFor(id('command-item-check-47'))
  await bottom(t,id('command-list-scroll'),'窄短窗命令末项可达')
  await t.click(id('command-item-check-47'))
  await bounded(t,id('command-workbench'),'窄短窗命令')
  const cmdPins = [page,id('command-back'),id('command-save')]
  const cmdBefore = await anchors(t,cmdPins)
  await bottom(t,id('command-form-scroll'),'命令表单末尾可达')
  t.check('编辑区滚动不带动返回或保存',await anchors(t,cmdPins),cmdBefore)
  await t.act('setManySkills',true)
  await t.click(id('ext-tab-skills')); await t.waitFor(id('skill-many-39'))
  const skillPins=[page,id('skill-add'),id('skill-view-list')]
  const initial=await anchors(t,skillPins)
  await bottom(t,id('skill-catalog-scroll'),'技能列表末项可达')
  t.check('技能页头及筛选工具行不动',await anchors(t,skillPins),initial)
  await bounded(t,id('skill-catalog-scroll'),'短窗技能')
}
