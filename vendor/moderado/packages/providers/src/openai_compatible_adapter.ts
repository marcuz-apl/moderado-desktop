import { NvidiaAdapter, NvidiaAdapterConfig } from './nvidia/nvidia_adapter.js';

export interface OpenAICompatibleAdapterConfig extends NvidiaAdapterConfig {
  providerId: string;
  providerName: string;
}

/** Shared OpenAI-compatible transport for OpenRouter, Agnes, and future providers. */
export class OpenAICompatibleAdapter extends NvidiaAdapter {
  constructor(config: OpenAICompatibleAdapterConfig) {
    super(config);
  }
}
