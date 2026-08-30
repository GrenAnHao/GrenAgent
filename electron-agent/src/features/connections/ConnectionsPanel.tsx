import { Button, Flexbox, Icon } from '@lobehub/ui';
import { Modal, Switch } from 'antd';
import { cssVar } from 'antd-style';
import { MessageSquare, Settings2 } from 'lucide-react';
import { type CSSProperties, useEffect, useState } from 'react';
import { useImMessagesStore } from '../../stores/imMessagesStore';
import { useWechatStatusStore } from '../../stores/wechatStatusStore';
import { SettingFieldInput } from '../settings/SettingField';
import { WECHAT_FIELDS } from '../settings/settingsSchema';
import { useSettingsForm } from '../settings/useSettingsForm';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

const isOn = (v: string | undefined): boolean => v === '1' || v?.toLowerCase() === 'true';

// 对话气泡：用户消息靠右、主色实底；助手回复靠左、表面色。只读镜像，不可编辑。
const bubbleStyle = (role: 'user' | 'assistant'): CSSProperties => ({
  alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
  maxWidth: '82%',
  padding: '6px 10px',
  borderRadius: 9,
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: role === 'user' ? cssVar.colorPrimary : 'var(--gren-surface, rgba(255,255,255,0.06))',
  // 主色实底上的文字用 colorTextLightSolid，而不是写死白色：暗色主题下 colorPrimary 可能是
  // 高亮度色（lobe 默认就是近白的中性主色），白字叠上去等于看不见。
  color: role === 'user' ? cssVar.colorTextLightSolid : cssVar.colorText,
});

// 网络配置项（齿轮弹窗）= 微信字段去掉「启用」开关本身（启用由卡片上的接入开关控制）。
const WECHAT_SETTING_FIELDS = WECHAT_FIELDS.filter((f) => f.key !== 'WECHAT_OC_ENABLE');

export function ConnectionsPanel() {
  const { values, setValue, persist, saving, loading, error } = useSettingsForm();
  const wechat = useWechatStatusStore((s) => s.wechat);
  const conversations = useImMessagesStore((s) => s.conversations);
  const [qrOpen, setQrOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [msgsOpen, setMsgsOpen] = useState(false);
  const totalMessages = conversations.reduce((n, c) => n + c.messages.length, 0);

  // 登录成功后短暂展示再自动关闭扫码弹窗。
  useEffect(() => {
    if (!qrOpen || !wechat.loggedIn) return;
    const t = window.setTimeout(() => setQrOpen(false), 1200);
    return () => window.clearTimeout(t);
  }, [qrOpen, wechat.loggedIn]);

  const wechatEnabled = isOn(values.WECHAT_OC_ENABLE);
  const wechatLabel = !wechatEnabled
    ? '未启用'
    : wechat.loggedIn
      ? '已登录'
      : wechat.status === 'waiting-scan'
        ? '待扫码'
        : '连接中…';
  const wechatColor = wechat.loggedIn ? cssVar.colorSuccess : wechatEnabled ? cssVar.colorWarning : muted;

  // 仅在后端真正进入「待扫码」时自动弹二维码：已绑定（持久 token）开启会直接登录，不该弹扫码窗。
  useEffect(() => {
    if (wechatEnabled && !wechat.loggedIn && wechat.status === 'waiting-scan' && wechat.qrLink) {
      setQrOpen(true);
    }
  }, [wechatEnabled, wechat.loggedIn, wechat.status, wechat.qrLink]);

  // 接入开关与网络配置：均热更新（persist 写盘 → sidecar watchConfig 重连），无需重启。
  const toggleWechat = async (on: boolean) => {
    setValue('WECHAT_OC_ENABLE', on ? '1' : '0');
    await persist();
    // 不再无条件弹扫码：已绑定（持久 token）开启会直接登录；仅当后端真正 waiting-scan 时由上方 effect 弹窗。
  };
  const saveWechatSettings = async () => {
    await persist();
    setSettingsOpen(false);
  };

  return (
    <Flexbox data-testid="connections-panel" style={{ height: '100%', minHeight: 0, overflowY: 'auto' }}>
      <Flexbox
        horizontal
        align="center"
        style={{ padding: '10px 14px', borderBottom: border, flex: '0 0 auto' }}
      >
        <span style={{ fontSize: 13 }}>IM 接入{loading ? ' · 加载中…' : ''}</span>
      </Flexbox>
      {error && <div style={{ padding: '6px 14px', fontSize: 12, color: cssVar.colorError }}>{error}</div>}

      <div style={{ padding: 16, maxWidth: 600 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBlockEnd: 8 }}>平台接入</div>

        {/* 微信（官方 ilink 智能 bot）—— 接入开关弹二维码、齿轮配网络，全部热更 */}
        <Flexbox
          data-testid="wechat-card"
          style={{ border, borderRadius: 10, padding: '11px 13px', marginBlockEnd: 10 }}
          gap={4}
        >
          <Flexbox horizontal align="center" gap={10}>
            <Icon icon={MessageSquare} size={16} />
            <Flexbox style={{ flex: 1, minWidth: 0 }} gap={1}>
              <Flexbox horizontal align="center" gap={8}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>微信</span>
                <span style={{ fontSize: 11, color: wechatColor }}>{wechatLabel}</span>
              </Flexbox>
              <span style={{ fontSize: 11, color: muted }}>官方智能对话 bot（ilink），扫码登录即用，无需公网</span>
            </Flexbox>
            <Button
              size="small"
              icon={<Settings2 size={14} />}
              title="网络配置"
              data-testid="wechat-settings"
              onClick={() => setSettingsOpen(true)}
            />
            <Switch
              size="small"
              checked={wechatEnabled}
              loading={saving}
              data-testid="wechat-enable"
              onChange={(on) => void toggleWechat(on)}
            />
          </Flexbox>
          {wechatEnabled && !wechat.loggedIn ? (
            <button
              type="button"
              data-testid="wechat-show-qr"
              onClick={() => setQrOpen(true)}
              style={{
                alignSelf: 'flex-start',
                marginInlineStart: 26,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: cssVar.colorPrimary,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {wechat.qrLink ? '显示登录二维码' : '获取二维码中…'}
            </button>
          ) : null}

          {/* 微信会话只读镜像：微信启用即常驻入口，无消息给空态。主人会话不含微信流量，这里是 UI 唯一能看到「微信聊了什么」的地方 */}
          {wechatEnabled ? (
            <div style={{ marginInlineStart: 26, marginBlockStart: 2 }}>
              <button
                type="button"
                data-testid="wechat-msgs-toggle"
                onClick={() => setMsgsOpen(true)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: muted,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                <Icon icon={MessageSquare} size={12} />
                微信会话记录（{totalMessages}）
              </button>
            </div>
          ) : null}
        </Flexbox>
      </div>

      {/* 扫码弹窗 */}
      <Modal
        open={qrOpen}
        title="微信扫码登录"
        footer={null}
        width={380}
        onCancel={() => setQrOpen(false)}
        data-testid="wechat-qr-modal"
      >
        <Flexbox align="center" gap={12} style={{ padding: '8px 0 4px' }}>
          {wechat.loggedIn ? (
            <span style={{ fontSize: 14, color: cssVar.colorSuccess }}>微信已登录，可直接给 bot 发消息遥控 Pi。</span>
          ) : wechat.qrLink ? (
            <>
              <img
                src={wechat.qrLink}
                alt="微信登录二维码"
                width={240}
                height={240}
                style={{ borderRadius: 8, background: '#fff', padding: 6 }}
              />
              <span style={{ fontSize: 12, color: muted }}>用手机微信「扫一扫」登录，二维码 5 分钟内有效（过期自动刷新）。</span>
            </>
          ) : (
            <span style={{ fontSize: 13, color: muted }}>正在获取二维码…（请确保已启用微信接入）</span>
          )}
        </Flexbox>
      </Modal>

      {/* 会话记录弹窗 */}
      <Modal
        open={msgsOpen}
        title={`微信会话记录（${totalMessages}）`}
        footer={null}
        width={520}
        onCancel={() => setMsgsOpen(false)}
        data-testid="wechat-msgs-modal"
        styles={{ body: { maxHeight: '60vh', overflowY: 'auto', padding: '12px 0 4px' } }}
      >
        {totalMessages > 0 ? (
          <Flexbox gap={12} data-testid="wechat-msgs">
            {conversations.map((conv) => (
              <Flexbox key={conv.user} gap={6}>
                {conversations.length > 1 ? (
                  <span style={{ fontSize: 10, color: muted, alignSelf: 'center' }}>{conv.user}</span>
                ) : null}
                {conv.messages.map((m, i) => (
                  <div key={`${conv.user}-${i}`} style={bubbleStyle(m.role)}>{m.text}</div>
                ))}
              </Flexbox>
            ))}
          </Flexbox>
        ) : (
          <span data-testid="wechat-msgs-empty" style={{ fontSize: 13, color: muted }}>
            暂无微信会话；微信登录后，收发的消息会镜像到这里。
          </span>
        )}
      </Modal>

      {/* 网络配置弹窗（齿轮） */}
      <Modal
        open={settingsOpen}
        title="微信网络配置"
        okText="保存"
        cancelText="取消"
        onOk={() => void saveWechatSettings()}
        onCancel={() => setSettingsOpen(false)}
        confirmLoading={saving}
        width={460}
        data-testid="wechat-settings-modal"
      >
        <div style={{ fontSize: 12, color: muted, marginBlockEnd: 10 }}>
          留空 bot_token 则启用后扫码登录；改动保存即热更新（无需重启）。
        </div>
        {WECHAT_SETTING_FIELDS.map((f) => (
          <SettingFieldInput
            key={f.key}
            field={f}
            value={values[f.key] ?? ''}
            onChange={(v) => setValue(f.key, v)}
            testIdPrefix="conn-field"
          />
        ))}
      </Modal>
    </Flexbox>
  );
}
