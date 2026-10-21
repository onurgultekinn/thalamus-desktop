import React from 'react';
import { MarkdownMessage } from './MarkdownMessage';

/**
 * Akış hâlindeki cevap için artımlı çizim.
 *
 * Kural (kullanıcı kararı): metin HER ZAMAN biçimli görünür — ham markdown
 * işaretleri hiç gösterilmez. Maliyeti sabit tutmak için cevap bloklara
 * bölünür: kapanmış bloklar dondurulur ve bir daha çizilmez (memo), yalnız
 * son blok (kuyruk) her karede yeniden çizilir.
 */
const FrozenBlock = React.memo(function FrozenBlock({ content }: { content: string }) {
  return <MarkdownMessage content={content} />;
});

/**
 * İçeriği "tamamlanmış bloklar" + "canlı kuyruk" olarak ayırır.
 * Blok sınırları: kapanmış ``` çiti veya boş satır (liste ortasında bölünmez).
 * Ekstra kopya/hash yok; tarama O(n) ve yalnız kuyruk yeniden çizilir.
 */
export function splitLiveBlocks(content: string): { frozen: string[]; tail: string } {
  const frozen: string[] = [];
  let start = 0;
  let i = 0;
  let inFence = false;
  while (i < content.length) {
    if (content.startsWith('```', i)) {
      if (!inFence) {
        inFence = true;
        i += 3;
        continue;
      }
      // Kapanış çiti: satır sonuna kadar blok tamamdır.
      const lineEnd = content.indexOf('\n', i);
      if (lineEnd < 0) break;
      frozen.push(content.slice(start, lineEnd));
      start = lineEnd + 1;
      i = start;
      inFence = false;
      continue;
    }
    if (!inFence && content[i] === '\n' && content[i + 1] === '\n') {
      const nextStart = i + 2;
      // Liste/numaralı liste öğeleri aynı blokta kalmalı.
      const rest = content.slice(nextStart, nextStart + 8);
      if (!/^\s*([-*+]|\d+[.)])\s/.test(rest)) {
        frozen.push(content.slice(start, i));
        start = nextStart;
        i = nextStart;
        continue;
      }
    }
    i++;
  }
  return { frozen: frozen.filter((block) => block.trim().length > 0), tail: content.slice(start) };
}

export const StreamingMessage: React.FC<{ content: string }> = ({ content }) => {
  const { frozen, tail } = splitLiveBlocks(content);
  return (
    <div className="tlm-streaming">
      {frozen.map((block, index) => (
        <FrozenBlock key={index} content={block} />
      ))}
      {tail.trim() ? (
        <MarkdownMessage content={tail} streaming />
      ) : (
        <span className="tlm-stream-dots" aria-hidden="true" />
      )}
    </div>
  );
};
