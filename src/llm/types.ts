export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmClient {
  /** Returns the assistant's reply text. */
  chat(messages: ChatMessage[]): Promise<string>;
}

/** Ollama is not running, the model is missing, or a request failed or timed out. */
export class LlmError extends Error {
  override name = 'LlmError';
}
