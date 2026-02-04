import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import { BaseProvider, ProviderConfigError, ProviderAPIError } from './base.js';
import type { ChatMessage, ChatOptions, StreamChunk, Provider } from '../core/types.js';

export class GoogleProvider extends BaseProvider {
  name: Provider = 'google';
  private client: GoogleGenerativeAI;
  private model: GenerativeModel;

  constructor(config: { apiKey?: string; model?: string } = {}) {
    const apiKey = config.apiKey || process.env.GOOGLE_API_KEY;
    super({
      apiKey,
      defaultModel: config.model || 'gemini-1.5-pro',
    });

    if (!apiKey) {
      throw new ProviderConfigError('Google', 'API key is required. Set GOOGLE_API_KEY or pass apiKey.');
    }

    this.client = new GoogleGenerativeAI(apiKey);
    this.model = this.client.getGenerativeModel({ model: this.defaultModel });
  }

  private convertMessages(messages: ChatMessage[]): { systemInstruction?: string; history: { role: string; parts: { text: string }[] }[]; lastMessage: string } {
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    
    // Google expects alternating user/model messages
    const history = conversationMessages.slice(0, -1).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const lastMessage = conversationMessages[conversationMessages.length - 1]?.content || '';

    return {
      systemInstruction: systemMessage?.content,
      history,
      lastMessage,
    };
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    try {
      const { systemInstruction, history, lastMessage } = this.convertMessages(messages);

      const model = this.client.getGenerativeModel({
        model: this.defaultModel,
        systemInstruction,
        generationConfig: {
          temperature: options?.temperature ?? 0.7,
          maxOutputTokens: options?.maxTokens,
          stopSequences: options?.stopSequences,
        },
      });

      const chat = model.startChat({ history });
      const result = await chat.sendMessage(lastMessage);
      
      return result.response.text();
    } catch (error) {
      throw new ProviderAPIError('Google', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    try {
      const { systemInstruction, history, lastMessage } = this.convertMessages(messages);

      const model = this.client.getGenerativeModel({
        model: this.defaultModel,
        systemInstruction,
        generationConfig: {
          temperature: options?.temperature ?? 0.7,
          maxOutputTokens: options?.maxTokens,
          stopSequences: options?.stopSequences,
        },
      });

      const chat = model.startChat({ history });
      const result = await chat.sendMessageStream(lastMessage);

      for await (const chunk of result.stream) {
        const text = chunk.text();
        yield { content: text, done: false };
      }
      
      yield { content: '', done: true };
    } catch (error) {
      throw new ProviderAPIError('Google', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.model.generateContent('Hi');
      return !!result.response;
    } catch {
      return false;
    }
  }
}
