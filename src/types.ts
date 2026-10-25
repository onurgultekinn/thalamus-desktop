// Shared application types — App and components import from here
// (the duplicate Message definition in App.tsx and ThalamusCopilot.tsx was unified).

import type { AttachedImage } from './lib/imageAttach';

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskQuestionOption[];
  multiple?: boolean;
  allowOther?: boolean;
}

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
  /** Ajan koşusu sırasında çağrılan araç adları (read_file, repo_map…).
   *  Akış sırasında canlı gösterilir; bitince geçmiş olarak kalır. */
  toolActivity?: string[];
  /** Akış yarıda kaldıysa sebep — cevap silinmez, küçük bir not düşülür. */
  stopped?: 'stop' | 'timeout' | 'error' | 'length';
  /**
   * Cevap akışla geldi: 260 px iç kaydırma kutusuna SIKIŞTIRILMAZ. Aksi halde
   * akış sırasında yeni metin kutunun dışında kalır ve bitişte balon aniden
   * küçülür (istenmeyen sıçrama).
   */
  streamed?: boolean;
  originalCodeSnippet?: string;
  compressedCodeSnippet?: string;
  metrics?: MessageMetrics;
  question?: AskQuestion;
  questionAnswer?: string;
  /**
   * Yerel motorun bu istekteki sıkıştırma bilançosu (backend `meta` olayı).
   * Yalnız gerçekten kazanç varsa gösterilir; uydurma yüzde yazılmaz.
   */
  engine?: { originalTokens: number; compressedTokens: number; compressedMessages?: number };
  /**
   * Vision attachments for this user message (kept so Regenerate can re-send
   * them). Session-only: stripped before writing to localStorage — data URLs
   * would blow the 5 MB quota — so a reloaded chat cannot regenerate vision.
   */
  images?: AttachedImage[];
  /**
   * Sağlayıcının bildirdiği GERÇEK token kullanımı (akışın `done` olayı).
   * Yoksa arayüz karakter/4 tahminine düşer — uydurma değer yazılmaz.
   */
  usage?: MessageUsage;
}

export interface MessageUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Saglayici prompt cache'inden karsilanan girdi token'i. */
  cachedTokens?: number;
  /** EVREN kredi bakiyesi snapshot'i ("1160.0000" gibi). */
  creditsRemaining?: string;
}

export interface ChatItem {
  id: string;
  title: string;
  /** Sabitlenen sohbetler listede önce gösterilir. */
  pinned?: boolean;
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
