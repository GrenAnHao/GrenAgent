interface NavigationError extends Error {
  code?: string;
  errno?: number;
}

const EXPECTED_NAV_ERROR =
  /ERR_(?:ABORTED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_TIMED_OUT|CONNECTION_CLOSED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|NETWORK_ACCESS_DENIED|BLOCKED_BY_CLIENT|INVALID_URL|TOO_MANY_REDIRECTS|EMPTY_RESPONSE|TIMED_OUT|FAILED|CERT_[A-Z_]+|SSL_PROTOCOL_ERROR|PROXY_CONNECTION_FAILED)/;

const NETWORK_TIPS = ['检查网络连接', '检查代理、防火墙和 DNS 配置'];
const ERROR_PAGE_PREFIX = 'data:text/html;charset=utf-8,';

const TOKEN_BY_CODE: Record<number, string> = {
  [-7]: 'ERR_TIMED_OUT',
  [-21]: 'ERR_NETWORK_CHANGED',
  [-100]: 'ERR_CONNECTION_CLOSED',
  [-101]: 'ERR_CONNECTION_RESET',
  [-102]: 'ERR_CONNECTION_REFUSED',
  [-105]: 'ERR_NAME_NOT_RESOLVED',
  [-106]: 'ERR_INTERNET_DISCONNECTED',
  [-107]: 'ERR_SSL_PROTOCOL_ERROR',
  [-109]: 'ERR_ADDRESS_UNREACHABLE',
  [-118]: 'ERR_CONNECTION_TIMED_OUT',
  [-130]: 'ERR_PROXY_CONNECTION_FAILED',
  [-138]: 'ERR_NETWORK_ACCESS_DENIED',
  [-202]: 'ERR_CERT_AUTHORITY_INVALID',
  [-310]: 'ERR_TOO_MANY_REDIRECTS',
  [-324]: 'ERR_EMPTY_RESPONSE',
};

export type BrowserErrorView = {
  title: string;
  summary: string;
  suggestions: string[];
  errorCode: string;
  certificate: boolean;
};

export function isCertificateError(code: number): boolean {
  return code <= -200 && code >= -219;
}

export function isAbortedNavigation(error: unknown): boolean {
  const details = error as NavigationError;
  return details?.code === 'ERR_ABORTED' || details?.errno === -3;
}

export function isExpectedNavigationFailure(error: unknown): boolean {
  if (isAbortedNavigation(error)) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (!message) return false;
  return EXPECTED_NAV_ERROR.test(message) || message.includes('GUEST_VIEW_MANAGER_CALL');
}

export function isBrowserErrorPageUrl(url: string): boolean {
  return url.startsWith(ERROR_PAGE_PREFIX);
}

export function hostFromBrowserUrl(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function errorToken(errorDescription: string | undefined, errorCode: number): string {
  const match = errorDescription?.match(/ERR_[A-Z0-9_]+/);
  if (match) return match[0];
  return TOKEN_BY_CODE[errorCode] ?? 'ERR_FAILED';
}

export function describeBrowserLoadError(input: {
  errorCode: number;
  errorDescription?: string;
  url: string;
}): BrowserErrorView {
  const host = hostFromBrowserUrl(input.url);
  const token = errorToken(input.errorDescription, input.errorCode);
  const certificate = isCertificateError(input.errorCode) || token.startsWith('ERR_CERT');

  if (certificate) {
    return {
      title: '您的连接不是私密连接',
      summary: host ? `攻击者可能试图从 ${host} 窃取您的信息` : '攻击者可能试图窃取您的信息',
      suggestions: ['检查系统时间是否正确'],
      errorCode: token,
      certificate: true,
    };
  }

  if (token === 'ERR_INTERNET_DISCONNECTED') {
    return {
      title: '无互联网连接',
      summary: '您已离线',
      suggestions: NETWORK_TIPS,
      errorCode: token,
      certificate: false,
    };
  }

  const summaryByToken: Record<string, string> = {
    ERR_CONNECTION_REFUSED: `${host} 拒绝建立连接`,
    ERR_NAME_NOT_RESOLVED: `找不到 ${host} 的服务器 IP 地址`,
    ERR_CONNECTION_RESET: `${host} 意外终止了连接`,
    ERR_CONNECTION_CLOSED: `${host} 意外关闭了连接`,
    ERR_CONNECTION_TIMED_OUT: `${host} 用了太长时间才响应`,
    ERR_TIMED_OUT: `${host} 用了太长时间才响应`,
    ERR_ADDRESS_UNREACHABLE: `无法访问 ${host}`,
    ERR_EMPTY_RESPONSE: `${host} 未发送任何数据`,
    ERR_TOO_MANY_REDIRECTS: '此网页包含重定向循环',
    ERR_PROXY_CONNECTION_FAILED: '无法连接到代理服务器',
    ERR_NETWORK_CHANGED: '网络连接已更改',
    ERR_NETWORK_ACCESS_DENIED: '您的网络设置不允许打开此网页',
    ERR_SSL_PROTOCOL_ERROR: `${host} 发送了无效响应`,
    ERR_FAILED: host ? `无法加载 ${host}` : '无法加载此网页',
  };

  return {
    title: '无法访问此站点',
    summary: summaryByToken[token] ?? (host ? `无法打开 ${host}` : '无法加载此网页'),
    suggestions: NETWORK_TIPS,
    errorCode: token,
    certificate: false,
  };
}

export function describeBrowserGuestFailure(reason: string): BrowserErrorView {
  return {
    title: '此网页无法正常运行',
    summary: '网页进程已退出',
    suggestions: ['重新打开此标签页'],
    errorCode: reason,
    certificate: false,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PI_BRAND_ICON = `<svg viewBox="40 56 160 134" xmlns="http://www.w3.org/2000/svg" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="M40 56 H200 V84 H40 Z M74 84 H102 V190 H74 Z M150 84 H178 V190 H150 Z"/></svg>`;

function networkDetailsHtml(): string {
  return `
      <div class="suggestions">
        <div class="suggestion-header">检查你的互联网连接</div>
        <div class="suggestion-body">检查网线，并重启路由器、调制解调器或其他网络设备</div>
      </div>
      <div class="suggestions">
        <div class="suggestion-header">检查 DNS 设置</div>
        <div class="suggestion-body">如果不确定这意味着什么，请联系网络管理员</div>
      </div>
      <div class="suggestions">
        <div class="suggestion-header">允许 GrenAgent 访问网络</div>
        <div class="suggestion-body">如果 GrenAgent 已在防火墙允许列表中，试着移除后再添加一次</div>
      </div>`;
}

export function browserErrorPageUrl(input: {
  errorCode: number;
  errorDescription?: string;
  url: string;
}): string {
  const view = describeBrowserLoadError(input);
  const [firstTip, detailsTip] = view.suggestions;
  const detailsLink = detailsTip
    ? `<li><a id="details-link" href="#details" aria-expanded="false">${escapeHtml(detailsTip)}</a></li>`
    : '';
  const suggestions = firstTip
    ? `<div id="suggestions-list">
          <p>尝试:</p>
          <ul>
            <li>${escapeHtml(firstTip)}</li>
${detailsLink}
          </ul>
        </div>`
    : '';
  const details = view.certificate || !detailsTip ? '' : `<div id="details">${networkDetailsHtml()}</div>`;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(view.title)}</title>
  <style>
    :root {
      --heading-color: #e8eaed;
      --text-color: #9aa0a6;
      --error-code-color: #9aa0a6;
      --link-color: #8ab4f8;
      --button-fill-color: rgba(255,255,255,.08);
      --button-fill-color-active: rgba(255,255,255,.16);
      --button-text-color: #e8eaed;
    }
    html, body { margin: 0; min-height: 100%; background: #202124; color: var(--text-color); font-family: system-ui, sans-serif; }
    .interstitial-wrapper { box-sizing: border-box; font-size: 1em; line-height: 1.6em; margin: 20vh auto 0; max-width: 600px; width: 100%; padding: 0 48px 48px; }
    .icon { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; margin: 0 0 24px; color: var(--link-color); animation: icon-spin 3s linear infinite; transform-origin: 50% 50%; }
    .icon svg { width: 28px; height: 28px; }
    @keyframes icon-spin { 100% { transform: rotate(360deg); } }
    h1 { color: var(--heading-color); font-size: 1.2em; font-weight: 500; line-height: 1.2em; margin: 0 0 12px; }
    #main-message > p { margin: 0; font-size: 1em; }
    #suggestions-list { margin-top: 18px; }
    #suggestions-list p { margin: 0; }
    #suggestions-list ul { margin: 0; padding-left: 1.25em; }
    #suggestions-list a { color: var(--link-color); text-decoration: none; }
    #suggestions-list a:hover { text-decoration: underline; }
    .error-code { color: var(--error-code-color); font-size: .8em; margin-top: 24px; text-transform: uppercase; }
    .nav-wrapper { display: flex; gap: 8px; justify-content: flex-start; margin-top: 51px; }
    button { background: var(--button-fill-color); border: 0; border-radius: 8px; box-sizing: border-box; color: var(--button-text-color); cursor: pointer; display: inline-flex; align-items: center; font: 500 13px/18px inherit; min-height: 28px; padding: 0 8px; }
    button:hover, button:active { background: var(--button-fill-color-active); }
    #details { display: none; margin: 24px 0 0; }
    #main-frame-error.showing-details #details { display: block; }
    .suggestions { margin-top: 18px; }
    .suggestion-header { color: var(--heading-color); font-weight: 700; margin-bottom: 4px; }
    .suggestion-body { color: var(--text-color); }
    @media (max-width: 420px) {
      .interstitial-wrapper { margin: 7vh auto 12px; padding: 0 24px; }
      .nav-wrapper { margin-top: 30px; }
    }
  </style>
</head>
<body class="neterror" data-gren-browser-error="1">
  <div id="main-frame-error" class="interstitial-wrapper">
    <div id="main-content">
      <div class="icon" aria-hidden="true">${PI_BRAND_ICON}</div>
      <div id="main-message">
        <h1>${escapeHtml(view.title)}</h1>
        <p>${escapeHtml(view.summary)}</p>
        ${suggestions}
        <div class="error-code">${escapeHtml(view.errorCode)}</div>
      </div>
    </div>
    <div id="buttons" class="nav-wrapper">
      <button id="reload-button" type="button">重新加载</button>
    </div>
    ${details}
  </div>
  <script>
    (() => {
      const failedUrl = ${JSON.stringify(input.url)};
      const main = document.getElementById("main-frame-error");
      const detailsLink = document.getElementById("details-link");
      document.getElementById("reload-button")?.addEventListener("click", () => { location.href = failedUrl; });
      detailsLink?.addEventListener("click", (event) => {
        event.preventDefault();
        const visible = !main.classList.contains("showing-details");
        main.classList.toggle("showing-details", visible);
        detailsLink.setAttribute("aria-expanded", String(visible));
      });
    })();
  </script>
</body>
</html>`;
  return ERROR_PAGE_PREFIX + encodeURIComponent(html);
}
