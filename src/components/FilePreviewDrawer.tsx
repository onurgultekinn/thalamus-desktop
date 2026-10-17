import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { FileCode, X, Download, PictureInPicture2, ExternalLink } from 'lucide-react';
import { FileViewer } from '@file-viewer/react-full';
import { useT } from '../lib/i18n';
import { useFloatingPanel, FloatResizeHandle, FLOATING_CHROME } from './floating';

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

/** Ayrı bir pencere/pop-up'ta açar (blob URL ile). */
function openInWindow(item: PreviewItem) {
  const url = item.url ?? (item.buffer ? URL.createObjectURL(new Blob([item.buffer], item.mime ? { type: item.mime } : undefined)) : undefined);
  if (!url) return;
  // Tauri/WebView2'de window.open sistem tarayıcısına gider; tarayıcı önizlemesinde yeni sekme.
  window.open(url, '_blank', 'noopener,noreferrer,width=1000,height=760');
}

/**
 * Sağ tarafta açılan dosya önizleme çekmecesi.
 * Native dallar (görsel/ses/video/metin) hızlı; diğer tüm formatlar
 * (PDF, Office, arşiv, e-posta, veri, 3D, EPUB…) `@file-viewer` ile çizilir.
 * (PDF, ileride ayrı bir pdfjs görüntüleyiciye devredilecek — metin seçimi için.)
 */
export function FilePreviewDrawer({ item, onClose, inline = false }: { item: PreviewItem; onClose: () => void; inline?: boolean }) {
  const t = useT();
  const fv = useFloatingPanel('preview', { def: { x: 860, y: 90, w: 560, h: 560 }, minScale: 0.5 });
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

  // `inline`: chat düzeni içinde bir SÜTUN olarak render edilir (chat'i örtmez,
  // onu daraltır). Yüzen modda her zaman portal + fixed kullanılır.
  const node = (
    <div
      style={fv.floating ? fv.style : undefined}
      className={`bg-obsidian-panel flex flex-col ${
        fv.floating
          ? `relative ${FLOATING_CHROME}`
          : inline
            ? 'relative h-full w-full border-l border-obsidian-border'
            : 'fixed top-0 right-0 h-screen w-[560px] max-w-[94vw] border-l border-obsidian-border shadow-2xl z-[60]'
      }`}
    >
      {/* İçerik doğal boyutunda kalır ve tek parça ölçeklenir (zoom). */}
      <div style={fv.contentStyle}>
      <div
        onPointerDown={fv.floating ? fv.onDragStart : undefined}
        className={`flex items-center justify-between gap-2 px-3 py-2 border-b border-obsidian-border bg-[#1C1B1A] flex-shrink-0 ${fv.floating ? 'cursor-move' : ''}`}
      >
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
          <button
            type="button"
            onClick={() => openInWindow(item)}
            className="p-1 rounded cursor-pointer text-obsidian-muted hover:text-obsidian-text transition-colors"
            title={t('preview.openExternal')}
          >
            <ExternalLink size={15} />
          </button>
          <button
            type="button"
            onClick={fv.toggle}
            className={`p-1 rounded cursor-pointer transition-colors ${fv.floating ? 'text-[#4385BE] bg-[#4385BE]/15' : 'text-obsidian-muted hover:text-obsidian-text'}`}
            title={fv.floating ? t('float.dock') : t('float.undock')}
          >
            <PictureInPicture2 size={15} />
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
        ) : canUseViewer ? (
            <FileViewer
              url={viewerUrl}
              filename={item.name}
              options={{
                theme: 'dark',
                onDiagnostic: (d: unknown) => {
                  const w = window as unknown as { __fvDiag?: unknown[] };
                  (w.__fvDiag = w.__fvDiag || []).push(d);
                },
              }}
              onEvent={(e: unknown) => {
                const w = window as unknown as { __fvDiag?: unknown[] };
                (w.__fvDiag = w.__fvDiag || []).push({ event: e });
              }}
              style={{ width: '100%', height: '100%' }}
            />
        ) : (
          <p className="p-4 text-[12px] text-obsidian-muted leading-relaxed">
            {item.kind === 'large' ? t('composer.previewTooLarge') : t('composer.previewBinary')}
          </p>
        )}
      </div>
      </div>

      {fv.floating && <FloatResizeHandle onPointerDown={fv.onResizeStart} />}
    </div>
  );

  // Inline + docked: bulunduğu sütunda kalır (portal yok). Aksi halde viewport'a
  // sabitlenmek için portal kullanılır.
  if (inline && !fv.floating) return node;
  return createPortal(node, document.body);
}
