import { type FormEvent, useState, useRef, useEffect } from 'react';
import {
  Paperclip, ArrowUp, FileCode, X, UploadCloud, ChevronUp, Square,
  RefreshCw, Check, Sparkles,
} from 'lucide-react';
import { prepareImageFile, DEFAULT_IMAGE_MODE, type AttachedImage, type ImageMode } from '../lib/imageAttach';
import { useT } from '../lib/i18n';
import { activeProviderStorageKey } from '../lib/providers';
import {
  connectionName,
  ensureConnectionsMigrated,
  isLocalBaseUrl,
  listConnections,
} from '../lib/connections';
import { modelChoices } from '../lib/models';
import { classifyTask } from '../lib/modelRouter';
import { getStoredKey } from '../lib/secrets';
import {
  buildLocalModelEntries,
  getCachedLocalScan,
  listServing,
  LOCAL_MODELS_EVENT,
  localEndpointsFresh,
  providerForBase,
  scanLocalModels,
  stopLocalModel,
  type LocalScan,
  type ModelFile,
} from '../lib/localModels';
import type { PreviewItem } from './FilePreviewDrawer';
import { LocalModelList } from './LocalModelList';
import { useToast } from './Toast';

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
  /** Ham baytlar — geniş format görüntüleyici (@file-viewer) için. */
  buffer?: ArrayBuffer;
  /** MIME türü (görüntüleyici yönlendirmesi + indirme). */
  mime?: string;
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
  /** Şu an kullanılan model id'si (sağlayıcı çözümlemesinden gelir). */
  currentModel: string;
  /** Sağlayıcı grubundaki bir modeli ANINDA seçer (sağlayıcı + model yazılır). */
  onSelectProviderModel: (providerId: string, modelId: string) => void;
  /** Gerçekte yanıtlayacak sağlayıcı · model (App çözer); boşsa anahtar yok. */
  activeModelLabel?: string;
  /** Etkin sağlayıcı; yerel model vurgusu için. */
  activeProviderId: string;
  /** Çalışan bir yerel uç noktayı etkin sağlayıcı yapar. */
  onUseLocalEndpoint: (provider: string, baseUrl: string, model: string) => void;
  /** Diskteki modeli başlatır ve etkin sağlayıcı yapar. */
  onActivateLocalFile: (file: ModelFile) => Promise<void>;
  images: AttachedImage[];
  setImages: React.Dispatch<React.SetStateAction<AttachedImage[]>>;
  /** Çipe tıklanınca önizlemeyi chat düzeninde (App) açar. */
  onOpenPreview?: (item: PreviewItem) => void;
  /** Gönderimde açık önizlemeyi kapatır (blob URL'ler serbest bırakılabilsin). */
  onClosePreview?: () => void;
}

export function CommandBar({
  input,
  loading,
  onSend,
  onStop,
  setInput,
  currentModel,
  onSelectProviderModel,
  activeModelLabel,
  activeProviderId,
  onUseLocalEndpoint,
  onActivateLocalFile,
  images,
  setImages,
  onOpenPreview,
  onClosePreview
}: CommandBarProps) {
  const t = useT();
  const { showToast } = useToast();
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [cloudGroups, setCloudGroups] = useState<
    { id: string; name: string; models: { id: string; label: string }[] }[]
  >([]);
  const [activeTab, setActiveTab] = useState<string>('');
  const [localScan, setLocalScan] = useState<LocalScan | null>(() => getCachedLocalScan());
  const [servers, setServers] = useState<Awaited<ReturnType<typeof listServing>>>([]);
  const [scanning, setScanning] = useState(false);
  const [scanFailed, setScanFailed] = useState(false);
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [imageMode] = useState<ImageMode>(DEFAULT_IMAGE_MODE);

  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Shared by the file-picker input and drag&drop → the exact same rules apply.
  // NOTE: nothing is written into the textarea; the file becomes a chip.
  const handleFile = async (file: File) => {
    // Yükleme paneli ekleme sonrası kapanır; yeniden açmak için tekrar basılır.
    setIsFileMenuOpen(false);
    const size = `${(file.size / 1024).toFixed(1)} KB`;

    const mime = file.type || '';

    if (mime.startsWith('image/')) {
      try {
        const attached = await prepareImageFile(file, imageMode);
        setImages(prev => [...prev, attached]);
      } catch {
        setUploadedFiles(prev => [...prev, { name: file.name, size, kind: 'binary', mime }]);
      }
      return;
    }

    // Çok büyük: önizleme yok, yalnız İndir.
    if (file.size > MAX_READ_BYTES) {
      setUploadedFiles(prev => [...prev, { name: file.name, size, kind: 'large', mime, url: URL.createObjectURL(file) }]);
      return;
    }

    const buffer = await file.arrayBuffer();

    // PDF ve medya: native/görüntüleyici önizlemesi (modele metin olarak gitmez).
    if (mime === 'application/pdf') {
      setUploadedFiles(prev => [...prev, { name: file.name, size, kind: 'pdf', mime, buffer, url: URL.createObjectURL(file) }]);
      return;
    }
    if (mime.startsWith('audio/')) {
      setUploadedFiles(prev => [...prev, { name: file.name, size, kind: 'audio', mime, buffer, url: URL.createObjectURL(file) }]);
      return;
    }
    if (mime.startsWith('video/')) {
      setUploadedFiles(prev => [...prev, { name: file.name, size, kind: 'video', mime, buffer, url: URL.createObjectURL(file) }]);
      return;
    }

    // Binary mi? (NUL taraması) — binary ise metin olarak çözmeyiz; görüntüleyici çizer.
    const probe = new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength));
    let binary = false;
    for (let i = 0; i < probe.length; i++) {
      if (probe[i] === 0) { binary = true; break; }
    }
    if (binary) {
      setUploadedFiles(prev => [...prev, { name: file.name, size, kind: 'binary', mime, buffer }]);
      return;
    }

    let text = new TextDecoder().decode(buffer);
    let truncated = false;
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS);
      truncated = true;
    }
    setUploadedFiles(prev => [...prev, { name: file.name, size, kind: truncated ? 'large' : 'text', mime, body: text }]);
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

  useEffect(() => {
    const refresh = () => {
      setLocalScan(getCachedLocalScan());
      void listServing().then(setServers);
    };
    window.addEventListener(LOCAL_MODELS_EVENT, refresh);
    return () => window.removeEventListener(LOCAL_MODELS_EVENT, refresh);
  }, []);

  const localFiles = localScan?.files ?? [];
  const localEndpoints = localScan?.endpoints ?? [];
  const localEntries = buildLocalModelEntries({
    endpoints: localEndpoints,
    files: localFiles,
    servers,
    activeProvider: activeProviderId,
    currentModel,
  });

  const refreshServers = async () => {
    setServers(await listServing());
  };

  const runLocalScan = async () => {
    if (scanning) return;
    setScanning(true);
    setScanFailed(false);
    try {
      setLocalScan(await scanLocalModels());
      setServers(await listServing());
    } catch {
      setScanFailed(true);
    } finally {
      setScanning(false);
    }
  };

  const loadCloudGroups = async () => {
    try {
      // Kullanıcı tanımlı bağlantılar: anahtarı olan ya da yerel URL'li her kayıt.
      await ensureConnectionsMigrated();
      const conns = listConnections().filter((c) => c.id !== 'managed');
      const withKeys = await Promise.all(
        conns.map(async (c) => ({ c, key: (await getStoredKey(c.id)).trim() })),
      );
      const groups = withKeys
        .filter((x) => x.key || isLocalBaseUrl(x.c.baseUrl))
        .map(({ c }) => ({ id: c.id, name: c.name, models: modelChoices(c.id) }))
        .filter((g) => g.models.length > 0);
      setCloudGroups(groups);
      // Sekme her zaman EN SON SEÇİLEN bağlantıyla açılır: durum (async)
      // çözülmeden önce bile doğru sekme görünsün diye kalıcı değer okunur.
      let lastId = activeProviderId;
      try {
        lastId = localStorage.getItem(activeProviderStorageKey) || activeProviderId;
      } catch { /* noop */ }
      const preferred = groups.some((g) => g.id === lastId)
        ? lastId
        : groups[0]?.id || 'local';
      setActiveTab(preferred);
    } catch {
      setCloudGroups([]);
      setActiveTab('local');
    }
  };

  const openModelMenu = () => {
    const next = !isModelMenuOpen;
    setIsModelMenuOpen(next);
    setIsFileMenuOpen(false);
    if (next) {
      setLocalScan(getCachedLocalScan());
      setScanFailed(false);
      void refreshServers();
      void loadCloudGroups();
      if (!localEndpointsFresh()) void runLocalScan();
    }
  };

  const selectCloudModel = (providerId: string, modelId: string) => {
    onSelectProviderModel(providerId, modelId);
    setIsModelMenuOpen(false);
  };

  const activeCloud = cloudGroups.find((g) => g.id === activeTab) || null;

  const selectEndpoint = (provider: string, baseUrl: string, model: string) => {
    onUseLocalEndpoint(provider, baseUrl, model);
    setIsModelMenuOpen(false);
  };

  const activateFile = async (file: ModelFile) => {
    const running = servers.find((s) => s.id === file.id || s.model === file.model);
    const served = running?.base_url || file.servedBy[0];
    if (served) {
      selectEndpoint(running ? 'managed' : providerForBase(served), served, file.model);
      return;
    }
    if (!file.servable || busyModel) return;
    setBusyModel(file.id);
    try {
      await onActivateLocalFile(file);
      await refreshServers();
      showToast(t('settings.localSelected'), file.label, 'info');
      setIsModelMenuOpen(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(t('settings.localStartFailed'), msg.slice(0, 300), 'error');
    } finally {
      setBusyModel(null);
    }
  };

  const stopServer = async (id: string) => {
    await stopLocalModel(id);
    await refreshServers();
  };

  const removeFile = (index: number) => {
    setUploadedFiles(prev => {
      const removed = prev[index];
      if (removed?.url) { try { URL.revokeObjectURL(removed.url); } catch {} }
      void removed;
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
    onClosePreview?.();
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

  // ÖNERİLEN MODEL — router'ın UI yüzü. Gömülü model adı yok: derin model
  // Ayarlar'da sağlayıcı başına girilir. Auto yalnız ÖNERİR; kullanıcı tek
  // tıkla geçer. Hızlı/Derin modu doğrudan uygulanır (App).
  const routerEnabled = (() => {
    try { return localStorage.getItem('tlm_router_enabled') === 'true'; } catch { return false; }
  })();
  const routerMode = (() => {
    try {
      const v = localStorage.getItem('tlm_router_mode');
      return v === 'fast' || v === 'deep' ? v : 'auto';
    } catch { return 'auto'; }
  })();
  const deepModel = (() => {
    try { return (localStorage.getItem('tlm_deep_model_' + activeProviderId) || '').trim(); } catch { return ''; }
  })();
  const structuredExts = new Set(['json','jsonl','csv','tsv','xml','yaml','yml','toml','ini','sql','ndjson','log']);
  const codeExts = new Set(['ts','tsx','js','jsx','py','rs','go','java','kt','c','h','cpp','hpp','cs','rb','php','swift','css','scss','html','vue','svelte','sh']);
  let hasStructuredData = false;
  let hasCodeFiles = false;
  for (const f of uploadedFiles) {
    if (f.kind !== 'text') continue;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (structuredExts.has(ext)) hasStructuredData = true;
    else if (codeExts.has(ext)) hasCodeFiles = true;
    else {
      const body = (f.body || '').trimStart();
      if (body.startsWith('{') || body.startsWith('[')) hasStructuredData = true;
    }
  }
  const task = classifyTask(hasStructuredData, hasCodeFiles);
  const recommendedModel =
    routerEnabled && deepModel && ((routerMode === 'auto' && task === 'data_analysis') || routerMode === 'deep')
      ? deepModel
      : null;
  const recommendedProviderName = connectionName(activeProviderId);
  const recommendedLabel = recommendedModel
    ? (modelChoices(activeProviderId).find((m) => m.id === recommendedModel)?.label || recommendedModel)
    : '';
  const recommendedReason =
    routerMode === 'deep' ? t('composer.recReasonMode') : t('composer.recReasonData');

  return (
    <div className="w-full max-w-[760px] mx-auto flex flex-col relative" ref={popoverRef}>
      
      {/* Model popover — sağlayıcı sekmeleri, altında o sağlayıcının modelleri. */}
      {isModelMenuOpen && (
        <div className="absolute bottom-full right-0 mb-2 z-50 flex w-[420px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-obsidian-border bg-obsidian-panel shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-150">
          <div className="flex items-center gap-1 overflow-x-auto border-b border-obsidian-border/60 p-1.5">
            <button
              type="button"
              onClick={() => setActiveTab('recommended')}
              className={`flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                activeTab === 'recommended'
                  ? 'bg-[#3AA99F]/15 text-[#9FD9D0] ring-1 ring-[#3AA99F]/35'
                  : 'text-obsidian-muted hover:text-obsidian-text'
              }`}
            >
              <Sparkles size={11} />
              {t('composer.tabRecommended')}
            </button>
            {cloudGroups.map((group) => (
              <button
                key={group.id}
                type="button"
                onClick={() => setActiveTab(group.id)}
                className={`flex-shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                  activeTab === group.id
                    ? 'bg-obsidian-button text-obsidian-text'
                    : 'text-obsidian-muted hover:text-obsidian-text'
                }`}
              >
                {group.name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setActiveTab('local')}
              className={`flex-shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                activeTab === 'local'
                  ? 'bg-obsidian-button text-obsidian-text'
                  : 'text-obsidian-muted hover:text-obsidian-text'
              }`}
            >
              {t('composer.tabLocal')}
            </button>
            {!activeCloud && (
              <button
                type="button"
                onClick={() => void runLocalScan()}
                disabled={scanning}
                title={t('settings.localScan')}
                className="ml-auto flex-shrink-0 cursor-pointer rounded-md p-1 text-[#87857F] transition-colors hover:bg-white/[0.06] hover:text-[#CECDC3] disabled:opacity-50"
              >
                <RefreshCw size={11} className={scanning ? 'animate-spin' : ''} />
              </button>
            )}
          </div>

          {activeTab === 'recommended' ? (
            <div className="p-2.5">
              {recommendedModel ? (
                <div className="rounded-lg border border-[#3AA99F]/30 bg-gradient-to-br from-[#3AA99F]/10 to-[#4385BE]/10 p-3">
                  <div className="flex items-center gap-2">
                    <Sparkles size={13} className="text-[#9FD9D0]" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[#F2F0E5]">
                      {recommendedLabel}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-[#A8A49E]">
                    {recommendedProviderName} · {recommendedReason}
                  </p>
                  <button
                    type="button"
                    disabled={recommendedModel === currentModel}
                    onClick={() => selectCloudModel(activeProviderId, recommendedModel)}
                    className="mt-2.5 w-full rounded-md bg-[#3AA99F]/20 px-2.5 py-1.5 text-[11.5px] font-medium text-[#BFE3DD] transition-colors hover:bg-[#3AA99F]/30 disabled:cursor-default disabled:opacity-60 cursor-pointer"
                  >
                    {recommendedModel === currentModel ? t('composer.recCurrent') : t('composer.recSwitch')}
                  </button>
                </div>
              ) : (
                <p className="px-1 py-2 text-[11px] leading-relaxed text-[#87857F]">
                  {t('composer.recSetup')}
                </p>
              )}
            </div>
          ) : activeCloud ? (
            <div className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto p-1.5">
              {activeCloud.models.map((model) => {
                const selected = activeProviderId === activeCloud.id && currentModel === model.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => selectCloudModel(activeCloud.id, model.id)}
                    title={model.id}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors cursor-pointer ${
                      selected ? 'bg-white/[0.05]' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <span
                      className={`min-w-0 flex-1 truncate text-[12px] font-medium ${
                        selected ? 'text-[#F2F0E5]' : 'text-[#CECDC3]'
                      }`}
                    >
                      {model.label}
                    </span>
                    {selected && <Check size={12} className="flex-shrink-0 text-[#3AA99F]" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-0 flex-col p-1.5">
              <LocalModelList
                entries={localEntries}
                scanning={scanning}
                scanFailed={scanFailed}
                busyKey={busyModel ? `file:${busyModel}` : null}
                onUse={(entry) => selectEndpoint(entry.provider, entry.baseUrl, entry.model)}
                onStart={(entry) => {
                  const file = localFiles.find((f) => `file:${f.id}` === entry.key);
                  if (file) void activateFile(file);
                }}
                onStop={(id) => void stopServer(id)}
                onScan={() => void runLocalScan()}
                className="max-h-[min(54vh,380px)] overflow-y-auto"
              />
            </div>
          )}
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

      <form onSubmit={(e) => { e.preventDefault(); submitWithFiles(); }} className="w-full bg-obsidian-panel border border-obsidian-border rounded-xl flex flex-col p-3 gap-2 shadow-2xl transition-all duration-200 focus-within:border-[#dcb67a]/40">
        {/* Attachment chips — the row sits just above the input; nothing is
            written into the textarea. Clicking a chip opens the right preview. */}
        {(uploadedFiles.length > 0 || images.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 pb-1">
            {images.map((img, idx) => (
              <div
                key={`img-${img.name}-${idx}`}
                className="group flex items-center gap-1.5 rounded-md border border-obsidian-border bg-obsidian-bg/60 pl-1 pr-1.5 py-1 cursor-pointer hover:border-[#dcb67a]/50 transition-colors"
                onClick={() => onOpenPreview?.({ name: img.name, kind: 'image', url: img.url })}
                title={img.name}
              >
                <img src={img.url} alt="" className="h-5 w-5 rounded object-cover border border-obsidian-border flex-shrink-0" />
                <span className="max-w-[140px] truncate text-[11px] text-obsidian-text">{img.name}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setImages(prev => prev.filter((_, i) => i !== idx)); }}
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
                onClick={() => onOpenPreview?.({ name: file.name, kind: file.kind, body: file.body, url: file.url, buffer: file.buffer, mime: file.mime, size: file.size })}
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
            {recommendedModel && recommendedModel !== currentModel && (
              <button
                type="button"
                onClick={() => selectCloudModel(activeProviderId, recommendedModel)}
                title={recommendedReason}
                className="flex items-center gap-1 rounded-md border border-[#3AA99F]/35 bg-[#3AA99F]/10 px-2 py-1 text-[10.5px] font-medium text-[#9FD9D0] transition-colors hover:bg-[#3AA99F]/20 cursor-pointer"
              >
                <Sparkles size={10} />
                <span className="truncate max-w-[130px]">
                  {t('composer.recChip', { model: recommendedLabel })}
                </span>
              </button>
            )}

            {/* D1/D8 güncel: seçici artık GERÇEK modeli belirler — ilk açılışta
                seçim sağlayıcı başına hatırlanır ve sohbet/ajan çağrıları bu
                modelle yapılır. Etiket, sağlayıcı çözümlemesinden gelir. */}
            <button
              type="button"
              title={
                activeModelLabel
                  ? t('composer.modelTooltipWith', { model: activeModelLabel })
                  : t('composer.modelTooltipWithout')
              }
              onClick={openModelMenu}
              className="flex items-center gap-1.5 bg-obsidian-button/40 border border-obsidian-border px-2.5 py-1 rounded-md text-obsidian-text text-[11px] cursor-pointer hover:bg-obsidian-button transition-colors font-medium"
            >
              {/* Saglayici anahtari yoksa bu GORUNUR uyari olur: kullanici
                  yazip gonderdikten sonra "no provider" hatasi almadan once
                  neyin eksik oldugunu bilir (eskiden yalniz tooltip'te idi). */}
              {activeModelLabel ? (
                // GERÇEKTE çağrılan model id'si gösterilir (uydurma etiket yok).
                <span className="truncate max-w-[170px]">
                  {currentModel || activeModelLabel.split(' · ').pop()}
                </span>
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