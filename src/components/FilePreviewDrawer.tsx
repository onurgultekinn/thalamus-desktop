import { useEffect, useMemo } from 'react';
import { FileCode, X, Download } from 'lucide-react';
import { FileViewer } from '@file-viewer/react';
import { useT } from '../lib/i18n';
import { FILE_VIEWER_OPTIONS } from '../lib/fileViewerSetup';

export interface PreviewItem {
  name: string;
  size?: string;
  /** Native dallanma için sınıf; geri kalanı @file-viewer'a gider. */
  kind: 'text' | 'binary' | 'large' | 'image' | 'pdf' | 'audio' | 'video';
  mime?: string;
  /** Metin içeriği (metin dallanması). */
  body?: string;
  /** Yerel önizleme URL'i (image/audio/video/pdf blob). */
  url?: string;
  /** @file-viewer için ham baytlar (office, arşiv, pdf, veri…). */
  buffer?: ArrayBuffer;
}

function triggerDownload(name: string, url?: string, buffer?: ArrayBuffer) {
  const href = url ?? (buffer ? URL.createObjectURL(new Blob([buffer])) : undefined);
  if (!href) return;
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // buffer'dan ürettiysek hemen serbest bırakma; tarayıcı indirmeyi başlattı.
}

/**
 * Sağ tarafta açılan dosya önizleme çekmecesi.
 * Native dallar (görsel/ses/video/metin) hızlı; diğer tüm formatlar
 * (PDF, Office, arşiv, e-posta, veri, 3D, EPUB…) `@file-viewer` ile çizilir.
 * (PDF, ileride ayrı bir pdfjs görüntüleyiciye devredilecek — metin seçimi için.)
 */
export function FilePreviewDrawer({ item, onClose }: { item: PreviewItem; onClose: () => void }) {
  const t = useT();
  const canUseViewer = useMemo(() => item.kind !== 'large' && (!!item.url || !!item.buffer), [item]);

  // @file-viewer `url` ile çalışır; buffer'dan blob URL üretip geçici olarak kullanırız.
  const viewerUrl = useMemo(() => {
    if (item.url) return item.url;
    if (item.buffer) return URL.createObjectURL(new Blob([item.buffer], item.mime ? { type: item.mime } : undefined));
    return undefined;
  }, [item]);
  useEffect(() => () => {
    // Yalnızca bizim ürettiğimiz blob'u serbest bırak.
    if (viewerUrl && !item.url) { try { URL.revokeObjectURL(viewerUrl); } catch { /* noop */ } }
  }, [viewerUrl, item.url]);

  return (
    <div className="fixed top-0 right-0 h-full w-[560px] max-w-[94vw] bg-obsidian-panel border-l border-obsidian-border shadow-2xl z-[60] flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-obsidian-border flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode size={14} className="text-obsidian-muted flex-shrink-0" />
          <span className="text-[12px] font-semibold text-obsidian-text truncate" title={item.name}>{item.name}</span>
          {item.size && <span className="text-[11px] text-obsidian-muted font-mono flex-shrink-0">{item.size}</span>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => triggerDownload(item.name, item.url, item.buffer)}
            className="flex items-center gap-1 rounded-md border border-obsidian-border px-2 py-1 text-[11px] text-obsidian-muted hover:text-obsidian-text hover:border-[#dcb67a]/50 cursor-pointer transition-colors"
            title={t('preview.download')}
          >
            <Download size={12} /> {t('preview.download')}
          </button>
          <button type="button" onClick={onClose} className="text-obsidian-muted hover:text-obsidian-text cursor-pointer p-1" title={t('common.close')}>
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto pretty-scrollbar">
        {item.kind === 'image' && item.url ? (
          <div className="p-3">
            <img src={item.url} alt={item.name} className="w-full rounded-md border border-obsidian-border" />
          </div>
        ) : item.kind === 'video' && item.url ? (
          <div className="p-3"><video src={item.url} controls className="w-full rounded-md border border-obsidian-border" /></div>
        ) : item.kind === 'audio' && item.url ? (
          <div className="p-3"><audio src={item.url} controls className="w-full" /></div>
        ) : item.body !== undefined ? (
          <pre className="p-3 text-[11.5px] leading-relaxed font-mono text-obsidian-text whitespace-pre-wrap break-words">{item.body}</pre>
        ) : item.kind === 'pdf' && item.url ? (
          /* Geçici: PDF şimdilik native görüntüleyici (Faz 2'de pdfjs ile
             metin seçimi + vurgulama için kendi görüntüleyicimize geçecek). */
          <iframe src={item.url} title={item.name} className="w-full h-full min-h-[70vh] border-0 bg-white" />
        ) : canUseViewer ? (
          <FileViewer
            url={viewerUrl}
            filename={item.name}
            type={item.mime}
            options={FILE_VIEWER_OPTIONS}
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <p className="p-4 text-[12px] text-obsidian-muted leading-relaxed">
            {item.kind === 'large' ? t('composer.previewTooLarge') : t('composer.previewBinary')}
          </p>
        )}
      </div>
    </div>
  );
}
