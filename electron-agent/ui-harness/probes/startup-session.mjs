export default async function (t) {
  const { body, workspace, path, other, scratch } = await t.data();
  const reached = (event) => t.waitUntil(`window.__uiEvents.includes(${JSON.stringify(event)})`, 10000);
  const broad = (events) => events.filter(e => /^(list_|unexpected:|draft:|prune:)/.test(e));
  async function failedLaunch() {
    await t.act('failNextLaunch');
    await new Promise(resolve => {
      t.win.webContents.once('did-finish-load', resolve);
      t.win.webContents.reload();
    });
    return t.waitForText('.ant-modal', '文件正在被其他程序使用');
  }
  t.ok('只定点查询上次的会话路径', await reached('lookup:' + path));
  t.check('定点读取未完成时，不扫描任何目录', broad(await t.events()), []);
  await t.act('lookup');
  t.ok('用迁移后的归属打开记录并读取同一份正文', await reached('history:' + workspace + ':' + path));
  t.ok('正文未到仍是启动页，不闪空草稿', await t.count('#boot-splash:not(.is-leaving)') === 1);
  t.check('恢复正文时项目和全量列表都没有抢跑', broad(await t.events()), []);
  await t.act('history');
  t.ok('不用等待目录即可看到上次的正文', await t.waitForText('body', body));
  t.ok('全量列表和项目登记均在就绪后拉取', await reached('list_all_sessions:ready') && await reached('list_projects:ready'));
  t.ok('全量目录还没有返回，启动页已消失', await t.waitUntil("!document.getElementById('boot-splash')"));
  await t.click('[aria-label="收起会话列表"]');
  t.ok('目录未返回时窗口已经可操作', await t.waitFor('[aria-label="展开会话列表"]'));
  await t.click('[aria-label="展开会话列表"]');
  await t.act('directory');
  t.ok('全量目录完成后才清理，并且保留原空草稿', await reached('prune:' + JSON.stringify([scratch])));
  t.ok('后台载入其他会话但不切换当前正文', await t.waitForText('body', other) && (await t.text('body')).includes(body));
  t.check('冷启动只发一次全局列表，没有额外单项目扫描', (await t.events()).filter(e => e.startsWith('list_all_sessions') || e === 'unexpected:project-list'), ['list_all_sessions:ready']);
  await t.shot('restored-session');
  const remembered = await t.act('remembered');
  t.ok('定点读取错误展示具体原因与重试入口', await failedLaunch());
  t.ok('错误态撤下全屏遮罩', await t.waitUntil("!document.getElementById('boot-splash')"));
  t.ok('默认键盘焦点在重试恢复，不会误建新对话', await t.waitUntil("document.activeElement?.matches('.ant-modal .ant-btn-primary')"));
  await t.shot('restore-error');
  t.check('查询失败不是目标已删除：不新建、不清理、不覆盖记忆', [broad(await t.events()), await t.act('remembered')], [[], remembered]);
  await t.click('.ant-modal .ant-btn-primary');
  await t.act('lookup');
  await t.act('history');
  t.ok('真实点击重试后重新显示原对话', await t.waitForText('body', body));
  t.check('重试只再核对同一份记录', (await t.events()).filter(e => e.startsWith('lookup:')), ['lookup:' + path, 'lookup:' + path]);
  t.ok('重试恢复后才开启后台补齐', await reached('list_all_sessions:ready'));
  t.check('过期空目录既不覆盖当前项目列表，也不抹掉全局目录中的恢复项', await t.act('expireDirectory'), [[path], [path]]);
  t.ok('再次遇到文件错误时可以主动选择新建', await failedLaunch());
  await t.key('Escape');
  t.check('Esc 不替用户放弃原会话，也不创建草稿', [await t.countVisible('.ant-modal'), broad(await t.events())], [1, []]);
  await t.act('failNextDraft');
  const newButton = '.ant-modal .ant-modal-footer button:not(.ant-btn-primary)';
  await t.click(newButton);
  t.ok('新建失败显示具体原因，仍可重试', await t.waitForText('.ant-modal', '暂时无法创建对话目录'));
  t.check('新草稿未创建成功前仍保留原位置', await t.act('remembered'), remembered);
  await t.click(newButton);
  t.ok('显式新建走到可输入的空草稿，不再留在骨架屏', await t.waitFor('[data-testid="empty-chat-prompt"]'));
  const draft = await t.act('remembered');
  t.ok('新草稿确认后才更改上次位置', draft.workspace.endsWith('/works/new') && draft.sessionPath === null && draft.draftId.startsWith('draft:'));
}
