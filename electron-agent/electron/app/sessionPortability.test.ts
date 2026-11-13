import { expect,it } from 'vitest';
import { isolateSessionHtml } from './sessionPortability.js';
it('HTML isolates trusted viewer scripts from tool HTML and prevents remote automatic resources',()=>{
 const data=Buffer.from(JSON.stringify({entries:[{text:'</script><script>globalThis.pwned=1</script>'}],renderedTools:{x:{callHtml:'<img src=https://evil.invalid/x onerror=alert(1)>'}}})).toString('base64');
 const html=isolateSessionHtml(`<html><head></head><body><script id="session-data" type="application/json">${data}</script><script>function image(token) { return '<img src="'+token.href+'">'; }</script></body></html>`);
 expect(html).toContain('Content-Security-Policy');expect(html).toContain("connect-src 'none'");expect(html).toContain("img-src data:");expect(html).not.toContain('<img src=https://evil');expect(html).toMatch(/script nonce=/);
});
