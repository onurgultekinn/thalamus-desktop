/**
 * Eski (binary) `.ppt` runtime'ı için stub.
 *
 * `@file-viewer/ppt` paketi açık kaynak değil: "Flyfish Public Watermarked
 * Runtime License v2" ile geliyor ve her render'da zorunlu filigran istiyor.
 * Dağıtılan pakette bu bağımlılığı hiç istemiyoruz. Vite alias'ı
 * `@file-viewer/ppt`'yi burada karşılar; böylece bir gün başka bir paket
 * dolaylı olarak ithal etse bile proprietary runtime pakete girmez.
 *
 * Desteklenen PowerPoint formatı `.pptx` (Apache-2.0 `@file-viewer/pptx`).
 */

export function createPptViewer(): never {
  throw new Error(
    'Eski .ppt formatı bu derlemede desteklenmiyor. Dosyayı .pptx olarak kaydedip yeniden açın.',
  );
}

export default { createPptViewer };
