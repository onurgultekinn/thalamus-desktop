/**
 * Sohbet araması: mesajlar localStorage'da sohbet başına ayrı anahtarda durur
 * (`thalamus_chat_messages_<id>`). Arama tüm sohbetleri tarar; büyük listelerde
 * UI'yi kilitlememek için sonuç sayısı sınırlıdır ve eşleşme başına kısa bir
 * bağlam parçası döner.
 */
import type { ChatItem, Message } from '../types';

export interface ChatSearchHit {
  chatId: string;
  chatTitle: string;
  messageIndex: number;
  role: 'user' | 'assistant';
  snippet: string;
  timestamp?: string;
}

const MAX_HITS = 40;
const SNIPPET_RADIUS = 46;

/**
 * Türkçe-duyarlı katlama: büyük/küçük harf ve aksan farkı aramayı bölmez
 * ("IŞIK" ≈ "isik" ≈ "ışık"). NFD ayrıştırma + birleşik işaret temizliği
 * Latin dışı harfleri de sadeleştirir.
 */
export function fold(s: string): string {
  return s
    .replace(/[İI]/g, 'i')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c');
}

function snippetAround(text: string, needle: string): string | null {
  const folded = fold(text);
  const at = folded.indexOf(needle);
  if (at === -1) return null;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + needle.length + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

function readMessages(chatId: string): Message[] {
  try {
    const raw = localStorage.getItem(`thalamus_chat_messages_${chatId}`);
    const parsed = raw ? (JSON.parse(raw) as Message[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Boş sorgu → boş sonuç (tüm sohbetleri listelemek için arama kullanılmaz). */
export function searchChats(query: string, chats: ChatItem[]): ChatSearchHit[] {
  const needle = fold(query.trim());
  if (!needle) return [];

  const hits: ChatSearchHit[] = [];
  for (const chat of chats) {
    // Başlık eşleşmesi sohbeti öne çıkarır: mesaj metni yoksa bile görünür.
    const titleMatch = fold(chat.title).includes(needle);
    const messages = readMessages(chat.id);
    let chatHasHit = false;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (typeof m.content !== 'string' || !m.content) continue;
      const snippet = snippetAround(m.content, needle);
      if (!snippet) continue;
      chatHasHit = true;
      hits.push({
        chatId: chat.id,
        chatTitle: chat.title,
        messageIndex: i,
        role: m.role,
        snippet,
        timestamp: m.timestamp,
      });
      if (hits.length >= MAX_HITS) return hits;
    }

    if (titleMatch && !chatHasHit) {
      hits.push({
        chatId: chat.id,
        chatTitle: chat.title,
        messageIndex: 0,
        role: 'user',
        snippet: chat.title,
      });
      if (hits.length >= MAX_HITS) return hits;
    }
  }
  return hits;
}
