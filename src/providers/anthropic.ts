import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider, ProviderConfigError, ProviderAPIError } from './base.js';
import type { ChatMessage, ChatOptions, StreamChunk, Provider } from '../core/types.js';

export class AnthropicProvider extends BaseProvider {
  name: Provider = 'anthropic';
  private client: Anthropic;

  constructor(config: { apiKey?: string; baseUrl?: string; model?: string } = {}) {
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    super({
      apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.model || 'claude-sonnet-4-20250514',
    });

    if (!apiKey) {
      throw new ProviderConfigError('Anthropic', 'API key is required. Set ANTHROPIC_API_KEY or pass apiKey.');
    }

    this.client = new Anthropic({
      apiKey,
      baseURL: config.baseUrl,
    });
  }

  private convertMessages(messages: ChatMessage[]): { system?: string; messages: Anthropic.MessageParam[] } {
    const systemMessage = messages.find((m) => m.role === 'system');
    const otherMessages = messages.filter((m) => m.role !== 'system');

    return {
      system: systemMessage?.content,
      messages: otherMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    };
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    try {
      const { system, messages: anthropicMessages } = this.convertMessages(messages);

      const response = await this.client.messages.create({
        model: this.defaultModel,
        max_tokens: options?.maxTokens || 4096,
        system,
        messages: anthropicMessages,
        temperature: options?.temperature ?? 0.7,
        stop_sequences: options?.stopSequences,
      });

      const textBlock = response.content.find((block) => block.type === 'text');
      return textBlock?.type === 'text' ? textBlock.text : '';
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new ProviderAPIError('Anthropic', error.message, error.status);
      }
      throw error;
    }
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    try {
      const { system, messages: anthropicMessages } = this.convertMessages(messages);

      const stream = this.client.messages.stream({
        model: this.defaultModel,
        max_tokens: options?.maxTokens || 4096,
        system,
        messages: anthropicMessages,
        temperature: options?.temperature ?? 0.7,
        stop_sequences: options?.stopSequences,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { content: event.delta.text, done: false };
        } else if (event.type === 'message_stop') {
          yield { content: '', done: true };
        }
      }
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new ProviderAPIError('Anthropic', error.message, error.status);
      }
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Simple check - try to create a minimal message
      await this.client.messages.create({
        model: this.defaultModel,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      return true;
    } catch {
      return false;
    }
  }
}
