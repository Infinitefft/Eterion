export type CapabilityStatus = 'verified' | 'unknown' | 'unsupported';

export interface ModelCapabilities {
  textStreaming: CapabilityStatus;
  thinkingStreaming: CapabilityStatus;
  toolCalling: CapabilityStatus;
  parallelToolCalls: CapabilityStatus;
}

/** OpenAI-compatible 不代表 Tool/Thinking 行为兼容，未知能力不能默认开启。 */
export const DEFAULT_MODEL_CAPABILITIES: Readonly<ModelCapabilities> = {
  textStreaming: 'verified',
  thinkingStreaming: 'unknown',
  toolCalling: 'unknown',
  parallelToolCalls: 'unknown',
};
