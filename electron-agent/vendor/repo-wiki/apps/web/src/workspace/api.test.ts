import { describe, it, expect, vi } from "vitest";
import { request, pageUrl } from "./api";
describe("workspace API client", () => {
  it("sends same-origin custom CSRF header on mutations, not credentials in URL", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ id: "one" }) });
    vi.stubGlobal("fetch", fetch);
    await request("/projects", "POST", { path: "/safe/repo" });
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspace/projects",
      expect.objectContaining({
        credentials: "same-origin",
        headers: {
          "X-RepoWiki-Request": "1",
          "Content-Type": "application/json",
        },
        body: '{"path":"/safe/repo"}',
      }),
    );
  });
  it("surfaces API rejection rather than claiming completion", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({ detail: "Revision changed" }),
        }),
    );
    await expect(request("/edit", "PUT", {})).rejects.toThrow(
      "Revision changed",
    );
  });
  it("encodes project and each page path component", () => {
    expect(pageUrl("id with space", "modules/data api")).toBe(
      "/projects/id%20with%20space/pages/modules/data%20api",
    );
  });
});

import { requestViaClient } from './api';
describe('embedded typed transport',()=>{
 it('maps pages and mutation requests to allowlisted IPC without HTTP',async()=>{const invoke=vi.fn().mockResolvedValue({id:'overview'});const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const client={invoke,subscribe:()=>()=>{}};await requestViaClient(client,'/projects/atlas/pages/modules/api');expect(invoke).toHaveBeenCalledWith('page',{project_id:'atlas',slug:'modules/api'});await requestViaClient(client,'/projects/atlas/generate','POST',{provider:'real',confirm_external:true});expect(invoke).toHaveBeenLastCalledWith('generate',{project_id:'atlas',provider:'real',confirm_external:true});expect(fetch).not.toHaveBeenCalled();});
 it('rejects unknown operations and malformed mutation payloads before IPC',async()=>{const invoke=vi.fn();const client={invoke,subscribe:()=>()=>{}};await expect(requestViaClient(client,'/shell','POST',{command:'run'})).rejects.toThrow('Route');await expect(requestViaClient(client,'/projects/atlas/watch','PUT',{enabled:'yes'})).rejects.toThrow('enabled');expect(invoke).not.toHaveBeenCalled();});
});
