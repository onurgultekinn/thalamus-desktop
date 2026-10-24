/**
 * @file-viewer (flyfish-dev/file-viewer) yapılandırması.
 *
 * Taban: `preset-standard` (PDF, Office, OFD, arşiv, e-posta, görsel,
 * ses/video, metin). Üzerine yalnızca **Apache-2.0** lisanslı ek renderer'lar
 * eklenir:
 *   drawing (Mermaid/PlantUML), typst, mindmap, data (PSD/SQLite/Parquet),
 *   epub, geo (GeoJSON/KML/Shapefile), hangul (HWPX), iwork, wordperfect,
 *   chm, eda.
 *
 * Bilerek DIŞARIDA:
 *   - CAD (`@flyfish-dev/cad-viewer`, `dwf-viewer`) → AGPL-3.0/GPL-3.0.
 *   - 3D/STEP (`@file-viewer/renderer-3d` → `occt-import-js`) → LGPL-2.1.
 *   - Eski binary `.ppt` (`@file-viewer/ppt`) → proprietary, zorunlu filigran.
 *   - drawio resmi entegrasyonu (`capability-drawio-official`) → drawio
 *     varlıkları Atlassian kısıtlı lisansta. Mermaid/PlantUML alternatifi var.
 *
 * Offline: worker/wasm/font asset'leri `@file-viewer/assets-*` paketlerinden
 * `public/file-viewer/` altına kopyalanır (scripts/copy-file-viewer-assets.mjs);
 * asset yolları bu köke bakar.
 */
import type { FileViewerOptions } from '@file-viewer/core';
import { registerFileViewerAutoRendererPreset } from '@file-viewer/core';
import standardRenderers, {
  createFullAssetOptions,
  getDefaultFullAssetBaseUrl,
  setDefaultFullAssetBaseUrl,
} from '@file-viewer/preset-standard';
import { drawingRenderer } from '@file-viewer/renderer-drawing';
import { typstRenderer } from '@file-viewer/renderer-typst';
import { mindmapRenderer } from '@file-viewer/renderer-mindmap';
import { dataRenderer } from '@file-viewer/renderer-data';
import { ebookRenderer } from '@file-viewer/renderer-epub';
import { geoRenderer } from '@file-viewer/renderer-geo';
import { hangulRenderer } from '@file-viewer/renderer-hangul';
import { iworkRenderer } from '@file-viewer/renderer-iwork';
import { wordPerfectRenderer } from '@file-viewer/renderer-wordperfect';
import { chmRenderer } from '@file-viewer/renderer-chm';
import { edaRenderer } from '@file-viewer/renderer-eda';

/** Asset kökü; asset'ler buraya kopyalanır (bkz. scripts + public/file-viewer). */
export const FILE_VIEWER_ASSET_BASE = '/file-viewer/';

// Varsayılan asset kökünü bizim public dizinine sabitle.
setDefaultFullAssetBaseUrl(FILE_VIEWER_ASSET_BASE);

/**
 * Tümü Apache-2.0 olan renderer'lardan oluşan genişletilmiş preset.
 * `preset-all` bilerek kullanılmıyor: o preset CAD/3D/legacy-PPT'yi de çeker.
 */
export const thalamusRenderers = {
  id: 'thalamus-preset',
  label: 'Thalamus standard + license-safe extras',
  renderers: [
    ...standardRenderers.renderers,
    drawingRenderer,
    typstRenderer,
    mindmapRenderer,
    dataRenderer,
    ebookRenderer,
    geoRenderer,
    hangulRenderer,
    iworkRenderer,
    wordPerfectRenderer,
    chmRenderer,
    edaRenderer,
  ],
};

// Otomatik renderer eşleşmesi (dosya adı/uzantı) bu preset üzerinden çalışsın.
registerFileViewerAutoRendererPreset(thalamusRenderers as never, {
  id: 'thalamus',
  packageName: 'thalamus-desktop',
});

/** `<FileViewer options={...} />` için tam seçenekler. */
export const FILE_VIEWER_OPTIONS = {
  preset: thalamusRenderers,
  rendererMode: 'replace',
  autoRenderers: true,
  theme: 'dark',
  ...createFullAssetOptions(getDefaultFullAssetBaseUrl()),
} as unknown as FileViewerOptions;
