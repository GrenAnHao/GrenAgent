/** OPTIONAL local preview transport. It talks to the child; it imports no engine. */
import http from "node:http";
import { readFileSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import {
  routeRequest,
  ContractError,
  type RepoWikiClient,
} from "../../contracts/src/index.js";
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY = 8 * 1024 * 1024;
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
export function createHttpServer(client: RepoWikiClient, staticDir: string) {
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    const json = (status: number, data: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      const body = JSON.stringify(data);
      if (status === 413 && !req.readableEnded) {
        // Send the complete error now, but do not close a socket with unread
        // upload bytes: Windows can reset it before the client receives 413.
        res.setHeader("Connection", "close");
        res.setHeader("Content-Length", Buffer.byteLength(body));
        req.once("end", () => res.end());
        res.write(body);
        req.resume();
      } else {
        res.end(body);
      }
    };
    try {
      const host = req.headers.host ?? "";
      let hostUrl: URL;
      try {
        hostUrl = new URL("http://" + host);
      } catch {
        throw new ContractError("Invalid host", 403);
      }
      if (
        !loopback.has(hostUrl.hostname) ||
        hostUrl.username ||
        hostUrl.password ||
        hostUrl.pathname !== "/" ||
        hostUrl.search ||
        hostUrl.hash
      )
        throw new ContractError("Only loopback hostnames are accepted", 403);
      if (req.headers.origin) {
        let origin: URL;
        try {
          origin = new URL(req.headers.origin);
        } catch {
          throw new ContractError("Invalid Origin", 403);
        }
        if (
          origin.protocol !== "http:" ||
          origin.host !== host ||
          origin.origin !== req.headers.origin ||
          !loopback.has(origin.hostname)
        )
          throw new ContractError("Cross-origin access is not allowed", 403);
      }
      if (!req.url?.startsWith("/") || req.url.startsWith("//"))
        throw new ContractError("Invalid request target");
      const url = new URL(req.url, hostUrl);
      const method = req.method ?? "GET";
      if (url.pathname.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
        if (req.headers["sec-fetch-site"] === "cross-site")
          throw new ContractError("Cross-site access is not allowed", 403);
        let body: unknown = {};
        if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
          if (req.headers["x-repowiki-request"] !== "1")
            throw new ContractError("X-RepoWiki-Request: 1 is required", 403);
          if (req.headers["content-type"]?.split(";")[0] !== "application/json")
            throw new ContractError("JSON requests are required", 415);
          if (Number(req.headers["content-length"] ?? 0) > MAX_BODY)
            throw new ContractError("Request exceeds 8 MiB", 413);
          let bytes = 0;
          const chunks: Buffer[] = [];
          // Keep the socket alive when rejecting early so the client receives
          // the JSON 413 instead of an async-iterator-induced connection reset.
          for await (const chunk of req.iterator({ destroyOnReturn: false })) {
            bytes += chunk.length;
            if (bytes > MAX_BODY)
              throw new ContractError("Request exceeds 8 MiB", 413);
            chunks.push(chunk);
          }
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            throw new ContractError("Invalid JSON");
          }
        }
        const suffix = url.pathname.startsWith("/api/workspace/")
          ? url.pathname.slice("/api/workspace".length) + url.search
          : "";
        const { action, input } = routeRequest(method, suffix, body);
        const result = await client.invoke(action, input);
        if (action === "export") {
          const files: Record<string, Uint8Array> = Object.create(null);
          for (const [name, text] of Object.entries(
            result as Record<string, string>,
          )) {
            if (
              !name ||
              /[\\:\x00-\x1f]/.test(name) ||
              name.startsWith("/") ||
              name.split("/").some((p) => !p || p === "." || p === "..")
            )
              throw new ContractError("Unsafe export filename");
            files[name] = strToU8(text);
          }
          res.setHeader("Content-Type", "application/zip");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="repowiki-${input.project_id}.zip"`,
          );
          res.end(zipSync(files));
          return;
        }
        json(
          action === "generate"
            ? 202
            : ["create", "clone"].includes(action)
              ? 201
              : 200,
          result,
        );
        return;
      }
      if (method !== "GET" && method !== "HEAD")
        throw new ContractError("Method not allowed", 405);
      let requested: string;
      try {
        requested = decodeURIComponent(url.pathname);
      } catch {
        throw new ContractError("Invalid path");
      }
      if (/[\\\x00]/.test(requested) || requested.split("/").includes(".."))
        throw new ContractError("Invalid path", 403);
      const root = realpathSync(staticDir);
      let file = path.resolve(root, "." + requested);
      const inside = (target: string) =>
        target === root || target.startsWith(root + path.sep);
      if (!inside(file)) throw new ContractError("Invalid path", 403);
      try {
        if (statSync(file).isDirectory()) file = path.join(file, "index.html");
        if (!statSync(file).isFile()) throw new Error();
      } catch {
        if (path.extname(requested)) throw new ContractError("Not found", 404);
        file = path.join(root, "index.html");
      }
      if (!inside(realpathSync(file)))
        throw new ContractError("Invalid path", 403);
      res.setHeader(
        "Content-Type",
        contentTypes[path.extname(file)] ?? "application/octet-stream",
      );
      res.end(method === "HEAD" ? undefined : readFileSync(file));
    } catch (error: any) {
      json(error instanceof ContractError ? error.status : 500, {
        detail:
          error instanceof ContractError
            ? error.message
            : "Operation failed safely; check service configuration",
      });
    }
  });
}
