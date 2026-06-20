import type { AgentChunk, AgentInput, CodexAgent } from "@local-codex-remote/shared";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MockCodexAgent implements CodexAgent {
  async *respond(input: AgentInput): AsyncIterable<AgentChunk> {
    const response = [
      "收到。这里是电脑端模拟 Codex 的回复。\n\n",
      `你刚才发送的是：“${input.text}”。\n\n`,
      "第一版已经证明通信链路可以工作：手机端样式页面 -> 本地 WebSocket 服务 -> 模拟 Codex -> 流式返回。\n\n",
      "下一步可以把这个 mock 处理器替换成真实 Codex CLI 适配器。"
    ];

    for (const paragraph of response) {
      for (const chunk of chunkText(paragraph, 8)) {
        await delay(45);
        yield { text: chunk };
      }
    }
  }
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }

  return chunks;
}
