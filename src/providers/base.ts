import type { ChatMessage, ChatOptions, LLMProvider, StreamChunk, Provider } from '../core/types.js';

/**
 * Base class for LLM providers with common functionality
 */
export abstract class BaseProvider implements LLMProvider {
  abstract name: Provider;
  protected apiKey?: string;
  protected baseUrl?: string;
  protected defaultModel: string;

  constructor(config: { apiKey?: string; baseUrl?: string; defaultModel: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.defaultModel = config.defaultModel;
  }

  abstract chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  abstract chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamChunk>;
  abstract isAvailable(): Promise<boolean>;

  /**
   * Validate that required configuration is present
   */
  protected validateConfig(): void {
    // Override in subclasses that require API keys
  }

  /**
   * Get the model to use, with fallback to default
   */
  protected getModel(options?: { model?: string }): string {
    return options?.model || this.defaultModel;
  }

  /**
   * Create an async generator from a readable stream
   */
  protected async *streamToAsyncIterable<T>(
    stream: ReadableStream<T>
  ): AsyncIterable<T> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Error thrown when a provider is not properly configured
 */
export class ProviderConfigError extends Error {
  constructor(provider: string, message: string) {
    super(`[${provider}] Configuration error: ${message}`);
    this.name = 'ProviderConfigError';
  }
}

/**
 * Error thrown when a provider API call fails
 */
export class ProviderAPIError extends Error {
  constructor(provider: string, message: string, public statusCode?: number) {
    super(`[${provider}] API error: ${message}`);
    this.name = 'ProviderAPIError';
  }
}
