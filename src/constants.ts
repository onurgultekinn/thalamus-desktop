// Single source of model definitions — CommandBar (selector) and App (pricing) feed from here.
export interface ModelOption {
  id: string;
  name: string;
  company: string;
  /** Base price in USD / token */
  pricePerToken: number;
}

export const MODELS: ModelOption[] = [
  { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', company: 'Anthropic', pricePerToken: 0.000003 },
  { id: 'gpt-4o', name: 'GPT-4o', company: 'OpenAI', pricePerToken: 0.000005 },
  { id: 'deepseek-v3', name: 'DeepSeek V3', company: 'DeepSeek', pricePerToken: 0.0000005 },
];

export const DEFAULT_MODEL_NAME = MODELS[0].name;

export const MODEL_PRICING: Record<string, number> = Object.fromEntries(
  MODELS.map((m) => [m.name, m.pricePerToken])
);
