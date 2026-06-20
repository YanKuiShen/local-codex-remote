// 本地程式（connector）：在用户自己的电脑上运行。
// 职责：① 生成/复用一个 16 位密钥并显示；② 主动拨号到云中转站(relay)；
//       ③ 把本机 Codex 的会话/历史/实时回复，按密钥转发给输入相同密钥的网页端。
import { WebSocket } from "ws";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Agent as HttpsAgent } from "node:https";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import os from "node:os";
import path from "node:path";
import {
  FALLBACK_CODEX_MODELS,
  getEffectiveChatRunSettings,
  type AgentInput,
  type ChatMessage,
  type CodexModelOption,
  type ReasoningEffort
} from "@local-codex-remote/shared";
import { CodexAppServerAgent } from "../../server/src/agent/codexAppServerAgent";

const HEX16 = /^[0-9a-f]{16}$/;
const REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);

const stateDir = process.env.CONNECTOR_STATE_DIR ?? path.join(os.homedir(), ".codex-remote-connector");
mkdirSync(stateDir, { recursive: true });
const keyFile = path.join(stateDir, "key");
const machineSecretFile = path.join(stateDir, "machine-secret");

const relayWsEnv = process.env.RELAY_WS || process.env.PUBLIC_BASE_URL || process.env.RELAY_BASE_URL || process.env.RELAY_BASE;
const relayWsBase = resolveRelayWsBase(relayWsEnv ?? `ws://localhost:${process.env.RELAY_PORT ?? "8787"}`);
const workspace = process.env.CODEX_REMOTE_WORKSPACE ?? path.join(os.homedir(), "CodexRemoteWorkspace");
mkdirSync(workspace, { recursive: true });
const codexBin = process.env.CODEX_BIN ?? defaultCodexBin();

const HEARTBEAT_MS = clampPositiveNumber(process.env.CONNECTOR_HEARTBEAT_MS, 25_000);
const PONG_TIMEOUT_MS = clampPositiveNumber(process.env.CONNECTOR_PONG_TIMEOUT_MS, 75_000, HEARTBEAT_MS * 2 + 1000);
const RECONNECT_INITIAL_MS = clampPositiveNumber(process.env.CONNECTOR_RECONNECT_INITIAL_MS, 1_000);
const RECONNECT_MAX_MS = clampPositiveNumber(process.env.CONNECTOR_RECONNECT_MAX_MS, 60_000, RECONNECT_INITIAL_MS);
const RECONNECT_JITTER_MS = clampPositiveNumber(process.env.CONNECTOR_RECONNECT_JITTER_MS, 500, 0);
const RECONNECT_MAX_ATTEMPTS = clampPositiveNumber(process.env.CONNECTOR_RECONNECT_MAX_ATTEMPTS, 0, 0);
const DESKTOP_SYNC_MODE = normalizeDesktopSyncMode(process.env.CODEX_DESKTOP_SYNC_MODE);
const DESKTOP_SYNC_POLL_MS = clampPositiveNumber(process.env.CODEX_DESKTOP_SYNC_POLL_MS, 250, 100);
const DESKTOP_SYNC_TIMEOUT_MS = clampPositiveNumber(process.env.CODEX_DESKTOP_SYNC_TIMEOUT_MS, 180_000, 5_000);
const DESKTOP_SYNC_PASTE_DELAY_MS = clampPositiveNumber(process.env.CODEX_DESKTOP_SYNC_PASTE_DELAY_MS, 350, 50);

const agent = new CodexAppServerAgent({ cwd: workspace, codexBin });
let keyResolution: Awaited<ReturnType<typeof resolveKey>>;
let key = "";
let deviceId = "";
let deviceProof = "";
let relayProxyAgent: HttpConnectTlsAgent | undefined;

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let lastPongAt = 0;
let paired = false;
let shuttingDown = false;
let reconnectAttempts = 0;
let reconnectTimes = 0;

main().catch((error) => {
  console.error("[connector] 启动失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  keyResolution = await resolveKey(agent);
  key = keyResolution.key;
  const deviceIdentity = createDeviceIdentity(key);
  deviceId = deviceIdentity.deviceId;
  deviceProof = deviceIdentity.proof;
  relayProxyAgent = createRelayProxyAgent(relayWsBase);
  printBanner();
  connect();
}

function connect() {
  if (shuttingDown) {
    return;
  }
  if (RECONNECT_MAX_ATTEMPTS > 0 && reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    console.log(`[connector] 重试次数超过上限 (${RECONNECT_MAX_ATTEMPTS})，已停止自动重连。手动重启进程可恢复。`);
    return;
  }
  if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) {
    return;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws && ws.readyState !== ws.OPEN && ws.readyState !== ws.CONNECTING) {
    try {
      ws.removeAllListeners();
      ws.terminate();
    } catch {
      // 忽略
    }
    ws = null;
  }

  const url = `${relayWsBase}?key=${key}&device=${deviceId}&proof=${deviceProof}`;
  const socket = new WebSocket(url, relayProxyAgent ? { agent: relayProxyAgent } : undefined);
  ws = socket;

  socket.on("open", () => {
    reconnectAttempts = 0;
    console.log(`[connector] 已连接中转站，等待网页输入相同密钥进行配对…（第 ${reconnectTimes} 次重连后恢复）`);
    paired = false;
    const netSocket = (socket as WebSocket & { _socket?: { setKeepAlive?: (enable: boolean, delay?: number) => void } })._socket;
    if (netSocket?.setKeepAlive) {
      netSocket.setKeepAlive(true, Math.max(15_000, HEARTBEAT_MS));
    }
    startHeartbeat(socket);
    safeSend({ kind: "hello", key });
  });

  socket.on("message", (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    handleMessage(msg).catch((error) => {
      console.error("[connector] 处理消息出错：", error instanceof Error ? error.message : error);
    });
  });

  socket.on("close", (code) => {
    stopHeartbeat();
    console.log(`[connector] 与中转站断开 (code=${code})，准备重连…`);
    scheduleReconnect();
  });

  socket.on("error", (error) => {
    console.log("[connector] 连接错误：", error instanceof Error ? error.message : error);
    scheduleReconnect();
  });

  socket.on("pong", () => {
    lastPongAt = Date.now();
  });
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) {
    return;
  }

  reconnectAttempts = Math.min(RECONNECT_MAX_ATTEMPTS, reconnectAttempts + 1);
  reconnectTimes += 1;

  const baseDelay = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_INITIAL_MS * Math.pow(2, reconnectAttempts - 1)
  );
  const jitter = Math.floor(Math.random() * (RECONNECT_JITTER_MS + 1));
  const delay = Math.max(RECONNECT_INITIAL_MS, Math.floor(baseDelay + jitter));

  console.log(`[connector] 第 ${reconnectAttempts} 次重连，${Math.max(1, Math.round(delay / 1000))} 秒后重试…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function safeSend(obj: unknown) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function startHeartbeat(socket: WebSocket) {
  stopHeartbeat();
  lastPongAt = Date.now();

  heartbeatTimer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    const silentMs = Date.now() - lastPongAt;
    if (silentMs > PONG_TIMEOUT_MS) {
      console.log("[connector] 中转站心跳超时，重新拨号…");
      socket.terminate();
      return;
    }
    try {
      socket.ping();
    } catch {
      socket.terminate();
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function stopAllTimers() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopHeartbeat();
}

async function handleMessage(msg: any) {
  if (msg?.kind === "paired") {
    paired = true;
    console.log("[connector] 网页端已用相同密钥连入，开始服务。");
    return;
  }

  if (msg?.kind === "rpc") {
    try {
      const result = await dispatchRpc(msg.method, msg.params ?? {});
      safeSend({ kind: "rpcResult", id: msg.id, result });
    } catch (error) {
      safeSend({ kind: "rpcError", id: msg.id, message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (msg?.kind === "chatStart") {
    const reqId = msg.reqId;
    try {
      const input = {
        ...msg.input,
        settings: msg.input?.settings ? getEffectiveChatRunSettings(msg.input.settings, readCodexModels()) : undefined
      } as AgentInput;
      console.log("[connector] 收到网页消息", {
        reqId,
        threadId: input.sessionId,
        textLength: input.text.length,
        desktopSync: DESKTOP_SYNC_MODE
      });
      for await (const chunk of respondWithPreferredSync(input)) {
        safeSend({ kind: "chatDelta", reqId, delta: chunk.text });
      }
      safeSend({ kind: "chatDone", reqId });
    } catch (error) {
      safeSend({ kind: "chatError", reqId, message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
}

async function *respondWithPreferredSync(input: AgentInput) {
  if (DESKTOP_SYNC_MODE !== "paste") {
    yield* agent.respond(input);
    return;
  }

  try {
    console.log("[desktop-sync] 开始强制同步到 Codex 桌面窗口", {
      threadId: input.sessionId,
      textLength: input.text.length
    });
    injectIntoCodexDesktop(input.text);
    yield* streamDesktopThreadReply(input);
    console.log("[desktop-sync] 桌面回复已回传网页", {
      threadId: input.sessionId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`桌面强制同步失败：${message}`);
  }
}

function injectIntoCodexDesktop(text: string) {
  if (process.platform !== "darwin") {
    throw new Error("桌面强制同步目前只支持 macOS。");
  }

  const previousClipboard = readClipboard();
  execFileSync("pbcopy", { input: text });

  try {
    execFileSync(
      "osascript",
      [
        "-e",
        [
          'tell application "Codex" to activate',
          "delay 0.25",
          'tell application "System Events"',
          '  if not (exists process "Codex") then error "Codex 桌面应用未运行"',
          "  keystroke \"v\" using command down",
          `  delay ${Math.max(0.05, DESKTOP_SYNC_PASTE_DELAY_MS / 1000).toFixed(2)}`,
          "  key code 36",
          "end tell"
        ].join("\n")
      ],
      { encoding: "utf8", timeout: 5_000 }
    );
    console.log("[desktop-sync] 已把手机消息粘贴并发送到 Codex 桌面窗口。");
  } finally {
    if (previousClipboard !== null) {
      try {
        execFileSync("pbcopy", { input: previousClipboard });
      } catch {
        // 剪贴板恢复失败不影响同步主流程。
      }
    }
  }
}

function readClipboard() {
  try {
    return execFileSync("pbpaste", { encoding: "utf8", timeout: 1_000 });
  } catch {
    return null;
  }
}

function checkDesktopSyncPreflight() {
  if (DESKTOP_SYNC_MODE !== "paste") {
    return {
      ok: true,
      platform: process.platform,
      message: "桌面强制同步未开启。"
    };
  }

  if (process.platform !== "darwin") {
    return {
      ok: false,
      platform: process.platform,
      message: "桌面强制同步目前只支持 macOS。"
    };
  }

  try {
    const output = execFileSync(
      "osascript",
      [
        "-e",
        [
          'tell application "System Events"',
          '  set frontApp to name of first application process whose frontmost is true',
          '  set codexRunning to exists process "Codex"',
          "end tell",
          'return frontApp & "\\n" & codexRunning'
        ].join("\n")
      ],
      { encoding: "utf8", timeout: 3_000 }
    );
    const [frontmostApp = "", codexRunningRaw = "false"] = output.trim().split(/\r?\n/);
    const codexRunning = codexRunningRaw.trim().toLowerCase() === "true";

    return {
      ok: codexRunning,
      platform: process.platform,
      automationAllowed: true,
      codexRunning,
      frontmostApp,
      message: codexRunning
        ? "强制同步预检通过。"
        : "Codex 桌面应用未运行，请先打开 Codex。"
    };
  } catch (error) {
    return {
      ok: false,
      platform: process.platform,
      automationAllowed: false,
      message: `macOS 自动化/辅助功能权限不可用：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function *streamDesktopThreadReply(input: AgentInput) {
  const startedAt = Date.now();
  const deadline = startedAt + DESKTOP_SYNC_TIMEOUT_MS;
  let emitted = "";
  let lastSeenAssistantText = "";
  let stableReads = 0;
  let pollCount = 0;

  while (Date.now() < deadline) {
    pollCount += 1;
    const history = await agent.readThreadMessages(input.sessionId);
    const assistant = findDesktopSyncedAssistant(history.messages, input.text, startedAt);

    if (assistant?.text) {
      const text = assistant.text;
      if (text.startsWith(emitted) && text.length > emitted.length) {
        const delta = text.slice(emitted.length);
        emitted = text;
        yield { text: delta };
      } else if (text !== emitted) {
        emitted = text;
        yield { text };
      }

      if (text === lastSeenAssistantText) {
        stableReads += 1;
      } else {
        lastSeenAssistantText = text;
        stableReads = 0;
      }

      if (stableReads >= 1) {
        console.log("[desktop-sync] 线程历史中已确认桌面回复稳定", {
          threadId: input.sessionId,
          polls: pollCount,
          textLength: text.length
        });
        return;
      }
    }

    if (pollCount === 1 || pollCount % 10 === 0) {
      console.log("[desktop-sync] 等待桌面回复写入线程历史", {
        threadId: input.sessionId,
        polls: pollCount,
        messages: history.messages.length
      });
    }

    await delay(DESKTOP_SYNC_POLL_MS);
  }

  throw new Error(`等待 ${Math.round(DESKTOP_SYNC_TIMEOUT_MS / 1000)} 秒后仍未看到桌面 Codex 回复。请确认 Codex 桌面当前打开的是同一个对话。`);
}

function findDesktopSyncedAssistant(messages: ChatMessage[], userText: string, startedAt: number) {
  const normalizedUserText = normalizeChatText(userText);
  const earliest = startedAt - 15_000;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === "user" &&
      normalizeChatText(message.text) === normalizedUserText &&
      Date.parse(message.timestamp) >= earliest
    ) {
      return messages.slice(index + 1).find((item) => item.role === "assistant" && item.text.trim());
    }
  }

  return messages
    .slice()
    .reverse()
    .find((item) => item.role === "assistant" && item.text.trim() && Date.parse(item.timestamp) >= earliest);
}

function normalizeChatText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function dispatchRpc(method: string, params: any) {
  switch (method) {
    case "status":
      return {
        ...(await agent.getStatus()),
        desktopSync: {
          mode: DESKTOP_SYNC_MODE,
          enabled: DESKTOP_SYNC_MODE === "paste",
          pasteDelayMs: DESKTOP_SYNC_PASTE_DELAY_MS,
          pollMs: DESKTOP_SYNC_POLL_MS,
          timeoutMs: DESKTOP_SYNC_TIMEOUT_MS,
          preflight: checkDesktopSyncPreflight()
        }
      };
    case "models":
      return { models: readCodexModels() };
    case "listThreads":
      return { groups: await agent.listProjectGroups() };
    case "readThreadMessages":
      return agent.readThreadMessages(params.threadId);
    case "createThread": {
      const created = await agent.createThread();
      return { ...created, groups: await agent.listProjectGroups() };
    }
    case "selectThread": {
      const selected = await agent.selectThread(params.threadId);
      return { ...selected, groups: await agent.listProjectGroups() };
    }
    case "selectProject":
      return agent.selectProject(params.cwd);
    case "deleteThread":
      return agent.deleteThread(params.threadId);
    case "accountUsage":
      return agent.getAccountUsage();
    default:
      throw new Error(`未知方法：${method}`);
  }
}

function readCodexModels(): CodexModelOption[] {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const cachePath = path.join(codexHome, "models_cache.json");

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
      .map((model): CodexModelOption | null => {
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
      })
      .filter((model): model is CodexModelOption => Boolean(model));

    return models.length > 0 ? models : FALLBACK_CODEX_MODELS;
  } catch {
    return FALLBACK_CODEX_MODELS;
  }
}

async function resolveKey(agent: CodexAppServerAgent): Promise<{ key: string; source: string; accountIdentity: string; machineIdentity: string }> {
  const fromEnv = process.env.CONNECTOR_KEY?.trim().toLowerCase();
  if (fromEnv && HEX16.test(fromEnv)) {
    return {
      key: fromEnv,
      source: "环境变量 CONNECTOR_KEY",
      accountIdentity: "manual",
      machineIdentity: getMachineIdentity()
    };
  }

  const machineIdentity = getMachineIdentity();
  const accountIdentity = await getCodexAccountIdentity(agent);
  if (accountIdentity) {
    const machineSecret = readOrCreateMachineSecret();
    const deterministicKey = createHash("sha256")
      .update(["codex-remote-v2", machineIdentity, accountIdentity, machineSecret].join("\n"))
      .digest("hex")
      .slice(0, 16);

    persistConnectorIdentity({
      key: deterministicKey,
      source: "电脑身份 + Codex账号 + 本机私有种子",
      accountIdentity,
      machineIdentity
    });

    return {
      key: deterministicKey,
      source: "电脑身份 + Codex账号 + 本机私有种子",
      accountIdentity,
      machineIdentity
    };
  }

  try {
    const fromFile = readFileSync(keyFile, "utf8").trim().toLowerCase();
    if (HEX16.test(fromFile)) {
      return {
        key: fromFile,
        source: "旧版持久化随机密钥（账号暂不可读）",
        accountIdentity: "unavailable",
        machineIdentity
      };
    }
  } catch {
    // 文件不存在或不可读，下面生成新密钥
  }
  const generated = randomBytes(8).toString("hex");
  try {
    writeFileSync(keyFile, `${generated}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn("[connector] 密钥持久化失败（仍可本次使用）：", error instanceof Error ? error.message : error);
  }
  return {
    key: generated,
    source: "随机生成（账号暂不可读）",
    accountIdentity: "unavailable",
    machineIdentity
  };
}

async function getCodexAccountIdentity(agent: CodexAppServerAgent) {
  try {
    const usage = await agent.getAccountUsage();
    return extractStableAccountIdentity(usage.account);
  } catch (error) {
    console.warn("[connector] 暂时无法读取 Codex 账号，使用已保存密钥或随机密钥：", error instanceof Error ? error.message : error);
    return null;
  }
}

function extractStableAccountIdentity(account: unknown): string | null {
  if (!account || typeof account !== "object") {
    return null;
  }

  const value = account as Record<string, unknown>;
  const candidates = [
    value.email,
    value.accountEmail,
    value.id,
    value.accountId,
    value.userId,
    value.sub,
    value.organizationId
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().toLowerCase();
    }
  }

  const stableJson = stableStringify(value);
  return stableJson === "{}" ? null : stableJson;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function getMachineIdentity() {
  const platformId = readPlatformMachineId();
  return [
    os.platform(),
    os.arch(),
    os.hostname(),
    os.userInfo().username,
    os.homedir(),
    platformId
  ]
    .filter(Boolean)
    .join("|")
    .toLowerCase();
}

function readPlatformMachineId() {
  try {
    if (process.platform === "darwin") {
      const output = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 2000 });
      return output.match(/"IOPlatformUUID" = "([^"]+)"/)?.[1] ?? "";
    }
    if (process.platform === "linux") {
      for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        if (existsSync(file)) {
          return readFileSync(file, "utf8").trim();
        }
      }
    }
    if (process.platform === "win32") {
      const output = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
        encoding: "utf8",
        timeout: 2000
      });
      return output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/)?.[1]?.trim() ?? "";
    }
  } catch {
    return "";
  }
  return "";
}

function readOrCreateMachineSecret() {
  try {
    const existing = readFileSync(machineSecretFile, "utf8").trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch {
    // 文件不存在或不可读，下面生成新私有种子
  }

  const created = randomBytes(32).toString("hex");
  try {
    writeFileSync(machineSecretFile, `${created}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn("[connector] 本机私有种子持久化失败（仍可本次使用）：", error instanceof Error ? error.message : error);
  }
  return created;
}

function createDeviceIdentity(connectorKey: string) {
  const machineSecret = readOrCreateMachineSecret();
  const machineIdentity = getMachineIdentity();
  const deviceId = createHash("sha256")
    .update(["codex-remote-device-v1", machineIdentity, machineSecret].join("\n"))
    .digest("hex")
    .slice(0, 16);
  const proof = createHash("sha256")
    .update(["codex-remote-proof-v1", connectorKey, deviceId, machineSecret].join("\n"))
    .digest("hex")
    .slice(0, 32);
  return { deviceId, proof };
}

function persistConnectorIdentity(identity: { key: string; source: string; accountIdentity: string; machineIdentity: string }) {
  try {
    writeFileSync(keyFile, `${identity.key}\n`, { mode: 0o600 });
    writeFileSync(
      path.join(stateDir, "identity.json"),
      `${JSON.stringify(
        {
          key: identity.key,
          source: identity.source,
          accountIdentity: identity.accountIdentity,
          machineHash: createHash("sha256").update(identity.machineIdentity).digest("hex").slice(0, 16),
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
  } catch (error) {
    console.warn("[connector] 身份信息持久化失败（仍可本次使用）：", error instanceof Error ? error.message : error);
  }
}

function defaultCodexBin(): string {
  const pluginBin = path.join(os.homedir(), ".codex/plugins/.plugin-appserver/codex");
  const candidates = [pluginBin, `${pluginBin}.cmd`, `${pluginBin}.exe`];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "codex";
}

function resolveRelayWsBase(rawRelayWs: string): string {
  const trimmed = rawRelayWs.trim();
  if (!trimmed) {
    return "ws://localhost:8787/agent";
  }

  let url = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = `ws://${url}`;
  }

  url = url.replace(/^http:/i, "ws:");
  url = url.replace(/^https:/i, "wss:");
  const noSlash = url.replace(/\/+$/, "");
  return /\/agent$/i.test(noSlash) ? noSlash : `${noSlash}/agent`;
}

function createRelayProxyAgent(relayWsUrl: string) {
  let relayUrl: URL;
  try {
    relayUrl = new URL(relayWsUrl);
  } catch {
    return undefined;
  }

  const proxyRaw = pickProxyForUrl(relayUrl);
  if (!proxyRaw) {
    return undefined;
  }

  let proxyUrl: URL;
  try {
    proxyUrl = new URL(proxyRaw);
  } catch {
    console.warn(`[connector] 代理地址无效，已忽略：${proxyRaw}`);
    return undefined;
  }

  if (proxyUrl.protocol !== "http:") {
    console.warn(`[connector] 暂只支持 HTTP 代理，已忽略：${maskProxyUrl(proxyUrl)}`);
    return undefined;
  }

  if (relayUrl.protocol === "wss:") {
    console.log(`[connector] WebSocket 将通过 HTTP CONNECT 代理连接：${maskProxyUrl(proxyUrl)}`);
    return new HttpConnectTlsAgent(proxyUrl);
  }

  console.warn("[connector] 当前代理只对 wss:// 中转站生效；ws:// 会继续直连。");
  return undefined;
}

function pickProxyForUrl(target: URL) {
  if (isNoProxyHost(target.hostname)) {
    return "";
  }

  if (target.protocol === "wss:" || target.protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
  }
  return process.env.HTTP_PROXY || process.env.http_proxy || "";
}

function isNoProxyHost(hostname: string) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return noProxy
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule === "*") {
        return true;
      }
      if (rule.startsWith(".")) {
        return host.endsWith(rule);
      }
      return host === rule || host.endsWith(`.${rule}`);
    });
}

function maskProxyUrl(proxyUrl: URL) {
  const user = proxyUrl.username ? "****@" : "";
  const port = proxyUrl.port ? `:${proxyUrl.port}` : "";
  return `${proxyUrl.protocol}//${user}${proxyUrl.hostname}${port}`;
}

class HttpConnectTlsAgent extends HttpsAgent {
  constructor(private readonly proxyUrl: URL) {
    super({ keepAlive: true });
  }

  override createConnection(options: any, callback?: (error: Error | null, socket: Duplex) => void): Duplex | null | undefined {
    const targetHost = options.host || options.hostname;
    const targetPort = Number(options.port || 443);
    const proxyPort = Number(this.proxyUrl.port || 80);
    const headers: Record<string, string> = {
      Host: `${targetHost}:${targetPort}`
    };

    if (this.proxyUrl.username || this.proxyUrl.password) {
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(this.proxyUrl.username)}:${decodeURIComponent(this.proxyUrl.password)}`).toString("base64")}`;
    }

    const req = http.request({
      host: this.proxyUrl.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers
    });

    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback?.(new Error(`HTTP 代理 CONNECT 失败：${res.statusCode}`), undefined as unknown as Duplex);
        return;
      }

      const tlsSocket = tls.connect({
        ...options,
        socket,
        servername: net.isIP(targetHost) ? undefined : options.servername || targetHost
      });
      callback?.(null, tlsSocket);
    });

    req.once("error", (error) => callback?.(error, undefined as unknown as Duplex));
    req.end();
    return undefined;
  }
}

function printBanner() {
  const line = "─".repeat(46);
  console.log("");
  console.log(line);
  console.log("  Codex 远程客户端已启动");
  console.log("");
  console.log(`  你的 16 位密钥：  ${key}`);
  console.log(`  生成方式：${keyResolution.source}`);
  if (keyResolution.accountIdentity !== "manual" && keyResolution.accountIdentity !== "unavailable") {
    console.log(`  Codex 账号：${maskIdentity(keyResolution.accountIdentity)}`);
  }
  console.log("");
  console.log("  把这串密钥填到网页端，即可在网页里访问本机 Codex。");
  console.log(`  中转站：${relayWsBase}`);
  console.log(`  工作目录：${workspace}`);
  console.log(`  Codex 程序：${codexBin}`);
  console.log(`  心跳：${HEARTBEAT_MS}ms，超时：${PONG_TIMEOUT_MS}ms`);
  const reconnectLimitText = RECONNECT_MAX_ATTEMPTS > 0 ? `，最多 ${RECONNECT_MAX_ATTEMPTS} 次` : "，0 表示不限制";
  console.log(`  重连：${RECONNECT_INITIAL_MS}ms 起，最大间隔：${RECONNECT_MAX_MS}ms，抖动：${RECONNECT_JITTER_MS}ms${reconnectLimitText}`);
  console.log(`  桌面强制同步：${DESKTOP_SYNC_MODE === "paste" ? "开启（粘贴到 Codex 桌面窗口）" : "关闭"}`);
  console.log(line);
  console.log("");
}

function maskIdentity(value: string) {
  if (value.includes("@")) {
    const [name, domain] = value.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function clampPositiveNumber(value: string | undefined, fallback: number, min = 500): number {
  const n = Number(value);
  if (Number.isFinite(n) && n >= min && n <= Number.MAX_SAFE_INTEGER) {
    return Math.floor(n);
  }
  return fallback;
}

function normalizeDesktopSyncMode(value: string | undefined): "off" | "paste" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "paste") {
    return "paste";
  }
  return "off";
}

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopAllTimers();
  if (ws) {
    try {
      ws.close(1000, "shutdown");
    } catch {
      try {
        ws.terminate();
      } catch {
        // 忽略
      }
    }
  }
  if (!paired) {
    console.log("[connector] 已停止（未配对时也会退出）。");
  } else {
    console.log("[connector] 已停止（已配对连接）。");
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (error) => {
  console.error("[connector] 未捕获异常：", error);
  scheduleReconnect();
});
process.on("unhandledRejection", (error) => {
  console.error("[connector] 未处理拒绝：", error instanceof Error ? error.message : error);
});
