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
  /** İsteğin gerçekten sürdüğü süre (ms) — sohbet bloğunun sağ üstünde. */
  latencyMs?: number;
  /**
   * Modelin düşünme (reasoning) metni — destekleyen sağlayıcılarda gelir.
   * Arayüzde katlanabilir "Düşünme" bloğunda gösterilir; içerik ayrı tutulur.
   */
  reasoning?: string;
  /** Cevap hâlâ akıyor: ChatView artımlı (dondurulmuş blok + canlı kuyruk) çizer. */
  streaming?: boolean;
  /** Akış yarıda kaldıysa sebep — cevap silinmez, küçük bir not düşülür. */
  stopped?: 'stop' | 'timeout' | 'error';
  /**
   * Cevap akışla geldi: 260 px iç kaydırma kutusuna SIKIŞTIRILMAZ. Aksi halde
   * akış sırasında yeni metin kutunun dışında kalır ve bitişte balon aniden
   * küçülür (istenmeyen sıçrama).
   */
  streamed?: boolean;
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
