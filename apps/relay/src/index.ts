// 中转站（relay）：部署在云服务器，本身不接触 OpenAI，只做“按密钥配对 + 转发”。
// 对网页端：完全沿用原 apps/server 的 /codex 与 /ws 接口。
// 对本地程式(connector)：新增 /agent WebSocket，按 16 位密钥登记一台“电脑端”。
// 网页端用相同密钥验证后，所有 codex 操作都被转发给对应 connector。
import express from "express";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import net from "node:net";
import {
  createId,
  nowIso,
  parseClientEvent,
  type ErrorEvent,
  type AgentInput,
  type ServerEvent,
  type UserMessageEvent
} from "@local-codex-remote/shared";

const HEX16 = /^[0-9a-f]{16}$/;
const port = Number(process.env.PORT ?? 8787);
const PUBLIC_BASE_URL = toPublicBaseUrl(
  process.env.PUBLIC_BASE_URL ??
    process.env.RELAY_PUBLIC_URL ??
    process.env.PUBLIC_URL ??
    `http://localhost:${port}`
);
const CONNECTOR_BUNDLE_PATH = process.env.CONNECTOR_BUNDLE_PATH ?? "";
const CONNECTOR_TLS_CA_PATH = process.env.CONNECTOR_TLS_CA_PATH ?? "";
// 客户端引导下载走 http（公开的客户端代码与证书，明文也无妨）；正式数据通道走 wss（已加密+校验）。
const BOOTSTRAP_BASE_URL = toBootstrapBaseUrl(PUBLIC_BASE_URL);
const ADMIN_ACCESS_KEY = loadAdminAccessKey();
const SESSION_TTL_MS = Number(process.env.CODEX_SESSION_TTL_MS ?? 15 * 60 * 1000);
const ADMIN_SESSION_TTL_MS = Number(process.env.CODEX_ADMIN_SESSION_TTL_MS ?? 5 * 60 * 1000);
const RPC_TIMEOUT_MS = 30_000;
const CHAT_INACTIVITY_MS = 180_000;
const AUTH_RATE_WINDOW_MS = Number(process.env.CODEX_AUTH_RATE_WINDOW_MS ?? 10 * 60 * 1000);
const AUTH_RATE_MAX_FAILS = Number(process.env.CODEX_AUTH_RATE_MAX_FAILS ?? 5);
const AUTH_RATE_BLOCK_MS = Number(process.env.CODEX_AUTH_RATE_BLOCK_MS ?? 60 * 1000);
const AUTH_KEY_ALLOWLIST = parseAuthKeyAllowlist(process.env.CODEX_AUTH_KEY_ALLOWLIST);
// 同源部署默认无需 CORS；设置 CODEX_ALLOWED_ORIGINS 后只放行白名单来源（默认空 = 兼容旧行为 *）。
const ALLOWED_ORIGINS = (process.env.CODEX_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const ADMIN_RATE_WINDOW_MS = Number(process.env.CODEX_ADMIN_RATE_WINDOW_MS ?? 10 * 60 * 1000);
const ADMIN_RATE_MAX_FAILS = Number(process.env.CODEX_ADMIN_RATE_MAX_FAILS ?? 3);
const ADMIN_RATE_BLOCK_MS = Number(process.env.CODEX_ADMIN_RATE_BLOCK_MS ?? 10 * 60 * 1000);
const WS_CONNECT_RATE_WINDOW_MS = Number(process.env.CODEX_WS_CONNECT_RATE_WINDOW_MS ?? 60_000);
const WS_CONNECT_RATE_MAX = Number(process.env.CODEX_WS_CONNECT_RATE_MAX ?? 30);
const WS_CONNECT_RATE_BLOCK_MS = Number(process.env.CODEX_WS_CONNECT_RATE_BLOCK_MS ?? 60_000);
const AGENT_CONNECT_RATE_WINDOW_MS = Number(process.env.CODEX_AGENT_CONNECT_RATE_WINDOW_MS ?? 60_000);
const AGENT_CONNECT_RATE_MAX = Number(process.env.CODEX_AGENT_CONNECT_RATE_MAX ?? 12);
const AGENT_CONNECT_RATE_BLOCK_MS = Number(process.env.CODEX_AGENT_CONNECT_RATE_BLOCK_MS ?? 5 * 60_000);
const CONNECTOR_CHAT_QUEUE_LIMIT = Number(process.env.CONNECTOR_CHAT_QUEUE_LIMIT ?? 8);
const CONNECTOR_CHAT_QUEUE_TIMEOUT_MS = Number(process.env.CONNECTOR_CHAT_QUEUE_TIMEOUT_MS ?? 300_000);
const SESSION_MESSAGE_LIMIT = Number(process.env.SESSION_MESSAGE_LIMIT ?? 6);
const SESSION_MESSAGE_WINDOW_MS = Number(process.env.SESSION_MESSAGE_WINDOW_MS ?? 60_000);
const CODEX_MAX_USER_SESSIONS = Number(process.env.CODEX_MAX_USER_SESSIONS ?? 500);
const CODEX_MAX_CONNECTORS = Number(process.env.CODEX_MAX_CONNECTORS ?? 300);
const SECURITY_AUDIT_LOG_PATH = process.env.CODEX_SECURITY_AUDIT_LOG_PATH;
const SECURITY_ALERT_WEBHOOK = process.env.CODEX_SECURITY_ALERT_WEBHOOK?.trim();
const SECURITY_ALERT_THROTTLE_MS = Number(process.env.CODEX_SECURITY_ALERT_THROTTLE_MS ?? 60_000);
const BLOCKED_KEY_FILE = process.env.CODEX_BLOCKED_KEY_FILE ?? ".codex-blocked-keys";
const CONNECTOR_DEVICE_FILE = process.env.CODEX_CONNECTOR_DEVICE_FILE ?? ".codex-connector-devices.json";
const ADMIN_VERIFY_PATH = process.env.CODEX_ADMIN_VERIFY_PATH ?? "/codex/admin-auth/verify";
const blockedAuthKeys = loadBlockedAuthKeys(BLOCKED_KEY_FILE);
const connectorDevices = loadConnectorDevices(CONNECTOR_DEVICE_FILE);

function toPublicBaseUrl(rawBaseUrl: string) {
  const trimmed = rawBaseUrl.trim();
  if (!trimmed) {
    return `http://localhost:${port}`;
  }
  return trimmed.replace(/\/$/, "");
}

function toWebSocketBaseUrl(rawBaseUrl: string) {
  let url = rawBaseUrl.trim();
  if (!url) {
    return `ws://localhost:${port}`;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = `ws://${url}`;
  }
  if (/^http:\/\//i.test(url)) {
    return url.replace(/^http:\/\//i, "ws://").replace(/\/+$/, "");
  }
  if (/^https:\/\//i.test(url)) {
    return url.replace(/^https:\/\//i, "wss://").replace(/\/+$/, "");
  }
  return url.replace(/\/+$/, "").replace(/^ws:/i, "ws:").replace(/^wss:/i, "wss:");
}

function toAgentWebSocketUrl(rawBaseUrl: string) {
  const wsBase = toWebSocketBaseUrl(rawBaseUrl);
  return /\/agent$/i.test(wsBase) ? wsBase : `${wsBase}/agent`;
}

function toBootstrapBaseUrl(rawBaseUrl: string) {
  return rawBaseUrl
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://")
    .replace(/^http:\/\//i, "http://")
    .replace(/^https:\/\//i, "https://");
}

// ---------- connector 注册表 ----------
type ChatQueueItem = {
  reqId: string;
  input: AgentInput;
  onDelta: (d: string) => void;
  resolve: () => void;
  reject: (e: Error) => void;
  queueTimer: NodeJS.Timeout;
};
type ConnectorConn = {
  key: string;
  socket: WebSocket;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  chats: Map<string, { onDelta: (d: string) => void; done: () => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>;
  chatQueue: ChatQueueItem[];
  activeChat: string | null;
  connectedAt: number;
  lastPongAt: number;
  heartbeatTimer: NodeJS.Timeout;
};
const connectors = new Map<string, ConnectorConn>();

// ---------- 网页会话 ----------
type AdminLogMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  messageId: string;
  timestamp: string;
  threadId?: string;
};
type SessionAuditRecord = {
  token: string;
  key: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  ip: string;
  userAgent: string;
  connectedSockets: number;
  threadId: string | null;
  messageCount: number;
  recentMessageTimestamps: number[];
  messages: AdminLogMessage[];
};
type AdminSession = { token: string; expiresAt: number; lastSeenAt: number };

const activeSessions = new Map<string, SessionAuditRecord>();
const adminSessions = new Map<string, AdminSession>();
const sockets = new Set<WebSocket>();
const socketSessionMap = new Map<WebSocket, string>();

const app = express();
const server = createServer(app);

if (!ADMIN_ACCESS_KEY) {
  console.warn("未配置 CODEX_ADMIN_KEY，管理员功能不可用。");
}
console.log(`Relay 启动，公网地址：${PUBLIC_BASE_URL}`);

app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (ALLOWED_ORIGINS.length === 0) {
    response.setHeader("Access-Control-Allow-Origin", "*");
  } else if (typeof origin === "string" && ALLOWED_ORIGINS.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Codex-Session, X-Codex-Admin-Session, X-Codex-Admin-Key"
  );
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
});
app.use(express.json());
app.use((request, response, next) => {
  if (isAuthExcluded(request.path)) {
    next();
    return;
  }
  const clientIp = extractClientIp(request);
  if (!isIpAllowed(clientIp)) {
    response.status(403).json({ code: "FORBIDDEN_IP", message: "当前IP无权访问该接口。" });
    return;
  }
  if (isAdminRoute(request.path)) {
    if (!isAdminSessionValid(extractAdminToken(request))) {
      response.status(401).json({ code: "UNAUTHORIZED", message: "管理员身份未授权。" });
      return;
    }
    return next();
  }
  const token = extractSessionToken(request);
  const session = touchUserSession(token, {
    ip: normalizeIp(request.socket.remoteAddress),
    userAgent: request.header("user-agent") ?? ""
  });
  if (!session) {
    response.status(401).json({ code: "UNAUTHORIZED", message: "请先完成密钥验证。" });
    return;
  }
  next();
});

// ---------- 客户端下载 ----------
app.get("/codex/connector/download", (_request, response) => {
  const script = buildMacDownloadCommand();
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader("Content-Disposition", 'attachment; filename="codex-remote-client.command"');
  response.send(script);
});

app.get("/codex/connector/download/mac", (_request, response) => {
  const script = buildMacDownloadCommand();
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader("Content-Disposition", 'attachment; filename="codex-remote-client.command"');
  response.send(script);
});

app.get("/codex/connector/download/windows", (_request, response) => {
  const script = buildWindowsDownloadCommand();
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader("Content-Disposition", 'attachment; filename="codex-remote-client.cmd"');
  response.send(script);
});

app.get("/codex/connector/cert.pem", (_request, response) => {
  if (!CONNECTOR_TLS_CA_PATH) {
    response.status(404).type("text/plain").send("# 未配置自签证书路径（CONNECTOR_TLS_CA_PATH）。");
    return;
  }
  try {
    response.setHeader("Content-Type", "application/x-pem-file");
    response.send(readFileSync(CONNECTOR_TLS_CA_PATH, "utf8"));
  } catch (error) {
    response.status(500).type("text/plain").send(`# 读取证书失败：${error instanceof Error ? error.message : error}`);
  }
});

app.get("/codex/connector/bundle.cjs", (_request, response) => {
  if (!CONNECTOR_BUNDLE_PATH) {
    response.status(404).type("text/plain").send("// 客户端尚未打包部署（CONNECTOR_BUNDLE_PATH 未配置）。");
    return;
  }
  try {
    const bundle = readFileSync(CONNECTOR_BUNDLE_PATH, "utf8");
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.send(bundle);
  } catch (error) {
    response.status(500).type("text/plain").send(`// 读取客户端失败：${error instanceof Error ? error.message : error}`);
  }
});

// ---------- 验证密钥 ----------
app.post("/codex/auth/verify", (request, response) => {
  const clientIp = extractClientIp(request);
  if (!isIpAllowed(clientIp)) {
    logSecurityEvent("FORBIDDEN_IP", { route: "/codex/auth/verify", ip: clientIp });
    response.status(403).json({ code: "FORBIDDEN_IP", message: "当前IP无权访问验证码接口。" });
    return;
  }
  const code = request.body?.code;
  const normalizedCode = normalizeCode(code);
  const isTrustedAuthKey = isAuthKeyAllowlisted(normalizedCode);

  if (!isTrustedAuthKey && !canProceedRateLimit("USER_AUTH", clientIp)) {
    const retryAfterMs = Math.max(1000, getRateLimitRetryMs("USER_AUTH", clientIp));
    response.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
    response.status(429).json({
      code: "RATE_LIMITED",
      message: `验证码请求过于频繁，请在 ${Math.round(retryAfterMs / 1000)} 秒后重试。`
    });
    return;
  }

  if (Number.isFinite(CODEX_MAX_USER_SESSIONS) && CODEX_MAX_USER_SESSIONS > 0 && activeSessions.size >= CODEX_MAX_USER_SESSIONS) {
    if (!isTrustedAuthKey) {
      recordRateLimitFailure("USER_AUTH", clientIp, "SESSION_LIMIT_REACHED");
    }
    response.status(429).json({
      code: "SESSION_LIMIT_REACHED",
      message: `当前服务端会话已满（上限 ${CODEX_MAX_USER_SESSIONS}）。请稍后再试。`
    });
    return;
  }

  if (typeof code !== "string" || !code.trim()) {
    recordRateLimitFailure("USER_AUTH", clientIp, "BAD_REQUEST");
    response.status(400).json({ code: "BAD_REQUEST", message: "缺少密钥。" });
    return;
  }
  if (!normalizedCode || !HEX16.test(normalizedCode)) {
    recordRateLimitFailure("USER_AUTH", clientIp, "INVALID_FORMAT");
    response.status(403).json({ code: "INVALID_CODE", message: "密钥格式不对：应为 16 位十六进制（0-9a-f）。" });
    return;
  }
  if (isAuthKeyBlocked(normalizedCode)) {
    logSecurityEvent("BLOCKED_KEY_LOGIN", { ip: clientIp, key: maskKey(normalizedCode) });
    response.status(403).json({ code: "KEY_BLOCKED", message: "该密钥已被管理员拉黑。" });
    return;
  }
  if (!connectors.has(normalizedCode)) {
    if (!isTrustedAuthKey) {
      recordRateLimitFailure("USER_AUTH", clientIp, "CONNECTOR_MISSING");
    }
    response.status(403).json({
      code: "CONNECTOR_OFFLINE",
      message: "没找到这个密钥对应的电脑客户端。请先在电脑上运行客户端程序，并使用它显示的 16 位密钥。"
    });
    return;
  }

  const sessionToken = randomBytes(24).toString("hex");
  clearRateLimit("USER_AUTH", clientIp);
  const now = Date.now();
  activeSessions.set(sessionToken, {
    token: sessionToken,
    key: normalizedCode,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    lastSeenAt: now,
    ip: normalizeIp(request.socket.remoteAddress),
    userAgent: request.header("user-agent") ?? "",
    connectedSockets: 0,
    threadId: null,
    messageCount: 0,
    recentMessageTimestamps: [],
    messages: []
  });
  logSecurityEvent("USER_LOGIN_SUCCESS", { level: "info", ip: clientIp, key: maskKey(normalizedCode) });
  response.json({ code: "OK", sessionToken, expiresAt: now + SESSION_TTL_MS });
});

// ---------- 管理员 ----------
app.post(ADMIN_VERIFY_PATH, (request, response) => {
  const clientIp = extractClientIp(request);
  if (!isIpAllowed(clientIp)) {
    logSecurityEvent("FORBIDDEN_IP", { route: ADMIN_VERIFY_PATH, ip: clientIp });
    response.status(403).json({ code: "FORBIDDEN_IP", message: "当前IP无权访问管理员接口。" });
    return;
  }
  if (!canProceedRateLimit("ADMIN_AUTH", clientIp)) {
    const retryAfterMs = Math.max(1000, getRateLimitRetryMs("ADMIN_AUTH", clientIp));
    response.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
    response.status(429).json({
      code: "RATE_LIMITED",
      message: `管理员验证过于频繁，请在 ${Math.round(retryAfterMs / 1000)} 秒后重试。`
    });
    return;
  }
  const adminKey = request.body?.adminKey;
  if (typeof ADMIN_ACCESS_KEY !== "string" || !ADMIN_ACCESS_KEY) {
    clearRateLimit("ADMIN_AUTH", clientIp);
    response.status(503).json({ code: "ADMIN_NOT_CONFIGURED", message: "未配置管理员密钥。" });
    return;
  }
  if (typeof adminKey !== "string" || !safeEqualHex(normalizeCode(adminKey), normalizeCode(ADMIN_ACCESS_KEY))) {
    recordRateLimitFailure("ADMIN_AUTH", clientIp, "INVALID_KEY");
    response.status(403).json({ code: "INVALID_ADMIN_KEY", message: "管理员KEY不正确。" });
    return;
  }
  clearRateLimit("ADMIN_AUTH", clientIp);
  const adminToken = randomBytes(24).toString("hex");
  const now = Date.now();
  adminSessions.set(adminToken, { token: adminToken, expiresAt: now + ADMIN_SESSION_TTL_MS, lastSeenAt: now });
  logSecurityEvent("ADMIN_LOGIN_SUCCESS", { level: "info", ip: clientIp });
  response.json({ code: "OK", adminSessionToken: adminToken, expiresAt: now + ADMIN_SESSION_TTL_MS });
});

app.get("/codex/admin/sessions", (_request, response) => {
  const sessions = [...activeSessions.values()].map((session) => ({
    token: session.token,
    ip: session.ip,
    userAgent: session.userAgent,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    connected: session.connectedSockets > 0,
    connectedSockets: session.connectedSockets,
    threadId: session.threadId,
    messageCount: session.messageCount,
    key: session.key,
    keyMasked: maskKey(session.key),
    blocked: isAuthKeyBlocked(session.key),
    protected: isAuthKeyAllowlisted(session.key),
    connectorOnline: connectors.has(session.key)
  }));
  response.json({ sessions, total: sessions.length });
});

app.get("/codex/admin/blocked-keys", (_request, response) => {
  response.json({
    keys: [...blockedAuthKeys].map((key) => ({
      key,
      keyMasked: maskKey(key),
      protected: isAuthKeyAllowlisted(key),
      connectorOnline: connectors.has(key),
      activeSessions: countSessionsForKey(key)
    }))
  });
});

app.post("/codex/admin/keys/block", (request, response) => {
  const key = normalizeCode(request.body?.key);
  if (!key || !HEX16.test(key)) {
    response.status(400).json({ code: "BAD_REQUEST", message: "缺少有效的 16 位密钥。" });
    return;
  }
  if (isAuthKeyAllowlisted(key)) {
    response.status(403).json({ code: "PROTECTED_KEY", message: "这是受保护的白名单密钥，不能拉黑。" });
    return;
  }
  blockedAuthKeys.add(key);
  persistBlockedAuthKeys(BLOCKED_KEY_FILE);
  const closedSessions = closeSessionsForKey(key, "该密钥已被管理员拉黑。");
  logSecurityEvent("KEY_BLOCKED", { key: maskKey(key), closedSessions });
  response.json({ code: "OK", key, keyMasked: maskKey(key), closedSessions });
});

app.post("/codex/admin/keys/unblock", (request, response) => {
  const key = normalizeCode(request.body?.key);
  if (!key || !HEX16.test(key)) {
    response.status(400).json({ code: "BAD_REQUEST", message: "缺少有效的 16 位密钥。" });
    return;
  }
  blockedAuthKeys.delete(key);
  persistBlockedAuthKeys(BLOCKED_KEY_FILE);
  logSecurityEvent("KEY_UNBLOCKED", { key: maskKey(key) });
  response.json({ code: "OK", key, keyMasked: maskKey(key) });
});

app.get("/codex/admin/sessions/:sessionToken/messages", (request, response) => {
  const session = activeSessions.get(request.params.sessionToken);
  if (!session) {
    response.status(404).json({ code: "SESSION_NOT_FOUND", message: "该用户会话不存在。" });
    return;
  }
  const limit = Number(request.query.limit ?? 200);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 200;
  const messages = session.messages.slice(Math.max(0, session.messages.length - safeLimit));
  response.json({
    session: {
      token: session.token,
      ip: session.ip,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      messageCount: session.messageCount,
      connected: session.connectedSockets > 0,
      key: session.key,
      keyMasked: maskKey(session.key),
      blocked: isAuthKeyBlocked(session.key),
      protected: isAuthKeyAllowlisted(session.key),
      threadId: session.threadId,
      connectedSockets: session.connectedSockets,
      connectorOnline: connectors.has(session.key)
    },
    messages
  });
});

app.get("/codex/admin/security-events", (request, response) => {
  const limit = Number(request.query.limit ?? 200);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 200;
  response.json({
    events: securityEvents.slice(Math.max(0, securityEvents.length - safeLimit)).reverse(),
    total: securityEvents.length
  });
});

// ---------- 健康检查 ----------
app.get("/health", (_request, response) => {
  const connectorList = [...connectors.values()];
  response.json({
    ok: true,
    name: "local-codex-remote-relay",
    connectors: connectors.size,
    maxConnectors: Number.isFinite(CODEX_MAX_CONNECTORS) && CODEX_MAX_CONNECTORS > 0 ? CODEX_MAX_CONNECTORS : null,
    activeChats: connectorList.filter((connector) => connector.activeChat).length,
    queuedChats: connectorList.reduce((total, connector) => total + connector.chatQueue.length, 0),
    connectorLastSeen: connectorList.map((connector) => ({
      key: `${connector.key.slice(0, 4)}…${connector.key.slice(-2)}`,
      connectedAt: new Date(connector.connectedAt).toISOString(),
      lastPongAt: new Date(connector.lastPongAt).toISOString()
    })),
    sessions: activeSessions.size,
    maxSessions: Number.isFinite(CODEX_MAX_USER_SESSIONS) && CODEX_MAX_USER_SESSIONS > 0 ? CODEX_MAX_USER_SESSIONS : null,
    sockets: sockets.size,
    timestamp: nowIso()
  });
});

// ---------- codex 接口（转发给 connector）----------
app.get("/codex/status", async (request, response) => {
  const key = sessionKey(request);
  if (!key || !connectors.has(key)) {
    response.json({ connected: false, message: "电脑客户端未连接" });
    return;
  }
  try {
    response.json(await callConnector(key, "status", {}));
  } catch (error) {
    response.json({ connected: false, message: error instanceof Error ? error.message : "Codex 状态读取失败。" });
  }
});

app.get("/codex/models", async (request, response) => {
  const key = sessionKey(request);
  if (!key || !connectors.has(key)) {
    response.status(503).json({ message: "电脑客户端未连接" });
    return;
  }
  try {
    response.json(await callConnector(key, "models", {}));
  } catch (error) {
    response.status(503).json({ message: error instanceof Error ? error.message : "Codex 模型映射读取失败。" });
  }
});

app.get("/codex/account/usage", async (request, response) => {
  const key = sessionKey(request);
  if (!key || !connectors.has(key)) {
    response.status(503).json({ message: "电脑客户端未连接" });
    return;
  }
  try {
    response.json(await callConnector(key, "accountUsage", {}));
  } catch (error) {
    response.status(503).json({ message: error instanceof Error ? error.message : "额度读取失败。" });
  }
});

app.get("/codex/threads", async (request, response) => {
  const key = sessionKey(request);
  if (!key || !connectors.has(key)) {
    response.json({ groups: [] });
    return;
  }
  try {
    response.json(await callConnector(key, "listThreads", {}));
  } catch (error) {
    response.status(503).json({ message: error instanceof Error ? error.message : "Codex 对话列表读取失败。" });
  }
});

app.get("/codex/threads/:threadId/messages", async (request, response) => {
  const key = sessionKey(request);
  if (!key) {
    response.status(503).json({ message: "电脑客户端未连接" });
    return;
  }
  try {
    response.json(await callConnector(key, "readThreadMessages", { threadId: request.params.threadId }));
  } catch (error) {
    response.status(503).json({ message: error instanceof Error ? error.message : "Codex 历史记录读取失败。" });
  }
});

app.post("/codex/threads", async (request, response) => {
  const key = sessionKey(request);
  if (!key) {
    response.status(503).json({ message: "电脑客户端未连接" });
    return;
  }
  try {
    response.status(201).json(await callConnector(key, "createThread", {}));
  } catch (error) {
    response.status(503).json({ message: error instanceof Error ? error.message : "Codex 新建对话失败。" });
  }
});

app.post("/codex/projects/select", async (request, response) => {
  const key = sessionKey(request);
  const cwd = request.body?.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) {
    response.status(400).json({ message: "缺少项目路径。" });
    return;
  }
  if (!key) {
    response.status(503).json({ message: "电脑客户端未连接" });
    return;
  }
  try {
    response.json(await callConnector(key, "selectProject", { cwd }));
  } catch (error) {
    response.status(503).json({ message: error instanceof Error ? error.message : "Codex 切换项目失败。" });
  }
});

app.post("/codex/threads/select", async (request, response) => {
  const key = sessionKey(request);
  const threadId = request.body?.threadId;
  if (typeof threadId !== "string" || !threadId.trim()) {
    response.status(400).json({ message: "缺少 threadId。" });
    return;
  }
  if (!key) {
    response.status(503).json({ message: "电脑客户端未连接" });
    return;
  }
  try {
    response.json(await callConnector(key, "selectThread", { threadId }));
  } catch (error) {
    response.status(503).json({ message: error instanceof Error ? error.message : "Codex 切换对话失败。" });
  }
});

app.delete("/codex/threads/:threadId", async (request, response) => {
  const key = sessionKey(request);
  if (!key) {
    response.status(503).json({ message: "电脑客户端未连接" });
    return;
  }
  try {
    response.json(await callConnector(key, "deleteThread", { threadId: request.params.threadId }));
  } catch (error) {
    response.status(503).json({ message: error instanceof Error ? error.message : "Codex 删除对话失败。" });
  }
});

// ---------- WebSocket：用 noServer 手动按路径分发，避免多 path 抢 upgrade ----------
const wss = new WebSocketServer({ noServer: true });
const agentWss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const clientIp = extractUpgradeClientIp(request);
  if (!isIpAllowed(clientIp)) {
    logSecurityEvent("FORBIDDEN_IP_UPGRADE", { ip: clientIp, path: (request.url ?? "").split("?")[0] });
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  let pathname = "";
  try {
    pathname = new URL(request.url ?? "", `http://localhost:${port}`).pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname === "/ws") {
    if (!recordConnectionAttempt("WS_CONNECT", clientIp)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  } else if (pathname === "/agent") {
    if (!recordConnectionAttempt("AGENT_CONNECT", clientIp)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    agentWss.handleUpgrade(request, socket, head, (ws) => agentWss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});

// ---------- WebSocket：网页端 ----------
wss.on("connection", (socket, request) => {
  const socketIp = normalizeIp(request?.socket?.remoteAddress);
  const wsIp = extractWsClientIp(request);
  if (!isIpAllowed(normalizeIp(wsIp ?? socketIp))) {
    logSecurityEvent("WEBSOCKET_DENY", { route: "/ws", ip: normalizeIp(wsIp ?? socketIp) });
    socket.close(4403, "FORBIDDEN_IP");
    return;
  }
  const url = request?.url ? new URL(request.url, `http://localhost:${port}`) : null;
  const token = normalizeCode(url?.searchParams.get("session") ?? url?.searchParams.get("auth") ?? "");
  const session = touchUserSession(token, {
    ip: normalizeIp(request?.socket?.remoteAddress),
    userAgent: request?.headers["user-agent"] ?? ""
  });
  if (!session) {
    socket.close(4401, "UNAUTHORIZED");
    return;
  }

  socketSessionMap.set(socket, session.token);
  session.connectedSockets++;
  sockets.add(socket);
  const sessionId = createId("session");
  const heartbeatTimer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    try {
      socket.ping();
    } catch {
      socket.terminate();
    }
  }, 30_000);

  // 通知对应 connector：网页端已连入
  const conn = connectors.get(session.key);
  if (conn && conn.socket.readyState === conn.socket.OPEN) {
    conn.socket.send(JSON.stringify({ kind: "paired" }));
  }

  send(socket, { id: createId("event"), type: "connection_ready", sessionId, timestamp: nowIso() });

  socket.on("message", async (data) => {
    const event = parseClientEvent(data.toString());
    if (!event) {
      sendError(socket, sessionId, "INVALID_EVENT", "服务器收到无法识别的消息。");
      return;
    }
    if (event.type === "ping") {
      send(socket, { id: createId("event"), type: "pong", sessionId, timestamp: nowIso() });
      return;
    }
    await handleUserMessage(socket, event);
  });

  socket.on("close", () => {
    clearInterval(heartbeatTimer);
    detachSocket(socket);
  });
  socket.on("error", () => {
    clearInterval(heartbeatTimer);
    detachSocket(socket);
  });
});

// ---------- WebSocket：本地程式 connector ----------
agentWss.on("connection", (socket, request) => {
  const socketIp = normalizeIp(request?.socket?.remoteAddress);
  const wsIp = extractWsClientIp(request);
  if (!isIpAllowed(normalizeIp(wsIp ?? socketIp))) {
    logSecurityEvent("WEBSOCKET_DENY", { route: "/agent", ip: normalizeIp(wsIp ?? socketIp) });
    socket.close(4403, "FORBIDDEN_IP");
    return;
  }
  const url = request?.url ? new URL(request.url, `http://localhost:${port}`) : null;
  const key = normalizeCode(url?.searchParams.get("key") ?? "");
  const deviceId = normalizeCode(url?.searchParams.get("device") ?? "");
  const proof = normalizeCode(url?.searchParams.get("proof") ?? "");
  if (!key || !HEX16.test(key)) {
    socket.close(4400, "INVALID_KEY");
    return;
  }
  if (!verifyConnectorDevice(key, deviceId, proof)) {
    logSecurityEvent("CONNECTOR_DEVICE_REJECTED", {
      ip: normalizeIp(wsIp ?? socketIp),
      key: maskKey(key),
      deviceId: deviceId ? maskKey(deviceId) : "missing"
    });
    socket.close(4403, "DEVICE_REJECTED");
    return;
  }
  if (isAuthKeyBlocked(key)) {
    logSecurityEvent("BLOCKED_KEY_CONNECTOR", { ip: normalizeIp(wsIp ?? socketIp), key: maskKey(key) });
    socket.close(4403, "KEY_BLOCKED");
    return;
  }

  // 同一密钥若已有连接，替换旧的
  const existing = connectors.get(key);
  if (existing && existing.socket !== socket) {
    try {
      existing.socket.close(4409, "REPLACED");
    } catch {}
  }
  if (connectors.size >= CODEX_MAX_CONNECTORS && !connectors.has(key)) {
    socket.close(1013, "CONNECTOR_LIMIT");
    return;
  }

  const conn: ConnectorConn = {
    key,
    socket,
    nextId: 1,
    pending: new Map(),
    chats: new Map(),
    chatQueue: [],
    activeChat: null,
    connectedAt: Date.now(),
    lastPongAt: Date.now(),
    heartbeatTimer: setInterval(() => {
      if (socket.readyState !== socket.OPEN) {
        return;
      }
      const silentMs = Date.now() - conn.lastPongAt;
      if (silentMs > 90_000) {
        console.log(`[agent] connector 心跳超时 key=${key.slice(0, 4)}…，断开等待重连`);
        socket.terminate();
        return;
      }
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, 30_000)
  };
  connectors.set(key, conn);
  console.log(`[agent] connector 上线 key=${key.slice(0, 4)}… 当前在线 ${connectors.size}`);

  socket.on("pong", () => {
    conn.lastPongAt = Date.now();
  });

  socket.on("message", (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    handleAgentMessage(conn, msg);
  });

  const cleanup = () => {
    clearInterval(conn.heartbeatTimer);
    if (connectors.get(key) === conn) {
      connectors.delete(key);
    }
    const err = new Error("电脑客户端已断开。");
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    conn.pending.clear();
    for (const c of conn.chats.values()) {
      clearTimeout(c.timer);
      c.fail(err);
    }
    conn.chats.clear();
    for (const item of conn.chatQueue.splice(0)) {
      clearTimeout(item.queueTimer);
      item.reject(err);
    }
    conn.activeChat = null;
    console.log(`[agent] connector 下线 key=${key.slice(0, 4)}… 当前在线 ${connectors.size}`);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

function handleAgentMessage(conn: ConnectorConn, msg: any) {
  if (msg?.kind === "rpcResult" || msg?.kind === "rpcError") {
    const pending = conn.pending.get(msg.id);
    if (!pending) {
      return;
    }
    conn.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.kind === "rpcResult") {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.message ?? "电脑客户端返回错误。"));
    }
    return;
  }

  const chat = msg?.reqId ? conn.chats.get(msg.reqId) : undefined;
  if (!chat) {
    return;
  }
  if (msg.kind === "chatDelta") {
    bumpChatTimer(conn, msg.reqId);
    chat.onDelta(typeof msg.delta === "string" ? msg.delta : "");
  } else if (msg.kind === "chatDone") {
    finishChat(conn, msg.reqId);
    chat.done();
  } else if (msg.kind === "chatError") {
    finishChat(conn, msg.reqId);
    chat.fail(new Error(msg.message ?? "Codex 回复失败。"));
  }
}

function callConnector(key: string, method: string, params: unknown): Promise<any> {
  const conn = connectors.get(key);
  if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
    return Promise.reject(new Error("电脑客户端未连接。"));
  }
  const id = conn.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error("电脑客户端响应超时。"));
    }, RPC_TIMEOUT_MS);
    conn.pending.set(id, { resolve, reject, timer });
    conn.socket.send(JSON.stringify({ kind: "rpc", id, method, params }));
  });
}

function streamChat(key: string, input: AgentInput, onDelta: (d: string) => void): Promise<void> {
  const conn = connectors.get(key);
  if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
    return Promise.reject(new Error("电脑客户端未连接。"));
  }
  const reqId = createId("chat");
  return new Promise((resolve, reject) => {
    if (conn.activeChat && conn.chatQueue.length >= CONNECTOR_CHAT_QUEUE_LIMIT) {
      reject(new Error(`当前电脑客户端排队已满（最多 ${CONNECTOR_CHAT_QUEUE_LIMIT} 条），请稍后再发。`));
      return;
    }
    const item: ChatQueueItem = {
      reqId,
      input,
      onDelta,
      resolve,
      reject,
      queueTimer: setTimeout(() => {
        const index = conn.chatQueue.findIndex((queued) => queued.reqId === reqId);
        if (index >= 0) {
          conn.chatQueue.splice(index, 1);
          reject(new Error("排队等待超时，请稍后重试。"));
        }
      }, CONNECTOR_CHAT_QUEUE_TIMEOUT_MS)
    };
    if (conn.activeChat) {
      conn.chatQueue.push(item);
      return;
    }
    startChat(conn, item);
  });
}

function startChat(conn: ConnectorConn, item: ChatQueueItem) {
  clearTimeout(item.queueTimer);
  const timer = setTimeout(() => {
    finishChat(conn, item.reqId);
    item.reject(new Error("Codex 回复超时。"));
  }, CHAT_INACTIVITY_MS);
  conn.activeChat = item.reqId;
  conn.chats.set(item.reqId, { onDelta: item.onDelta, done: item.resolve, fail: item.reject, timer });
  try {
    conn.socket.send(JSON.stringify({ kind: "chatStart", reqId: item.reqId, input: item.input }));
  } catch (error) {
    finishChat(conn, item.reqId);
    item.reject(error instanceof Error ? error : new Error("发送到电脑客户端失败。"));
  }
}

function finishChat(conn: ConnectorConn, reqId: string) {
  const chat = conn.chats.get(reqId);
  if (chat) {
    clearTimeout(chat.timer);
    conn.chats.delete(reqId);
  }
  if (conn.activeChat === reqId) {
    conn.activeChat = null;
    startNextQueuedChat(conn);
  }
}

function startNextQueuedChat(conn: ConnectorConn) {
  if (conn.activeChat || conn.socket.readyState !== conn.socket.OPEN) {
    return;
  }
  const next = conn.chatQueue.shift();
  if (next) {
    startChat(conn, next);
  }
}

function bumpChatTimer(conn: ConnectorConn, reqId: string) {
  const chat = conn.chats.get(reqId);
  if (!chat) {
    return;
  }
  clearTimeout(chat.timer);
  chat.timer = setTimeout(() => {
    finishChat(conn, reqId);
    chat.fail(new Error("Codex 回复超时。"));
  }, CHAT_INACTIVITY_MS);
}

async function handleUserMessage(socket: WebSocket, event: UserMessageEvent) {
  const assistantMessageId = createId("assistant");
  const sessionToken = socketSessionMap.get(socket);
  const session = sessionToken ? activeSessions.get(sessionToken) : null;
  if (session && !recordMessageAttempt(session)) {
    sendError(
      socket,
      event.sessionId,
      "RATE_LIMITED",
      `发送太快了：每 ${Math.round(SESSION_MESSAGE_WINDOW_MS / 1000)} 秒最多 ${SESSION_MESSAGE_LIMIT} 条，请稍后再试。`,
      event.messageId
    );
    return;
  }
  if (session) {
    session.messageCount++;
    logSecurityEvent("USER_MESSAGE_RECEIVED", {
      level: "info",
      key: maskKey(session.key),
      sessionToken: session.token.slice(0, 8),
      textLength: event.text.length
    });
    session.messages.push({
      id: event.messageId,
      role: "user",
      messageId: event.messageId,
      text: event.text,
      timestamp: nowIso(),
      threadId: session.threadId ?? undefined
    });
    trimSessionMessages(session);
  }

  send(socket, {
    id: createId("event"),
    type: "assistant_started",
    sessionId: event.sessionId,
    timestamp: nowIso(),
    messageId: assistantMessageId
  });

  const buffer: string[] = [];
  try {
    if (!session) {
      throw new Error("会话已失效。");
    }
    await streamChat(session.key, { sessionId: event.sessionId, messageId: event.messageId, text: event.text, settings: event.settings }, (delta) => {
      buffer.push(delta);
      send(socket, {
        id: createId("event"),
        type: "assistant_delta",
        sessionId: event.sessionId,
        timestamp: nowIso(),
        messageId: assistantMessageId,
        delta
      });
    });

    if (session) {
      session.threadId = event.sessionId;
      session.messages.push({
        id: assistantMessageId,
        role: "assistant",
        messageId: assistantMessageId,
        text: buffer.join(""),
        timestamp: nowIso(),
        threadId: session.threadId
      });
      session.messageCount++;
      trimSessionMessages(session);
      logSecurityEvent("ASSISTANT_MESSAGE_DONE", {
        level: "info",
        key: maskKey(session.key),
        sessionToken: session.token.slice(0, 8),
        textLength: buffer.join("").length
      });
    }

    send(socket, {
      id: createId("event"),
      type: "assistant_done",
      sessionId: event.sessionId,
      timestamp: nowIso(),
      messageId: assistantMessageId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex 回复失败。";
    sendError(socket, event.sessionId, "AGENT_FAILED", `Codex 连接或回复失败：${message}`, assistantMessageId);
  }
}

// 默认只绑回环 127.0.0.1：只允许本机 nginx 反代访问，外部无法直连绕过 TLS。
const host = process.env.HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  console.log(`Relay listening on http://${host}:${port}  (ws /ws 给网页端, /agent 给电脑端)`);
});

// ---------- 工具函数 ----------
function sessionKey(request: express.Request): string | null {
  const token = extractSessionToken(request);
  const record = token ? activeSessions.get(token) : undefined;
  if (!record) {
    return null;
  }
  if (isAuthKeyBlocked(record.key)) {
    activeSessions.delete(record.token);
    return null;
  }
  return record.key;
}

function detachSocket(socket: WebSocket) {
  const sessionToken = socketSessionMap.get(socket);
  if (sessionToken) {
    const userSession = activeSessions.get(sessionToken);
    if (userSession && userSession.connectedSockets > 0) {
      userSession.connectedSockets--;
    }
    socketSessionMap.delete(socket);
  }
  sockets.delete(socket);
}

function send(socket: WebSocket, event: ServerEvent) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

function sendError(socket: WebSocket, sessionId: string, code: string, message: string, messageId?: string) {
  const event: ErrorEvent = { id: createId("event"), type: "error", sessionId, timestamp: nowIso(), code, message, messageId };
  send(socket, event);
}

function buildMacDownloadCommand(): string {
  const relayWsUrl = toAgentWebSocketUrl(PUBLIC_BASE_URL);
  return [
    "#!/bin/bash",
    "# Codex 远程客户端 —— 双击运行（macOS）。运行后会显示一个 16 位密钥，把它填到网页端。",
    "set -euo pipefail",
    `BASE="${BOOTSTRAP_BASE_URL}"`,
    `RELAY_WS="${relayWsUrl}"`,
    'DIR="$HOME/CodexRemoteConnector"',
    'mkdir -p "$DIR"',
    'echo "正在下载 Codex 远程客户端与证书…"',
    '# 自签证书：下载这两个公开文件时跳过校验（-k）；连接器随后用证书对 wss 做校验。',
    'curl -fsSLk "$BASE/codex/connector/cert.pem"   -o "$DIR/relay-cert.pem"',
    'curl -fsSLk "$BASE/codex/connector/bundle.cjs" -o "$DIR/codex-connector.cjs"',
    'chmod 600 "$DIR/relay-cert.pem" "$DIR/codex-connector.cjs" || true',
    'if ! command -v curl >/dev/null 2>&1; then',
    '  echo "未检测到 curl，请先安装 Apple 命令行工具（Xcode CLI）。"',
    '  read -n 1 -s -r -p "按任意键关闭…"; exit 1',
    "fi",
    'if ! command -v node >/dev/null 2>&1; then',
    '  if [ -x "/opt/homebrew/bin/node" ]; then',
    '    NODE_BIN="/opt/homebrew/bin/node"',
    '  elif [ -x "/usr/local/bin/node" ]; then',
    '    NODE_BIN="/usr/local/bin/node"',
    '  elif [ -x "/usr/bin/node" ]; then',
    '    NODE_BIN="/usr/bin/node"',
    '  else',
    '  echo "未检测到 Node.js，请先安装 Node（https://nodejs.org）后重试。"',
    '  read -n 1 -s -r -p "按任意键关闭…"; exit 1',
    "  fi",
    "fi",
    'NODE_BIN="${NODE_BIN:-node}"',
    'if ! command -v "$NODE_BIN" >/dev/null 2>&1; then',
    '  echo "未找到可用 Node 可执行文件（系统 PATH 中也不存在 node）。"',
    '  read -n 1 -s -r -p "按任意键关闭…"; exit 1',
    "fi",
    '# 让客户端信任服务器自签证书，从而以 wss 加密+校验方式连接（防中间人）。',
    'export NODE_EXTRA_CA_CERTS="$DIR/relay-cert.pem"',
    `export RELAY_WS="$RELAY_WS"`,
    '# 强制同步：手机消息会粘贴并发送到已打开的 Codex 桌面窗口，再把该窗口产生的回复回传网页。',
    '# 如果没有给终端/Node 辅助功能权限，可改成 off 回到后台 app-server 通道。',
    'export CODEX_DESKTOP_SYNC_MODE="${CODEX_DESKTOP_SYNC_MODE:-paste}"',
    'export CODEX_DESKTOP_SYNC_POLL_MS="${CODEX_DESKTOP_SYNC_POLL_MS:-250}"',
    'export CODEX_DESKTOP_SYNC_PASTE_DELAY_MS="${CODEX_DESKTOP_SYNC_PASTE_DELAY_MS:-350}"',
    "# 连接保活参数（可按需调整）",
    'export CONNECTOR_HEARTBEAT_MS=25000',
    'export CONNECTOR_PONG_TIMEOUT_MS=75000',
    'export CONNECTOR_RECONNECT_INITIAL_MS=1000',
    'export CONNECTOR_RECONNECT_MAX_MS=60000',
    'export CONNECTOR_RECONNECT_JITTER_MS=500',
    'export CONNECTOR_RECONNECT_MAX_ATTEMPTS=0',
    'echo "启动客户端，请保持本窗口开启……（关闭窗口即断开）"',
    'exec "$NODE_BIN" "$DIR/codex-connector.cjs"',
    ""
  ].join("\n");
}

function buildWindowsDownloadCommand(): string {
  const relayWsUrl = toAgentWebSocketUrl(PUBLIC_BASE_URL);
  return [
    "@echo off",
    "chcp 65001 >nul",
    "setlocal",
    "title Codex Remote Connector",
    "echo Codex 远程客户端 - Windows",
    "echo.",
    `set "BASE=${BOOTSTRAP_BASE_URL}"`,
    `set "RELAY_WS=${relayWsUrl}"`,
    'set "DIR=%USERPROFILE%\\CodexRemoteConnector"',
    'if not exist "%DIR%" mkdir "%DIR%"',
    "echo 正在下载 Codex 远程客户端与证书...",
    'curl.exe -fsSLk "%BASE%/codex/connector/cert.pem" -o "%DIR%\\relay-cert.pem"',
    "if errorlevel 1 goto download_failed",
    'curl.exe -fsSLk "%BASE%/codex/connector/bundle.cjs" -o "%DIR%\\codex-connector.cjs"',
    "if errorlevel 1 goto download_failed",
    "where node >nul 2>nul",
    "if errorlevel 1 goto node_missing",
    'set "NODE_EXTRA_CA_CERTS=%DIR%\\relay-cert.pem"',
    'set "CONNECTOR_HEARTBEAT_MS=25000"',
    'set "CONNECTOR_PONG_TIMEOUT_MS=75000"',
    'set "CONNECTOR_RECONNECT_INITIAL_MS=1000"',
    'set "CONNECTOR_RECONNECT_MAX_MS=60000"',
    'set "CONNECTOR_RECONNECT_JITTER_MS=500"',
    'set "CONNECTOR_RECONNECT_MAX_ATTEMPTS=0"',
    'set "CODEX_REMOTE_WORKSPACE=%USERPROFILE%\\CodexRemoteWorkspace"',
    "echo.",
    "echo 启动客户端，请保持本窗口开启。（关闭窗口即断开）",
    "echo.",
    'node "%DIR%\\codex-connector.cjs"',
    "echo.",
    "echo 客户端已退出。",
    "pause",
    "exit /b",
    "",
    ":download_failed",
    "echo 下载失败，请确认网络可以访问服务器，或稍后再试。",
    "pause",
    "exit /b 1",
    "",
    ":node_missing",
    "echo 未检测到 Node.js，请先安装 Node.js LTS：https://nodejs.org/",
    "pause",
    "exit /b 1",
    ""
  ].join("\r\n");
}

function normalizeCode(value: string | undefined) {
  return value?.normalize("NFKC").toLowerCase().trim().replace(/[^0-9a-f]/g, "");
}
type RateLimitScope = "USER_AUTH" | "ADMIN_AUTH";
type RateLimitRecord = {
  failures: number[];
  blockedUntil: number | null;
};
type SecurityEventRecord = {
  ts: string;
  level: "info" | "warn";
  component: string;
  event: string;
  [key: string]: unknown;
};
type ConnectorDeviceRecord = {
  deviceId: string;
  proof: string;
  firstSeenAt: number;
  lastSeenAt: number;
};
const userAuthRateLimit = new Map<string, RateLimitRecord>();
const adminAuthRateLimit = new Map<string, RateLimitRecord>();
const wsConnectRateLimit = new Map<string, RateLimitRecord>();
const agentConnectRateLimit = new Map<string, RateLimitRecord>();
const allowlist = parseIpAllowlist(process.env.CODEX_IP_ALLOWLIST ?? process.env.CODEX_ALLOW_IPS);
const securityEvents: SecurityEventRecord[] = [];

// 限流表定期清理：删除已过期且未封禁的条目，并设硬上限，避免被伪造/海量 IP 撑爆内存。
const RATE_LIMIT_MAX_ENTRIES = Number(process.env.CODEX_RATE_LIMIT_MAX_ENTRIES ?? 50_000);
function pruneRateLimitMap(store: Map<string, RateLimitRecord>, windowMs: number) {
  const now = Date.now();
  for (const [ip, state] of store) {
    const blocked = Boolean(state.blockedUntil && now < state.blockedUntil);
    const recentFail = state.failures.some((time) => now - time < windowMs);
    if (!blocked && !recentFail) {
      store.delete(ip);
    }
  }
  if (store.size > RATE_LIMIT_MAX_ENTRIES) {
    let excess = store.size - RATE_LIMIT_MAX_ENTRIES;
    for (const ip of store.keys()) {
      if (excess-- <= 0) {
        break;
      }
      store.delete(ip);
    }
  }
}
setInterval(() => {
  pruneRateLimitMap(userAuthRateLimit, AUTH_RATE_WINDOW_MS);
  pruneRateLimitMap(adminAuthRateLimit, ADMIN_RATE_WINDOW_MS);
  pruneRateLimitMap(wsConnectRateLimit, WS_CONNECT_RATE_WINDOW_MS);
  pruneRateLimitMap(agentConnectRateLimit, AGENT_CONNECT_RATE_WINDOW_MS);
}, 60_000).unref();

// 全局失败洪峰告警：即使来自大量不同 IP（僵尸网络/代理池），也能在被分散爆破时收到告警。
const globalAuthFailures: number[] = [];
const GLOBAL_AUTH_FLOOD_WINDOW_MS = 60_000;
const GLOBAL_AUTH_FLOOD_THRESHOLD = Number(process.env.CODEX_GLOBAL_AUTH_FLOOD_THRESHOLD ?? 100);
function noteGlobalAuthFailure(scope: RateLimitScope, ip: string) {
  const now = Date.now();
  globalAuthFailures.push(now);
  while (globalAuthFailures.length && now - globalAuthFailures[0] > GLOBAL_AUTH_FLOOD_WINDOW_MS) {
    globalAuthFailures.shift();
  }
  if (globalAuthFailures.length === GLOBAL_AUTH_FLOOD_THRESHOLD) {
    logSecurityEvent("GLOBAL_AUTH_FLOOD", { scope, ip, failuresPerMinute: globalAuthFailures.length });
  }
}

// 只信任 nginx 注入的 X-Real-IP（= $remote_addr，由 nginx 用 proxy_set_header 覆盖，客户端无法伪造）。
// 绝不使用客户端可控的 X-Forwarded-For 最左值——否则可伪造 IP 绕过限流与白名单、撑爆限流表。
function trustedClientIp(headers: Record<string, unknown> | undefined, socketAddr: string | undefined) {
  const rawRealIp = headers?.["x-real-ip"];
  const realIp = Array.isArray(rawRealIp) ? rawRealIp[0] : rawRealIp;
  if (typeof realIp === "string" && realIp.trim()) {
    return normalizeIp(realIp.trim());
  }
  return normalizeIp(socketAddr);
}

function extractClientIp(request: express.Request) {
  return trustedClientIp(request.headers as Record<string, unknown>, request.socket?.remoteAddress);
}

function extractUpgradeClientIp(request: any) {
  return trustedClientIp(request?.headers, request?.socket?.remoteAddress);
}

function extractWsClientIp(request: any) {
  const ip = trustedClientIp(request?.headers, request?.socket?.remoteAddress);
  return ip === "unknown" ? undefined : ip;
}

function loadAdminAccessKey() {
  const filePath = process.env.CODEX_ADMIN_KEY_FILE;
  if (filePath) {
    try {
      const content = readFileSync(filePath, "utf8").trim();
      if (content) {
        return content.toLowerCase().trim();
      }
    } catch (error) {
      console.warn("读取 CODEX_ADMIN_KEY_FILE 失败：", error instanceof Error ? error.message : String(error));
    }
  }

  return process.env.CODEX_ADMIN_KEY?.trim();
}

function parseAuthKeyAllowlist(raw: string | undefined) {
  if (!raw) {
    return new Set<string>();
  }

  return new Set(
    raw
      .split(",")
      .map((item) => normalizeCode(item))
      .filter((item): item is string => Boolean(item && HEX16.test(item)))
  );
}

function isAuthKeyAllowlisted(code: string | undefined) {
  return Boolean(code && AUTH_KEY_ALLOWLIST.has(code));
}

function isAuthKeyBlocked(code: string | undefined) {
  return Boolean(code && blockedAuthKeys.has(code));
}

function loadBlockedAuthKeys(filePath: string) {
  if (!filePath || !existsSync(filePath)) {
    return new Set<string>();
  }
  try {
    return new Set(
      readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((line) => normalizeCode(line))
        .filter((line): line is string => Boolean(line && HEX16.test(line)))
    );
  } catch (error) {
    console.warn("读取密钥黑名单失败：", error instanceof Error ? error.message : String(error));
    return new Set<string>();
  }
}

function persistBlockedAuthKeys(filePath: string) {
  if (!filePath) {
    return;
  }
  try {
    writeFileSync(filePath, `${[...blockedAuthKeys].sort().join("\n")}${blockedAuthKeys.size ? "\n" : ""}`, {
      encoding: "utf8",
      mode: 0o600
    });
  } catch (error) {
    console.warn("写入密钥黑名单失败：", error instanceof Error ? error.message : String(error));
  }
}

function loadConnectorDevices(filePath: string) {
  if (!filePath || !existsSync(filePath)) {
    return new Map<string, ConnectorDeviceRecord>();
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, ConnectorDeviceRecord>;
    return new Map(
      Object.entries(parsed).filter(([, record]) =>
        Boolean(record && HEX16.test(record.deviceId) && /^[0-9a-f]{32}$/.test(record.proof))
      )
    );
  } catch (error) {
    console.warn("读取 connector 设备绑定失败：", error instanceof Error ? error.message : String(error));
    return new Map<string, ConnectorDeviceRecord>();
  }
}

function persistConnectorDevices(filePath: string) {
  if (!filePath) {
    return;
  }
  try {
    writeFileSync(filePath, `${JSON.stringify(Object.fromEntries(connectorDevices), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  } catch (error) {
    console.warn("写入 connector 设备绑定失败：", error instanceof Error ? error.message : String(error));
  }
}

function verifyConnectorDevice(key: string, deviceId: string | undefined, proof: string | undefined) {
  if (!deviceId || !proof || !HEX16.test(deviceId) || !/^[0-9a-f]{32}$/.test(proof)) {
    return false;
  }
  const now = Date.now();
  const existing = connectorDevices.get(key);
  if (!existing) {
    connectorDevices.set(key, { deviceId, proof, firstSeenAt: now, lastSeenAt: now });
    persistConnectorDevices(CONNECTOR_DEVICE_FILE);
    logSecurityEvent("CONNECTOR_DEVICE_BOUND", { level: "info", key: maskKey(key), deviceId: maskKey(deviceId) });
    return true;
  }
  if (!safeEqualHex(existing.deviceId, deviceId) || !safeEqualHex(existing.proof, proof)) {
    return false;
  }
  existing.lastSeenAt = now;
  persistConnectorDevices(CONNECTOR_DEVICE_FILE);
  return true;
}

function maskKey(key: string) {
  return key.length >= 6 ? `${key.slice(0, 4)}…${key.slice(-2)}` : key;
}

// 恒定时间比较，避免用 === 比较密钥时被时间侧信道一点点测出来。
function safeEqualHex(a: string | undefined, b: string | undefined) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function countSessionsForKey(key: string) {
  return [...activeSessions.values()].filter((session) => session.key === key).length;
}

function closeSessionsForKey(key: string, reason: string) {
  let closedSessions = 0;
  for (const [token, session] of [...activeSessions]) {
    if (session.key !== key) {
      continue;
    }
    activeSessions.delete(token);
    closedSessions++;
    for (const [socket, socketToken] of [...socketSessionMap]) {
      if (socketToken !== token) {
        continue;
      }
      sendError(socket, "blocked", "KEY_BLOCKED", reason);
      socket.close(4403, "KEY_BLOCKED");
      socketSessionMap.delete(socket);
      sockets.delete(socket);
    }
  }
  return closedSessions;
}

function canProceedRateLimit(scope: RateLimitScope, ip: string) {
  if (ip === "unknown") {
    return true;
  }
  const now = Date.now();
  const state = getRateLimitState(scope, ip);
  if (state.blockedUntil && now < state.blockedUntil) {
    return false;
  }
  if (state.blockedUntil && now >= state.blockedUntil) {
    state.blockedUntil = null;
  }

  const windowMs = scope === "ADMIN_AUTH" ? ADMIN_RATE_WINDOW_MS : AUTH_RATE_WINDOW_MS;
  const maxFails = scope === "ADMIN_AUTH" ? ADMIN_RATE_MAX_FAILS : AUTH_RATE_MAX_FAILS;
  if (maxFails <= 0) {
    return true;
  }
  state.failures = state.failures.filter((time) => now - time < windowMs);
  if (state.failures.length >= maxFails) {
    const blockMs = scope === "ADMIN_AUTH" ? ADMIN_RATE_BLOCK_MS : AUTH_RATE_BLOCK_MS;
    state.blockedUntil = now + blockMs;
    logSecurityEvent("RATE_LIMIT_BLOCK", { scope, ip, failures: state.failures.length, blockedUntil: state.blockedUntil });
    return false;
  }
  return true;
}

function recordRateLimitFailure(scope: RateLimitScope, ip: string, reason: string) {
  if (ip === "unknown") {
    return;
  }
  const now = Date.now();
  const state = getRateLimitState(scope, ip);
  const windowMs = scope === "ADMIN_AUTH" ? ADMIN_RATE_WINDOW_MS : AUTH_RATE_WINDOW_MS;
  state.failures = state.failures.filter((time) => now - time < windowMs);
  state.failures.push(now);
  logSecurityEvent("RATE_LIMIT_FAIL", { scope, ip, reason, failures: state.failures.length });
  noteGlobalAuthFailure(scope, ip);
}

function getRateLimitRetryMs(scope: RateLimitScope, ip: string) {
  const state = getRateLimitState(scope, ip);
  if (!state.blockedUntil) {
    return 0;
  }
  return Math.max(0, state.blockedUntil - Date.now());
}

function clearRateLimit(scope: RateLimitScope, ip: string) {
  if (scope === "USER_AUTH") {
    userAuthRateLimit.delete(ip);
  } else {
    adminAuthRateLimit.delete(ip);
  }
}

function getRateLimitState(scope: RateLimitScope, ip: string) {
  const store = scope === "USER_AUTH" ? userAuthRateLimit : adminAuthRateLimit;
  const existing = store.get(ip);
  if (existing) {
    return existing;
  }
  const created = { failures: [], blockedUntil: null } as RateLimitRecord;
  store.set(ip, created);
  return created;
}

type ConnectionLimitScope = "WS_CONNECT" | "AGENT_CONNECT";
function recordConnectionAttempt(scope: ConnectionLimitScope, ip: string) {
  if (ip === "unknown") {
    return true;
  }
  const store = scope === "WS_CONNECT" ? wsConnectRateLimit : agentConnectRateLimit;
  const windowMs = scope === "WS_CONNECT" ? WS_CONNECT_RATE_WINDOW_MS : AGENT_CONNECT_RATE_WINDOW_MS;
  const maxAttempts = scope === "WS_CONNECT" ? WS_CONNECT_RATE_MAX : AGENT_CONNECT_RATE_MAX;
  const blockMs = scope === "WS_CONNECT" ? WS_CONNECT_RATE_BLOCK_MS : AGENT_CONNECT_RATE_BLOCK_MS;
  const now = Date.now();
  const state = store.get(ip) ?? { failures: [], blockedUntil: null };
  if (state.blockedUntil && now < state.blockedUntil) {
    logSecurityEvent("CONNECT_RATE_LIMITED", { scope, ip, retryAfterMs: state.blockedUntil - now });
    store.set(ip, state);
    return false;
  }
  if (state.blockedUntil && now >= state.blockedUntil) {
    state.blockedUntil = null;
  }
  state.failures = state.failures.filter((time) => now - time < windowMs);
  state.failures.push(now);
  if (maxAttempts > 0 && state.failures.length > maxAttempts) {
    state.blockedUntil = now + blockMs;
    logSecurityEvent("CONNECT_RATE_BLOCK", { scope, ip, attempts: state.failures.length, blockedUntil: state.blockedUntil });
    store.set(ip, state);
    return false;
  }
  store.set(ip, state);
  return true;
}

type IPRule = { family: 4; network: number; mask: number };
function parseIpAllowlist(raw: string | undefined) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => parseIpRule(item))
    .filter((item): item is IPRule => Boolean(item));
}

function parseIpRule(value: string) {
  if (!value.includes("/")) {
    const ip = normalizeIp(value);
    if (ip === "unknown" || ipv4ToInt(ip) === null) {
      return null;
    }
    return { family: 4, network: ipv4ToInt(ip)!, mask: 0xffffffff };
  }
  const [base, maskText] = value.split("/");
  const ip = normalizeIp(base);
  const bits = Number(maskText);
  const network = ipv4ToInt(ip ?? "");
  if (!ip || network === null || Number.isNaN(bits) || bits < 0 || bits > 32) {
    return null;
  }
  const mask = bits === 32 ? 0xffffffff : bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
  return { family: 4, network, mask };
}

function isIpAllowed(ip: string) {
  if (!allowlist.length) {
    return true;
  }
  if (!ip || ip === "unknown" || ip === "0.0.0.0") {
    return false;
  }
  return allowlist.some((rule) => {
    if (rule.family !== 4 || net.isIP(ip) !== 4) {
      return false;
    }
    return (ipv4ToInt(ip)! & rule.mask) === (rule.network & rule.mask);
  });
}

function ipv4ToInt(ip: string) {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }
  return ((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + (parts[3] >>> 0);
}

function logSecurityEvent(event: string, info: Record<string, unknown>) {
  const payload: SecurityEventRecord = {
    ts: new Date().toISOString(),
    level: info.level === "info" ? "info" : "warn",
    component: "local-codex-relay",
    event,
    ...info
  };
  const text = JSON.stringify(payload);
  if (payload.level === "info") {
    console.log(`[security] ${text}`);
  } else {
    console.warn(`[security] ${text}`);
  }
  securityEvents.push(payload);
  if (securityEvents.length > 1000) {
    securityEvents.splice(0, securityEvents.length - 1000);
  }

  if (SECURITY_AUDIT_LOG_PATH) {
    try {
      appendFileSync(SECURITY_AUDIT_LOG_PATH, `${text}\n`, { encoding: "utf8", flag: "a" });
    } catch (error) {
      console.warn("[security] 写安全日志失败：", error instanceof Error ? error.message : String(error));
    }
  }

  if (shouldAlertSecurityEvent(event)) {
    void sendSecurityAlert(payload);
  }
}

function alertThrottleKey(event: string, payload: Record<string, unknown>) {
  const ip = typeof payload.ip === "string" && payload.ip ? payload.ip : payload.route || "global";
  return `${event}|${ip}`;
}

function shouldAlertSecurityEvent(event: string) {
  return (
    event === "FORBIDDEN_IP" ||
    event === "FORBIDDEN_IP_UPGRADE" ||
    event === "RATE_LIMIT_BLOCK" ||
    event === "CONNECT_RATE_BLOCK" ||
    event === "CONNECTOR_DEVICE_REJECTED" ||
    event === "WEBSOCKET_DENY" ||
    event === "GLOBAL_AUTH_FLOOD" ||
    event === "RATE_LIMIT_FAIL"
  );
}

const securityAlertWindow = new Map<string, number>();
async function sendSecurityAlert(payload: Record<string, unknown>) {
  if (!SECURITY_ALERT_WEBHOOK) {
    return;
  }

  const event = String(payload.event);
  const now = Date.now();
  const key = alertThrottleKey(event, payload);
  const lastAlertAt = securityAlertWindow.get(key) ?? 0;
  if (now - lastAlertAt < SECURITY_ALERT_THROTTLE_MS) {
    return;
  }
  securityAlertWindow.set(key, now);

  try {
    await fetch(SECURITY_ALERT_WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch {
    // 告警失败不影响主流程
  }
}
function normalizeIp(address: string | undefined) {
  return address ? address.replace(/^::ffff:/, "") : "unknown";
}
function isAuthExcluded(path: string) {
  return (
    path === "/health" ||
    path.startsWith("/codex/auth/") ||
    path === ADMIN_VERIFY_PATH ||
    path.startsWith("/codex/connector/")
  );
}
function isAdminRoute(path: string) {
  return path.startsWith("/codex/admin/");
}
function extractSessionToken(request: express.Request) {
  const querySession = typeof request.query.session === "string" ? request.query.session : undefined;
  const queryAuth = typeof request.query.auth === "string" ? request.query.auth : undefined;
  const headerToken = request.header("x-codex-session");
  return normalizeCode(headerToken ?? querySession ?? queryAuth);
}
function extractAdminToken(request: express.Request) {
  const query = typeof request.query.adminSession === "string" ? request.query.adminSession : undefined;
  const header = request.header("x-codex-admin-session");
  const headerAlt = request.header("x-codex-admin");
  return normalizeCode(header ?? headerAlt ?? query);
}
function isSessionValid(session: SessionAuditRecord | undefined, now = Date.now()) {
  if (!session) {
    return false;
  }
  if (now > session.expiresAt) {
    activeSessions.delete(session.token);
    return false;
  }
  return true;
}
function touchUserSession(token: string | undefined, source: { ip: string; userAgent: string }) {
  if (!token) {
    return null;
  }
  const now = Date.now();
  const record = activeSessions.get(token);
  if (!record || !isSessionValid(record, now)) {
    return null;
  }
  if (isAuthKeyBlocked(record.key)) {
    activeSessions.delete(token);
    return null;
  }
  record.expiresAt = now + SESSION_TTL_MS;
  record.lastSeenAt = now;
  if (source.ip && source.ip !== "unknown") {
    record.ip = source.ip;
  }
  if (source.userAgent) {
    record.userAgent = source.userAgent;
  }
  return record;
}
function isAdminSessionValid(token: string | undefined) {
  if (!token) {
    return false;
  }
  const now = Date.now();
  const session = adminSessions.get(token);
  if (!session || now > session.expiresAt) {
    if (session) {
      adminSessions.delete(token);
    }
    return false;
  }
  session.lastSeenAt = now;
  session.expiresAt = now + ADMIN_SESSION_TTL_MS;
  return true;
}
function trimSessionMessages(session: SessionAuditRecord) {
  const maxMessages = 200;
  if (session.messages.length > maxMessages) {
    session.messages = session.messages.slice(session.messages.length - maxMessages);
  }
}

function recordMessageAttempt(session: SessionAuditRecord) {
  const now = Date.now();
  session.recentMessageTimestamps = session.recentMessageTimestamps.filter(
    (timestamp) => now - timestamp < SESSION_MESSAGE_WINDOW_MS
  );
  if (session.recentMessageTimestamps.length >= SESSION_MESSAGE_LIMIT) {
    return false;
  }
  session.recentMessageTimestamps.push(now);
  return true;
}
