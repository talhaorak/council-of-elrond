import { BaseProvider, ProviderAPIError } from './base.js';
import type { ChatMessage, ChatOptions, StreamChunk, Provider } from '../core/types.js';

/**
 * LM Studio provider using OpenAI-compatible API
 */
export class LMStudioProvider extends BaseProvider {
  name: Provider = 'lmstudio';
  private lmStudioUrl: string;

  constructor(config: { baseUrl?: string; model?: string } = {}) {
    const baseUrl = config.baseUrl || process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234';
    super({
      baseUrl,
      defaultModel: config.model || 'local-model', // LM Studio uses the loaded model
    });

    this.lmStudioUrl = baseUrl;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    try {
      const response = await fetch(`${this.lmStudioUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.defaultModel,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens || 4096,
          stop: options?.stopSequences,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as {
        choices: { message: { content: string } }[];
      };
      
      return data.choices[0]?.message?.content || '';
    } catch (error) {
      throw new ProviderAPIError('LMStudio', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamChunk> {
    try {
      const response = await fetch(`${this.lmStudioUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.defaultModel,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens || 4096,
          stop: options?.stopSequences,
          stream: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let hasEmittedDone = false;

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          if (!hasEmittedDone) {
            hasEmittedDone = true;
            yield { content: '', done: true };
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            if (!hasEmittedDone) {
              hasEmittedDone = true;
              yield { content: '', done: true };
            }
            return;
          }

          try {
            const parsed = JSON.parse(data) as {
              choices: { delta: { content?: string }; finish_reason?: string }[];
            };
            const content = parsed.choices[0]?.delta?.content || '';
            const isDone = parsed.choices[0]?.finish_reason !== null && 
                          parsed.choices[0]?.finish_reason !== undefined;
            
            if (content) {
              yield { content, done: false };
            }
            
            if (isDone && !hasEmittedDone) {
              hasEmittedDone = true;
              yield { content: '', done: true };
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } catch (error) {
      throw new ProviderAPIError('LMStudio', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.lmStudioUrl}/v1/models`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models from LM Studio
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.lmStudioUrl}/v1/models`);
      if (!response.ok) return [];
      
      const data = await response.json() as { data: { id: string }[] };
      return data.data.map((m) => m.id);
    } catch {
      return [];
    }
  }
}
