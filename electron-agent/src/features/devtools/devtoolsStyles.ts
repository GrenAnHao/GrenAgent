import { createStaticStyles, cssVar } from 'antd-style';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: ${cssVar.colorText};
    background: ${cssVar.colorBgLayout};
  `,

  header: css`
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 58px;
    padding: 10px 18px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgContainer};
  `,
  identity: css`
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  `,
  icon: css`
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 7px;
    background: ${cssVar.colorPrimaryBg};
    color: ${cssVar.colorPrimary};
  `,
  title: css`
    font-size: 16px;
    font-weight: 600;
    line-height: 1.3;
  `,
  subtitle: css`
    overflow: hidden;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  headerActions: css`
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
  `,
  badge: css`
    padding: 2px 8px;
    border-radius: 999px;
    background: ${cssVar.colorWarningBg};
    color: ${cssVar.colorWarningText};
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
  `,

  nav: css`
    display: flex;
    flex: 0 0 auto;
    gap: 2px;
    padding: 6px 14px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgContainer};
  `,
  tab: css`
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;

    &:hover {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorText};
    }
  `,
  tabActive: css`
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorText};
    font-weight: 600;
  `,

  body: css`
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
  `,
  scroll: css`
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px 18px 24px;
  `,
  error: css`
    margin-block-end: 12px;
    padding: 8px 12px;
    border: 1px solid ${cssVar.colorErrorBorder};
    border-radius: ${cssVar.borderRadius}px;
    background: ${cssVar.colorErrorBg};
    color: ${cssVar.colorErrorText};
    font-size: 12px;
  `,
  state: css`
    padding: 24px 0;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    text-align: center;
  `,

  toolbar: css`
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  toolbarSpacer: css`
    flex: 1;
  `,

  button: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius}px;
    cursor: pointer;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorText};
    font-size: 12px;

    &:hover:not(:disabled) {
      background: ${cssVar.colorFillSecondary};
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
  `,
  buttonPrimary: css`
    border-color: ${cssVar.colorPrimaryBorder};
    background: ${cssVar.colorPrimaryBg};
    color: ${cssVar.colorPrimaryText};

    &:hover:not(:disabled) {
      background: ${cssVar.colorPrimaryBgHover};
    }
  `,
  iconButton: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius}px;
    cursor: pointer;
    background: transparent;
    color: ${cssVar.colorTextSecondary};

    &:hover:not(:disabled) {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorText};
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
  `,

  input: css`
    min-width: 0;
    padding: 5px 10px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius}px;
    background: ${cssVar.colorBgContainer};
    color: ${cssVar.colorText};
    font-size: 12px;
    font-family: ${mono};

    &:focus {
      border-color: ${cssVar.colorPrimaryBorder};
      outline: none;
    }
  `,
  textarea: css`
    width: 100%;
    min-height: 92px;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius}px;
    background: ${cssVar.colorBgContainer};
    color: ${cssVar.colorText};
    font-size: 12px;
    font-family: ${mono};
    line-height: 1.55;
    resize: vertical;

    &:focus {
      border-color: ${cssVar.colorPrimaryBorder};
      outline: none;
    }
  `,
  select: css`
    padding: 5px 8px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius}px;
    background: ${cssVar.colorBgContainer};
    color: ${cssVar.colorText};
    font-size: 12px;

    &:focus {
      border-color: ${cssVar.colorPrimaryBorder};
      outline: none;
    }
  `,

  section: css`
    margin-block-end: 18px;
  `,
  sectionTitle: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-block-end: 8px;
  `,
  heading: css`
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  hint: css`
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
  `,

  card: css`
    padding: 12px 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG}px;
    background: ${cssVar.colorBgContainer};
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG}px;
    background: ${cssVar.colorBorderSecondary};
  `,
  gridItem: css`
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 12px;
    background: ${cssVar.colorBgContainer};
  `,
  gridLabel: css`
    flex: 0 0 108px;
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
  `,
  gridValue: css`
    min-width: 0;
    flex: 1;
    overflow-wrap: anywhere;
    font-size: 12px;
    font-family: ${mono};
  `,

  list: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  row: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius}px;
    background: ${cssVar.colorBgContainer};
    font-size: 12px;
  `,
  rowHead: css`
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  `,
  rowTime: css`
    flex: 0 0 auto;
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
    font-family: ${mono};
  `,
  tag: css`
    flex: 0 0 auto;
    padding: 1px 6px;
    border-radius: 4px;
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorTextSecondary};
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.03em;
  `,
  tagOk: css`
    background: ${cssVar.colorSuccessBg};
    color: ${cssVar.colorSuccessText};
  `,
  tagError: css`
    background: ${cssVar.colorErrorBg};
    color: ${cssVar.colorErrorText};
  `,
  rowSummary: css`
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ${mono};
  `,
  rowBody: css`
    max-height: 320px;
    margin: 0;
    padding: 8px 10px;
    overflow: auto;
    border-radius: 6px;
    background: ${cssVar.colorFillQuaternary};
    font-size: 11px;
    font-family: ${mono};
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  `,
  clickable: css`
    cursor: pointer;
  `,

  meter: css`
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 11px;
    color: ${cssVar.colorTextSecondary};
  `,
  meterBar: css`
    flex: 1;
    height: 6px;
    overflow: hidden;
    border-radius: 3px;
    background: ${cssVar.colorFillSecondary};
  `,
  meterFill: css`
    height: 100%;
    border-radius: 3px;
    background: ${cssVar.colorPrimary};
  `,

  mono: css`
    font-family: ${mono};
  `,
  muted: css`
    color: ${cssVar.colorTextTertiary};
  `,
  nowrap: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));
