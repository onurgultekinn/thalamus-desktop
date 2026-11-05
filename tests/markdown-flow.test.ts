import { describe, expect, it } from 'vitest';
import { expandSingleLineTables } from '../src/components/MarkdownMessage';
import { splitLiveBlocks } from '../src/components/StreamingMarkdown';

describe('expandSingleLineTables', () => {
  it('hatalar.txt örneğini çok satırlı tabloya açar', () => {
    const src = 'Kapasite/verim karşılaştırması:\n| Sürüm | ~Token | Kapsam | |---|---|---| | Orijinal | 90 | temel | | Önceki "A" | 55 | temel (aynı) | | Bu sürüm | ~120 | temel + prosedür |';
    const out = expandSingleLineTables(src);
    expect(out).toContain('| Sürüm | ~Token | Kapsam |');
    expect(out).toContain('| --- | --- | --- |');
    expect(out).toContain('| Orijinal | 90 | temel |');
    expect(out).toContain('| Önceki "A" | 55 | temel (aynı) |');
    expect(out).not.toContain('|---|---|---| |');
  });

  it('çok satırlı tablolara dokunmaz', () => {
    const src = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(expandSingleLineTables(src)).toBe(src);
  });

  it('az hücreli düz metin satırlarını olduğu gibi bırakır', () => {
    const src = 'seçenekler: | a | b | gibi';
    expect(expandSingleLineTables(src)).toBe(src);
  });

  it('kod çiti içindeki örnek tabloyu yeniden yazmaz', () => {
    const src = 'Örnek:\n```text\n| a | b | |---|---| | 1 | 2 |\n```';
    expect(expandSingleLineTables(src)).toBe(src);
  });

  it('çit içindekilere dokunmaz, çit dışını açar', () => {
    const src = '```md\n| x | |---| |\n```\n| Sürüm | ~Token | Kapsam | |---|---|---| | Orijinal | 90 | temel |';
    const out = expandSingleLineTables(src);
    expect(out).toContain('| x | |---| |');
    expect(out).toContain('| Sürüm | ~Token | Kapsam |');
  });
});

describe('splitLiveBlocks', () => {
  it('boş satırlarda dondurur, kuyrukta kalır', () => {
    const { frozen, tail } = splitLiveBlocks('ilk paragraf.\n\nikinci paragraf');
    expect(frozen).toEqual(['ilk paragraf.']);
    expect(tail).toBe('ikinci paragraf');
  });

  it('kapanmış kod çitini blok olarak dondurur', () => {
    const { frozen, tail } = splitLiveBlocks('```js\nlet a = 1;\n```\nsonra yazı');
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toContain('```js');
    expect(tail).toBe('sonra yazı');
  });

  it('liste öğeleri önceki paragraftan ayrılmaz (aynı blokta kalır)', () => {
    const { frozen, tail } = splitLiveBlocks('giriş\n\n- bir\n- iki');
    expect(frozen).toEqual([]);
    expect(tail).toBe('giriş\n\n- bir\n- iki');
  });
});
