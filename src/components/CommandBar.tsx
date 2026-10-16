import { type FormEvent, useState, useRef, useEffect } from 'react';
import { Paperclip, ArrowUp, FileCode, X, UploadCloud, ChevronUp, Square } from 'lucide-react';
import { MODELS } from '../constants';
import { prepareImageFile, IMAGE_MODE_ORDER, imageModeLabel, imageModeHint, DEFAULT_IMAGE_MODE, type AttachedImage, type ImageMode } from '../lib/imageAttach';

// Attachments must never dump raw bytes into the prompt. Images become a compact
// on-device measurement summary; binary files are noted but omitted; oversized
// text files are truncated.
const MAX_TEXT_CHARS = 200_000;
const MAX_READ_BYTES = 8 * 1024 * 1024;

interface UploadedFile {
  name: string;
  size: string;
  /** Operand injected into the textarea for this file; removed on delete. */
  injected?: string;
}

interface CommandBarProps {
  input: string;
  loading: boolean;
  onSend: (e: FormEvent) => void;
  /** T2: istek sürerken gönder düğmesi Durdur'a döner ve fetch'i iptal eder. */
  onStop?: () => void;
  setInput: (value: string) => void;
  setTargetModel: (model: string) => void;
  targetModel: string;
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
  images,
  setImages
}: CommandBarProps) {
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [imageMode, setImageMode] = useState<ImageMode>(DEFAULT_IMAGE_MODE);

  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Shared by the file-picker input and drag&drop → the exact same rules apply.
  const handleFile = async (file: File) => {
    const size = `${(file.size / 1024).toFixed(1)} KB`;

    if (file.type.startsWith('image/')) {
      try {
        const attached = await prepareImageFile(file, imageMode);
        setImages(prev => [...prev, attached]);
      } catch {
        setUploadedFiles(prev => [...prev, { name: `${file.name} (image — could not be read)`, size }]);
      }
      return;
    }

    if (file.size > MAX_READ_BYTES) {
      const injected = `\n\n--- @${file.name} (${size}) ---\n[skipped — file is too large to attach]\n`;
      setUploadedFiles(prev => [...prev, { name: file.name, size, injected }]);
      setInput(input + injected);
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
      const injected = `\n\n--- @${file.name} (binary, ${size}) ---\n[contents omitted — binary file]\n`;
      setUploadedFiles(prev => [...prev, { name: file.name, size, injected }]);
      setInput(input + injected);
      return;
    }

    let text = new TextDecoder().decode(bytes);
    let truncated = false;
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS);
      truncated = true;
    }
    const injected = `\n\n--- @${file.name} ---\n${text}${truncated ? '\n[truncated — file too large]' : ''}\n`;
    setUploadedFiles(prev => [...prev, { name: file.name, size, injected }]);
    setInput(input + injected);
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
      const file = prev[index];
      // Chip removal must also remove the injected operand from the input.
      if (file?.injected) setInput(input.split(file.injected).join(''));
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !loading) {
        onSend(e as unknown as FormEvent);
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
            <span>Context Files</span>
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
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              {IMAGE_MODE_ORDER.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setImageMode(m)}
                  title={imageModeHint(m)}
                  className={`flex-1 rounded-md border px-1.5 py-1 text-[11px] transition-colors cursor-pointer ${
                    imageMode === m
                      ? 'border-[#dcb67a]/50 bg-[#dcb67a]/10 text-[#dcb67a]'
                      : 'border-obsidian-border text-obsidian-muted hover:text-obsidian-text'
                  }`}
                >
                  {imageModeLabel(m)}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-obsidian-muted/70">Image: {imageModeHint(imageMode)}</span>
          </div>
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`border border-dashed rounded-md p-3 text-center flex flex-col items-center gap-1 cursor-pointer transition-colors ${
              isDragging
                ? 'border-[#dcb67a]/60 bg-[#dcb67a]/10'
                : 'border-obsidian-border bg-obsidian-bg/50 hover:border-obsidian-muted/40'
            }`}
          >
            <UploadCloud size={14} className={isDragging ? 'text-[#dcb67a]' : 'text-obsidian-muted'} />
            <span className={`text-[11px] ${isDragging ? 'text-[#dcb67a]' : 'text-obsidian-muted'}`}>
              {isDragging ? 'Release to attach' : 'Upload or drag dataset'}
            </span>
          </div>

          <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto">
            {images.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pb-1">
                {images.map((img, idx) => (
                  <div key={`${img.name}-${idx}`} className="relative">
                    <img
                      src={img.url}
                      alt={img.name}
                      title={`${img.name} · ${img.width}×${img.height} · detail:${img.detail} · ${img.reason}${img.visionDiag ? ' · ' + img.visionDiag : ''}\n${img.options.map((o) => `${o.label}: ${Math.round(o.ratio * 100)}% · ≈${o.tokens} tok · ${o.retention}% detail`).join('\n')}`}
                      className="h-12 w-12 rounded-md object-cover border border-obsidian-border"
                    />
                    <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded bg-obsidian-panel/90 px-1 text-[8.5px] font-mono text-[#dcb67a] whitespace-nowrap">
                      ≈{img.estTokens} · %{img.retention}
                    </span>
                    <button
                      type="button"
                      onClick={() => setImages(prev => prev.filter((_, i) => i !== idx))}
                      className="absolute -top-1.5 -right-1.5 bg-obsidian-panel border border-obsidian-border rounded-full p-0.5 text-obsidian-muted hover:text-rose-400 cursor-pointer"
                      title="Remove image"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {images.length > 0 && (() => {
              const last = images[images.length - 1];
              return (
                <div className="rounded-md border border-obsidian-border bg-obsidian-bg/40 p-2 flex flex-col gap-0.5">
                  <span className="text-[11px] text-obsidian-muted/70 truncate">{last.name} — mode comparison</span>
                  {last.options.map((o) => (
                    <div key={o.mode} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className={o.mode === last.chosenMode ? 'text-[#dcb67a]' : 'text-obsidian-muted'}>
                        {o.mode === last.chosenMode ? '●' : '○'} {o.label}
                        {o.mode === 'economy' && last.textLike && (
                          <span title="This image looks like text/UI — low detail may hurt legibility"> ⚠</span>
                        )}
                      </span>
                      <span className="font-mono text-obsidian-muted whitespace-nowrap">
                        {Math.round(o.ratio * 100)}% · ≈{o.tokens} tok · {o.retention}% detail
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
            {uploadedFiles.map((file, idx) => (
              <div key={idx} className="flex items-center justify-between p-1.5 bg-obsidian-bg border border-obsidian-border rounded text-[11px]">
                <div className="flex items-center gap-2 min-w-0">
                  <FileCode size={12} className="text-obsidian-muted" />
                  <span className="text-obsidian-text truncate font-mono">{file.name}</span>
                </div>
                <button type="button" onClick={() => removeFile(idx)} className="text-obsidian-muted hover:text-rose-400 cursor-pointer p-0.5">
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Command Input Box */}
      <form onSubmit={onSend} className="w-full bg-obsidian-panel border border-obsidian-border rounded-xl flex flex-col p-3 gap-2 shadow-2xl transition-all duration-200 focus-within:border-[#dcb67a]/40">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a prompt to the compression engine..."
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
              <span>Attach</span>
              {images.length > 0 && (
                <span className="text-[11px] text-[#dcb67a]">{images.length} image{images.length > 1 ? 's' : ''}</span>
              )}
            </button>
          </div>

          <div className="flex items-center gap-2">
            {/* D1/D8: bu secici bir MALIYET TAHMIN referansidir. Metin
                sayfagi model CAGIRMAZ (yerel sikistirma motoru); ≈ ve title
                ile bu durustce belirtilir. */}
            <button
              type="button"
              title="Cost-estimate reference only. Text chat runs on the local compression engine and calls no model API; this choice only changes the ≈ cost figures."
              onClick={() => {
                setIsModelMenuOpen(!isModelMenuOpen);
                setIsFileMenuOpen(false);
              }}
              className="flex items-center gap-1.5 bg-obsidian-button/40 border border-obsidian-border px-2.5 py-1 rounded-md text-obsidian-text text-[11px] cursor-pointer hover:bg-obsidian-button transition-colors font-medium"
            >
              <span>≈ {targetModel}</span>
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
                title="Stop request"
              >
                <Square size={9} strokeWidth={0} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={loading || (!input.trim() && images.length === 0)}
                className="flex items-center justify-center w-6 h-6 bg-obsidian-text text-obsidian-bg rounded-md cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed hover:bg-obsidian-text/90 transition-all"
                title="Send Command"
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