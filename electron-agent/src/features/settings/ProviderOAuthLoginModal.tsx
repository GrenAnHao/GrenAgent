import { Alert, Button, Input, Modal, Space, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Channel } from '../../platform/runtime';
import { pi, type ProviderLoginUiEvent, type ProviderOAuthCapability } from '../../lib/pi';

const { Text, Paragraph } = Typography;

interface Props {
  providerId: string;
  providerName: string;
  capability: ProviderOAuthCapability;
  /** 凭据已写入：让设置页重查状态，不动未保存的模型草稿。 */
  onDone: () => void;
  onClose: () => void;
}

interface PromptView {
  promptId: string;
  type: string;
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
}

interface ViewState {
  phase: 'waiting' | 'error' | 'done';
  message: string;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  prompt?: PromptView;
}

const initialView: ViewState = { phase: 'waiting', message: '正在准备登录…' };

/** 官方 OAuth flow 的交互界面：授权链接、设备码、手动回调码、进度、取消与错误重试。 */
export function ProviderOAuthLoginModal({ providerId, providerName, capability, onDone, onClose }: Props) {
  const [view, setView] = useState<ViewState>(initialView);
  const [manualValue, setManualValue] = useState('');
  const [selectValue, setSelectValue] = useState<string | null>(null);
  const loginIdRef = useRef<string | null>(null);

  const start = useCallback(async () => {
    const channel = new Channel<ProviderLoginUiEvent>();
    channel.onmessage = (event) => {
      // 所有事件都带 loginId / providerId；只处理当前这一轮，避免切换供应商后串台。
      loginIdRef.current = event.loginId;
      if (event.providerId !== providerId) return;
      switch (event.type) {
        case 'info':
        case 'progress':
          setView((prev) => ({ ...prev, message: event.message ?? '正在等待授权…' }));
          break;
        case 'auth_url':
          setView((prev) => ({ ...prev, url: event.url, instructions: event.instructions, message: '请在浏览器中完成授权' }));
          break;
        case 'device_code':
          setView((prev) => ({
            ...prev, userCode: event.userCode, verificationUri: event.verificationUri,
            message: '请在验证页面输入下方用户码',
          }));
          break;
        case 'prompt':
          setManualValue('');
          setSelectValue(null);
          setView((prev) => ({
            ...prev, phase: 'waiting',
            prompt: {
              promptId: event.promptId!, type: event.prompt!.type,
              message: event.prompt!.message, placeholder: event.prompt!.placeholder,
              options: event.prompt!.options,
            },
          }));
          break;
        case 'prompt_cancelled':
          setView((prev) => (prev.prompt?.promptId === event.promptId ? { ...prev, prompt: undefined } : prev));
          break;
        case 'done':
          setView((prev) => ({ ...prev, phase: 'done', message: '登录成功', prompt: undefined }));
          onDone();
          break;
        case 'error':
          setView((prev) => ({ ...prev, phase: 'error', message: event.message ?? '登录失败', prompt: undefined }));
          break;
      }
    };
    try {
      await pi.startProviderLogin(providerId, channel);
    } catch (error) {
      setView((prev) => ({
        ...prev, phase: 'error',
        message: `登录失败：${error instanceof Error ? error.message : String(error)}`,
      }));
    }
  }, [providerId, onDone]);

  useEffect(() => { void start(); }, [start]);

  const cancel = () => {
    if (loginIdRef.current) void pi.cancelProviderLogin(loginIdRef.current);
    onClose();
  };

  const retry = () => {
    setView(initialView);
    setManualValue('');
    void start();
  };

  const submitPrompt = (value: string) => {
    if (!view.prompt || !value.trim()) return;
    void pi.respondProviderLoginPrompt(view.prompt.promptId, value.trim());
    setView((prev) => ({ ...prev, prompt: undefined }));
  };

  const copy = (value: string | undefined) => {
    if (value) void navigator.clipboard?.writeText(value).catch(() => {});
  };

  return (
    <Modal
      open
      title={`登录 ${providerName}`}
      data-testid="prov-oauth-modal"
      onCancel={cancel}
      maskClosable={false}
      footer={
        view.phase === 'done'
          ? <Button type="primary" data-testid="prov-oauth-finish" onClick={onClose}>完成</Button>
          : <Space>
              {view.phase === 'error'
                ? <Button data-testid="prov-oauth-retry" onClick={retry}>重新登录</Button>
                : null}
              <Button data-testid="prov-oauth-cancel" onClick={cancel}>取消</Button>
            </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div data-testid="prov-oauth-progress">
          <Text type={view.phase === 'error' ? 'danger' : 'secondary'}>{view.message}</Text>
        </div>
        {capability.isSubscription ? <Text type="secondary">使用订阅账号登录，不占用 API Key 额度。</Text> : null}

        {view.url ? (
          <div>
            <Paragraph style={{ marginBottom: 4 }}><Text strong>授权链接</Text></Paragraph>
            <Paragraph data-testid="prov-oauth-url" copyable={{ text: view.url }} style={{ wordBreak: 'break-all', marginBottom: 4 }}>
              {view.url}
            </Paragraph>
            {view.instructions ? <Text type="secondary">{view.instructions}</Text> : null}
            <div>
              <a href={view.url} target="_blank" rel="noreferrer" data-testid="prov-oauth-open">在浏览器打开</a>
              {' · '}
              <a data-testid="prov-oauth-copy-url" onClick={() => copy(view.url)}>复制链接</a>
            </div>
          </div>
        ) : null}

        {view.userCode ? (
          <div>
            <Paragraph style={{ marginBottom: 4 }}><Text strong>用户码</Text></Paragraph>
            <Text data-testid="prov-oauth-user-code" style={{ fontSize: 20, letterSpacing: 2 }} code>{view.userCode}</Text>
            <div>
              <a data-testid="prov-oauth-copy-code" onClick={() => copy(view.userCode)}>复制用户码</a>
              {view.verificationUri
                ? <>{' · '}<a href={view.verificationUri} target="_blank" rel="noreferrer">打开验证页面</a></>
                : null}
            </div>
          </div>
        ) : null}

        {view.prompt ? (
          <div>
            <Paragraph style={{ marginBottom: 4 }}><Text strong>{view.prompt.message}</Text></Paragraph>
            {view.prompt.options?.length ? (
              <Space wrap>
                {view.prompt.options.map((option) => (
                  <Button
                    key={option.id}
                    data-testid={`prov-oauth-option-${option.id}`}
                    type={selectValue === option.id ? 'primary' : 'default'}
                    onClick={() => { setSelectValue(option.id); submitPrompt(option.id); }}
                  >
                    {option.label}
                  </Button>
                ))}
              </Space>
            ) : (
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  data-testid="prov-oauth-manual-input"
                  type={view.prompt.type === 'secret' ? 'password' : 'text'}
                  placeholder={view.prompt.placeholder ?? '粘贴回调码'}
                  value={manualValue}
                  onChange={(e) => setManualValue(e.target.value)}
                  onPressEnter={() => submitPrompt(manualValue)}
                />
                <Button
                  type="primary"
                  data-testid="prov-oauth-manual-submit"
                  disabled={!manualValue.trim()}
                  onClick={() => submitPrompt(manualValue)}
                >提交</Button>
              </Space.Compact>
            )}
          </div>
        ) : null}

        {view.phase === 'error' ? (
          <Alert type="error" showIcon data-testid="prov-oauth-error" message={view.message} />
        ) : null}
        {view.phase === 'done' ? (
          <Alert type="success" showIcon message="凭据已保存，可用模型已刷新。" />
        ) : null}
      </Space>
    </Modal>
  );
}
