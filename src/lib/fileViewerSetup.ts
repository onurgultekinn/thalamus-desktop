/**
 * @file-viewer (flyfish-dev/file-viewer) yapılandırması.
 *
 * `preset-standard` kullanıyoruz: PDF, Office (docx/xlsx/pptx), OFD, arşiv,
 * e-posta, görsel, ses/video, metin/kod. **CAD içermez** (CAD runtime'ı
 * `@flyfish-dev/cad-viewer`/`dwf-viewer` AGPL-3.0 olduğundan ticari kapalı-kaynak
 * uygulamada paketlenemez). `preset-all`/`preset-engineering` bu yüzden KULLANILMAZ.
 *
 * Offline: worker/wasm/font asset'leri `@file-viewer/assets-*` paketlerinden
 * `public/file-viewer/` altına kopyalanır (scripts/copy-file-viewer-assets.mjs);
 * asset yolları bu köke bakar.
 */
import type { FileViewerOptions } from '@file-viewer/core';
import standardRenderers, {
  createFullAssetOptions,
  getDefaultFullAssetBaseUrl,
  setDefaultFullAssetBaseUrl,
} from '@file-viewer/preset-standard';

/** Asset kökü; asset'ler buraya kopyalanır (bkz. scripts + public/file-viewer). */
export const FILE_VIEWER_ASSET_BASE = '/file-viewer/';

// Varsayılan asset kökünü bizim public dizinine sabitle.
setDefaultFullAssetBaseUrl(FILE_VIEWER_ASSET_BASE);

/** `<FileViewer options={...} />` için tam seçenekler. */
export const FILE_VIEWER_OPTIONS = {
  preset: standardRenderers,
  rendererMode: 'replace',
  autoRenderers: true,
  theme: 'dark',
  ...createFullAssetOptions(getDefaultFullAssetBaseUrl()),
} as unknown as FileViewerOptions;
