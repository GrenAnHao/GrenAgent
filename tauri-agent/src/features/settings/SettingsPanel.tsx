import { Flexbox, Icon } from '@lobehub/ui';
import { createStyles } from 'antd-style';
import { useEffect, useState } from 'react';
import { SETTINGS_SCHEMA, SETTING_GROUPS, type SettingCategory } from './settingsSchema';
import { SettingCard } from './SettingCard';
import { SettingFieldInput } from './SettingField';
import { useSettingsForm } from './useSettingsForm';
import { AppearanceSettings } from './AppearanceSettings';
import { ProvidersSettings } from './ProvidersSettings';
import { CapabilityModelField } from './CapabilityModelField';
import { migratePhase2 } from './phase2Migration';
import { pi } from '../../lib/pi';

const useStyles = createStyles(({ css, token }) => ({
  root: css`
    height: 100%;
    min-height: 0;
  `,
  saveBtn: css`
    padding: 5px 18px;
    border: 1px solid ${token.colorBorder};
    border-radius: ${token.borderRadius}px;
    cursor: pointer;
    background: ${token.colorFillSecondary};
    color: ${token.colorText};
    font-size: 12px;
    &:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
  `,
  body: css`
    display: flex;
    flex: 1;
    min-height: 0;
  `,
  nav: css`
    width: 220px;
    flex: 0 0 auto;
    border-inline-end: 1px solid ${token.colorBorderSecondary};
    overflow-y: auto;
    padding: 12px 8px;
  `,
  groupTitle: css`
    padding: 12px 12px 4px;
    font-size: 12px;
    color: ${token.colorTextDescription};
  `,
  navItem: css`
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 12px;
    border: none;
    border-radius: ${token.borderRadius}px;
    cursor: pointer;
    text-align: start;
    background: transparent;
    color: ${token.colorTextSecondary};
    font-size: 13px;
    &:hover {
      background: ${token.colorFillTertiary};
    }
  `,
  navItemActive: css`
    background: ${token.colorFillSecondary};
    color: ${token.colorText};
  `,
  content: css`
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  `,
  scroll: css`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 24px;
  `,
  pageTitle: css`
    font-size: 18px;
    font-weight: 600;
    color: ${token.colorText};
    margin-block-end: 16px;
  `,
  inner: css`
    max-width: 720px;
  `,
  innerWide: css`
    max-width: none;
  `,
  footer: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex: 0 0 auto;
    padding: 10px 24px;
    border-block-start: 1px solid ${token.colorBorderSecondary};
  `,
  footerMsg: css`
    font-size: 13px;
    color: ${token.colorTextSecondary};
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  footerMsgError: css`
    color: ${token.colorError};
  `,
}));

export function SettingsPanel() {
  const { styles, cx } = useStyles();
  const { values, setValue, persist, saving, loading, error, dirty } = useSettingsForm();
  const [activeId, setActiveId] = useState(SETTINGS_SCHEMA[0].id);
  const cat: SettingCategory = SETTINGS_SCHEMA.find((c) => c.id === activeId) ?? SETTINGS_SCHEMA[0];
  const sections = cat.sections ?? [{ title: '', fields: cat.fields ?? [] }];

  // 一次性迁移：旧 IMAGE/TTS/KB_EMBED/MEMORY_EMBED 的 key/baseURL → provider+model（幂等）。
  useEffect(() => {
    void (async () => {
      const [settings, cfg] = await Promise.all([pi.getSettings(), pi.getProviderConfig()]);
      const r = migratePhase2(settings, cfg.modelsJson, cfg.authJson);
      if (!r.changed) return;
      await pi.setProviderConfig(r.modelsJson, r.authJson);
      await pi.setSettings(r.nextSettings);
    })().catch(() => {});
  }, []);

  const showSaveBar = activeId !== 'providers' && activeId !== 'appearance';

  return (
    <Flexbox className={styles.root} data-testid="settings-panel">
      <div className={styles.body}>
        <nav className={styles.nav}>
          {SETTING_GROUPS.map((g) => {
            const items = SETTINGS_SCHEMA.filter((c) => c.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <div className={styles.groupTitle}>{g}</div>
                {items.map((c) => (
                  <button
                    key={c.id}
                    data-testid={`set-cat-${c.id}`}
                    onClick={() => setActiveId(c.id)}
                    className={cx(styles.navItem, c.id === activeId && styles.navItemActive)}
                  >
                    <Icon icon={c.icon} size={16} />
                    {c.title}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        <div className={styles.content}>
          <div className={styles.scroll}>
            <div className={cx(styles.inner, activeId === 'providers' && styles.innerWide)}>
              <div className={styles.pageTitle}>{cat.title}</div>
              {activeId === 'appearance' ? (
                <AppearanceSettings />
              ) : activeId === 'providers' ? (
                <ProvidersSettings />
              ) : (
                sections.map((sec, i) => (
                  <SettingCard key={sec.title || i} title={sec.title || undefined}>
                    {sec.fields.map((f) =>
                      f.type === 'capability' ? (
                        <CapabilityModelField key={f.key} field={f} values={values} setValue={setValue} />
                      ) : (
                        <SettingFieldInput
                          key={f.key}
                          field={f}
                          value={values[f.key] ?? ''}
                          onChange={(v) => setValue(f.key, v)}
                        />
                      ),
                    )}
                  </SettingCard>
                ))
              )}
            </div>
          </div>
          {showSaveBar ? (
            <div className={styles.footer}>
              <span className={cx(styles.footerMsg, !!error && styles.footerMsgError)}>
                {error ? error : loading ? '加载中…' : dirty ? '有未保存改动' : '手动保存，无需重启'}
              </span>
              <button
                data-testid="set-save"
                onClick={() => void persist()}
                disabled={saving || !dirty}
                className={styles.saveBtn}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </Flexbox>
  );
}
