import { Ollama } from 'ollama';
import { BaseProvider, ProviderAPIError } from './base.js';
import type { ChatMessage, ChatOptions, StreamChunk, Provider } from '../core/types.js';

export class OllamaProvider extends BaseProvider {
  name: Provider = 'ollama';
  private client: Ollama;

  constructor(config: { baseUrl?: string; model?: string } = {}) {
    const baseUrl = config.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    super({
      baseUrl,
      defaultModel: config.model || 'llama3.1',
    });

    this.client = new Ollama({ host: baseUrl });
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    try {
      const response = await this.client.chat({
        model: this.defaultModel,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        options: {
          temperature: options?.temperature ?? 0.7,
          num_predict: options?.maxTokens,
          stop: options?.stopSequences,
        },
      });

      return response.message.content;
    } catch (error) {
      throw new ProviderAPIError('Ollama', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    try {
      const stream = await this.client.chat({
        model: this.defaultModel,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        options: {
          temperature: options?.temperature ?? 0.7,
          num_predict: options?.maxTokens,
          stop: options?.stopSequences,
        },
        stream: true,
      });

      for await (const chunk of stream) {
        yield {
          content: chunk.message.content,
          done: chunk.done,
        };
      }
    } catch (error) {
      throw new ProviderAPIError('Ollama', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.list();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List available models from Ollama
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await this.client.list();
      return response.models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  /**
   * Pull a model if not already available
   */
  async pullModel(model: string): Promise<void> {
    await this.client.pull({ model });
  }
}
