import { type FormEvent, useState, useRef, useEffect } from 'react';
import { Paperclip, ArrowUp, FileCode, X, UploadCloud, ChevronUp, Square } from 'lucide-react';
import { MODELS } from '../constants';
import { prepareImageFile, DEFAULT_IMAGE_MODE, type AttachedImage, type ImageMode } from '../lib/imageAttach';
import { useT } from '../lib/i18n';

// Attachments must never dump raw bytes into the prompt. Images become a compact
// on-device measurement summary; binary files are noted but omitted; oversized
// text files are truncated.
const MAX_TEXT_CHARS = 200_000;
const MAX_READ_BYTES = 8 * 1024 * 1024;

export interface UploadedFile {
  name: string;
  size: string;
  /**
   * 'text' taşınabilir bağlam (modele gider). 'pdf'/'audio'/'video' yerel
   * önizleme (object URL) — modele metin olarak gönderilmez. 'binary'/'large'
   * yalnız not.
   */
  kind: 'text' | 'binary' | 'large' | 'pdf' | 'audio' | 'video';
  /** Metin dosyasının içeriği (modele görünmez bağlam olarak gider). */
  body?: string;
  /** pdf/audio/video için yerel önizleme URL'i (blob). */
  url?: string;
  /**
   * Eklenen dosya input'a YAZILMAZ (eski davranış prompt'u dosya metniyle
   * dolduruyordu). Dosyalar input üstünde çip olarak durur; çipe tıklayınca
   * sağda önizleme açılır; gönderimde modele `code_blocks` olarak gider.
   */
}

interface CommandBarProps {
  input: string;
  loading: boolean;
  onSend: (e: FormEvent, files?: { name: string; body: string }[]) => void;
  /** T2: istek sürerken gönder düğmesi Durdur'a döner ve fetch'i iptal eder. */
  onStop?: () => void;
  setInput: (value: string) => void;
  setTargetModel: (model: string) => void;
  targetModel: string;
  /** Gerçekte yanıtlayacak sağlayıcı · model (App çözer); boşsa anahtar yok. */
  activeModelLabel?: string;
  images: AttachedImage[];
  setImages: React.Dispatch<React.SetStateAction<AttachedImage[]>>;
}

export function CommandBar({
  input,
  loading,
  onSend,
  onStop,
  setInput,
  setTargetModel,
  targetModel,
  activeModelLabel,
  images,
  setImages
}: CommandBarProps) {
  const t = useT();
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [imageMode] = useState<ImageMode>(DEFAULT_IMAGE_MODE);
  /** Çipe tıklanınca sağda açılan önizleme. */
  const [preview, setPreview] = useState<{ name: string; kind: 'text' | 'binary' | 'large' | 'image' | 'pdf' | 'audio' | 'video'; body?: string; url?: string; size?: string } | null>(null);

  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Shared by the file-picker input and drag&drop → the exact same rules apply.
  // NOTE: nothing is written into the textarea; the file becomes a chip.
  const handleFile = async (file: File) => {
    // Yükleme paneli ekleme sonrası kapanır; yeniden açmak için tekrar basılır.
    setIsFileMenuOpen(false);
    const size = `${(file.size / 1024).toFixed(1)} KB`;

    if (file.type.startsWith('image/')) {
      try {
        const attached = await prepareImageFile(file, imageMode);
        setImages(prev => [...prev, attached]);
      } catch {
        setUploadedFiles(prev => [...prev, { name: file.name, size, kind: 'binary' }]);
      }
      return;
    }

    // PDF ve medya: tarayıcıda yerel olarak önizlenir (modele metin olarak gitmez).
    if (file.type === 'application/pdf') {
      setUploadedFiles(prev => [...prev, { name: file.name, size, kind: 'pdf', url: URL.createObjectURL(file) }]);
      return;
    }
    if (file.type.startsWith('audio/')) {
      setUploadedFiles(prev => [...prev, { name: file.name, size, kind: 'audio', url: URL.createObjectURL(file) }]);
      return;
    }
    if (file.type.startsWith('video/')) {
      setUploadedFiles(prev => [...prev, { name: file.name, size, kind: 'video', url: URL.createObjectURL(file) }]);
      return;
    }

    if (file.size > MAX_READ_BYTES) {
      setUploadedFiles(prev => [...prev, { name: file.name, size, kind: 'large' }]);
      return;
    }

    // Read as bytes first so binary files are never decoded into garbage text.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const probe = bytes.subarray(0, 1024);
    let binary = false;
    for (let i = 0; i < probe.length; i++) {
      if (probe[i] === 0) { binary = true; break; }
    }
    if (binary) {
      setUploadedFiles(prev => [...prev, { name: file.name, size, kind: 'binary' }]);
      return;
    }

    let text = new TextDecoder().decode(bytes);
    let truncated = false;
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS);
      truncated = true;
    }
    setUploadedFiles(prev => [...prev, {
      name: file.name,
      size,
      kind: truncated ? 'large' : 'text',
      body: truncated ? text : text,
    }]);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await handleFile(file);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await handleFile(file);
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
    }
  }, [input]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsModelMenuOpen(false);
        setIsFileMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const modelsData = MODELS.map((m) => ({ id: m.id, name: m.name, company: m.company }));

  const removeFile = (index: number) => {
    setUploadedFiles(prev => {
      const removed = prev[index];
      if (removed?.url) { try { URL.revokeObjectURL(removed.url); } catch {} }
      if (removed && preview?.name === removed.name) setPreview(null);
      return prev.filter((_, i) => i !== index);
    });
  };

  /** Metin dosyalarını modele gidecek görünmez bağlama çevirir. */
  const buildFileContext = () =>
    uploadedFiles
      .filter((f) => f.kind === 'text' && f.body)
      .map((f) => ({ name: f.name, body: f.body as string }));

  const submitWithFiles = () => {
    const files = buildFileContext();
    // Serbest bırak: yerel önizleme blob URL'leri artık gerekmiyor.
    uploadedFiles.forEach(f => { if (f.url) { try { URL.revokeObjectURL(f.url); } catch {} } });
    setUploadedFiles([]);
    setPreview(null);
    onSend({ preventDefault: () => {} } as unknown as FormEvent, files);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if ((input.trim() || images.length > 0 || uploadedFiles.length > 0) && !loading) {
        submitWithFiles();
      }
    }
  };

  return (
    <div className="w-full max-w-[760px] mx-auto flex flex-col relative" ref={popoverRef}>
      
      {/* Model Popover */}
      {isModelMenuOpen && (
        <div className="absolute bottom-full right-0 mb-2 bg-obsidian-panel border border-obsidian-border rounded-lg w-[220px] z-50 shadow-2xl p-1.5 flex flex-col gap-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150">
          {modelsData.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => {
                setTargetModel(model.name);
                setIsModelMenuOpen(false);
              }}
              className={`w-full flex items-center justify-between p-2 rounded text-left cursor-pointer transition-colors ${
                targetModel === model.name 
                  ? 'bg-obsidian-button border border-obsidian-border/50 text-obsidian-text' 
                  : 'text-obsidian-muted hover:bg-obsidian-button/40 hover:text-obsidian-text'
              }`}
            >
              <span className="text-[11px] font-medium">{model.name}</span>
              <span className="text-[11px] opacity-60 font-mono">{model.company}</span>
            </button>
          ))}
        </div>
      )}

      {/* File Popover */}
      {isFileMenuOpen && (
        <div className="absolute bottom-full left-0 mb-2 bg-obsidian-panel border border-obsidian-border rounded-lg w-[260px] z-50 shadow-2xl p-3 flex flex-col gap-2.5 animate-in fade-in slide-in-from-bottom-2 duration-150">
          <div className="flex items-center justify-between text-[11px] font-semibold text-obsidian-muted/60 tracking-wider uppercase">
            <span>{t('composer.uploadFile')}</span>
            <button type="button" onClick={() => setIsFileMenuOpen(false)} className="text-obsidian-muted hover:text-obsidian-text cursor-pointer">
              <X size={12} />
            </button>
          </div>
          
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            style={{ display: 'none' }} 
          />
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`border border-dashed rounded-md px-3 py-5 text-center flex flex-col items-center gap-1.5 cursor-pointer transition-colors ${
              isDragging
                ? 'border-[#dcb67a]/60 bg-[#dcb67a]/10'
                : 'border-obsidian-border bg-obsidian-bg/50 hover:border-[#dcb67a]/40 hover:bg-obsidian-bg'
            }`}
          >
            <UploadCloud size={18} className={isDragging ? 'text-[#dcb67a]' : 'text-obsidian-muted'} />
            <span className={`text-[12px] font-medium ${isDragging ? 'text-[#dcb67a]' : 'text-obsidian-text'}`}>
              {isDragging ? t('composer.releaseToAttach') : t('composer.uploadDrag')}
            </span>
            <span className="text-[10.5px] text-obsidian-muted/60">
              {t('composer.uploadHint')}
            </span>
          </div>

        </div>
      )}

      {/* Main Command Input Box */}
      {/* Preview drawer (right side) — opens when a chip is clicked. */}
      {preview && (
        <div className="fixed top-0 right-0 h-full w-[420px] max-w-[90vw] bg-obsidian-panel border-l border-obsidian-border shadow-2xl z-[60] flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-obsidian-border flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <FileCode size={13} className="text-obsidian-muted flex-shrink-0" />
              <span className="text-[12px] font-semibold text-obsidian-text truncate">{preview.name}</span>
              {preview.size && <span className="text-[11px] text-obsidian-muted font-mono flex-shrink-0">{preview.size}</span>}
            </div>
            <button type="button" onClick={() => setPreview(null)} className="text-obsidian-muted hover:text-obsidian-text cursor-pointer p-0.5" title={t('common.close')}>
              <X size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-auto pretty-scrollbar p-3">
            {preview.kind === 'image' && preview.url ? (
              <img src={preview.url} alt={preview.name} className="w-full rounded-md border border-obsidian-border" />
            ) : preview.kind === 'pdf' && preview.url ? (
              <iframe src={preview.url} title={preview.name} className="w-full h-full min-h-[70vh] rounded-md border border-obsidian-border bg-white" />
            ) : preview.kind === 'video' && preview.url ? (
              <video src={preview.url} controls className="w-full rounded-md border border-obsidian-border" />
            ) : preview.kind === 'audio' && preview.url ? (
              <audio src={preview.url} controls className="w-full" />
            ) : preview.body !== undefined ? (
              <pre className="text-[11.5px] leading-relaxed font-mono text-obsidian-text whitespace-pre-wrap break-words">{preview.body}</pre>
            ) : (
              <p className="text-[12px] text-obsidian-muted leading-relaxed">
                {preview.kind === 'large' ? t('composer.previewTooLarge') : t('composer.previewBinary')}
              </p>
            )}
          </div>
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); submitWithFiles(); }} className="w-full bg-obsidian-panel border border-obsidian-border rounded-xl flex flex-col p-3 gap-2 shadow-2xl transition-all duration-200 focus-within:border-[#dcb67a]/40">
        {/* Attachment chips — the row sits just above the input; nothing is
            written into the textarea. Clicking a chip opens the right preview. */}
        {(uploadedFiles.length > 0 || images.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 pb-1">
            {images.map((img, idx) => (
              <div
                key={`img-${img.name}-${idx}`}
                className="group flex items-center gap-1.5 rounded-md border border-obsidian-border bg-obsidian-bg/60 pl-1 pr-1.5 py-1 cursor-pointer hover:border-[#dcb67a]/50 transition-colors"
                onClick={() => setPreview({ name: img.name, kind: 'image', url: img.url })}
                title={img.name}
              >
                <img src={img.url} alt="" className="h-5 w-5 rounded object-cover border border-obsidian-border flex-shrink-0" />
                <span className="max-w-[140px] truncate text-[11px] text-obsidian-text">{img.name}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setImages(prev => prev.filter((_, i) => i !== idx)); if (preview?.name === img.name) setPreview(null); }}
                  className="text-obsidian-muted hover:text-rose-400 cursor-pointer p-0.5"
                  title={t('cop.removeImage')}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
            {uploadedFiles.map((file, idx) => (
              <div
                key={`file-${file.name}-${idx}`}
                className="group flex items-center gap-1.5 rounded-md border border-obsidian-border bg-obsidian-bg/60 pl-2 pr-1.5 py-1 cursor-pointer hover:border-[#dcb67a]/50 transition-colors"
                onClick={() => setPreview({ name: file.name, kind: file.kind, body: file.body, url: file.url, size: file.size })}
                title={file.name}
              >
                <FileCode size={12} className="text-obsidian-muted flex-shrink-0" />
                <span className="max-w-[180px] truncate text-[11px] font-mono text-obsidian-text">{file.name}</span>
                <span className="text-[10.5px] text-obsidian-muted font-mono flex-shrink-0">{file.size}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); removeFile(idx); }}
                  className="text-obsidian-muted hover:text-rose-400 cursor-pointer p-0.5"
                  title={t('common.remove')}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('composer.placeholder')}
          disabled={loading}
          rows={1}
          className="w-full border-none outline-none text-obsidian-text text-[13px] bg-transparent resize-none min-h-[24px] max-h-[180px] leading-relaxed font-sans placeholder-obsidian-muted/40"
        />

        {/* Toolbar area */}
        <div className="flex items-center justify-between border-t border-obsidian-border/50 pt-2 mt-0.5">
          <div className="flex items-center gap-3 text-[11px] text-obsidian-muted">
            <button 
              type="button" 
              onClick={() => {
                setIsFileMenuOpen(!isFileMenuOpen);
                setIsModelMenuOpen(false);
              }}
              className="flex items-center gap-1.5 text-obsidian-muted hover:text-obsidian-text cursor-pointer transition-colors text-[11px] font-sans"
            >
              <Paperclip size={12} />
              <span>{t('composer.uploadFile')}</span>
              {images.length > 0 && (
                <span className="text-[11px] text-[#dcb67a]">{t(images.length > 1 ? 'composer.imageMany' : 'composer.imageOne', { n: images.length })}</span>
              )}
            </button>
          </div>

          <div className="flex items-center gap-2">
            {/* D1/D8: bu secici bir MALIYET TAHMIN referansidir; metin sohbeti
                AKTIF SAGLAYICININ modelini cagirir (faturalandirilir). Eski ipucu
                "hic model API cagrilmaz" diyordu — YANLISTI (kullanici yerel/
                ucretsiz sanip faturalandirilabiliyordu). Gercek model adi
                App'ten 'activeModelLabel' olarak gelir. */}
            <button
              type="button"
              title={
                activeModelLabel
                  ? t('composer.modelTooltipWith', { model: activeModelLabel })
                  : t('composer.modelTooltipWithout')
              }
              onClick={() => {
                setIsModelMenuOpen(!isModelMenuOpen);
                setIsFileMenuOpen(false);
              }}
              className="flex items-center gap-1.5 bg-obsidian-button/40 border border-obsidian-border px-2.5 py-1 rounded-md text-obsidian-text text-[11px] cursor-pointer hover:bg-obsidian-button transition-colors font-medium"
            >
              {/* Saglayici anahtari yoksa bu GORUNUR uyari olur: kullanici
                  yazip gonderdikten sonra "no provider" hatasi almadan once
                  neyin eksik oldugunu bilir (eskiden yalniz tooltip'te idi). */}
              {activeModelLabel ? (
                <span>≈ {targetModel}</span>
              ) : (
                <span className="flex items-center gap-1 text-[#dcb67a]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#dcb67a]" />
                  {t('composer.noModelKey')}
                </span>
              )}
              <ChevronUp 
                size={11} 
                className={`text-obsidian-muted transition-transform duration-150 ${isModelMenuOpen ? 'rotate-180' : ''}`} 
              />
            </button>

            {/* Send arrow — while a request is in flight it turns into Stop */}
            {loading && onStop ? (
              <button
                type="button"
                onClick={onStop}
                className="flex items-center justify-center w-6 h-6 bg-[#D14D41] hover:bg-[#E0685C] text-white rounded-md cursor-pointer transition-all"
                title={t('composer.stop')}
              >
                <Square size={9} strokeWidth={0} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={loading || (!input.trim() && images.length === 0)}
                className="flex items-center justify-center w-6 h-6 bg-obsidian-text text-obsidian-bg rounded-md cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed hover:bg-obsidian-text/90 transition-all"
                title={t('composer.send')}
              >
                <ArrowUp size={12} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}