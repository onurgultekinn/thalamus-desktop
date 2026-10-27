import { beforeEach, describe, expect, it } from 'vitest';
import { fold, searchChats } from '../src/lib/chatSearch';
import { cacheAwareHistory, planFileContext } from '../src/lib/contextPlan';
import type { ChatItem, Message } from '../src/types';

beforeEach(() => localStorage.clear());

function seedChat(chatId: string, messages: Partial<Message>[]) {
  localStorage.setItem(
    `thalamus_chat_messages_${chatId}`,
    JSON.stringify(messages.map((m) => ({ role: 'user', content: '', ...m })))
  );
}

describe('fold', () => {
  it('makes Turkish case and accent differences equal', () => {
    expect(fold('IŞIK')).toBe(fold('ışık'));
    expect(fold('IŞIK')).toBe('isik');
    expect(fold('GÖZLÜK')).toBe('gozluk');
  });

  it('leaves plain ASCII lowercased', () => {
    expect(fold('Hello World')).toBe('hello world');
  });
});

describe('searchChats', () => {
  const chats: ChatItem[] = [
    { id: 'c1', title: 'Motorsuz basınç' },
    { id: 'c2', title: 'Other chat' },
  ] as never;

  it('returns nothing for a blank query', () => {
    expect(searchChats('   ', chats)).toEqual([]);
  });

  it('finds a Turkish term regardless of case and accents', () => {
    seedChat('c1', [{ content: 'BASINÇ değeri yükseldi' }]);
    const hits = searchChats('basinc', chats);
    expect(hits).toHaveLength(1);
    expect(hits[0].chatId).toBe('c1');
    expect(hits[0].snippet).toContain('BASINÇ');
  });

  it('matches the chat title even without message hits', () => {
    seedChat('c2', [{ content: 'unrelated' }]);
    const hits = searchChats('motorsuz', chats);
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toBe('Motorsuz basınç');
  });

  it('returns no hit when nothing matches', () => {
    seedChat('c1', [{ content: 'abc' }]);
    seedChat('c2', [{ content: 'def' }]);
    expect(searchChats('zzz', chats)).toEqual([]);
  });

  it('tolerates corrupt stored JSON', () => {
    localStorage.setItem('thalamus_chat_messages_c1', '{not json');
    expect(() => searchChats('abc', chats)).not.toThrow();
  });
});

describe('planFileContext', () => {
  it('resends a file the first time and references it when unchanged', () => {
    const files = [{ name: 'a.ts', body: 'export const a = 1;\n' }];
    const first = planFileContext('chat1', 1, files);
    expect(first.blocks[0].body).toBe(files[0].body);
    expect(first.referenced).toEqual([]);

    const second = planFileContext('chat1', 2, files);
    expect(second.referenced).toEqual(['a.ts']);
    expect(second.avoidedChars).toBe(files[0].body.length);
    expect(second.blocks[0].body).toContain('DEĞİŞMEDİ');
  });

  it('resends when the file content changed', () => {
    planFileContext('chat2', 1, [{ name: 'a.ts', body: 'v1' }]);
    const next = planFileContext('chat2', 2, [{ name: 'a.ts', body: 'v2' }]);
    expect(next.referenced).toEqual([]);
    expect(next.resendReasons).toContain('a.ts: değişti');
    expect(next.blocks[0].body).toBe('v2');
  });

  it('resends once the file falls out of the history window', () => {
    planFileContext('chat3', 1, [{ name: 'a.ts', body: 'same' }]);
    const next = planFileContext('chat3', 1 + 7, [{ name: 'a.ts', body: 'same' }]);
    expect(next.referenced).toEqual([]);
    expect(next.resendReasons.join(' ')).toContain('bağlam penceresinden çıktı');
  });

  it('handles an empty file list', () => {
    const r = planFileContext('chat4', 1, []);
    expect(r.blocks).toEqual([]);
    expect(r.avoidedChars).toBe(0);
  });
});

describe('cacheAwareHistory', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ i }));
  const many = Array.from({ length: 40 }, (_, i) => ({ i }));

  it('returns the full list when it fits the keep window', () => {
    expect(cacheAwareHistory(msgs, 'h1')).toEqual(msgs);
  });

  it('drops to the recent window when the threshold is exceeded', () => {
    const out = cacheAwareHistory(many, 'h2');
    expect(out).toHaveLength(8);
    expect(out[out.length - 1].i).toBe(39);
  });

  it('shrinks further when the character budget is exceeded', () => {
    const big = Array.from({ length: 30 }, (_, i) => ({ i, size: 10_000 }));
    const out = cacheAwareHistory(big, 'h3', (m) => m.size);
    expect(out.length).toBeLessThanOrEqual(24);
    expect(out[out.length - 1].i).toBe(29);
  });

  it('is stable across calls for the same chat', () => {
    const a = cacheAwareHistory(many, 'h4');
    const b = cacheAwareHistory(many, 'h4');
    expect(b).toEqual(a);
  });
});
