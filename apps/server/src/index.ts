import express from "express";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import net from "node:net";
import os from "node:os";
import {
  FALLBACK_CODEX_MODELS,
  createId,
  nowIso,
  parseClientEvent,
  type CodexModelOption,
  type ErrorEvent,
  type ReasoningEffort,
  type ServerEvent,
  type UserMessageEvent
} from "@local-codex-remote/shared";
import { CodexAppServerAgent } from "./agent/codexAppServerAgent.js";

const REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);

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
  messages: AdminLogMessage[];
  socketCount: number;
};

type AdminSession = {
  token: string;
  expiresAt: number;
  lastSeenAt: number;
};

const port = Number(process.env.PORT ?? 8787);
const serverSourceDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot =
  process.env.CODEX_REMOTE_WORKSPACE ?? process.env.INIT_CWD ?? resolve(serverSourceDir, "../../..");
const app = express();
const server = createServer(app);
const sockets = new Set<WebSocket>();
const socketSessionMap = new Map<WebSocket, string>();
const agent = new CodexAppServerAgent({
  cwd: workspaceRoot
});

const SESSION_TTL_MS = Number(process.env.CODEX_SESSION_TTL_MS ?? 60 * 60 * 1000);
const ADMIN_SESSION_TTL_MS = Number(process.env.CODEX_ADMIN_SESSION_TTL_MS ?? 15 * 60 * 1000);
const AUTH_RATE_WINDOW_MS = Number(process.env.CODEX_AUTH_RATE_WINDOW_MS ?? 10 * 60 * 1000);
const AUTH_RATE_MAX_FAILS = Number(process.env.CODEX_AUTH_RATE_MAX_FAILS ?? 5);
const AUTH_RATE_BLOCK_MS = Number(process.env.CODEX_AUTH_RATE_BLOCK_MS ?? 60 * 1000);
const AUTH_KEY_ALLOWLIST = parseAuthKeyAllowlist(process.env.CODEX_AUTH_KEY_ALLOWLIST);
const ADMIN_RATE_WINDOW_MS = Number(process.env.CODEX_ADMIN_RATE_WINDOW_MS ?? 10 * 60 * 1000);
const ADMIN_RATE_MAX_FAILS = Number(process.env.CODEX_ADMIN_RATE_MAX_FAILS ?? 3);
const ADMIN_RATE_BLOCK_MS = Number(process.env.CODEX_ADMIN_RATE_BLOCK_MS ?? 10 * 60 * 1000);
const SECURITY_AUDIT_LOG_PATH = process.env.CODEX_SECURITY_AUDIT_LOG_PATH;
const SECURITY_ALERT_WEBHOOK = process.env.CODEX_SECURITY_ALERT_WEBHOOK?.trim();
const SECURITY_ALERT_THROTTLE_MS = Number(process.env.CODEX_SECURITY_ALERT_THROTTLE_MS ?? 60_000);
const IP_ALLOWLIST = parseIpAllowlist(process.env.CODEX_IP_ALLOWLIST ?? process.env.CODEX_ALLOW_IPS);
const ADMIN_ACCESS_KEY = loadAdminAccessKey();
const ADMIN_VERIFY_PATH = process.env.CODEX_ADMIN_VERIFY_PATH ?? "/codex/admin-auth/verify";
const ACCESS_CODE_FILE = resolve(workspaceRoot, ".codex-access-code");
const BLOCKED_KEY_FILE = process.env.CODEX_BLOCKED_KEY_FILE ?? resolve(workspaceRoot, ".codex-blocked-keys");
const accessCode = createAccessCode(process.env.CODEX_ACCESS_CODE, ACCESS_CODE_FILE);
const accessCodeSource = getAccessCodeSource(process.env.CODEX_ACCESS_CODE, accessCode, ACCESS_CODE_FILE);
const activeSessions = new Map<string, SessionAuditRecord>();
const adminSessions = new Map<string, AdminSession>();
const blockedAuthKeys = loadBlockedAuthKeys(BLOCKED_KEY_FILE);
const securityEvents: Array<Record<string, unknown>> = [];

if (!ADMIN_ACCESS_KEY) {
  console.warn("未配置 CODEX_ADMIN_KEY，管理员功能不可用。");
}

console.log(`本机验证码（16位）: ${accessCode}（来源：${accessCodeSource}）`);
console.log(`验证码持久化文件: ${ACCESS_CODE_FILE}`);
console.log(`进程PID: ${process.pid}`);
console.log(`运行目录: ${process.cwd()}`);
console.log("浏览器请先访问 /codex/auth/verify，填写验证码后再请求 /codex/* 与 /ws。");

app.use((request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
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
    logSecurityEvent("FORBIDDEN_IP", { route: request.path, ip: clientIp });
    response.status(403).json({
      code: "FORBIDDEN_IP",
      message: "当前IP无权访问该接口。"
    });
    return;
  }

  if (isAdminRoute(request.path)) {
    logSecurityEvent("ADMIN_ROUTE_ACCESS", { route: request.path, ip: clientIp, hasAdminToken: Boolean(extractAdminToken(request)) });
    const adminToken = extractAdminToken(request);

    if (!isAdminSessionValid(adminToken)) {
      response.status(401).json({
        code: "UNAUTHORIZED",
        message: "管理员身份未授权。"
      });
      return;
    }

    return next();
  }

  const token = extractSessionToken(request);
  const ip = normalizeIp(request.socket.remoteAddress);
  const userAgent = request.header("user-agent") ?? "";
  if (!touchUserSession(token, { ip, userAgent })) {
    response.status(401).json({
      code: "UNAUTHORIZED",
      message: "请先完成验证码验证。"
    });
    return;
  }

  next();
});

app.post("/codex/auth/verify", (request, response) => {
  const clientIp = extractClientIp(request);
  if (!isIpAllowed(clientIp)) {
    logSecurityEvent("FORBIDDEN_IP", { route: "/codex/auth/verify", ip: clientIp });
    response.status(403).json({
      code: "FORBIDDEN_IP",
      message: "当前IP无权访问验证码接口。"
    });
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

  if (typeof code !== "string" || !code.trim()) {
    recordRateLimitFailure("USER_AUTH", clientIp, "BAD_REQUEST");
    response.status(400).json({
      code: "BAD_REQUEST",
      message: "缺少验证码。"
    });
    return;
  }

  if (!normalizedCode || normalizedCode.length !== 16) {
    recordRateLimitFailure("USER_AUTH", clientIp, "INVALID_FORMAT");
    response.status(403).json({
      code: "INVALID_CODE",
      message: "验证码不正确：请填写 16 位十六进制验证码（0-9a-f）。"
    });
    return;
  }
  if (isAuthKeyBlocked(normalizedCode)) {
    logSecurityEvent("BLOCKED_KEY_LOGIN", { ip: clientIp, key: maskKey(normalizedCode) });
    response.status(403).json({
      code: "KEY_BLOCKED",
      message: "该密钥已被管理员拉黑。"
    });
    return;
  }

  if (normalizedCode !== accessCode) {
    if (!isTrustedAuthKey) {
      recordRateLimitFailure("USER_AUTH", clientIp, "INVALID_CODE");
    }
    response.status(403).json({
      code: "INVALID_CODE",
      message:
        "验证码不正确：请确认使用的是当前实例打印的 16 位验证码（可从服务器日志或 /opt/local-codex/.codex-access-code 获取）。"
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
    messages: [],
    socketCount: 0
  });
  logSecurityEvent("USER_LOGIN_SUCCESS", { level: "info", ip: clientIp, key: maskKey(normalizedCode) });

  response.json({
    code: "OK",
    sessionToken,
    expiresAt: now + SESSION_TTL_MS
  });
});

app.post(ADMIN_VERIFY_PATH, (request, response) => {
  const clientIp = extractClientIp(request);
  if (!isIpAllowed(clientIp)) {
    logSecurityEvent("FORBIDDEN_IP", { route: ADMIN_VERIFY_PATH, ip: clientIp });
    response.status(403).json({
      code: "FORBIDDEN_IP",
      message: "当前IP无权访问管理员接口。"
    });
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
    response.status(503).json({
      code: "ADMIN_NOT_CONFIGURED",
      message: "未配置管理员密钥。"
    });
    return;
  }

  if (typeof adminKey !== "string" || !adminKey.trim() || normalizeCode(adminKey) !== normalizeCode(ADMIN_ACCESS_KEY)) {
    recordRateLimitFailure("ADMIN_AUTH", clientIp, "INVALID_KEY");
    response.status(403).json({
      code: "INVALID_ADMIN_KEY",
      message: "管理员KEY不正确。"
    });
    return;
  }

  const adminToken = randomBytes(24).toString("hex");
  const now = Date.now();
  adminSessions.set(adminToken, {
    token: adminToken,
    expiresAt: now + ADMIN_SESSION_TTL_MS,
    lastSeenAt: now
  });
  logSecurityEvent("ADMIN_LOGIN_SUCCESS", { level: "info", ip: clientIp });

  response.json({
    code: "OK",
    adminSessionToken: adminToken,
    expiresAt: now + ADMIN_SESSION_TTL_MS
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
    connectorOnline: true
  }));

  response.json({
    sessions,
    total: sessions.length
  });
});

app.get("/codex/admin/blocked-keys", (_request, response) => {
  response.json({
    keys: [...blockedAuthKeys].map((key) => ({
      key,
      keyMasked: maskKey(key),
      protected: isAuthKeyAllowlisted(key),
      connectorOnline: key === accessCode,
      activeSessions: countSessionsForKey(key)
    }))
  });
});

app.post("/codex/admin/keys/block", (request, response) => {
  const key = normalizeCode(request.body?.key);
  if (!key || key.length !== 16) {
    response.status(400).json({
      code: "BAD_REQUEST",
      message: "缺少有效的 16 位密钥。"
    });
    return;
  }
  if (isAuthKeyAllowlisted(key)) {
    response.status(403).json({
      code: "PROTECTED_KEY",
      message: "这是受保护的白名单密钥，不能拉黑。"
    });
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
  if (!key || key.length !== 16) {
    response.status(400).json({
      code: "BAD_REQUEST",
      message: "缺少有效的 16 位密钥。"
    });
    return;
  }
  blockedAuthKeys.delete(key);
  persistBlockedAuthKeys(BLOCKED_KEY_FILE);
  logSecurityEvent("KEY_UNBLOCKED", { key: maskKey(key) });
  response.json({ code: "OK", key, keyMasked: maskKey(key) });
});

app.get("/codex/admin/sessions/:sessionToken/messages", (request, response) => {
  const sessionToken = request.params.sessionToken;
  const session = activeSessions.get(sessionToken);

  if (!session) {
    response.status(404).json({
      code: "SESSION_NOT_FOUND",
      message: "该用户会话不存在。"
    });
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
      connectedSockets: session.connectedSockets
    },
    messages
  });
});

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    name: "local-codex-remote-server",
    agent: "codex-app-server",
    workspaceRoot,
    sockets: sockets.size,
    timestamp: nowIso()
  });
});

app.get("/codex/status", async (_request, response) => {
  try {
    response.json(await agent.getStatus());
  } catch (error) {
    response.status(503).json({
      connected: false,
      message: error instanceof Error ? error.message : "Codex 连接失败。"
    });
  }
});

app.get("/codex/models", (_request, response) => {
  response.json({ models: readCodexModels() });
});

app.get("/codex/account/usage", async (_request, response) => {
  try {
    response.json(await agent.getAccountUsage());
  } catch (error) {
    response.status(503).json({
      message: error instanceof Error ? error.message : "额度读取失败。"
    });
  }
});

app.get("/codex/threads", async (_request, response) => {
  try {
    response.json({
      groups: await agent.listProjectGroups()
    });
  } catch (error) {
    response.status(503).json({
      message: error instanceof Error ? error.message : "Codex 对话列表读取失败。"
    });
  }
});

app.get("/codex/threads/:threadId/messages", async (request, response) => {
  try {
    response.json(await agent.readThreadMessages(request.params.threadId));
  } catch (error) {
    response.status(503).json({
      message: error instanceof Error ? error.message : "Codex 历史记录读取失败。"
    });
  }
});

app.post("/codex/threads", async (_request, response) => {
  try {
    const created = await agent.createThread();

    response.status(201).json({
      ...created,
      groups: await agent.listProjectGroups()
    });
  } catch (error) {
    response.status(503).json({
      message: error instanceof Error ? error.message : "Codex 新建对话失败。"
    });
  }
});

app.post("/codex/projects/select", async (request, response) => {
  const cwd = request.body?.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) {
    response.status(400).json({
      message: "缺少项目路径。"
    });
    return;
  }

  try {
    response.json(await agent.selectProject(cwd));
  } catch (error) {
    response.status(503).json({
      message: error instanceof Error ? error.message : "Codex 切换项目失败。"
    });
  }
});

app.post("/codex/threads/select", async (request, response) => {
  const threadId = request.body?.threadId;

  if (typeof threadId !== "string" || !threadId.trim()) {
    response.status(400).json({
      message: "缺少 threadId。"
    });
    return;
  }

  try {
    const selected = await agent.selectThread(threadId);

    response.json({
      ...selected,
      groups: await agent.listProjectGroups()
    });
  } catch (error) {
    response.status(503).json({
      message: error instanceof Error ? error.message : "Codex 切换对话失败。"
    });
  }
});

app.delete("/codex/threads/:threadId", async (request, response) => {
  try {
    response.json(await agent.deleteThread(request.params.threadId));
  } catch (error) {
    response.status(503).json({
      message: error instanceof Error ? error.message : "Codex 删除对话失败。"
    });
  }
});

const wss = new WebSocketServer({
  server,
  path: "/ws"
});

wss.on("connection", (socket, request) => {
  const socketIp = normalizeIp(request?.socket?.remoteAddress);
  const wsIp = extractWsClientIp(request);
  const clientIp = normalizeIp(wsIp ?? socketIp);
  if (!isIpAllowed(clientIp)) {
    logSecurityEvent("WEBSOCKET_DENY", { route: "/ws", ip: clientIp });
    socket.close(4403, "FORBIDDEN_IP");
    return;
  }

  const token = request?.url
    ? new URL(request.url, `http://localhost:${port}`).searchParams.get("session") ??
      new URL(request.url, `http://localhost:${port}`).searchParams.get("auth") ??
      ""
    : "";
  const session = touchUserSession(token, {
    ip: normalizeIp(request?.socket?.remoteAddress),
    userAgent: request?.headers["user-agent"] ?? ""
  });

  if (!session) {
    socket.close(4401, "UNAUTHORIZED");
    return;
  }

  socketSessionMap.set(socket, token);
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

  send(socket, {
    id: createId("event"),
    type: "connection_ready",
    sessionId,
    timestamp: nowIso()
  });

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
    const sessionToken = socketSessionMap.get(socket);

    if (sessionToken) {
      const userSession = activeSessions.get(sessionToken);
      if (userSession && userSession.connectedSockets > 0) {
        userSession.connectedSockets--;
      }
      socketSessionMap.delete(socket);
    }

    sockets.delete(socket);
  });

  socket.on("error", () => {
    clearInterval(heartbeatTimer);
    const sessionToken = socketSessionMap.get(socket);

    if (sessionToken) {
      const userSession = activeSessions.get(sessionToken);
      if (userSession && userSession.connectedSockets > 0) {
        userSession.connectedSockets--;
      }
      socketSessionMap.delete(socket);
    }

    sockets.delete(socket);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Local Codex Remote server listening on http://localhost:${port}`);
  console.log(`WebSocket endpoint is ws://localhost:${port}/ws`);
});

type RateLimitScope = "USER_AUTH" | "ADMIN_AUTH";
type RateLimitRecord = {
  failures: number[];
  blockedUntil: number | null;
};

const userAuthRateLimit = new Map<string, RateLimitRecord>();
const adminAuthRateLimit = new Map<string, RateLimitRecord>();

function extractClientIp(request: express.Request) {
  const raw = request.headers["x-forwarded-for"];
  const first = Array.isArray(raw) ? raw[0] : raw?.split(",")[0];
  return normalizeIp((first ?? request.socket?.remoteAddress) as string | undefined);
}

function extractWsClientIp(request: any) {
  const first = Array.isArray(request?.headers?.["x-forwarded-for"])
    ? request.headers["x-forwarded-for"][0]
    : request?.headers?.["x-forwarded-for"];
  return first ? String(first).split(",")[0].trim() : undefined;
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
      .filter((item): item is string => Boolean(item && item.length === 16))
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
        .filter((line): line is string => Boolean(line && line.length === 16))
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

function maskKey(key: string) {
  return key.length >= 6 ? `${key.slice(0, 4)}…${key.slice(-2)}` : key;
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
  const { blockedUntil } = state;
  if (blockedUntil && now < blockedUntil) {
    return false;
  }
  if (blockedUntil && now >= blockedUntil) {
    state.blockedUntil = null;
  }

  const windowMs = scope === "ADMIN_AUTH" ? ADMIN_RATE_WINDOW_MS : AUTH_RATE_WINDOW_MS;
  const maxFails = scope === "ADMIN_AUTH" ? ADMIN_RATE_MAX_FAILS : AUTH_RATE_MAX_FAILS;
  if (maxFails <= 0) {
    return true;
  }
  const failures = state.failures.filter((time) => now - time < windowMs);
  state.failures = failures;

  if (failures.length >= maxFails) {
    state.blockedUntil = now + (scope === "ADMIN_AUTH" ? ADMIN_RATE_BLOCK_MS : AUTH_RATE_BLOCK_MS);
    logSecurityEvent("RATE_LIMIT_BLOCK", { scope, ip, failures: failures.length, blockedUntil: state.blockedUntil });
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

type IPRule = { family: 4; network: number; mask: number };
let allowlist = IP_ALLOWLIST;
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
  return (
    ((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + (parts[3] >>> 0)
  );
}

function logSecurityEvent(event: string, info: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level: info.level === "info" ? "info" : "warn",
    component: "local-codex-server",
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

function shouldAlertSecurityEvent(event: string) {
  return event === "FORBIDDEN_IP" || event === "RATE_LIMIT_BLOCK" || event === "WEBSOCKET_DENY";
}

function readCodexModels(): CodexModelOption[] {
  const codexHome = process.env.CODEX_HOME ?? join(os.homedir(), ".codex");
  const cachePath = join(codexHome, "models_cache.json");

  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
      models?: Array<{
        slug?: unknown;
        display_name?: unknown;
        visibility?: unknown;
        priority?: unknown;
        default_reasoning_level?: unknown;
        supported_reasoning_levels?: Array<{ effort?: unknown }>;
        additional_speed_tiers?: unknown[];
        service_tiers?: Array<{ id?: unknown }>;
      }>;
    };
    const models = (parsed.models ?? [])
      .filter((model) => typeof model.slug === "string" && model.visibility === "list")
      .sort((left, right) => Number(left.priority ?? 999) - Number(right.priority ?? 999))
      .map((model): CodexModelOption => {
        const value = String(model.slug);
        const reasoningEfforts = (model.supported_reasoning_levels ?? [])
          .map((item) => item.effort)
          .filter((effort): effort is ReasoningEffort => typeof effort === "string" && REASONING_EFFORTS.has(effort as ReasoningEffort));
        const hasFastTier =
          (model.additional_speed_tiers ?? []).includes("fast") ||
          (model.service_tiers ?? []).some((tier) => tier.id === "priority");
        const defaultReasoningEffort =
          typeof model.default_reasoning_level === "string" && REASONING_EFFORTS.has(model.default_reasoning_level as ReasoningEffort)
            ? (model.default_reasoning_level as ReasoningEffort)
            : reasoningEfforts[0];

        return {
          value,
          label: typeof model.display_name === "string" ? model.display_name : value,
          defaultReasoningEffort,
          reasoningEfforts,
          speedTiers: hasFastTier ? ["standard", "fast"] : ["standard"]
        };
      });

    return models.length > 0 ? models : FALLBACK_CODEX_MODELS;
  } catch {
    return FALLBACK_CODEX_MODELS;
  }
}

const securityAlertWindow = new Map<string, number>();
async function sendSecurityAlert(payload: Record<string, unknown>) {
  if (!SECURITY_ALERT_WEBHOOK) {
    return;
  }

  const event = String(payload.event);
  const now = Date.now();
  const lastAlertAt = securityAlertWindow.get(event) ?? 0;
  if (now - lastAlertAt < SECURITY_ALERT_THROTTLE_MS) {
    return;
  }
  securityAlertWindow.set(event, now);

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

async function handleUserMessage(socket: WebSocket, event: UserMessageEvent) {
  const assistantMessageId = createId("assistant");
  const userMessageId = event.messageId;
  const sessionToken = socketSessionMap.get(socket);
  const session = sessionToken ? activeSessions.get(sessionToken) : null;
  if (sessionToken && session) {
    touchUserSession(sessionToken, {
      ip: session.ip,
      userAgent: session.userAgent
    });

    session.messageCount++;
    session.messages.push({
      id: userMessageId,
      role: "user",
      messageId: userMessageId,
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

  const assistantBuffer: string[] = [];

  try {
    for await (const chunk of agent.respond({
      sessionId: event.sessionId,
      messageId: event.messageId,
      text: event.text,
      settings: event.settings
    })) {
      assistantBuffer.push(chunk.text);
      send(socket, {
        id: createId("event"),
        type: "assistant_delta",
        sessionId: event.sessionId,
        timestamp: nowIso(),
        messageId: assistantMessageId,
        delta: chunk.text
      });
    }

    if (session) {
      session.threadId = event.sessionId;
      session.messages.push({
        id: assistantMessageId,
        role: "assistant",
        messageId: assistantMessageId,
        text: assistantBuffer.join(""),
        timestamp: nowIso(),
        threadId: session.threadId
      });
      session.messageCount++;
      trimSessionMessages(session);
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

function send(socket: WebSocket, event: ServerEvent) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

function sendError(
  socket: WebSocket,
  sessionId: string,
  code: string,
  message: string,
  messageId?: string
) {
  const event: ErrorEvent = {
    id: createId("event"),
    type: "error",
    sessionId,
    timestamp: nowIso(),
    code,
    message,
    messageId
  };

  send(socket, event);
}

function createAccessCode(value: string | undefined, persistPath: string) {
  const normalized = normalizeCode(value);

  if (normalized && normalized.length === 16) {
    return normalized;
  }

  const fileBased = loadPersistedAccessCode(persistPath);
  if (fileBased) {
    return fileBased;
  }

  const generated = randomBytes(8).toString("hex");
  persistAccessCode(persistPath, generated);

  return generated;
}

function getAccessCodeSource(configuredValue: string | undefined, resolvedCode: string, persistPath: string) {
  const normalized = normalizeCode(configuredValue);

  if (normalized && normalized.length === 16) {
    return "环境变量 CODEX_ACCESS_CODE";
  }

  const persisted = loadPersistedAccessCode(persistPath);
  if (persisted === resolvedCode) {
    return "持久化文件 .codex-access-code";
  }

  return "随机生成（本次启动）";
}

function loadPersistedAccessCode(filePath: string) {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const content = readFileSync(filePath, "utf8").trim();
    const normalized = normalizeCode(content);

    if (normalized && normalized.length === 16) {
      return normalized;
    }
  } catch (error) {
    console.warn("读取 .codex-access-code 失败：", error instanceof Error ? error.message : String(error));
  }
  return null;
}

function persistAccessCode(filePath: string, code: string) {
  try {
    writeFileSync(filePath, `${code}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn("写入 .codex-access-code 失败：", error instanceof Error ? error.message : String(error));
  }
}

function normalizeCode(value: string | undefined) {
  return value
    ?.normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[^0-9a-f]/g, "");
}

function normalizeIp(address: string | undefined) {
  return address ? address.replace(/^::ffff:/, "") : "unknown";
}

function isAuthExcluded(path: string) {
  return path === "/health" || path.startsWith("/codex/auth/") || path === ADMIN_VERIFY_PATH;
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

function touchUserSession(
  token: string | undefined,
  source: {
    ip: string;
    userAgent: string;
  }
) {
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

  activeSessions.set(token, record);
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
  adminSessions.set(token, session);
  return true;
}

function trimSessionMessages(session: SessionAuditRecord) {
  const maxMessages = 200;
  if (session.messages.length > maxMessages) {
    session.messages = session.messages.slice(session.messages.length - maxMessages);
  }
}
