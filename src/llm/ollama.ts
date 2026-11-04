import { Ollama } from 'ollama';
import type { Config } from '#/infra/index.js';
import { describeError } from '#/sources/index.js';
import { type ChatMessage, type LlmClient, LlmError } from './types.js';

const CHECK_TIMEOUT_MS = 20_000;

/** `qwen3` and `qwen3:latest` are the same model; a registry port is not a tag. */
export function sameModel(a: string, b: string): boolean {
  const normalize = (name: string) => {
    const lastPart = name.slice(name.lastIndexOf('/') + 1);
    return lastPart.includes(':') ? name : `${name}:latest`;
  };
  return normalize(a) === normalize(b);
}

function timedFetch(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchImpl(input, { ...init, signal });
  };
}

export class OllamaClient implements LlmClient {
  private readonly quick: Ollama;
  private readonly slow: Ollama;
  /** Set once the startup check has passed; a failed check is retried on the next call. */
  private supportsThinking: boolean | undefined;

  constructor(
    private readonly config: Config['ollama'],
    fetchImpl: typeof fetch = fetch,
  ) {
    this.quick = new Ollama({ host: config.host, fetch: timedFetch(fetchImpl, CHECK_TIMEOUT_MS) });
    this.slow = new Ollama({
      host: config.host,
      fetch: timedFetch(fetchImpl, config.timeout_seconds * 1000),
    });
  }

  /** Checks that Ollama runs and has the model, and reads whether it can think. */
  async check(): Promise<void> {
    const { host, model } = this.config;
    let installed: string[];
    try {
      installed = (await this.quick.list()).models.map((m) => m.name);
    } catch (error) {
      throw new LlmError(
        `无法连接 Ollama（${host}）：${describeError(error)}。请确认 Ollama 已经启动`,
        { cause: error },
      );
    }
    if (!installed.some((name) => sameModel(name, model))) {
      throw new LlmError(`模型 ${model} 还没有下载，请先运行 ollama pull ${model}`);
    }
    const { capabilities } = await this.quick.show({ model });
    this.supportsThinking = capabilities.includes('thinking');
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    if (this.supportsThinking === undefined) await this.check();
    const { model, keep_alive, temperature, num_ctx, think, timeout_seconds } = this.config;
    try {
      const response = await this.slow.chat({
        model,
        messages,
        stream: false,
        keep_alive,
        options: { temperature, num_ctx },
        // Models without thinking reject the parameter, even `false`, on some versions.
        ...(this.supportsThinking && { think }),
      });
      return response.message.content;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new LlmError(`模型 ${timeout_seconds} 秒内没有回复`, { cause: error });
      }
      throw new LlmError(`模型请求失败：${describeError(error)}`, { cause: error });
    }
  }
}
