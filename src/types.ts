// Shared application types — App and components import from here
// (the duplicate Message definition in App.tsx and ThalamusCopilot.tsx was unified).

import type { AttachedImage } from './lib/imageAttach';

export interface MessageMetrics {
  originalTokens: number;
  compressedTokens: number;
  savingsPercentage: number;
  executionTimeMs: number;
  classId: number;
  cost: string;
  financialSavings: string;
  /**
   * D2: motor kayipsizlik dogrulamasini gercekten yapti mi?
   * veto_override ile zorlanan ciktilarda false. Eski kayitlarda
   * undefined olabilir (normal yol varsayilir).
   */
  losslessVerified?: boolean;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  modelName?: string;
  originalCodeSnippet?: string;
  compressedCodeSnippet?: string;
  metrics?: MessageMetrics;
  /**
   * Vision attachments for this user message (kept so Regenerate can re-send
   * them). Session-only: stripped before writing to localStorage — data URLs
   * would blow the 5 MB quota — so a reloaded chat cannot regenerate vision.
   */
  images?: AttachedImage[];
}

export interface ChatItem {
  id: string;
  title: string;
}

/** Subscription plan id — the registered plans live in the lib/plan.ts catalog. */
export type PlanId = 'free' | 'pro' | 'team';

/**
 * Local user profile. The plan field is optional: while the plan feature is
 * off it is never written and never shown in the UI (see lib/plan.ts).
 */
export interface User {
  name: string;
  email: string;
  role: 'user' | 'developer';
  plan?: PlanId;
  /** Data-URL avatar image, stored locally on this device. */
  avatar?: string;
}
