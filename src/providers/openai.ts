import OpenAI from 'openai';
import { BaseProvider, ProviderConfigError, ProviderAPIError } from './base.js';
import type { ChatMessage, ChatOptions, StreamChunk, Provider } from '../core/types.js';

export class OpenAIProvider extends BaseProvider {
  name: Provider = 'openai';
  private client: OpenAI;

  constructor(config: { apiKey?: string; baseUrl?: string; model?: string } = {}) {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    super({
      apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.model || 'gpt-4o',
    });

    if (!apiKey) {
      throw new ProviderConfigError('OpenAI', 'API key is required. Set OPENAI_API_KEY or pass apiKey.');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseUrl,
    });
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.defaultModel,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens,
        stop: options?.stopSequences,
      });

      return response.choices[0]?.message?.content || '';
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        throw new ProviderAPIError('OpenAI', error.message, error.status);
      }
      throw error;
    }
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    try {
      const stream = await this.client.chat.completions.create({
        model: this.defaultModel,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens,
        stop: options?.stopSequences,
        stream: true,
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        const done = chunk.choices[0]?.finish_reason !== null;
        
        if (content || done) {
          yield { content, done };
        }
      }
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        throw new ProviderAPIError('OpenAI', error.message, error.status);
      }
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
