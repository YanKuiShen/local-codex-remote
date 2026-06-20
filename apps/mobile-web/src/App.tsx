import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  Circle,
  Download,
  Folder,
  MessageCircle,
  Plus,
  RefreshCw,
  Settings,
  Shield,
  Search,
  Send,
  Trash2,
  Smartphone,
  UserRound,
  Wifi,
  WifiOff,
  XCircle,
  X
} from "lucide-react";
import {
  FALLBACK_CODEX_MODELS,
  createId,
  getCodexModelCapability,
  getEffectiveChatRunSettings,
  nowIso,
  type ChatRunSettings,
  type ChatMessage,
  type CodexModelOption,
  type CodexProjectGroup,
  type CodexThreadMessages,
  type CodexThreadSummary,
  type ConnectionStatus,
  type ServerEvent,
  type UserMessageEvent
} from "@local-codex-remote/shared";

const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "::1" ||
  hostname === "0.0.0.0";
const isLocalHostLike = isLoopbackHost(window.location.hostname);
const shouldDropEndpointParam = (value: string | null) => {
  if (!value || isLocalHostLike) {
    return false;
  }

  try {
    const url = new URL(value);
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
};

const rawQueryParams = new URLSearchParams(window.location.search);
const queryParams = new URLSearchParams(rawQueryParams);
const keptSearchKeys = ["api", "backend", "ws"];
if (rawQueryParams.size) {
  for (const key of [...queryParams.keys()]) {
    if (!keptSearchKeys.includes(key) || shouldDropEndpointParam(queryParams.get(key))) {
      queryParams.delete(key);
    }
  }
  const nextQuery = queryParams.toString();
  if (nextQuery !== rawQueryParams.toString()) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.search = nextQuery ? `?${nextQuery}` : "";
    window.history.replaceState({}, "", cleanUrl);
  }
}

const apiUrlFromQuery = queryParams.get("api") ?? queryParams.get("backend");
const wsUrlFromQuery = queryParams.get("ws");
const normalizeEndpointUrl = (value: string | null, kind: "http" | "ws") => {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    const sameHost = url.host === window.location.host;

    if (window.location.protocol === "https:" && sameHost) {
      if (kind === "http" && url.protocol === "http:") {
        url.protocol = "https:";
      }

      if (kind === "ws" && url.protocol === "ws:") {
        url.protocol = "wss:";
      }
    }

    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
};
const normalizedApiUrlFromQuery = normalizeEndpointUrl(apiUrlFromQuery, "http");
const normalizedWsUrlFromQuery = normalizeEndpointUrl(wsUrlFromQuery, "ws");
const SESSION_STORAGE_KEY = "codex_remote_session_token";
const ADMIN_SESSION_STORAGE_KEY = "codex_remote_admin_session_token";
const CHAT_SETTINGS_STORAGE_KEY = "codex_remote_chat_settings";
const ADMIN_VERIFY_PATH = "/codex/admin-auth/verify";
const THREAD_SELECTION_SYNC_TTL_MS = 8000;
const LIVE_HISTORY_POLL_VISIBLE_MS = 1000;
const LIVE_HISTORY_POLL_HIDDEN_MS = 12000;
const AGENT_ERROR_CONFIRM_DELAY_MS = 4500;
const INITIAL_THREAD_HINT = "正在拉取当前对话历史...";
const SELECT_THREAD_HINT = "请选择或新建一个 Codex 对话，然后像聊天一样发送指令。";
const DEFAULT_CHAT_SETTINGS: Required<ChatRunSettings> = {
  model: "gpt-5.5",
  reasoningEffort: "medium",
  speed: "standard",
  approvalPolicy: "never",
  sandboxMode: "workspace-write"
};
const MODEL_OPTIONS = FALLBACK_CODEX_MODELS;
const REASONING_OPTIONS = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" }
] as const;
const SPEED_OPTIONS = [
  { value: "standard", label: "标准" },
  { value: "fast", label: "快速" }
] as const;
const APPROVAL_OPTIONS = [
  { value: "never", label: "无需确认" },
  { value: "on-request", label: "按需确认" }
] as const;
const SANDBOX_OPTIONS = [
  { value: "read-only", label: "只读" },
  { value: "workspace-write", label: "工作区可写" },
  { value: "danger-full-access", label: "完全访问" }
] as const;
const localBackendHost = `${window.location.hostname}:8787`;
const getDefaultHttpUrl = () => (isLocalHostLike ? `http://${localBackendHost}` : `https://${window.location.host}`);
const getDefaultWsUrl = () => {
  const fallbackProtocol = isLocalHostLike ? "ws" : (window.location.protocol === "https:" ? "wss" : "ws");
  const fallbackHost = isLocalHostLike ? localBackendHost : window.location.host;
  return `${fallbackProtocol}://${fallbackHost}/ws`;
};

const getWsUrlFromApiUrl = (apiUrl: string) => {
  const url = new URL(apiUrl);
  return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/ws`;
};

const serverUrl =
  import.meta.env.VITE_WS_URL ||
  normalizedWsUrlFromQuery ||
  (normalizedApiUrlFromQuery ? getWsUrlFromApiUrl(normalizedApiUrlFromQuery) : getDefaultWsUrl());
const httpBaseUrl = (import.meta.env.VITE_API_URL ??
  normalizedApiUrlFromQuery ??
  (isLocalHostLike
    ? getDefaultHttpUrl()
    : serverUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/ws$/, "")));
// Mac 一行安装命令：在「终端」里直接运行，绕开浏览器下载脚本的 Gatekeeper 安全限制（不需可执行权限/不弹安全警告）。
const macInstallCommand = `bash <(curl -fsSLk ${httpBaseUrl}/codex/connector/download/mac)`;
const isJsonResponse = (response: Response) => response.headers.get("content-type")?.includes("application/json");
const getStoredSession = () => {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
};
const getStoredChatSettings = (): Required<ChatRunSettings> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_SETTINGS_STORAGE_KEY) ?? "{}") as Partial<ChatRunSettings>;
    return {
      model: typeof parsed.model === "string" ? parsed.model : DEFAULT_CHAT_SETTINGS.model,
      reasoningEffort: isReasoningEffort(parsed.reasoningEffort) ? parsed.reasoningEffort : DEFAULT_CHAT_SETTINGS.reasoningEffort,
      speed: parsed.speed === "fast" || parsed.speed === "standard" ? parsed.speed : DEFAULT_CHAT_SETTINGS.speed,
      approvalPolicy: isApprovalPolicy(parsed.approvalPolicy) ? parsed.approvalPolicy : DEFAULT_CHAT_SETTINGS.approvalPolicy,
      sandboxMode: isSandboxMode(parsed.sandboxMode) ? parsed.sandboxMode : DEFAULT_CHAT_SETTINGS.sandboxMode
    };
  } catch {
    return DEFAULT_CHAT_SETTINGS;
  }
};

type CodexStatus = {
  connected: boolean;
  cwd?: string;
  threadId?: string;
  message?: string;
  desktopSync?: {
    mode?: "off" | "paste" | string;
    enabled?: boolean;
    pasteDelayMs?: number;
    pollMs?: number;
    timeoutMs?: number;
    preflight?: {
      ok?: boolean;
      platform?: string;
      automationAllowed?: boolean;
      codexRunning?: boolean;
      frontmostApp?: string;
      message?: string;
    };
  };
};

type AccountUsageResponse = {
  account?: {
    type?: string;
    email?: string;
    planType?: string;
  };
  rateLimits?: RateLimitRecord;
  rateLimitsByLimitId?: Record<string, RateLimitRecord>;
  rateLimitResetCredits?: {
    availableCount?: number;
  };
};

type ModelsResponse = {
  models: CodexModelOption[];
};

type RateLimitRecord = {
  limitId?: string;
  limitName?: string | null;
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  credits?: {
    hasCredits?: boolean;
    unlimited?: boolean;
    balance?: string;
  } | null;
  planType?: string;
  rateLimitReachedType?: string | null;
};

type RateLimitWindow = {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
};

type ThreadsResponse = {
  groups: CodexProjectGroup[];
};

type ThreadActionResponse = ThreadsResponse & {
  thread: CodexThreadSummary;
  messages: CodexThreadMessages;
};

type ThreadDeleteResponse = ThreadsResponse & {
  thread?: CodexThreadSummary;
};

type ProjectSelectResponse = ThreadsResponse & {
  status: CodexStatus;
  messages: CodexThreadMessages;
};

type AdminSessionRecord = {
  token: string;
  key?: string;
  keyMasked?: string;
  blocked?: boolean;
  protected?: boolean;
  connectorOnline?: boolean;
  ip: string;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number;
  connected: boolean;
  connectedSockets: number;
  threadId: string | null;
  messageCount: number;
};

type AdminSessionsResponse = {
  sessions: AdminSessionRecord[];
  total: number;
};

type AdminMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  messageId: string;
  timestamp: string;
  threadId?: string;
};

type AdminSecurityEvent = {
  ts: string;
  level: "info" | "warn";
  event: string;
  ip?: string;
  route?: string;
  scope?: string;
  reason?: string;
  key?: string;
  deviceId?: string;
  message?: string;
  [key: string]: unknown;
};

type AdminSecurityEventsResponse = {
  events: AdminSecurityEvent[];
  total: number;
};

type AdminSessionMessagesResponse = {
  session: {
    token: string;
    ip: string;
    userAgent: string;
    createdAt: number;
    lastSeenAt: number;
    messageCount: number;
    connected: boolean;
    key?: string;
    keyMasked?: string;
    blocked?: boolean;
    protected?: boolean;
    connectorOnline?: boolean;
    threadId: string | null;
    connectedSockets: number;
  };
  messages: AdminMessage[];
};

export function App() {
  const [sessionToken, setSessionToken] = useState<string | null>(() => getStoredSession());
  const [adminSessionToken, setAdminSessionToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ADMIN_SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [showAuthGate, setShowAuthGate] = useState(() => !getStoredSession());
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [chatSettings, setChatSettings] = useState<Required<ChatRunSettings>>(() => getStoredChatSettings());
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>(MODEL_OPTIONS);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [adminKey, setAdminKey] = useState("");
  const [adminKeyError, setAdminKeyError] = useState("");
  const [adminSessions, setAdminSessions] = useState<AdminSessionRecord[]>([]);
  const [adminSessionTokenSelected, setAdminSessionTokenSelected] = useState<string | null>(null);
  const [adminMessages, setAdminMessages] = useState<AdminMessage[]>([]);
  const [adminSecurityEvents, setAdminSecurityEvents] = useState<AdminSecurityEvent[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [authError, setAuthError] = useState("");
  const [macCmdCopied, setMacCmdCopied] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(() =>
    getStoredSession() ? "connecting" : "disconnected"
  );
  const [codexStatus, setCodexStatus] = useState<CodexStatus>({ connected: false });
  const [accountUsage, setAccountUsage] = useState<AccountUsageResponse | null>(null);
  const [usageError, setUsageError] = useState("");
  const [usageLoading, setUsageLoading] = useState(false);
  const [threadGroups, setThreadGroups] = useState<CodexProjectGroup[]>([]);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([createSystemMessage(INITIAL_THREAD_HINT)]);
  const [draft, setDraft] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const webSocketHeartbeatRef = useRef<number | null>(null);
  const initializedCollapsedGroupsRef = useRef(false);
  const isComposingRef = useRef(false);
  const loadedThreadIdRef = useRef<string | null>(null);
  const threadSelectionIntentRef = useRef<{ threadId: string; at: number } | null>(null);
  const refreshRequestIdRef = useRef(0);
  const historyFollowTimerRef = useRef<number | null>(null);
  const liveHistoryTimerRef = useRef<number | null>(null);
  const errorConfirmTimersRef = useRef<number[]>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior, block: "end" });
      });
    });
  };
  const clearSessionState = (message = "会话已失效，请重新输入验证码。") => {
    setSessionToken(null);
    setShowAuthGate(true);
    setAuthError(message);
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {}
  };
  const clearAdminSession = (message = "管理员会话已失效，请重新输入管理员KEY。") => {
    setAdminSessionToken(null);
    setAdminSessions([]);
    setAdminSessionTokenSelected(null);
    setAdminMessages([]);
    setAdminSecurityEvents([]);
    setAdminError(message);
    try {
      localStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);
    } catch {}
  };
  const clearSelectionIntent = () => {
    threadSelectionIntentRef.current = null;
  };

  const markSelectionIntent = (threadId: string | null) => {
    threadSelectionIntentRef.current = threadId
      ? {
          threadId,
          at: Date.now()
        }
      : null;
  };
  const stopHistoryFollow = () => {
    if (historyFollowTimerRef.current) {
      window.clearInterval(historyFollowTimerRef.current);
      historyFollowTimerRef.current = null;
    }
  };
  const stopLiveHistoryWatch = () => {
    if (liveHistoryTimerRef.current) {
      window.clearTimeout(liveHistoryTimerRef.current);
      liveHistoryTimerRef.current = null;
    }
  };

  const clearErrorConfirmTimers = () => {
    for (const timer of errorConfirmTimersRef.current) {
      window.clearTimeout(timer);
    }
    errorConfirmTimersRef.current = [];
  };

  const startHistoryFollow = (threadId: string, sentAt: string) => {
    stopHistoryFollow();
    const stopAt = Date.now() + 120_000;

    historyFollowTimerRef.current = window.setInterval(async () => {
      if (Date.now() > stopAt) {
        stopHistoryFollow();
        setMessages((current) =>
          current.map((message) => (message.status === "sending" ? { ...message, status: "sent" as const } : message))
        );
        return;
      }

      try {
        const history = await readThreadMessages(threadId);
        const sentTime = new Date(sentAt).getTime();
        const hasAssistantAfterSend = history.messages.some(
          (message) => message.role === "assistant" && new Date(message.timestamp).getTime() >= sentTime - 1000
        );

        setMessages((current) => mergeHistoryWithLiveMessages(history.messages, current));

        if (hasAssistantAfterSend) {
          stopHistoryFollow();
        }
      } catch {
        // 实时通道还在，历史兜底失败时不打断当前聊天
      }
    }, 2000);
  };

  const refreshThreadHistoryQuietly = async (threadId: string) => {
    const history = await readThreadMessages(threadId);
    setMessages((current) => {
      const hasLiveAssistantStream = current.some((message) => message.role === "assistant" && message.status === "streaming");
      return mergeHistoryWithLiveMessages(history.messages, current, { preserveLiveAssistantStream: hasLiveAssistantStream });
    });
    loadedThreadIdRef.current = threadId;
    return history;
  };
  const getWsUrl = () => {
    if (!sessionToken) {
      return serverUrl;
    }

    const queryChar = serverUrl.includes("?") ? "&" : "?";

    return `${serverUrl}${queryChar}session=${encodeURIComponent(sessionToken)}`;
  };
  const persistSession = (token: string) => {
    setSessionToken(token);
    setShowAuthGate(false);
    setAuthError("");
    setRuntimeError(null);
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, token);
    } catch {}
  };
  const persistAdminSession = (token: string) => {
    setAdminSessionToken(token);
    setAdminError("");
    setAdminSessions([]);
    setAdminSessionTokenSelected(null);
    setAdminMessages([]);
    try {
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, token);
    } catch {}
  };

  useEffect(() => {
    const handleError = (event: ErrorEvent | PromiseRejectionEvent) => {
      const message =
        event instanceof ErrorEvent
          ? event.error?.message || event.message
          : event.reason instanceof Error
            ? event.reason.message
            : String(event.reason);

      if (/network request failed|failed to fetch|load failed/i.test(message)) {
        setRuntimeError(`网络请求失败：请确认当前后端地址为 ${httpBaseUrl}`);
        return;
      }

      setRuntimeError(`前端运行错误: ${message}`);
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleError);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleError);
    };
  }, []);

  useEffect(() => {
    if (!sessionToken) {
      setConnectionStatus("disconnected");
      return;
    }

    let isActive = true;

    const connect = () => {
      if (!isActive) {
        return;
      }

      const socket = new WebSocket(getWsUrl());
      socketRef.current = socket;
      setConnectionStatus("connecting");

      socket.addEventListener("open", () => {
        if (socketRef.current === socket) {
          setConnectionStatus("connected");
          if (webSocketHeartbeatRef.current) {
            window.clearInterval(webSocketHeartbeatRef.current);
          }
          webSocketHeartbeatRef.current = window.setInterval(() => {
            if (socketRef.current === socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ id: createId("event"), type: "ping", sessionId: sessionToken, timestamp: nowIso() }));
            }
          }, 25_000);
        }
      });

      socket.addEventListener("message", (message) => {
        try {
          handleServerEvent(JSON.parse(message.data) as ServerEvent);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          setRuntimeError(`WS消息解析失败: ${text}`);
        }
      });

      socket.addEventListener("close", (event) => {
        if (socketRef.current !== socket) {
          return;
        }

        socketRef.current = null;
        if (webSocketHeartbeatRef.current) {
          window.clearInterval(webSocketHeartbeatRef.current);
          webSocketHeartbeatRef.current = null;
        }
        if (event.code === 4401) {
          clearSessionState();
          setConnectionStatus("disconnected");
          return;
        }

        setConnectionStatus("disconnected");

        reconnectTimerRef.current = window.setTimeout(() => {
          connect();
        }, 1200);
      });

      socket.addEventListener("error", () => {
        if (socketRef.current === socket) {
          socket.close();
        }
      });
    };

    connect();

    return () => {
      isActive = false;

      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (webSocketHeartbeatRef.current) {
        window.clearInterval(webSocketHeartbeatRef.current);
        webSocketHeartbeatRef.current = null;
      }

      stopHistoryFollow();
      stopLiveHistoryWatch();
      clearErrorConfirmTimers();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [sessionToken]);

  useEffect(() => {
    stopLiveHistoryWatch();

    if (!sessionToken || showAuthGate || !codexStatus.threadId) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    const threadId = codexStatus.threadId;

    const schedule = () => {
      if (cancelled) {
        return;
      }

      const delay = document.visibilityState === "hidden" ? LIVE_HISTORY_POLL_HIDDEN_MS : LIVE_HISTORY_POLL_VISIBLE_MS;
      liveHistoryTimerRef.current = window.setTimeout(tick, delay);
    };

    const tick = async () => {
      if (cancelled || inFlight) {
        schedule();
        return;
      }

      inFlight = true;
      try {
        await refreshThreadHistoryQuietly(threadId);
      } catch {
        // 实时历史监听失败时保持页面现状，下一轮继续尝试。
      } finally {
        inFlight = false;
        schedule();
      }
    };

    schedule();

    return () => {
      cancelled = true;
      stopLiveHistoryWatch();
    };
  }, [sessionToken, showAuthGate, codexStatus.threadId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (!sessionToken || showAuthGate) {
      return;
    }

    scrollToBottom("auto");
    const timers = [250, 800, 1400].map((delay) => window.setTimeout(() => scrollToBottom("auto"), delay));

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [sessionToken, showAuthGate, codexStatus.threadId]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_SETTINGS_STORAGE_KEY, JSON.stringify(chatSettings));
    } catch {}
  }, [chatSettings]);

  useEffect(() => {
    if (!showAdminPanel || !adminSessionToken) {
      return;
    }

    refreshAdminSessions(adminSessionToken);
    refreshAdminSecurityEvents(adminSessionToken);
  }, [showAdminPanel, adminSessionToken]);

  useEffect(() => {
    if (initializedCollapsedGroupsRef.current || threadGroups.length === 0) {
      return;
    }

    const apiGroups = threadGroups.filter((group) => group.kind === "api" && !group.threads.some((thread) => thread.active));

    if (apiGroups.length > 0) {
      setCollapsedProjects((current) => {
        const next = new Set(current);

        for (const group of apiGroups) {
          next.add(group.cwd);
        }

        return next;
      });
    }

    initializedCollapsedGroupsRef.current = true;
  }, [threadGroups]);

  const synchronizeSessionState = async () => {
    if (!sessionToken) {
      return;
    }

    const requestId = ++refreshRequestIdRef.current;

    try {
      const status = await readCodexStatus();
      const pending = threadSelectionIntentRef.current;
      const isSelectionPending = Boolean(pending && Date.now() - pending.at < THREAD_SELECTION_SYNC_TTL_MS);
      const shouldFollowStatusThread = !isSelectionPending || pending?.threadId === status.threadId;

      setCodexStatus((current) =>
        shouldFollowStatusThread
          ? status
          : {
              ...current,
              connected: status.connected,
              cwd: status.cwd,
              message: status.message,
              threadId: current.threadId
            }
      );

      if (shouldFollowStatusThread && pending?.threadId === status.threadId) {
        clearSelectionIntent();
      }

      if (requestId !== refreshRequestIdRef.current) {
        return;
      }

      const threads = await readThreads();
      if (requestId !== refreshRequestIdRef.current) {
        return;
      }

      const mergedGroups = ensureActiveThreadInGroups(threads.groups, status);
      if (!isSelectionPending || pending?.threadId === status.threadId) {
        setThreadGroups(mergedGroups);
      }

      if (shouldFollowStatusThread && status.threadId && loadedThreadIdRef.current !== status.threadId) {
        try {
          setMessages((current) =>
            current.some((message) => message.status === "streaming" || message.status === "sending")
              ? current
              : [createSystemMessage(INITIAL_THREAD_HINT)]
          );
          const history = await readThreadMessages(status.threadId);
          if (requestId !== refreshRequestIdRef.current) {
            return;
          }
          loadedThreadIdRef.current = status.threadId;
          setMessages((current) => mergeHistoryWithLiveMessages(history.messages, current));
        } catch (threadError) {
          loadedThreadIdRef.current = status.threadId;
          setMessages((current) =>
            current.some((message) => message.status === "streaming")
              ? current
              : [createSystemMessage("当前对话暂无历史消息，发送第一条消息即可开始。")]
          );
          console.warn("[sync] readThreadMessages 失败，保留连接状态。", threadError);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === "UNAUTHORIZED") {
        clearSessionState();
      } else {
        setCodexStatus({
          connected: false,
          message: error instanceof Error ? error.message : "Codex 状态读取失败"
        });
      }
    }
  };

  useEffect(() => {
    if (!sessionToken) {
      setAccountUsage(null);
      setUsageError("");
      return;
    }

    synchronizeSessionState();
    refreshCodexModels();
    refreshAccountUsage();
  }, [sessionToken]);

  const statusCopy = useMemo(() => {
    if (connectionStatus === "connected") {
      return "已连接";
    }

    if (connectionStatus === "connecting") {
      return "连接中";
    }

    return "未连接";
  }, [connectionStatus]);

  const activeThread = useMemo(() => {
    return threadGroups.flatMap((group) => group.threads).find((thread) => thread.id === codexStatus.threadId);
  }, [codexStatus.threadId, threadGroups]);

  const projectGroups = useMemo(() => threadGroups.filter((group) => group.kind === "project"), [threadGroups]);

  const activeProject = useMemo(() => {
    return (
      projectGroups.find((group) => group.active) ??
      projectGroups.find((group) => group.cwd === codexStatus.cwd) ??
      null
    );
  }, [codexStatus.cwd, projectGroups]);

  const currentModelCapability = useMemo(
    () => getCodexModelCapability(codexModels, chatSettings.model),
    [chatSettings.model, codexModels]
  );

  const settingsSummary = useMemo(
    () => getSettingsSummary(chatSettings, codexModels),
    [chatSettings, codexModels]
  );

  const selectedAdminSession = useMemo(
    () => adminSessions.find((session) => session.token === adminSessionTokenSelected) ?? null,
    [adminSessionTokenSelected, adminSessions]
  );

  const filteredGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    if (!query) {
      return threadGroups;
    }

    return threadGroups
      .map((group) => {
        const groupMatches = `${group.name} ${group.cwd}`.toLowerCase().includes(query);
        const threads = group.threads.filter((thread) =>
          `${thread.title} ${thread.preview} ${thread.id} ${thread.cwd}`.toLowerCase().includes(query)
        );

        return {
          ...group,
          threads: groupMatches ? group.threads : threads
        };
      })
      .filter((group) => group.threads.length > 0);
  }, [searchQuery, threadGroups]);

  function handleServerEvent(event: ServerEvent) {
    if (event.type === "connection_ready") {
      setSessionId(event.sessionId);
      void synchronizeSessionState();
      return;
    }

    if (event.type === "assistant_started") {
      setMessages((current) => [
        ...current.map((message) =>
          message.role === "user" && message.status === "sending" ? { ...message, status: "sent" as const } : message
        ),
        {
          id: event.messageId,
          role: "assistant",
          text: "",
          status: "streaming",
          timestamp: event.timestamp
        }
      ]);
      return;
    }

    if (event.type === "assistant_delta") {
      setMessages((current) => {
        if (!current.some((message) => message.id === event.messageId)) {
          return [
            ...current,
            {
              id: event.messageId,
              role: "assistant",
              text: event.delta,
              status: "streaming",
              timestamp: event.timestamp
            }
          ];
        }

        return current.map((message) =>
          message.id === event.messageId
            ? { ...message, text: `${message.text}${event.delta}` }
            : message
        );
      });
      return;
    }

    if (event.type === "assistant_done") {
      setMessages((current) => {
        if (!current.some((message) => message.id === event.messageId)) {
          return [
            ...current,
            {
              id: event.messageId,
              role: "assistant",
              text: "回复已完成，但中间内容可能因页面重连丢失。请点“拉取对话记录”查看完整记录。",
              status: "sent",
              timestamp: event.timestamp
            }
          ];
        }

        return current.map((message) =>
          message.id === event.messageId ? { ...message, status: "sent" } : message
        );
      });
      return;
    }

    if (event.type === "error") {
      if (event.code === "AGENT_FAILED" && event.messageId) {
        confirmAgentErrorBeforeShowing(event);
        return;
      }

      appendSystemError(event.message, event.timestamp);
    }
  }

  function confirmAgentErrorBeforeShowing(event: Extract<ServerEvent, { type: "error" }>) {
    const timer = window.setTimeout(async () => {
      errorConfirmTimersRef.current = errorConfirmTimersRef.current.filter((item) => item !== timer);

      try {
        const history = await refreshThreadHistoryQuietly(event.sessionId);
        const eventTime = new Date(event.timestamp).getTime();
        const hasRecentAssistant = history.messages.some((message) => {
          const messageTime = new Date(message.timestamp).getTime();
          return (
            message.role === "assistant" &&
            message.text.trim().length > 0 &&
            Number.isFinite(messageTime) &&
            messageTime >= eventTime - 10_000
          );
        });

        if (hasRecentAssistant) {
          setMessages((current) =>
            current.map((message) =>
              message.id === event.messageId && message.status === "streaming"
                ? { ...message, status: "sent" }
                : message
            )
          );
          return;
        }
      } catch {
        // 读取历史失败时再显示错误，避免用户以为消息仍在发送。
      }

      setMessages((current) =>
        current.map((message) =>
          message.id === event.messageId && message.status === "streaming"
            ? {
                ...message,
                text: message.text || event.message,
                status: "failed"
              }
            : message
        )
      );
      appendSystemError(event.message, event.timestamp);
    }, AGENT_ERROR_CONFIRM_DELAY_MS);

    errorConfirmTimersRef.current.push(timer);
  }

  function appendSystemError(text: string, timestamp = nowIso()) {
    setMessages((current) => {
      const latest = current[current.length - 1];
      if (latest?.role === "system" && latest.text === text) {
        return current;
      }

      return [
        ...current,
        {
          id: createId("system"),
          role: "system",
          text,
          status: "failed",
          timestamp
        }
      ];
    });
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!authCode.trim()) {
      setAuthError("请输入验证码。");
      return;
    }

    setAuthError("");
    setRuntimeError(null);
    try {
      const response = await requestJson<{
        code: string;
        sessionToken?: string;
      }>(`${httpBaseUrl}/codex/auth/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ code: authCode.trim() })
      });

      if (!response.sessionToken) {
        throw new Error("返回值缺少 sessionToken");
      }

      persistSession(response.sessionToken);
      setAuthCode("");
      loadedThreadIdRef.current = null;
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "验证码验证失败。");
    }
  }

  async function verifyAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!adminKey.trim()) {
      setAdminKeyError("请输入管理员 KEY。");
      return;
    }

    setAdminKeyError("");
    setAdminError("");
    setAdminLoading(true);

    try {
      const response = await requestJson<{
        adminSessionToken: string;
      }>(`${httpBaseUrl}${ADMIN_VERIFY_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ adminKey: adminKey.trim() })
      }, "admin");

      persistAdminSession(response.adminSessionToken);
      setAdminKey("");
      await refreshAdminSessions(response.adminSessionToken);
      await refreshAdminSecurityEvents(response.adminSessionToken);
      setShowAdminPanel(true);
    } catch (error) {
      setAdminKeyError(error instanceof Error ? error.message : "管理员 KEY 校验失败。");
    } finally {
      setAdminLoading(false);
    }
  }

  async function refreshAdminSessions(forceAdminToken?: string) {
    const requestAdminToken = forceAdminToken ?? adminSessionToken;

    if (!requestAdminToken) {
      return;
    }

    setAdminLoading(true);
    setAdminError("");

    try {
      const headers = new Headers({
        "Content-Type": "application/json"
      });
      headers.set("X-Codex-Admin-Session", requestAdminToken);

      const response = await requestJson<AdminSessionsResponse>(
        `${httpBaseUrl}/codex/admin/sessions`,
        {
          headers
        },
        "admin"
      );
      setAdminSessions(response.sessions ?? []);

      if (adminSessionTokenSelected && !response.sessions.some((session) => session.token === adminSessionTokenSelected)) {
        setAdminSessionTokenSelected(null);
        setAdminMessages([]);
      }
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "读取用户会话失败。");
    } finally {
      setAdminLoading(false);
    }
  }

  async function refreshAdminSecurityEvents(forceAdminToken?: string) {
    const requestAdminToken = forceAdminToken ?? adminSessionToken;

    if (!requestAdminToken) {
      return;
    }

    try {
      const headers = new Headers({
        "Content-Type": "application/json"
      });
      headers.set("X-Codex-Admin-Session", requestAdminToken);

      const response = await requestJson<AdminSecurityEventsResponse>(
        `${httpBaseUrl}/codex/admin/security-events?limit=200`,
        { headers },
        "admin"
      );
      setAdminSecurityEvents(response.events ?? []);
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "读取安全日志失败。");
    }
  }

  async function loadAdminSessionMessages(sessionTokenForAdmin: string) {
    setAdminSessionTokenSelected(sessionTokenForAdmin);
    setAdminLoading(true);
    setAdminError("");

    try {
      const response = await requestJson<AdminSessionMessagesResponse>(
        `${httpBaseUrl}/codex/admin/sessions/${encodeURIComponent(sessionTokenForAdmin)}/messages`,
        {},
        "admin"
      );
      setAdminMessages(response.messages ?? []);
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "读取会话消息失败。");
      setAdminMessages([]);
    } finally {
      setAdminLoading(false);
    }
  }

  async function blockAdminSessionKey(session: AdminSessionRecord) {
    const key = session.key ?? session.keyMasked;
    if (!key) {
      setAdminError("这个会话没有返回密钥，无法拉黑。");
      return;
    }
    if (session.protected) {
      setAdminError("这是受保护的白名单密钥，不能拉黑。");
      return;
    }
    const confirmed = window.confirm(`确认拉黑密钥 ${session.keyMasked ?? key} 吗？该密钥的网页会话会立即失效。`);
    if (!confirmed) {
      return;
    }

    setAdminLoading(true);
    setAdminError("");

    try {
      await requestJson<{ code: string }>(
        `${httpBaseUrl}/codex/admin/keys/block`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ key })
        },
        "admin"
      );
      if (adminSessionTokenSelected === session.token) {
        setAdminSessionTokenSelected(null);
        setAdminMessages([]);
      }
      await refreshAdminSessions();
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "拉黑密钥失败。");
    } finally {
      setAdminLoading(false);
    }
  }

  const buildHeaders = (existing?: HeadersInit, mode: "user" | "admin" = "user") => {
    const headers = new Headers(existing ?? {});

    if (mode === "user" && sessionToken) {
      headers.set("X-Codex-Session", sessionToken);
    }

    if (mode === "admin" && adminSessionToken && !headers.has("X-Codex-Admin-Session")) {
      headers.set("X-Codex-Admin-Session", adminSessionToken);
    }

    return headers;
  };

  async function requestJson<T>(url: string, init: RequestInit = {}, mode: "user" | "admin" = "user"): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: buildHeaders(init.headers, mode)
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(`网络请求失败：${text}（后端：${httpBaseUrl}）`);
    }

    if (response.status === 401) {
      if (mode === "admin") {
        clearAdminSession();
      } else {
        clearSessionState();
      }

      const error = new Error("UNAUTHORIZED");
      error.name = "UNAUTHORIZED";
      throw error;
    }

    if (!isJsonResponse(response)) {
      throw new Error("后端返回页面而不是 JSON，当前页面不是后端接口地址");
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      if (payload && typeof payload.message === "string") {
        throw new Error(payload.message);
      }

      throw new Error("请求失败");
    }

    return (await response.json()) as T;
  }

  async function readCodexStatus(): Promise<CodexStatus> {
    return requestJson<CodexStatus>(`${httpBaseUrl}/codex/status`).catch((error) => {
      if (error instanceof Error && error.name === "UNAUTHORIZED") {
        throw error;
      }

      if (error instanceof Error && error.message === "UNAUTHORIZED") {
        throw error;
      }

      throw new Error(error instanceof Error ? error.message : "Codex 状态读取失败");
    });
  }

  async function refreshAccountUsage() {
    if (!sessionToken) {
      return;
    }

    setUsageLoading(true);
    setUsageError("");
    try {
      setAccountUsage(await requestJson<AccountUsageResponse>(`${httpBaseUrl}/codex/account/usage`));
    } catch (error) {
      if (error instanceof Error && (error.name === "UNAUTHORIZED" || error.message === "UNAUTHORIZED")) {
        return;
      }
      setUsageError(error instanceof Error ? error.message : "额度读取失败");
    } finally {
      setUsageLoading(false);
    }
  }

  async function refreshCodexModels() {
    if (!sessionToken) {
      return;
    }

    try {
      const response = await requestJson<ModelsResponse>(`${httpBaseUrl}/codex/models`);
      const models = response.models?.length ? response.models : MODEL_OPTIONS;
      setCodexModels(models);
      setChatSettings((current) => {
        const exists = models.some((model) => model.value === current.model);
        if (exists) {
          return current;
        }

        return {
          ...current,
          model: models[0]?.value ?? DEFAULT_CHAT_SETTINGS.model,
          reasoningEffort: models[0]?.defaultReasoningEffort ?? DEFAULT_CHAT_SETTINGS.reasoningEffort,
          speed: "standard"
        };
      });
    } catch {
      setCodexModels(MODEL_OPTIONS);
    }
  }

  async function readThreads(): Promise<ThreadsResponse> {
    return requestJson<ThreadsResponse>(`${httpBaseUrl}/codex/threads`).catch((error) => {
      if (error instanceof Error && error.name === "UNAUTHORIZED") {
        throw error;
      }

      throw new Error("Codex 对话列表读取失败");
    });
  }

  async function readThreadMessages(threadId: string): Promise<CodexThreadMessages> {
    return requestJson<CodexThreadMessages>(`${httpBaseUrl}/codex/threads/${threadId}/messages`).catch((error) => {
      if (error instanceof Error && error.name === "UNAUTHORIZED") {
        throw error;
      }

      throw new Error("Codex 历史记录读取失败");
    });
  }

  async function createThread() {
    if (!sessionToken) {
      setShowAuthGate(true);
      return;
    }

    try {
      const response = await requestJson<ThreadActionResponse>(`${httpBaseUrl}/codex/threads`, {
        method: "POST"
      });

      markSelectionIntent(response.thread.id);
      setCodexStatus((current) => ({
        ...current,
        connected: true,
        threadId: response.thread.id,
        cwd: response.thread.cwd
      }));
      setThreadGroups(response.groups);
      loadedThreadIdRef.current = response.thread.id;
      setMessages(normalizeHistoryMessages(response.messages.messages, `新对话已创建：${response.thread.title}`));
      setDrawerOpen(false);
    } catch (error) {
      setMessages([createSystemMessage("新建 Codex 对话失败。")]);
      setRuntimeError(error instanceof Error ? error.message : "新建对话失败");
      return;
    }
  }

  async function ensureThreadForSend(): Promise<string | null> {
    if (codexStatus.threadId) {
      return codexStatus.threadId;
    }

    try {
      const status = await readCodexStatus();
      if (status.threadId) {
        setCodexStatus(status);
        loadedThreadIdRef.current = status.threadId;
        return status.threadId;
      }
    } catch {
      // 继续尝试新建对话
    }

    try {
      const response = await requestJson<ThreadActionResponse>(`${httpBaseUrl}/codex/threads`, {
        method: "POST"
      });
      markSelectionIntent(response.thread.id);
      setCodexStatus((current) => ({
        ...current,
        connected: true,
        threadId: response.thread.id,
        cwd: response.thread.cwd
      }));
      setThreadGroups(response.groups);
      loadedThreadIdRef.current = response.thread.id;
      return response.thread.id;
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "新建对话失败");
      return null;
    }
  }

  async function selectThread(thread: CodexThreadSummary) {
    if (!sessionToken) {
      setShowAuthGate(true);
      return;
    }

    try {
      const response = await requestJson<ThreadActionResponse>(`${httpBaseUrl}/codex/threads/select`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          threadId: thread.id
        })
      });

      setCodexStatus((current) => ({
        ...current,
        connected: true,
        threadId: response.thread.id,
        cwd: response.thread.cwd
      }));
      markSelectionIntent(response.thread.id);
      setThreadGroups(response.groups);
      loadedThreadIdRef.current = response.thread.id;
      setMessages(normalizeHistoryMessages(response.messages.messages, `已切换到对话：${response.thread.title}`));
      setDrawerOpen(false);
    } catch (error) {
      setMessages([createSystemMessage("切换 Codex 对话失败。")]);
      setRuntimeError(error instanceof Error ? error.message : "切换对话失败");
      return;
    }
  }

  async function selectProject(group: CodexProjectGroup) {
    if (!sessionToken || group.kind === "api") {
      return;
    }

    try {
      const response = await requestJson<ProjectSelectResponse>(`${httpBaseUrl}/codex/projects/select`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ cwd: group.cwd })
      });

      markSelectionIntent(response.status.threadId ?? null);
      setCodexStatus(response.status);
      setThreadGroups(response.groups);
      loadedThreadIdRef.current = response.status.threadId ?? null;
      setMessages(normalizeHistoryMessages(response.messages.messages, `已切换到项目：${group.name}`));
      setDrawerOpen(false);
      setProjectPickerOpen(false);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "切换项目失败");
    }
  }

  async function deleteActiveThread() {
    const threadId = codexStatus.threadId;

    if (!sessionToken || !threadId) {
      return;
    }

    const confirmed = window.confirm("确定删除/归档当前 Codex 对话吗？这个操作会同步到本机 Codex。");
    if (!confirmed) {
      return;
    }

    try {
      const response = await requestJson<ThreadDeleteResponse>(`${httpBaseUrl}/codex/threads/${encodeURIComponent(threadId)}`, {
        method: "DELETE"
      });
      setThreadGroups(response.groups ?? []);
      loadedThreadIdRef.current = null;
      setCodexStatus((current) => ({
        ...current,
        threadId: undefined,
        message: "当前对话已删除/归档"
      }));
      setMessages([createSystemMessage("当前对话已删除/归档，请选择或新建一个对话。")]);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "删除对话失败");
    }
  }

  function toggleProject(cwd: string) {
    setCollapsedProjects((current) => {
      const next = new Set(current);

      if (next.has(cwd)) {
        next.delete(cwd);
      } else {
        next.add(cwd);
      }

      return next;
    });
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = draft.trim();
    const socket = socketRef.current;
    const socketReady = Boolean(socket && socket.readyState === WebSocket.OPEN && sessionId);

    if (!text) {
      return;
    }

    if (!socketReady) {
      const timestamp = nowIso();
      setMessages((current) => [
        ...current,
        {
          id: createId("user"),
          role: "user",
          text,
          status: "failed",
          timestamp
        },
        createSystemMessage("发送失败：连接还没准备好，请等顶部显示“已连接”后再试。")
      ]);
      setDraft("");
      return;
    }

    const threadId = await ensureThreadForSend();

    if (!threadId) {
      const timestamp = nowIso();
      setMessages((current) => [
        ...current,
        {
          id: createId("user"),
          role: "user",
          text,
          status: "failed",
          timestamp
        },
        createSystemMessage("发送失败：没有可用的 Codex 对话，已尝试自动新建但失败。")
      ]);
      setDraft("");
      return;
    }

    const messageId = createId("user");
    const timestamp = nowIso();

    setMessages((current) => [
      ...current.filter((message) => message.text !== SELECT_THREAD_HINT && message.text !== INITIAL_THREAD_HINT),
      {
        id: messageId,
        role: "user",
        text,
        status: "sending",
        timestamp
      }
      ]);
    setDraft("");

    const payload: UserMessageEvent = {
      id: createId("event"),
      type: "user_message",
      sessionId: threadId,
      timestamp,
      messageId,
      text,
      settings: getEffectiveChatRunSettings(chatSettings, codexModels)
    };

    socket?.send(JSON.stringify(payload));
    startHistoryFollow(threadId, timestamp);
  }

  return (
    <main className="app-shell">
      {runtimeError ? (
        <section className="error-banner">
          {runtimeError}
        </section>
      ) : null}
      <section className="phone" aria-label="Codex Remote 手机模拟界面">
        {showAuthGate ? (
          <div className="auth-layer" role="presentation">
            <section className="auth-card" aria-label="会话验证">
              <h2>输入密钥</h2>
              <p>填写电脑客户端显示的 16 位密钥。服务器只用它把网页和那台电脑配对。</p>
              <div className="auth-privacy-note">
                <strong>隐私说明</strong>
                <span>不会把你的 Codex 账号、登录信息或 API Key 发到服务器；Codex 账号只在电脑本机参与生成稳定密钥。</span>
              </div>
              <form className="auth-form" onSubmit={verifyCode}>
                <input
                  type="text"
                  placeholder="请输入16位密钥"
                  value={authCode}
                  maxLength={32}
                  onChange={(event) => setAuthCode(event.target.value)}
                  autoFocus
                />
                <button type="submit" disabled={!authCode.trim()}>
                  验证并进入
                </button>
              </form>
              {authError ? <p className="auth-error">{authError}</p> : null}
              <div className="auth-divider"><span>还没有密钥？</span></div>
              <div className="auth-downloads">
                <a className="auth-download" href={`${httpBaseUrl}/codex/connector/download/mac`}>
                  <Download size={16} />
                  Mac 客户端
                </a>
                <a className="auth-download" href={`${httpBaseUrl}/codex/connector/download/windows`}>
                  <Download size={16} />
                  Windows 客户端
                </a>
              </div>
              <div className="auth-terminal">
                <p className="auth-terminal-label">
                  Mac 双击打不开（提示"无法验证/安全限制"）？把下面这行粘到「终端」回车即可，免去安全限制：
                </p>
                <div className="auth-terminal-row">
                  <code className="auth-terminal-code">{macInstallCommand}</code>
                  <button
                    type="button"
                    className="auth-terminal-copy"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(macInstallCommand);
                        setMacCmdCopied(true);
                        setTimeout(() => setMacCmdCopied(false), 2000);
                      } catch {
                        setMacCmdCopied(false);
                      }
                    }}
                  >
                    {macCmdCopied ? "已复制" : "复制"}
                  </button>
                </div>
              </div>
              <p className="auth-hint">
                在你的电脑上运行下载的客户端，它会显示一个 16 位密钥；把密钥填到上面即可。
                客户端需要你的电脑已安装并登录 Codex，消息会通过服务器中转给你的电脑客户端。
              </p>
            </section>
          </div>
        ) : null}

        <header className="chat-header">
          <div className="identity">
            <button className="avatar avatar-button" type="button" aria-label="打开对话列表" onClick={() => setDrawerOpen(true)}>
              <MessageCircle size={20} />
            </button>
            <div>
              <h1>{activeThread?.title ?? "Codex Remote"}</h1>
              <p>{activeThread ? activeThread.cwd : "选择一个 Codex 对话"}</p>
            </div>
          </div>
          <div className="header-actions">
            <div className={`status status-${connectionStatus}`} title={statusCopy}>
              {connectionStatus === "connected" ? <Wifi size={16} /> : <WifiOff size={16} />}
              <span>{statusCopy}</span>
            </div>
            <button className="icon-button primary-icon-button" type="button" aria-label="新建对话" onClick={createThread}>
              <Plus size={18} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="模型设置"
              title="模型设置"
              onClick={() => setShowSettingsPanel(true)}
            >
              <Settings size={18} />
            </button>
            <button
              className="icon-button danger-icon-button"
              type="button"
              aria-label="删除当前对话"
              title="删除当前对话"
              disabled={!codexStatus.threadId}
              onClick={deleteActiveThread}
            >
              <Trash2 size={18} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="管理员面板"
              title="管理员面板"
              onClick={() => setShowAdminPanel((current) => !current)}
            >
              <Shield size={18} />
            </button>
          </div>
        </header>

        <div className="session-strip">
          <Smartphone size={15} />
          <span>{sessionId ? `本地会话 ${sessionId.slice(0, 18)}...` : "等待电脑端连接"}</span>
        </div>

        <div className={`codex-strip ${codexStatus.connected ? "codex-strip-connected" : ""}`}>
          <Bot size={15} />
          <span>
            {codexStatus.connected && codexStatus.threadId
              ? `已链接 Codex 线程 ${codexStatus.threadId.slice(0, 8)}... · ${getDesktopSyncLabel(codexStatus)}`
              : `Codex 未链接：${codexStatus.message ?? "等待状态"}`}
          </span>
        </div>

        <div className="settings-strip">
          <Settings size={14} />
          <span>{settingsSummary}</span>
        </div>

        <div className={`usage-strip ${usageError ? "usage-strip-error" : ""}`}>
          <Circle size={8} fill="currentColor" />
          <span>{usageError || getUsageSummary(accountUsage, usageLoading)}</span>
          <button type="button" aria-label="刷新剩余额度" title="刷新剩余额度" onClick={refreshAccountUsage} disabled={usageLoading || !sessionToken}>
            <RefreshCw size={13} />
          </button>
        </div>

        <section className="message-list" aria-live="polite">
          {messages.map((message) => (
            <article key={message.id} className={`message-row message-row-${message.role}`}>
              <div className={`bubble bubble-${message.role}`}>
                <p>{message.text || "正在输入..."}</p>
                <div className="message-meta">
                  <Circle size={7} fill="currentColor" />
                  <span>{message.status === "failed" ? "发送失败" : message.status}</span>
                </div>
              </div>
            </article>
          ))}
          <div ref={bottomRef} />
        </section>

        <form className="composer" onSubmit={sendMessage}>
          <label className="sr-only" htmlFor="message">
            输入消息
          </label>
          <textarea
            id="message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="给当前 Codex 对话发消息..."
            rows={1}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onKeyDown={(event) => {
              const nativeEvent = event.nativeEvent as KeyboardEvent;
              if (event.key === "Enter" && !event.shiftKey && !nativeEvent.isComposing && !isComposingRef.current) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="composer-tools">
            <div className="project-picker">
              <button
                className="composer-project-button"
                type="button"
                aria-label="选择项目组"
                aria-expanded={projectPickerOpen}
                onClick={() => setProjectPickerOpen((current) => !current)}
                disabled={!sessionToken || projectGroups.length === 0}
              >
                <Folder size={16} />
                <span>{activeProject?.name ?? "选择项目"}</span>
                <ChevronDown size={15} />
              </button>

              {projectPickerOpen ? (
                <div className="project-picker-menu" role="menu">
                  {projectGroups.map((group) => (
                    <button
                      key={group.cwd}
                      className={group.cwd === activeProject?.cwd ? "project-picker-item project-picker-item-active" : "project-picker-item"}
                      type="button"
                      role="menuitem"
                      onClick={() => selectProject(group)}
                      disabled={group.cwd === activeProject?.cwd}
                    >
                      <Folder size={15} />
                      <span>{group.name}</span>
                      <small>{group.threads.length}</small>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <button className="composer-send-button" type="submit" aria-label="发送消息" disabled={!draft.trim()}>
              <Send size={18} />
            </button>
          </div>
        </form>

        {drawerOpen ? (
          <div className="drawer-layer" role="presentation">
            <button className="drawer-scrim" type="button" aria-label="关闭对话列表" onClick={() => setDrawerOpen(false)} />
            <aside className="thread-drawer" aria-label="Codex 对话列表">
              <div className="drawer-header">
                <div>
                  <h2>对话</h2>
                  <p>{threadGroups.length} 个项目组</p>
                </div>
                <button className="icon-button" type="button" aria-label="关闭对话列表" onClick={() => setDrawerOpen(false)}>
                  <X size={18} />
                </button>
              </div>

              <div className="drawer-search">
                <Search size={16} />
                <label className="sr-only" htmlFor="thread-search">
                  搜索对话
                </label>
                <input
                  id="thread-search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="搜索项目或对话"
                />
              </div>

              <button className="new-thread-card" type="button" onClick={createThread}>
                <Plus size={18} />
                <span>新建 Codex 对话</span>
              </button>

              <div className="project-list">
                {filteredGroups.map((group) => {
                  const collapsed = collapsedProjects.has(group.cwd);

                  return (
                    <section className="project-group" key={group.cwd}>
                      <div className={`project-header ${group.active ? "project-header-active" : ""}`}>
                        <button className="project-toggle" type="button" onClick={() => toggleProject(group.cwd)}>
                          {group.kind === "api" ? <Bot size={16} /> : <Folder size={16} />}
                          <span>{group.name}</span>
                          <strong>{group.threads.length}</strong>
                          <ChevronDown className={collapsed ? "chevron-collapsed" : ""} size={16} />
                        </button>
                        {group.kind === "project" ? (
                          <button className="project-select" type="button" onClick={() => selectProject(group)} disabled={group.active}>
                            {group.active ? "当前" : "切换"}
                          </button>
                        ) : null}
                      </div>

                      {!collapsed ? (
                        <div className="thread-list">
                          {group.threads.map((thread) => (
                            <button
                              className={`thread-card ${thread.active ? "thread-card-active" : ""}`}
                              key={thread.id}
                              type="button"
                              onClick={() => selectThread(thread)}
                            >
                              <div className="thread-card-main">
                                <span>{thread.title}</span>
                                <p>{thread.preview}</p>
                              </div>
                              <div className="thread-card-side">
                                {group.kind === "api" ? <small>API</small> : null}
                                <time>{formatThreadTime(thread.updatedAt)}</time>
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </section>
                  );
                })}

                {filteredGroups.length === 0 ? <p className="empty-state">没有匹配的对话。</p> : null}
              </div>
            </aside>
          </div>
        ) : null}

        {showSettingsPanel ? (
          <div className="settings-layer" role="presentation">
            <button className="settings-scrim" type="button" aria-label="关闭模型设置" onClick={() => setShowSettingsPanel(false)} />
            <section className="settings-panel" aria-label="模型设置">
              <div className="settings-panel-header">
                <div>
                  <h2>模型设置</h2>
                  <p>这些设置会在下一条消息生效。</p>
                </div>
                <button className="icon-button" type="button" aria-label="关闭模型设置" onClick={() => setShowSettingsPanel(false)}>
                  <X size={18} />
                </button>
              </div>

              <label className="setting-field">
                <span>模型</span>
                <select
                  value={chatSettings.model}
                  onChange={(event) => {
                    const capability = getCodexModelCapability(codexModels, event.target.value);
                    setChatSettings((current) => ({
                      ...current,
                      model: event.target.value,
                      reasoningEffort: capability.defaultReasoningEffort ?? current.reasoningEffort,
                      speed: capability.speedTiers.includes(current.speed) ? current.speed : "standard"
                    }));
                  }}
                >
                  {codexModels.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              <div className="setting-field">
                <span>思考深度</span>
                <div className="segmented-control">
                  {currentModelCapability.reasoningEfforts.length > 0 ? (
                    REASONING_OPTIONS.filter((option) => currentModelCapability.reasoningEfforts.includes(option.value)).map((option) => (
                      <button
                        key={option.value}
                        className={chatSettings.reasoningEffort === option.value ? "segmented-active" : ""}
                        type="button"
                        onClick={() => setChatSettings((current) => ({ ...current, reasoningEffort: option.value }))}
                      >
                        {option.label}
                      </button>
                    ))
                  ) : (
                    <span className="setting-muted">当前模型不支持单独设置</span>
                  )}
                </div>
              </div>

              <div className="setting-field">
                <span>速度</span>
                <div className="segmented-control segmented-two">
                  {SPEED_OPTIONS.filter((option) => currentModelCapability.speedTiers.includes(option.value)).map((option) => (
                    <button
                      key={option.value}
                      className={chatSettings.speed === option.value ? "segmented-active" : ""}
                      type="button"
                      onClick={() => setChatSettings((current) => ({ ...current, speed: option.value }))}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-field">
                <span>审批</span>
                <div className="segmented-control segmented-two">
                  {APPROVAL_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      className={chatSettings.approvalPolicy === option.value ? "segmented-active" : ""}
                      type="button"
                      onClick={() => setChatSettings((current) => ({ ...current, approvalPolicy: option.value }))}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-field">
                <span>权限</span>
                <div className="segmented-control segmented-three">
                  {SANDBOX_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      className={chatSettings.sandboxMode === option.value ? "segmented-active" : ""}
                      type="button"
                      onClick={() => setChatSettings((current) => ({ ...current, sandboxMode: option.value }))}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          </div>
        ) : null}

        {showAdminPanel ? (
          <div className="admin-layer" role="presentation">
            <button className="admin-scrim" type="button" aria-label="关闭管理员面板" onClick={() => setShowAdminPanel(false)} />
            <aside className="admin-drawer" aria-label="管理员面板">
              <div className="admin-drawer-header">
                <div>
                  <h2>管理员面板</h2>
                  <p>{adminSessionToken ? "可查看当前活跃会话与消息日志" : "请先输入管理员 KEY"}</p>
                </div>
                <div className="admin-actions">
                  {adminSessionToken ? (
                    <>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label="刷新管理员数据"
                        onClick={() => {
                          refreshAdminSessions();
                          refreshAdminSecurityEvents();
                        }}
                      >
                        <RefreshCw size={16} />
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label="退出管理员"
                        onClick={() => {
                          clearAdminSession();
                        }}
                      >
                        <XCircle size={16} />
                      </button>
                    </>
                  ) : null}
                  <button className="icon-button" type="button" aria-label="关闭管理员面板" onClick={() => setShowAdminPanel(false)}>
                    <X size={16} />
                  </button>
                </div>
              </div>

              {!adminSessionToken ? (
                <form className="admin-auth-form" onSubmit={verifyAdmin}>
                  <input
                    type="password"
                    placeholder="管理员 KEY"
                    value={adminKey}
                    onChange={(event) => setAdminKey(event.target.value)}
                  />
                  <button type="submit" disabled={adminLoading || !adminKey.trim()}>
                    {adminLoading ? "校验中" : "验证"}
                  </button>
                </form>
              ) : null}

              {adminKeyError ? <p className="auth-error">{adminKeyError}</p> : null}
              {adminError ? <p className="admin-error">{adminError}</p> : null}

              {adminSessionToken ? (
                <div className="admin-content">
                  <section className="admin-session-list-wrap">
                    <h3>用户会话 ({adminSessions.length})</h3>
                    {adminSessions.length === 0 ? (
                      <p className="empty-state">暂无用户会话记录</p>
                    ) : (
                      <div className="admin-session-list">
                        {adminSessions.map((session) => {
                          const active = session.token === adminSessionTokenSelected;
                          return (
                            <article
                              className={`admin-session-item ${active ? "admin-session-item-active" : ""}`}
                              key={session.token}
                            >
                              <button
                                className="admin-session-open"
                                type="button"
                                onClick={() => loadAdminSessionMessages(session.token)}
                              >
                                <div className="admin-session-main">
                                  <span>{session.token.slice(0, 10)}...</span>
                                  <p>
                                    <UserRound size={12} />
                                    <strong>IP</strong> {session.ip || "未知"}
                                  </p>
                                  <p>
                                    <strong>密钥</strong> {session.key ?? session.keyMasked ?? "未知"}
                                  </p>
                                  <small>{session.userAgent}</small>
                                </div>
                                <div className="admin-session-meta">
                                  <small>{session.connected ? "网页在线" : "网页离线"}</small>
                                  <small>{session.connectorOnline ? "电脑在线" : "电脑离线"}</small>
                                  <small>消息 {session.messageCount}</small>
                                  <small>登入 {formatAdminTime(session.createdAt)}</small>
                                  <small>活跃 {formatAdminTime(session.lastSeenAt)}</small>
                                  {session.protected ? <strong>受保护</strong> : null}
                                  {session.blocked ? <strong>已拉黑</strong> : null}
                                </div>
                              </button>
                              <div className="admin-session-controls">
                                <button
                                  className="danger-text-button"
                                  type="button"
                                  disabled={adminLoading || session.blocked || session.protected}
                                  onClick={() => blockAdminSessionKey(session)}
                                >
                                  {session.protected ? "受保护" : session.blocked ? "已拉黑" : "拉黑密钥"}
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  <section className="admin-message-wrap">
                    {selectedAdminSession ? <h3>聊天记录（{selectedAdminSession.token.slice(0, 10)}...）</h3> : null}
                    {adminLoading ? <p className="admin-empty">加载中…</p> : null}
                    {!adminLoading && !selectedAdminSession ? (
                      <p className="empty-state">先点左侧会话查看日志</p>
                    ) : null}
                    {adminMessages.length > 0 ? (
                      <div className="admin-message-list">
                        {adminMessages.map((message) => (
                          <article className={`admin-message admin-message-${message.role}`} key={message.id}>
                            <div className="admin-message-meta">
                              <strong>{message.role === "user" ? "用户" : "Codex"}</strong>
                              <span>{formatAdminTime(message.timestamp)}</span>
                              {message.threadId ? <small>thread:{message.threadId.slice(0, 8)}</small> : null}
                            </div>
                            <p>{message.text}</p>
                          </article>
                        ))}
                      </div>
                    ) : null}
                    <div className="admin-security-section">
                      <h3>安全日志（最近 {adminSecurityEvents.length} 条）</h3>
                      {adminSecurityEvents.length === 0 ? (
                        <p className="empty-state">暂无安全事件</p>
                      ) : (
                        <div className="admin-security-list">
                          {adminSecurityEvents.map((event, index) => (
                            <article className={`admin-security-event admin-security-${event.level}`} key={`${event.ts}-${event.event}-${index}`}>
                              <div>
                                <strong>{formatSecurityEvent(event.event)}</strong>
                                <span>{formatAdminTime(event.ts)}</span>
                              </div>
                              <p>
                                {event.ip ? `IP ${event.ip}` : "无IP"}
                                {event.scope ? ` · ${event.scope}` : ""}
                                {event.reason ? ` · ${event.reason}` : ""}
                                {event.key ? ` · key ${event.key}` : ""}
                                {event.deviceId ? ` · device ${event.deviceId}` : ""}
                              </p>
                            </article>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>
                </div>
              ) : null}
            </aside>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function createSystemMessage(text: string): ChatMessage {
  return {
    id: createId("system"),
    role: "system",
    text,
    status: "sent",
    timestamp: nowIso()
  };
}

function isReasoningEffort(value: unknown): value is Required<ChatRunSettings>["reasoningEffort"] {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isApprovalPolicy(value: unknown): value is Required<ChatRunSettings>["approvalPolicy"] {
  return value === "never" || value === "on-request";
}

function isSandboxMode(value: unknown): value is Required<ChatRunSettings>["sandboxMode"] {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function getModelLabel(value: string, models = MODEL_OPTIONS) {
  return models.find((option) => option.value === value)?.label ?? value;
}

function getReasoningLabel(value: Required<ChatRunSettings>["reasoningEffort"]) {
  return REASONING_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function getSpeedLabel(value: Required<ChatRunSettings>["speed"]) {
  return SPEED_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function getSandboxLabel(value: Required<ChatRunSettings>["sandboxMode"]) {
  return SANDBOX_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function getSettingsSummary(settings: Required<ChatRunSettings>, models: CodexModelOption[]) {
  const capability = getCodexModelCapability(models, settings.model);
  const parts = [getModelLabel(settings.model, models)];

  if (capability.reasoningEfforts.includes(settings.reasoningEffort)) {
    parts.push(`思考${getReasoningLabel(settings.reasoningEffort)}`);
  }

  if (settings.speed !== "standard" && capability.speedTiers.includes(settings.speed)) {
    parts.push(getSpeedLabel(settings.speed));
  }

  parts.push(getSandboxLabel(settings.sandboxMode));
  return parts.join(" · ");
}

function getUsageSummary(usage: AccountUsageResponse | null, loading: boolean) {
  if (loading && !usage) {
    return "正在读取剩余额度...";
  }

  const primary = usage?.rateLimits?.primary;
  if (!primary || typeof primary.usedPercent !== "number") {
    return loading ? "正在刷新剩余额度..." : "剩余额度待刷新";
  }

  const remaining = Math.max(0, Math.min(100, 100 - primary.usedPercent));
  const reset = primary.resetsAt ? `，重置 ${formatResetTime(primary.resetsAt)}` : "";
  const resetCredits = usage?.rateLimitResetCredits?.availableCount;
  const resetCreditCopy = typeof resetCredits === "number" ? `，重置券 ${resetCredits}` : "";

  return `剩余额度 ${remaining}%（已用 ${primary.usedPercent}%${reset}${resetCreditCopy}）`;
}

function formatResetTime(timestampSeconds: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestampSeconds * 1000));
}

function normalizeHistoryMessages(messages: ChatMessage[], emptyText = "这个对话还没有历史消息。"): ChatMessage[] {
  if (messages.length > 0) {
    return messages;
  }

  return [createSystemMessage(emptyText)];
}

function mergeHistoryWithLiveMessages(
  historyMessages: ChatMessage[],
  currentMessages: ChatMessage[],
  options: { preserveLiveAssistantStream?: boolean } = {}
): ChatMessage[] {
  const safeHistoryMessages = options.preserveLiveAssistantStream
    ? historyMessages.filter((message) => message.role !== "assistant")
    : historyMessages;
  const normalizedHistory = normalizeHistoryMessages(safeHistoryMessages);
  const historyIds = new Set(normalizedHistory.map((message) => message.id));
  const latestHistoryAssistantTime = Math.max(
    0,
    ...safeHistoryMessages
      .filter((message) => message.role === "assistant")
      .map((message) => new Date(message.timestamp).getTime())
      .filter((timestamp) => Number.isFinite(timestamp))
  );
  const liveMessages = currentMessages.filter((message) => {
    if (historyIds.has(message.id)) {
      return false;
    }
    const messageTime = new Date(message.timestamp).getTime();
    if (
      !options.preserveLiveAssistantStream &&
      (message.status === "sending" || (message.status === "streaming" && message.role === "assistant")) &&
      latestHistoryAssistantTime > 0 &&
      Number.isFinite(messageTime) &&
      latestHistoryAssistantTime >= messageTime - 1000
    ) {
      return false;
    }

    return (
      message.status === "sending" ||
      message.status === "streaming" ||
      message.status === "failed" ||
      (message.role === "system" && safeHistoryMessages.length === 0 && !isTransientSystemMessage(message.text))
    );
  });

  if (safeHistoryMessages.length === 0 && liveMessages.length > 0) {
    return liveMessages;
  }

  return [...normalizedHistory, ...liveMessages];
}

function isTransientSystemMessage(text: string) {
  return (
    text === SELECT_THREAD_HINT ||
    text === INITIAL_THREAD_HINT
  );
}

function getDesktopSyncLabel(status: CodexStatus) {
  const sync = status.desktopSync;
  if (!sync?.enabled) {
    return "后台通道";
  }

  if (sync.preflight && sync.preflight.ok === false) {
    return `强制同步异常：${sync.preflight.message ?? "请检查电脑端权限"}`;
  }

  return "强制同步已开启";
}

function ensureActiveThreadInGroups(groups: CodexProjectGroup[], status: CodexStatus): CodexProjectGroup[] {
  if (!status.threadId) {
    return groups;
  }

  const hasActiveThread = groups.some((group) => group.threads.some((thread) => thread.id === status.threadId));

  if (hasActiveThread) {
    return groups;
  }

  const cwd = status.cwd ?? "local";
  const fallbackGroup = {
    cwd,
    name: "当前会话",
    kind: "api" as const,
    threads: [
      {
        id: status.threadId,
        title: "当前 Codex 对话",
        preview: "无历史消息",
        cwd,
        source: "appServer",
        updatedAt: Date.now() / 1000,
        createdAt: Date.now() / 1000,
        active: true
      }
    ]
  };

  return [fallbackGroup, ...groups];
}

function formatThreadTime(timestamp: number): string {
  if (!timestamp) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp * 1000));
}

function formatAdminTime(timestamp: string | number): string {
  const date = typeof timestamp === "number" ? new Date(timestamp) : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function formatSecurityEvent(event: string) {
  const labels: Record<string, string> = {
    ADMIN_LOGIN_SUCCESS: "管理员登录成功",
    USER_LOGIN_SUCCESS: "用户登录成功",
    RATE_LIMIT_FAIL: "验证失败记录",
    RATE_LIMIT_BLOCK: "验证限流封禁",
    CONNECT_RATE_BLOCK: "连接限流封禁",
    CONNECT_RATE_LIMITED: "连接已被限流",
    WEBSOCKET_DENY: "WebSocket 拒绝",
    FORBIDDEN_IP: "IP 拒绝",
    FORBIDDEN_IP_UPGRADE: "连接升级拒绝",
    KEY_BLOCKED: "密钥拉黑",
    KEY_UNBLOCKED: "密钥解除拉黑",
    BLOCKED_KEY_LOGIN: "拉黑密钥尝试登录",
    BLOCKED_KEY_CONNECTOR: "拉黑密钥尝试连接电脑端",
    CONNECTOR_DEVICE_BOUND: "电脑端设备绑定",
    CONNECTOR_DEVICE_REJECTED: "电脑端设备拒绝"
  };
  return labels[event] ?? event;
}
