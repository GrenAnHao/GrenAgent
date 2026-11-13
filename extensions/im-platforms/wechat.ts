// WeChat official AI-bot (ilink / clawbot) connector, ported from AstrBot's
// weixin_oc adapter. This is WeChat's official open bot interface served at
// ilinkai.weixin.qq.com — NOT the Official-Account webhook. It is an OUTBOUND
// long-poll client (no public IP / inbound port needed), which fits Pi's
// single-owner process:
//
//   1. GET  ilink/bot/get_bot_qrcode?bot_type=3   -> QR for the user to scan
//   2. GET  ilink/bot/get_qrcode_status?qrcode=.. -> long-poll until "confirmed"
//                                                    -> bot_token + baseurl
//   3. POST ilink/bot/getupdates                  -> long-poll inbound messages
//   4. POST ilink/bot/sendmessage (context_token) -> reply
//
// Messages are plain JSON (no per-message AES; only media CDN uses AES, which we
// skip for now — inbound media becomes a placeholder, outbound is text-only).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

/** ilink session-expired code: the persisted token is dead and must re-login via QR. */
export const SESSION_TIMEOUT_ERRCODE = -14;

// ----------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ----------------------------------------------------------------------------

export interface IlinkItem {
  type: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  [k: string]: unknown;
}

/** Flatten an ilink item_list into plain text, with placeholders for media. */
export function itemListToText(itemList: unknown): string {
  if (!Array.isArray(itemList)) return "";
  const parts: string[] = [];
  for (const raw of itemList) {
    const item = raw as IlinkItem;
    switch (Number(item?.type) || 0) {
      case 1: {
        const t = (item.text_item?.text ?? "").trim();
        if (t) parts.push(t);
        break;
      }
      case 2:
        parts.push("[图片]");
        break;
      case 3: {
        const v = (item.voice_item?.text ?? "").trim();
        parts.push(v || "[语音]");
        break;
      }
      case 4:
        parts.push("[文件]");
        break;
      case 5:
        parts.push("[视频]");
        break;
      default:
        break;
    }
  }
  return parts.join("\n").trim();
}

/** Build an ilink item_list carrying a single text item. */
export function buildTextItems(text: string): IlinkItem[] {
  return [{ type: 1, text_item: { text } }];
}

/** ilink success check: ret == 0 && errcode == 0. */
export function isOk(payload: Record<string, unknown>): boolean {
  return Number(payload?.ret ?? 0) === 0 && Number(payload?.errcode ?? 0) === 0;
}

function randomHex(): string {
  let s = "";
  for (let i = 0; i < 4; i += 1) s += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return s;
}

function uin(): string {
  return Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString("base64");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------------
// HTTP request
// ----------------------------------------------------------------------------

interface RequestOptions {
  params?: Record<string, string>;
  payload?: Record<string, unknown>;
  token?: string;
  timeoutMs: number;
  /** Stable X-WECHAT-UIN for this client; falls back to a fresh random when absent. */
  uin?: string;
  extraHeaders?: Record<string, string>;
}

async function ilinkRequest(
  baseUrl: string,
  method: string,
  endpoint: string,
  opts: RequestOptions,
): Promise<Record<string, unknown>> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(endpoint.replace(/^\//, ""), base);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": opts.uin ?? uin(),
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    ...(opts.extraHeaders ?? {}),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: opts.payload ? JSON.stringify(opts.payload) : undefined,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`${method} ${endpoint} failed: ${resp.status} ${text.slice(0, 200)}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// Runner: QR login -> long-poll updates -> dispatch; reply via context_token
// ----------------------------------------------------------------------------

interface PersistedState {
  token?: string;
  syncBuf?: string;
  baseUrl?: string;
  /** Stable device UIN reused across requests/restarts (see deviceUin below). */
  uin?: string;
  contextTokens?: Record<string, string>;
}

export interface WeixinOcOptions {
  baseUrl?: string;
  /** Pre-obtained bot_token; when absent, a QR login is performed. */
  token?: string;
  botType?: string;
  apiTimeoutMs?: number;
  longPollTimeoutMs?: number;
  /** File to persist token / cursor / context tokens across restarts. */
  statePath?: string;
  /** Only accept this ilink_user_id (single-owner); empty = accept all. */
  ownerUserId?: string;
  /** LRU cap on tracked per-user context tokens (accept-all anti-bloat). Default 200. */
  maxContexts?: number;
  onInbound: (text: string, fromUser: string) => void;
  /** Surface the login QR to the user (qrLink renders the QR as an image). */
  onQr?: (info: { qrImgContent: string; qrLink: string }) => void;
  onStatus?: (status: string) => void;
  log?: (msg: string) => void;
}

export interface WeixinOcHandle {
  /** Reply to a user (uses their most recent context_token). */
  sendToUser: (fromUser: string, text: string) => Promise<void>;
  loggedIn: () => boolean;
  close: () => void;
}

export function startWeixinOc(opts: WeixinOcOptions): WeixinOcHandle {
  const log = opts.log ?? (() => {});
  const botType = opts.botType || "3";
  const apiTimeout = opts.apiTimeoutMs ?? 15_000;
  const longTimeout = opts.longPollTimeoutMs ?? 35_000;
  const statePath = opts.statePath;
  let baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  let token = opts.token || "";
  let syncBuf = "";
  let deviceUin = "";
  const contextTokens = new Map<string, string>();
  let closed = false;

  // Bound the per-user context_token map (LRU) so accept-all mode can't grow it
  // (and the persisted state file) without limit as new senders appear.
  const maxContexts = Math.max(1, opts.maxContexts ?? 200);
  const setContextToken = (user: string, ctxToken: string): void => {
    contextTokens.delete(user); // re-insert at the tail (most-recently-active)
    contextTokens.set(user, ctxToken);
    while (contextTokens.size > maxContexts) {
      const oldest = contextTokens.keys().next().value;
      if (oldest === undefined) break;
      contextTokens.delete(oldest);
    }
  };

  if (statePath) {
    try {
      const s = JSON.parse(readFileSync(statePath, "utf8")) as PersistedState;
      token = token || s.token || "";
      syncBuf = s.syncBuf || "";
      deviceUin = s.uin || "";
      if (s.baseUrl) baseUrl = s.baseUrl.replace(/\/$/, "");
      for (const [k, v] of Object.entries(s.contextTokens ?? {})) setContextToken(k, String(v));
    } catch {
      /* no prior state */
    }
  }

  const saveState = (): void => {
    if (!statePath) return;
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      const state: PersistedState = {
        token,
        syncBuf,
        baseUrl,
        uin: deviceUin,
        contextTokens: Object.fromEntries(contextTokens),
      };
      writeFileSync(statePath, JSON.stringify(state));
    } catch (e) {
      log(`weixin_oc save state failed: ${(e as Error).message}`);
    }
  };

  // Stable device UIN: ilink expects a consistent X-WECHAT-UIN per bot client.
  // Previously every request sent a fresh random uin; generate once and persist
  // so it stays stable across requests and restarts.
  if (!deviceUin) {
    deviceUin = uin();
    saveState();
  }

  const loginLoop = async (): Promise<void> => {
    const qr = await ilinkRequest(baseUrl, "GET", "ilink/bot/get_bot_qrcode", {
      params: { bot_type: botType },
      timeoutMs: apiTimeout,
      uin: deviceUin,
    });
    const qrcode = String(qr.qrcode ?? "");
    const qrImg = String(qr.qrcode_img_content ?? "");
    if (!qrcode || !qrImg) {
      await sleep(5000);
      return;
    }
    const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrImg)}`;
    // onQr drives the "waiting-scan" UI state; we intentionally do NOT emit a
    // status per poll (that would spam the frontend / notifications). Only the
    // final "confirmed" transition is reported, exactly once.
    opts.onQr?.({ qrImgContent: qrImg, qrLink });

    const startedAt = Date.now();
    while (!closed && !token && Date.now() - startedAt < 5 * 60_000) {
      let data: Record<string, unknown>;
      try {
        data = await ilinkRequest(baseUrl, "GET", "ilink/bot/get_qrcode_status", {
          params: { qrcode },
          timeoutMs: longTimeout,
          uin: deviceUin,
          extraHeaders: { "iLink-App-ClientVersion": "1" },
        });
      } catch {
        await sleep(2000);
        continue;
      }
      const status = String(data.status ?? "wait");
      if (status === "expired") {
        // QR expired before it was scanned: bail out so the outer loop regenerates a fresh QR.
        return;
      }
      if (status === "confirmed") {
        token = String(data.bot_token ?? "");
        if (data.baseurl) baseUrl = String(data.baseurl).replace(/\/$/, "");
        if (token) {
          saveState();
          opts.onStatus?.("confirmed");
          return;
        }
      }
      await sleep(1000);
    }
  };

  const pollUpdates = async (): Promise<void> => {
    const data = await ilinkRequest(baseUrl, "POST", "ilink/bot/getupdates", {
      payload: { base_info: { channel_version: "grenagent" }, get_updates_buf: syncBuf },
      token,
      timeoutMs: longTimeout,
      uin: deviceUin,
    });
    if (!isOk(data)) {
      const ret = Number(data.ret ?? 0);
      const errcode = Number(data.errcode ?? 0);
      // Session expired: the persisted token is dead. Clear it and drop back to
      // QR login instead of hammering getupdates with a dead token forever (which
      // would leave the UI stuck on "logged in" but unresponsive). Mirrors
      // AstrBot's _handle_inbound_session_timeout.
      if (ret === SESSION_TIMEOUT_ERRCODE || errcode === SESSION_TIMEOUT_ERRCODE) {
        log(`weixin_oc session expired (ret=${ret} errcode=${errcode}); clearing token for re-login`);
        token = "";
        syncBuf = "";
        saveState();
        opts.onStatus?.("session-expired");
        return; // loop() sees !token → runs loginLoop() → fresh QR
      }
      log(`weixin_oc getupdates error ret=${data.ret} errcode=${data.errcode} errmsg=${String(data.errmsg ?? "")}`);
      await sleep(3000);
      return;
    }
    if (data.get_updates_buf) syncBuf = String(data.get_updates_buf);
    const msgs = Array.isArray(data.msgs) ? data.msgs : [];
    for (const raw of msgs) {
      if (closed) return;
      const msg = raw as Record<string, unknown>;
      const fromUser = String(msg.from_user_id ?? "").trim();
      if (!fromUser) continue;
      if (opts.ownerUserId && fromUser !== opts.ownerUserId) continue;
      const ctxToken = String(msg.context_token ?? "").trim();
      if (ctxToken) setContextToken(fromUser, ctxToken);
      const text = itemListToText(msg.item_list);
      if (text) opts.onInbound(text, fromUser);
    }
    saveState();
  };

  const loop = async (): Promise<void> => {
    while (!closed) {
      try {
        if (!token) {
          await loginLoop();
          continue;
        }
        await pollUpdates();
      } catch (e) {
        if (closed) return;
        log(`weixin_oc loop error: ${(e as Error).message}`);
        await sleep(5000);
      }
    }
  };

  void loop();

  return {
    async sendToUser(fromUser, text) {
      const ctxToken = contextTokens.get(fromUser);
      if (!token || !ctxToken) {
        log(`weixin_oc cannot send to ${fromUser}: missing token or context_token`);
        return;
      }
      // client_id is computed once (stable across retries) so a server-side dedupe
      // won't double-deliver if an earlier attempt actually landed before erroring.
      const payload = {
        base_info: { channel_version: "grenagent" },
        msg: {
          from_user_id: "",
          to_user_id: fromUser,
          client_id: randomHex(),
          message_type: 2,
          message_state: 2,
          context_token: ctxToken,
          item_list: buildTextItems(text),
        },
      };
      // Retry transient failures (network / timeout / 5xx) so a flaky send doesn't
      // ghost the user. The caller records the assistant turn only after we return.
      let lastErr: Error | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await sleep(500 * attempt);
        try {
          const data = await ilinkRequest(baseUrl, "POST", "ilink/bot/sendmessage", {
            token,
            timeoutMs: apiTimeout,
            uin: deviceUin,
            payload,
          });
          if (!isOk(data)) {
            throw new Error(`sendmessage failed ret=${data.ret} errcode=${data.errcode} errmsg=${String(data.errmsg ?? "")}`);
          }
          return;
        } catch (e) {
          lastErr = e as Error;
        }
      }
      throw lastErr ?? new Error("weixin_oc sendmessage failed");
    },
    loggedIn: () => !!token,
    close() {
      closed = true;
    },
  };
}
