// Single source of model definitions — CommandBar (selector) and App (pricing) feed from here.
export interface ModelOption {
  id: string;
  name: string;
  company: string;
  /** Base price in USD / token */
  pricePerToken: number;
}

// D8: kabaca GIRIS (input) fiyatlari, USD/token. Tahmini referanstir —
// UI'da "≈" ile gosterilir; provider'in guncel fatura fiyati degildir.
// (Claude 3.5 Sonnet ~$3/M, GPT-4o ~$2.50/M, DeepSeek V3 ~$0.27/M giris.)
export const MODELS: ModelOption[] = [
  { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', company: 'Anthropic', pricePerToken: 0.000003 },
  { id: 'gpt-4o', name: 'GPT-4o', company: 'OpenAI', pricePerToken: 0.0000025 },
  { id: 'deepseek-v3', name: 'DeepSeek V3', company: 'DeepSeek', pricePerToken: 0.00000027 },
];

export const DEFAULT_MODEL_NAME = MODELS[0].name;

export const MODEL_PRICING: Record<string, number> = Object.fromEntries(
  MODELS.map((m) => [m.name, m.pricePerToken])
);
