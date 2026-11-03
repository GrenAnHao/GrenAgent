import { Button, Popover } from 'antd';
import { AppearanceSettings } from '../../src/features/settings/AppearanceSettings';
import { useThemeStore } from '../../src/stores/themeStore';
import { WorkbenchThemeProvider } from '../../src/theme/WorkbenchThemeProvider';

useThemeStore.setState({ appearance: 'dark', fontSize: 14 });

export default function AppearanceSettingsScenario() {
  const appearance = useThemeStore((state) => state.appearance);
  return (
    <WorkbenchThemeProvider appearance={appearance}>
      <main
        data-testid="appearance-stage"
        style={{ height: '100vh', padding: 32, background: 'var(--gren-content-bg)', color: 'var(--gren-text)', boxSizing: 'border-box' }}
      >
        <div style={{ maxWidth: 720 }}>
          <AppearanceSettings />
          <p data-testid="appearance-font-sample" style={{ fontSize: 'var(--pi-font-size)' }}>对话字号预览</p>
          <output data-testid="appearance-state">{appearance}</output>
          <Popover
            trigger="click"
            content={<div data-testid="appearance-popup">外观预览</div>}
          >
            <Button data-testid="appearance-popup-trigger" style={{ marginLeft: 24 }}>打开弹层</Button>
          </Popover>
        </div>
      </main>
    </WorkbenchThemeProvider>
  );
}
