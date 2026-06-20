import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { getEffectiveChatRunSettings } from "@local-codex-remote/shared";
import type {
  AgentChunk,
  AgentInput,
  ChatRunSettings,
  ChatMessage,
  CodexAgent,
  CodexProjectGroup,
  CodexThreadMessages,
  CodexThreadSummary
} from "@local-codex-remote/shared";

type JsonRpcId = number | string;

type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

type Thread = {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  source: string | { custom?: string } | Record<string, unknown>;
  threadSource: string | null;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
};

type ThreadListResponse = {
  data: Thread[];
};

type ThreadStartResponse = {
  thread: Thread;
};

type ThreadResumeResponse = {
  thread: Thread;
};

type ThreadReadResponse = {
  thread: Thread & {
    turns: Turn[];
  };
};

type ThreadDeleteResponse = {
  thread: Thread;
};

type AccountUsageResponse = {
  account: unknown;
  rateLimits: unknown;
  rateLimitsByLimitId: unknown;
  rateLimitResetCredits: unknown;
};

type Turn = {
  id: string;
  items: ThreadItem[];
  startedAt: number | null;
  completedAt: number | null;
};

type ThreadItem = {
  type: string;
  id: string;
  content?: Array<{ type: string; text?: string }>;
  text?: string;
  phase?: string | null;
};

type TurnStartResponse = {
  turn: {
    id: string;
  };
};

type CodexAppServerOptions = {
  cwd: string;
  codexBin?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class CodexAppServerAgent implements CodexAgent {
  private clientPromise: Promise<CodexAppServerClient> | null = null;
  private threadId: string | null = null;
  private currentCwd: string;

  constructor(private readonly options: CodexAppServerOptions) {
    this.currentCwd = options.cwd;
  }

  async *respond(input: AgentInput): AsyncIterable<AgentChunk> {
    const client = await this.getClient();
    const threadId = await this.getThreadId(client);
    const turn = await client.request<TurnStartResponse>("turn/start", {
      threadId,
      clientUserMessageId: input.messageId,
      input: [
        {
          type: "text",
          text: input.text,
          text_elements: []
        }
      ],
      cwd: this.currentCwd,
      approvalPolicy: input.settings?.approvalPolicy ?? "never",
      sandboxPolicy: toSandboxPolicy(input.settings?.sandboxMode, this.currentCwd),
      ...toTurnModelSettings(input.settings)
    });

    yield* client.streamTurn(threadId, turn.turn.id);
  }

  async getStatus() {
    const client = await this.getClient();
    const threadId = await this.getThreadId(client);

    return {
      connected: true,
      cwd: this.currentCwd,
      threadId,
      transport: "codex app-server stdio"
    };
  }

  async listProjectGroups(options: { ensureActive?: boolean } = {}): Promise<CodexProjectGroup[]> {
    const client = await this.getClient();
    const activeThreadId = options.ensureActive === false ? this.threadId : await this.getThreadId(client);
    const list = await client.request<ThreadListResponse>("thread/list", {
      limit: 80,
      archived: false,
      sortKey: "updated_at",
      sortDirection: "desc"
    });
    const groups = new Map<string, CodexThreadSummary[]>();

    for (const thread of list.data) {
      const summary = toThreadSummary(thread, activeThreadId);
      const groupKey = getGroupKey(thread);
      const threads = groups.get(groupKey) ?? [];
      threads.push(summary);
      groups.set(groupKey, threads);
    }

    return Array.from(groups.entries()).map(([cwd, threads]) => ({
      cwd,
      name: cwd === API_GROUP_KEY ? "API" : cwd.split("/").filter(Boolean).at(-1) ?? cwd,
      kind: cwd === API_GROUP_KEY ? "api" : "project",
      active: cwd === this.currentCwd,
      threads
    }));
  }

  async selectThread(threadId: string) {
    const client = await this.getClient();
    const resumed = await client.request<ThreadResumeResponse>("thread/resume", {
      threadId,
      cwd: this.currentCwd,
      runtimeWorkspaceRoots: [this.currentCwd],
      approvalPolicy: "never",
      sandbox: "workspace-write",
      excludeTurns: true
    });

    this.threadId = resumed.thread.id;
    this.currentCwd = resumed.thread.cwd || this.currentCwd;

    return {
      thread: toThreadSummary(resumed.thread, this.threadId),
      messages: await this.readThreadMessages(threadId)
    };
  }

  async createThread() {
    const client = await this.getClient();
    const started = await client.request<ThreadStartResponse>("thread/start", {
      cwd: this.currentCwd,
      runtimeWorkspaceRoots: [this.currentCwd],
      approvalPolicy: "never",
      sandbox: "workspace-write"
    });

    this.threadId = started.thread.id;

    return {
      thread: toThreadSummary(started.thread, this.threadId),
      messages: emptyThreadMessages(started.thread.id)
    };
  }

  async selectProject(cwd: string) {
    if (!cwd || cwd === API_GROUP_KEY) {
      throw new Error("不能选择这个项目组。");
    }

    const client = await this.getClient();
    this.currentCwd = cwd;
    this.threadId = null;
    const threadId = await this.getThreadId(client);

    return {
      status: {
        connected: true,
        cwd: this.currentCwd,
        threadId,
        transport: "codex app-server stdio"
      },
      groups: await this.listProjectGroups(),
      messages: await this.readThreadMessages(threadId)
    };
  }

  async deleteThread(threadId: string) {
    const client = await this.getClient();
    const methods = ["thread/archive", "thread/delete"] as const;
    let lastError: Error | null = null;

    for (const method of methods) {
      try {
        const response = await client.request<ThreadDeleteResponse>(method, { threadId });
        if (this.threadId === threadId) {
          this.threadId = null;
        }
        return {
          thread: toThreadSummary(response.thread, this.threadId),
          groups: await this.listProjectGroups({ ensureActive: false })
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error("Codex 删除对话失败。");
  }

  async getAccountUsage() {
    const client = await this.getClient();
    const account = await client.request<{ account: unknown; requiresOpenaiAuth?: boolean }>("account/read", {});
    const limits = await client.request<Omit<AccountUsageResponse, "account">>("account/rateLimits/read", {});

    return {
      account: account.account,
      ...limits
    };
  }

  async readThreadMessages(threadId: string): Promise<CodexThreadMessages> {
    const client = await this.getClient();
    try {
      const response = await client.request<ThreadReadResponse>("thread/read", {
        threadId,
        includeTurns: true
      });

      return {
        threadId,
        messages: response.thread.turns.flatMap((turn) => mapTurnItemsToMessages(turn))
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("not materialized yet")) {
        return emptyThreadMessages(threadId);
      }
      throw error;
    }
  }

  private async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = CodexAppServerClient.start({
        cwd: this.options.cwd,
        codexBin: this.options.codexBin ?? resolveCodexBin()
      });
    }

    try {
      return await this.clientPromise;
    } catch (error) {
      // 避免一次启动失败后永久卡住，允许下一次请求重新尝试启动 codex 进程。
      this.clientPromise = null;
      throw error;
    }
  }

  private async getThreadId(client: CodexAppServerClient) {
    if (this.threadId) {
      return this.threadId;
    }

    const list = await client.request<ThreadListResponse>("thread/list", {
      limit: 1,
      cwd: this.currentCwd,
      archived: false,
      sortKey: "updated_at",
      sortDirection: "desc"
    });
    const existingThread = list.data[0];

    if (existingThread) {
      const resumed = await client.request<ThreadResumeResponse>("thread/resume", {
        threadId: existingThread.id,
        cwd: this.currentCwd,
        runtimeWorkspaceRoots: [this.currentCwd],
        approvalPolicy: "never",
        sandbox: "workspace-write",
        excludeTurns: true
      });

      this.threadId = resumed.thread.id;
      console.log("[codex] resumed thread", {
        threadId: resumed.thread.id,
        name: resumed.thread.name,
        preview: resumed.thread.preview
      });
      return this.threadId;
    }

    const started = await client.request<ThreadStartResponse>("thread/start", {
      cwd: this.currentCwd,
      runtimeWorkspaceRoots: [this.currentCwd],
      approvalPolicy: "never",
      sandbox: "workspace-write"
    });

    this.threadId = started.thread.id;
    console.log("[codex] started thread", {
      threadId: started.thread.id,
      name: started.thread.name,
      preview: started.thread.preview
    });

    return this.threadId;
  }
}

function toTurnModelSettings(settings: ChatRunSettings | undefined): Record<string, unknown> {
  if (!settings) {
    return {};
  }
  const effectiveSettings = getEffectiveChatRunSettings(settings);

  const result: Record<string, unknown> = {};

  if (effectiveSettings.model) {
    result.model = effectiveSettings.model;
  }

  if (effectiveSettings.reasoningEffort) {
    // codex 协议 TurnStartParams 的字段名是 effort（不是 reasoningEffort），写错了会被忽略。
    result.effort = effectiveSettings.reasoningEffort;
  }

  if (effectiveSettings.speed === "fast") {
    result.serviceTier = "priority";
  }

  return result;
}

function toSandboxPolicy(mode: ChatRunSettings["sandboxMode"] | undefined, cwd: string) {
  if (mode === "read-only") {
    return {
      type: "readOnly"
    };
  }

  if (mode === "danger-full-access") {
    return {
      type: "dangerFullAccess"
    };
  }

  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

const API_GROUP_KEY = "__api__";

function toThreadSummary(thread: Thread, activeThreadId: string | null): CodexThreadSummary {
  const title = thread.name?.trim() || thread.preview.trim() || "未命名对话";

  return {
    id: thread.id,
    title,
    preview: thread.preview.trim() || "新对话",
    cwd: thread.cwd,
    source: getSourceLabel(thread.source),
    updatedAt: thread.recencyAt ?? thread.updatedAt,
    createdAt: thread.createdAt,
    active: thread.id === activeThreadId
  };
}

function getGroupKey(thread: Thread) {
  return isApiThread(thread) ? API_GROUP_KEY : thread.cwd;
}

function isApiThread(thread: Thread) {
  const source = getSourceLabel(thread.source);

  return (
    source === "exec" ||
    source === "appServer" ||
    source === "custom" ||
    source === "subAgent" ||
    thread.threadSource === "api" ||
    thread.cwd === path.join(os.homedir(), "Downloads") ||
    isGeneratedCodexWorkspace(thread.cwd)
  );
}

function isGeneratedCodexWorkspace(cwd: string) {
  return cwd.startsWith(path.join(os.homedir(), "Documents", "Codex") + path.sep);
}

function getSourceLabel(source: Thread["source"]) {
  if (typeof source === "string") {
    return source;
  }

  if ("custom" in source) {
    return "custom";
  }

  if ("subAgent" in source) {
    return "subAgent";
  }

  return "unknown";
}

function mapTurnItemsToMessages(turn: Turn): ChatMessage[] {
  const timestamp = new Date(((turn.startedAt ?? turn.completedAt ?? Date.now() / 1000) * 1000)).toISOString();

  return turn.items.reduce<ChatMessage[]>((messages, item) => {
    if (item.type === "userMessage" && Array.isArray(item.content)) {
      const text = item.content
        .filter((content) => content.type === "text" && content.text)
        .map((content) => content.text)
        .join("\n")
        .trim();

      if (!text) {
        return messages;
      }

      messages.push({
        id: item.id,
        role: "user",
        text,
        status: "sent",
        timestamp
      });
      return messages;
    }

    if (item.type === "agentMessage" && item.text?.trim()) {
      messages.push({
        id: item.id,
        role: "assistant",
        text: item.text.trim(),
        status: "sent",
        timestamp
      });
      return messages;
    }

    return messages;
  }, []);
}

function emptyThreadMessages(threadId: string): CodexThreadMessages {
  return {
    threadId,
    messages: []
  };
}

class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly events = new EventEmitter();

  private constructor(private readonly proc: ChildProcessWithoutNullStreams) {}

  static async start(options: Required<CodexAppServerOptions>) {
    let proc: ChildProcessWithoutNullStreams;

    try {
      proc = spawn(options.codexBin, ["app-server"], {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      throw new Error(`启动 codex 进程失败（命令 ${options.codexBin}）：${message}`);
    }

    const client = new CodexAppServerClient(proc);
    client.attach();

    await client.request("initialize", {
      clientInfo: {
        name: "local_codex_remote",
        title: "Local Codex Remote",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    client.notify("initialized", {});

    return client;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const payload = { id, method, params };

    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
    });
  }

  notify(method: string, params: unknown) {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async *streamTurn(threadId: string, turnId: string): AsyncIterable<AgentChunk> {
    const queue: AgentChunk[] = [];
    let completed = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;

    const wakeReader = () => {
      wake?.();
      wake = null;
    };
    const onMessage = (message: JsonRpcMessage) => {
      if (message.method === "item/agentMessage/delta") {
        const params = message.params as { threadId: string; turnId: string; delta: string };

        if (params.threadId === threadId && params.turnId === turnId) {
          queue.push({ text: params.delta });
          wakeReader();
        }
      }

      if (message.method === "turn/completed") {
        const params = message.params as { threadId: string; turn: { id: string; status?: string } };

        if (params.threadId === threadId && params.turn.id === turnId) {
          completed = true;
          wakeReader();
        }
      }

      if (message.method === "error") {
        const params = message.params as Record<string, unknown> | undefined;
        const errorMessage = extractAppServerErrorMessage(params) ?? "Codex app-server returned an error.";
        failure = new Error(errorMessage);
        wakeReader();
      }
    };

    this.events.on("message", onMessage);

    try {
      while (!completed || queue.length > 0) {
        if (failure) {
          throw failure;
        }

        const chunk = queue.shift();

        if (chunk) {
          yield chunk;
          continue;
        }

        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      this.events.off("message", onMessage);
    }
  }

  private attach() {
    const rl = readline.createInterface({
      input: this.proc.stdout
    });

    rl.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      const message = JSON.parse(line) as JsonRpcMessage;

      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);

        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }

      if (message.method) {
        this.events.emit("message", message);
      }
    });

    this.proc.stderr.on("data", (data) => {
      console.error(`[codex app-server] ${data.toString().trim()}`);
    });

    this.proc.on("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}.`);

      for (const pending of this.pending.values()) {
        pending.reject(error);
      }

      this.pending.clear();
      this.events.emit("message", {
        method: "error",
        params: {
          message: error.message
        }
      });
    });
  }
}

function extractAppServerErrorMessage(params: Record<string, unknown> | undefined): string | null {
  if (!params) {
    return null;
  }

  if (typeof params.message === "string" && params.message.trim()) {
    return params.message;
  }

  const nestedError = params.error;
  if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
    const message = (nestedError as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  const codexError = params.codexErrorInfo;
  if (codexError && typeof codexError === "object") {
    const nestedMessage = (codexError as { responseStreamDisconnected?: { httpStatusCode?: unknown } })?.responseStreamDisconnected
      ?.httpStatusCode;

    if (nestedMessage) {
      return `Codex app-server error: response stream disconnected (${String(nestedMessage)}).`;
    }
  }

  if (params.additionalDetails && typeof params.additionalDetails === "string" && params.additionalDetails.trim()) {
    const additional = params.additionalDetails.trim().toLowerCase();

    if (containsKeyword(additional, ["timed out", "timeout", "request timed out", "response stream disconnected"])) {
      return "Codex app-server 与模型服务通信超时：请检查服务器是否能访问 api.openai.com:443，或配置可用代理。";
    }

    return params.additionalDetails;
  }

  return JSON.stringify(params);
}

function containsKeyword(value: string, keywords: string[]) {
  return keywords.some((keyword) => value.includes(keyword));
}

function resolveCodexBin() {
  const candidates = [process.env.CODEX_BIN, "/usr/bin/codex", "codex"]
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        if (existsSync(candidate)) {
          return candidate;
        }
      }
      continue;
    }

    return candidate;
  }

  return "codex";
}
