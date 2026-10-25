import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react';
import { ts } from './lib/format';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { ProjectDashboard } from './components/ProjectDashboard';
import { CommandBar } from './components/CommandBar';
import { FilePreviewDrawer, type PreviewItem } from './components/FilePreviewDrawer';
import type { AttachedImage } from './lib/imageAttach';
import { ChatView } from './components/ChatView';
import { useThalamus } from './hooks/useThalamus';
import { SettingsModal } from './components/SettingsModal';
import { NucleusCommand } from './components/NucleusCommand';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { AuthScreen } from './components/auth/AuthScreen';
import { useToast } from './components/Toast';
import { API_BASE } from './services/ThalamusClient';
import { aiChat, aiChatStream, userMessage, getActiveProvider } from './services/aiClient';
import { setProviderModel } from './lib/models';
import {
  LOCAL_LOADING_EVENT,
  LOCAL_MODELS_EVENT,
  clearPendingLocalModel,
  getCachedLocalScan,
  getPendingLocalModel,
  isLocalProvider,
  listServing,
  localEndpointsFresh,
  normalizeBaseUrl,
  providerForBase,
  scanLocalModels,
  serveLocalModel,
  setPendingLocalModel,
  stopLocalModel,
  type ModelFile,
} from './lib/localModels';
import { activeProviderStorageKey, baseStorageKey } from './lib/providers';
import { connectionName, upsertConnection } from './lib/connections';
import { getWorkspaceName, getWorkspaceRoot, openProject, pruneRecentProjects, rememberProject } from './lib/workspace';
import { planFileContext, addSavings, loadSavings, estimateTokens, cacheAwareHistory, type SessionSavings } from './lib/contextPlan';
import { expandCompactDiff } from './lib/compactDiff';
import { askQuestionHistoryText, parseAskQuestion } from './lib/askQuestion';
import { chatToJson, chatToMarkdown, downloadText, safeFilename } from './lib/chatExport';
import type { NucleusAction } from './lib/nucleusActions';
import { NUCLEUS_LIMITS } from './lib/nucleusPolicy';
import { policyFromSettings, policyDirective, type AnswerMode } from './lib/intentPolicy';
import { routeModel, type RoutingMode, type TaskClass } from './lib/modelRouter';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import { explainError, splitExplanation, type ExplainedError } from './lib/errors';
import { markSwitchStart, reportSwitchPaint } from './lib/perfTrace';
import { useT, t } from './lib/i18n';
import type { Message, ChatItem, User } from './types';
export type { Message, MessageMetrics, ChatItem } from './types';
import './App.css';

// D1: metin sohbeti model ÇAĞIRMAZ — yerel sıkıştırma motoru çalışır.
// Mesaj rozetleri pazarlama modeli adı (Claude/GPT…) değil, gerçekte
// kullanılanı yazar.
const localEngineStamp = () => t('app.engineStamp');

const chatErrorContent = (x: ExplainedError): string => {
  const action = splitExplanation(x.explanation).rest ?? x.explanation;
  const detail = x.detail && !action.includes(x.detail) ? `\n\n\`${x.detail}\`` : '';
  return `**[${x.code}] ${x.title}**\n\n${action}${detail}\n\n*${t('toast.wiki')}*`;
};

// Yerel model yalnızca sohbet sürerken açık kalsın: son etkinlikten bu kadar
// sonra uygulamanın başlattığı sunucular durdurulur (sonraki istekte yeniden başlar).
const LOCAL_MODEL_IDLE_MS = 3 * 60 * 1000;

const getDefaultMessages = (): Message[] => [];

/** Maximum number of messages written to localStorage per chat. */
const MAX_STORED_MESSAGES = 200;

export default function App() {
  const { showToast } = useToast();
  const t = useT();
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  // Bumped whenever the active project changes so the sidebar list and the
  // project dashboard both refresh.
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  // Images attached to the next message. A model is only called when this is
  // non-empty, so text-only chats keep the zero-model compression path.
  const [pendingImages, setPendingImages] = useState<AttachedImage[]>([]);
  const [currentView, setCurrentView] = useState<'chat' | 'project'>(() => {
    const saved = localStorage.getItem('tlm_start_view');
    return saved === 'project' ? 'project' : 'chat';
  });
  /** Proje paneli ilk açılıştan sonra gizlenir, unmount edilmez (PTY yaşar). */
  const [projectMounted, setProjectMounted] = useState(currentView === 'project');
  useEffect(() => {
    if (currentView === 'project') setProjectMounted(true);
  }, [currentView]);
  // Gerçekte yanıtlayacak sağlayıcı · model; composer'ın dürüst ipucu için.
  // Ayarlar değişince (anahtar kaydı, sağlayıcı seçimi, model) yeniden çözülür.
  const [activeProviderId, setActiveProviderId] = useState<string>('');
  const [activeModel, setActiveModel] = useState<string>('');
  const [activeModelLabel, setActiveModelLabel] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      try {
        const pending = getPendingLocalModel();
        if (pending) {
          if (cancelled) return;
          const name = connectionName('managed');
          setActiveProviderId('managed');
          setActiveModel(pending.model);
          setActiveModelLabel(`${name} — ${pending.model}`);
          return;
        }
        const p = await getActiveProvider();
        if (cancelled) return;
        setActiveProviderId(p?.id ?? '');
        setActiveModel(p?.model ?? '');
        setActiveModelLabel(p ? `${p.name} · ${p.model}` : '');
      } catch {
        if (cancelled) return;
        setActiveProviderId('');
        setActiveModel('');
        setActiveModelLabel('');
      }
    };
    void resolve();
    window.addEventListener('thalamus_config_changed', resolve);
    window.addEventListener('storage', resolve);
    window.addEventListener(LOCAL_MODELS_EVENT, resolve);
    return () => {
      cancelled = true;
      window.removeEventListener('thalamus_config_changed', resolve);
      window.removeEventListener('storage', resolve);
      window.removeEventListener(LOCAL_MODELS_EVENT, resolve);
    };
  }, []);

  // Yerel sağlayıcı seçiliyse AÇILIŞTA bir kez tara (önbellek bayatsa): böylece
  // kullanıcı Ayarlar'ı açmadan gerçekten indirilmiş modeller kullanılır.
  // Sonuç LOCAL_MODELS_EVENT yayar → model yukarıdaki effect'te yeniden çözülür.
  const [, setLocalModelsVersion] = useState(0);
  useEffect(() => {
    const bump = () => setLocalModelsVersion((v) => v + 1);
    window.addEventListener(LOCAL_MODELS_EVENT, bump);
    void (async () => {
      try {
        const p = await getActiveProvider();
        if (!p || !isLocalProvider(p.id) || localEndpointsFresh()) return;
        await scanLocalModels(p.baseUrl ? [p.baseUrl] : []);
      } catch { /* tarama başarısız — sağlayıcı varsayılanı kullanılır */ }
    })();
    return () => window.removeEventListener(LOCAL_MODELS_EVENT, bump);
  }, []);

  // Yerel model boşta durdurulur; her seçim/istek bu zamanı tazeler.
  const lastModelUseRef = useRef(Date.now());

  const useLocalEndpoint = useCallback((provider: string, baseUrl: string, model: string) => {
    lastModelUseRef.current = Date.now();
    // Ollama'nın Windows CUDA yolu modeli RAM'e kopyalıyor (düşük RAM'de
    // 20–50 sn). Tek GGUF blob'u olan modelleri kendi llama-server'ımızla
    // mmap üzerinden aç: aynı model, ~4–10 sn. Görsel/parçalı modellerde
    // backend otomatik olarak Ollama'ya düşer.
    const file = /:11434\/v1$/.test(normalizeBaseUrl(baseUrl))
      ? getCachedLocalScan()?.files.find(
          (f) => f.kind === 'ollama' && f.model === model && f.servable
        )
      : undefined;
    if (provider === 'ollama' && file) {
      setPendingLocalModel({
        id: file.id,
        path: file.path,
        model: file.model,
        label: file.label,
      });
      const name = connectionName('managed');
      setActiveProviderId('managed');
      setActiveModel(file.model);
      setActiveModelLabel(`${name} - ${file.model}`);
      return;
    }
    clearPendingLocalModel();
    try {
      localStorage.setItem(activeProviderStorageKey, provider);
      localStorage.setItem(baseStorageKey(provider), baseUrl);
    } catch { /* noop */ }
    // Seçilen uç nokta bir KAYITLI BAĞLANTIYA dönüşür (geçiş listesinde görünsün).
    if (provider !== 'managed') upsertConnection({ id: provider, baseUrl });
    setProviderModel(provider, model);
    const name = connectionName(provider);
    setActiveProviderId(provider);
    setActiveModel(model);
    setActiveModelLabel(`${name} · ${model}`);
  }, []);

  const selectProviderModel = useCallback((provider: string, model: string) => {
    lastModelUseRef.current = Date.now();
    clearPendingLocalModel();
    try {
      localStorage.setItem(activeProviderStorageKey, provider);
    } catch { /* noop */ }
    setProviderModel(provider, model);
    const name = connectionName(provider);
    setActiveProviderId(provider);
    setActiveModel(model);
    setActiveModelLabel(`${name} · ${model}`);
  }, []);

  const activateLocalFile = useCallback(async (file: ModelFile) => {
    const served = file.servedBy[0];
    if (served) {
      useLocalEndpoint(providerForBase(served), served, file.model);
      return;
    }
    // Motoru SEÇİM ANINDA başlatma: ilk istek gelene kadar bekle.
    lastModelUseRef.current = Date.now();
    setPendingLocalModel({
      id: file.id,
      path: file.path,
      model: file.model,
      label: file.label,
    });
    const name = connectionName('managed');
    setActiveProviderId('managed');
    setActiveModel(file.model);
    setActiveModelLabel(`${name} — ${file.model}`);
  }, [useLocalEndpoint]);

  /**
   * Seçili yerel model boşta durdurulduysa göndermeden önce yeniden başlatır.
   * Sunucu zaten ayaktaysa hiçbir şey yapmaz; hata sohbeti engellemez.
   */
  const ensureLocalModelReady = useCallback(async () => {
    try {
      const p = await getActiveProvider();
      if (!p || p.id !== 'managed' || !p.model) return;
      const servers = await listServing();
      const base = normalizeBaseUrl(p.baseUrl || '');
      if (servers.some((s) => normalizeBaseUrl(s.base_url) === base || s.model === p.model)) return;
      const file = getCachedLocalScan()?.files.find((f) => f.model === p.model && f.servable);
      if (!file) return;
      const served = await serveLocalModel(file.id, file.path);
      useLocalEndpoint('managed', served.baseUrl, served.model);
    } catch { /* sohbet mevcut sağlayıcıyla devam eder */ }
  }, [useLocalEndpoint]);

  const [input, setInput] = useState<string>('');
  // Dosya önizlemesi: chat düzeninde SAĞDA bir sütun (chat'i örtmez, daraltır).
  const [previewItem, setPreviewItem] = useState<PreviewItem | null>(null);
  // Önizleme sütun genişliği — sol kenardan çekip bırakarak ayarlanır, hatırlanır.
  const [previewWidth, setPreviewWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('tlm_preview_width'));
    return Number.isFinite(v) && v >= 320 ? v : 520;
  });
  useEffect(() => {
    try { localStorage.setItem('tlm_preview_width', String(previewWidth)); } catch { /* noop */ }
  }, [previewWidth]);
  // İçerik (PDF/office) genişliği: panelin gerçek genişliğini izler. Sabit
  // tutulduğunda panel genişletilince içerik sol kenara yapışıyordu.
  const [previewContentW, setPreviewContentW] = useState<number>(640);
  const previewColRef = useRef<HTMLDivElement>(null);
  const openPreview = useCallback((item: PreviewItem) => {
    setPreviewItem(item);
    // Panel `maxWidth: calc(100vw - 560px)` ile kırpılabildiği için içeriği
    // kırpılmamış `previewWidth`e değil, gerçek panel genişliğine sığdır.
    const maxPanel = Math.max(320, window.innerWidth - 560);
    setPreviewContentW(Math.min(previewWidth, maxPanel));
  }, [previewWidth]);
  // Panel gerçekten kaç px yer buldu? (flex küçültmesi + maxWidth). İçerik
  // genişliğini bir kez gerçek ölçüye sabitle; taşma/kırpılma olmasın.
  useEffect(() => {
    if (!previewItem) return;
    const w = previewColRef.current?.clientWidth;
    if (w && w > 0) setPreviewContentW(w);
  }, [previewItem]);

  // Sol kenardan çekip bırakarak ÇALIŞMA ALANI (panel) genişliği ayarlanır.
  const startPreviewResize = (e: { clientX: number; preventDefault: () => void }) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = previewWidth;
    let raf = 0;
    let latestW = startW;
    document.body.style.userSelect = 'none';
    // Sürükleme sırasında içerik genişliğini de canlı güncelle (rAF ile
    // sınırlı) → içerik bırakınca sıçramaz, panel kenarıyla birlikte akar.
    const apply = () => {
      raf = 0;
      setPreviewWidth(latestW);
      const maxPanel = Math.max(320, window.innerWidth - 560);
      setPreviewContentW(Math.min(latestW, maxPanel));
    };
    const move = (ev: PointerEvent) => {
      latestW = Math.max(320, Math.min(startW + (startX - ev.clientX), window.innerWidth - 380));
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const up = () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setPreviewWidth(latestW);
      const maxPanel = Math.max(320, window.innerWidth - 560);
      setPreviewContentW(Math.min(latestW, maxPanel));
      // Flex/maxWidth yüzünden panel gerçekte daha dar kaldıysa son ölçüyü
      // (commit sonrası) kullan.
      requestAnimationFrame(() => {
        const actual = previewColRef.current?.clientWidth;
        if (actual && actual > 0) setPreviewContentW(actual);
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /**
   * The theme is applied via the `html[data-theme]` attribute (rules live in App.css).
   * A single attribute swap replaces the old document.head <style> injection.
   */
  const applyTheme = (theme: 'dark' | 'nord-red') => {
    const el = document.documentElement;
    if (theme === 'nord-red') el.setAttribute('data-theme', 'nord-red');
    else el.removeAttribute('data-theme');
  };

  useEffect(() => {
    let savedTheme: string | null = 'dark';
    try { savedTheme = localStorage.getItem('tlm_theme'); } catch {}
    applyTheme(savedTheme === 'nord-red' ? 'nord-red' : 'dark');
  }, []);

  // T1 close-guard: Rust CloseRequested'i önler ve bu olayı iletir; kirli
  // editör tamponu varsa kullanıcıya sorulur, aksi hâlde destroy ile kapatılır.
  useEffect(() => {
    // Tauri yoksa (tarayıcı önizlemesi) close-guard atlanır — aksi halde
    // getCurrentWebviewWindow() __TAURI_INTERNALS__ üzerinden çöküp tüm
    // arayüzü düşürür.
    let win: ReturnType<typeof getCurrentWebviewWindow>;
    try { win = getCurrentWebviewWindow(); } catch { return; }
    let off: (() => void) | undefined;
    let disposed = false;
    win.listen('close-requested', () => {
      let dirtyFiles: string[] = [];
      try {
        const map = JSON.parse(localStorage.getItem('thalamus_dirty_buffers_v1') || '{}');
        dirtyFiles = Object.keys(map).filter((k) => typeof (map as Record<string, unknown>)[k] === 'string');
      } catch {}
      if (dirtyFiles.length === 0) {
        void win.destroy();
        return;
      }
      const names = dirtyFiles.map((f) => f.split('/').pop()).join(', ');
      const proceed = window.confirm(
        t('chat.unsavedCloseMany', { n: dirtyFiles.length, names })
      );
      if (proceed) void win.destroy();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);


  
  // 🎯 Active file tracking on the project screen (synced with Header)
  const [activeTab, setActiveTab] = useState<string>('');
  const projectContextRef = useRef<{ activeFile: string; code: string; cursorLine: number; selection: string }>({
    activeFile: '',
    code: '',
    cursorLine: 0,
    selection: '',
  });
  const handleProjectContext = useCallback((context: { activeFile: string; code: string; cursorLine: number; selection: string }) => {
    projectContextRef.current = context;
  }, []);

  // Oturum tasarrufu (görünür kılınır): planlayıcının yeniden göndermediği içerik.
  const [sessionSave, setSessionSave] = useState<SessionSavings>({ avoidedChars: 0, files: 0, turns: 0 });

  // ⚙️ Ayarlar paneli state'i
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  // Uygulama geneli Nucleus komut yüzeyi (Siri benzeri global çağrı).
  const [isNucleusOpen, setIsNucleusOpen] = useState<boolean>(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState<boolean>(false);

  /**
   * Projects görünümünde Nucleus kalıcı bir panel değil, yüzen bir penceredir.
   * Global çağrılar (Alt+N, başlık, palet) proje ekranında o pencereyi açar;
   * diğer görünümlerde mevcut komut overlay'i kullanılır.
   */
  const openNucleus = useCallback(() => {
    if (currentView === 'project') {
      setIsNucleusOpen(false);
      window.dispatchEvent(new Event('tlm:nucleus-open'));
    } else {
      setIsNucleusOpen(true);
    }
  }, [currentView]);

  const toggleNucleus = useCallback(() => {
    setIsPaletteOpen(false);
    if (currentView === 'project') {
      setIsNucleusOpen(false);
      window.dispatchEvent(new Event('tlm:nucleus-toggle'));
    } else {
      setIsNucleusOpen((open) => !open);
    }
  }, [currentView]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const altN = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'KeyN';
      const chord = (event.ctrlKey || event.metaKey) && event.shiftKey && (event.code === 'Space' || event.key === ' ');
      const palette = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';
      if (!event.repeat && (altN || chord)) {
        event.preventDefault();
        toggleNucleus();
      } else if (!event.repeat && palette) {
        event.preventDefault();
        setIsNucleusOpen(false);
        setIsPaletteOpen((open) => !open);
      } else if (event.key === 'Escape' && isNucleusOpen) {
        setIsNucleusOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isNucleusOpen, toggleNucleus]);

  /**
   * Dış bağlantılar: Tauri webview'de `target="_blank"` yeni pencere izni
   * olmadığı için sessizce ölüyordu. Tüm http(s)/mailto tıklamalarını yakalayıp
   * sistem tarayıcısına veririz (tarayıcı önizlemesinde window.open'a düşer).
   */
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (!/^(https?:\/\/|mailto:)/i.test(href)) return;
      event.preventDefault();
      event.stopPropagation();
      invoke('open_external', { url: href }).catch(() => {
        window.open(href, '_blank', 'noopener,noreferrer');
      });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
  
  // 🔑 User session state (read from localStorage — corrupt data must never crash the app)
  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = localStorage.getItem('thalamus_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  
  // 🌐 Whether live pricing is enabled (read from localStorage)
  const [onlinePricing, setOnlinePricing] = useState<boolean>(() => {
    return localStorage.getItem('tlm_online_pricing') === 'true';
  });

  // 🧭 Confirmation popup control on first launch (defaults to true when not set in localStorage)
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    return localStorage.getItem('tlm_online_pricing') === null;
  });

  useEffect(() => {
    if (!isSettingsOpen) {
      setOnlinePricing(localStorage.getItem('tlm_online_pricing') === 'true');
    }
  }, [isSettingsOpen]);

  // Ayar değişimi ANINDA uygulanır (Kaydet beklenmez): SettingsModal her
  // değişiklikte 'thalamus_config_changed' yayar; model ve fiyatlandırma
  // burada yeniden okunur. (Önceden bu değişiklikler yalnız Kaydet ile ya da
  // uygulama yeniden başlatılınca etkili oluyordu.)
  useEffect(() => {
    const syncSettings = () => {
      setOnlinePricing(localStorage.getItem('tlm_online_pricing') === 'true');
    };
    window.addEventListener('thalamus_config_changed', syncSettings);
    return () => window.removeEventListener('thalamus_config_changed', syncSettings);
  }, []);

  const { isLoading: engineLoading, checkHealth } = useThalamus();

  /** Welcome card 4: a real engine health check (HTTP + latency). */
  const handleEngineDiagnostic = async () => {
    const t0 = performance.now();
    try {
      const ok = await checkHealth();
      const ms = Math.max(1, Math.round(performance.now() - t0));
      if (ok) {
        showToast(t('app.engineActive'), t('app.engineActiveMsg', { base: API_BASE, ms }), 'success');
      } else {
        showToast(t('app.engineOffline'), t('app.engineOfflineMsg', { base: API_BASE }), 'error', undefined, '[503] health check failed');
      }
    } catch {
      showToast(t('app.engineOffline'), t('app.engineOfflineMsg', { base: API_BASE }), 'error', undefined, '[503] health check failed');
    }
  };
  const [loading, setLoading] = useState<boolean>(false);
  // İlk mesajda yerel model yüklenirken "Yerel model yükleniyor · X" göster.
  const [localLoadingLabel, setLocalLoadingLabel] = useState<string>('');
  useEffect(() => {
    const onLoading = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      setLocalLoadingLabel(typeof detail === 'string' ? detail : '');
    };
    window.addEventListener(LOCAL_LOADING_EVENT, onLoading);
    return () => window.removeEventListener(LOCAL_LOADING_EVENT, onLoading);
  }, []);
  const chatEndRef = useRef<HTMLDivElement>(null);
  // T2: süren AI isteğini iptal etmek için (Stop düğmesi).
  const abortControllerRef = useRef<AbortController | null>(null);

  // Boşta kalan yerel modeli kapat: istek yoksa ve son etkinlikten
  // LOCAL_MODEL_IDLE_MS geçtiyse uygulamanın başlattığı tüm sunucuları durdur.
  const loadingRef = useRef(false);
  useEffect(() => {
    loadingRef.current = loading;
    lastModelUseRef.current = Date.now();
  }, [loading]);
  useEffect(() => {
    const tick = window.setInterval(() => {
      if (loadingRef.current) return;
      if (Date.now() - lastModelUseRef.current < LOCAL_MODEL_IDLE_MS) return;
      void (async () => {
        try {
          const servers = await listServing();
          if (servers.length === 0) return;
          await Promise.all(servers.map((s) => stopLocalModel(s.id, true)));
          window.dispatchEvent(new Event(LOCAL_MODELS_EVENT));
        } catch { /* noop */ }
      })();
    }, 30_000);
    return () => window.clearInterval(tick);
  }, []);

  const [chats, setChats] = useState<ChatItem[]>(() => {
    try {
      const saved = localStorage.getItem('thalamus_chats');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [activeChatId, setActiveChatId] = useState<string>(() => {
    try {
      const savedId = localStorage.getItem('thalamus_active_chat_id') || '';
      // V5: kalıcı aktif-id listede yoksa (silinmiş/bozuk kayıt) hayalet
      // sohbet oluşmasın: gerçek bir sohbete düş, liste boşsa boş kal.
      const list = JSON.parse(localStorage.getItem('thalamus_chats') || '[]') as ChatItem[];
      if (list.some(c => c.id === savedId)) return savedId;
      return list[0]?.id || '';
    } catch {
      return '';
    }
  });
  // V3: asenkron istekler sürerken kullanıcı sohbet değiştirirse yanıtların
  // YANLIŞ sohbete yazılmasını engellemek için güncel id'nin ref'i.
  const activeChatIdRef = useRef(activeChatId);
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  const activeChat = chats.find(c => c.id === activeChatId) || chats[0] || { id: '', title: t('app.newChatTitle') };

  // Sohbet değişince o sohbetin birikimli tasarrufu gösterilir.
  useEffect(() => {
    setSessionSave(activeChatId ? loadSavings(activeChatId) : { avoidedChars: 0, files: 0, turns: 0 });
  }, [activeChatId]);

  const [messages, setMessages] = useState<Message[]>([]);
  // Perf: acilista okunan sohbetin hemen geri yazilmasini engelleyen isaret
  // (bkz. kalicilik efektindeki loadedChatRef).
  const loadedChatRef = useRef<string | null>(null);
  /** Akış sırasında kalıcılık yazımını saniyede 1 ile sınırlar. */
  const streamPersistAtRef = useRef(0);
  /** Şu an akışı süren sohbet: sohbetten çıkıp dönersek akış devam eder. */
  const streamingChatIdRef = useRef<string | null>(null);
  /** Başka sohbetteyken akış kopyasını en fazla saniyede 1 yazar. */
  const ownerPersistAtRef = useRef(0);
  /** Kota uyarısını sohbet başına yalnız bir kez gösterir. */
  const ownerQuotaWarnedRef = useRef<string | null>(null);
  /** 200 mesaj sınırı uyarısını sohbet başına yalnız bir kez gösterir. */
  const historyTrimWarnedRef = useRef<string | null>(null);

  // Load messages whenever activeChatId changes
  useEffect(() => {
    if (!activeChatId) {
      setMessages([]);
      return;
    }
    const savedMsg = localStorage.getItem(`thalamus_chat_messages_${activeChatId}`);
    if (savedMsg) {
      try {
        const t0 = performance.now();
        // Eski sohbetlerdeki otomatik "hazır" karşılama mesajı artık yok.
        const legacyWelcome = new Set([t('app.welcome1'), t('app.welcome2')]);
        const parsed = (JSON.parse(savedMsg) as Message[])
          .filter((m) => !(m.role === 'assistant' && legacyWelcome.has(m.content)))
          // Uygulama akış ortasında kapanmışsa ya da akışı olmayan bir sohbet
          // açıldıysa: bayat "streaming" bayrağı kalıcı olmasın; yarım cevap
          // korunur, "koptu" notu düşülür. Canlı akış sürüyorsa dokunma.
          .map((m) =>
            m.streaming && activeChatId !== streamingChatIdRef.current
              ? { ...m, streaming: false, stopped: m.stopped ?? 'error' }
              : m
          );
        if (import.meta.env.DEV) {
          const total = parsed.reduce((s, m) => s + (m.content?.length ?? 0), 0);
          const biggest = parsed.reduce((b, m, i) => (m.content && m.content.length > b.len ? { len: m.content.length, i } : b), { len: 0, i: -1 });
          const heavy = parsed
            .map((m, i) => ({ i, len: m.content?.length ?? 0, imgs: m.images?.length ?? 0 }))
            .filter((m) => m.len > 20000 || m.imgs > 0)
            .map((m) => `#${m.i} ${Math.round(m.len / 1024)}KB${m.imgs ? ` +${m.imgs} img` : ''}`)
            .join(', ');
          console.log(`[perf] loaded chat: ${parsed.length} msgs, ${Math.round(total / 1024)}KB total, biggest #${biggest.i} ${Math.round(biggest.len / 1024)}KB, parse ${Math.round(performance.now() - t0)}ms${heavy ? ` | heavy: ${heavy}` : ''}`);
        }
        loadedChatRef.current = activeChatId;
        setMessages(parsed);
      } catch {
        setMessages(getDefaultMessages());
      }
    } else {
      setMessages(getDefaultMessages());
    }
    // D1: varsayilan mesaj artik modele bagli degil; secici degisikleti
    // acik sohbeti sifirlamamali.
  }, [activeChatId]);

  // Save messages whenever they change. The stored copy is capped (UI keeps
  // everything in memory) and quota failures degrade to a toast instead of
  // crashing the app — localStorage's 5 MB limit is a real boundary.
  // Perf: a freshly LOADED chat must not be written straight back — that cost
  // a full JSON.stringify per open for zero benefit (loadedChatRef marks it).
  useEffect(() => {
    if (activeChatId && messages.length > 0) {
      if (loadedChatRef.current === activeChatId) {
        loadedChatRef.current = null;
        return;
      }
      // Akış sırasında her karede tüm sohbeti JSON'lamak pahalı; saniyede en
      // fazla bir kez yaz (bitişte zaten yazılacak).
      if (messages.some((m) => m.streaming)) {
        const now = Date.now();
        if (now - streamPersistAtRef.current < 1000) return;
        streamPersistAtRef.current = now;
      }
      if (messages.length > MAX_STORED_MESSAGES && historyTrimWarnedRef.current !== activeChatId) {
        historyTrimWarnedRef.current = activeChatId;
        showToast(
          t('toast.historyTrimmed'),
          t('toast.historyTrimmedMsg', { n: MAX_STORED_MESSAGES }),
          'info'
        );
      }
      const capped = messages.length > MAX_STORED_MESSAGES ? messages.slice(-MAX_STORED_MESSAGES) : messages;
      // Görseller (data URL'ler) kalıcı depoya gitmez — 5 MB kota rekoru
      // (Storage Full) sohbet kaydını komple öldürür. Klon yerine replacer ile
      // atılır: O(n) kopya çıkar.
      const dropImages = (key: string, value: unknown) => (key === 'images' ? undefined : value);
      try {
        localStorage.setItem(`thalamus_chat_messages_${activeChatId}`, JSON.stringify(capped, dropImages));
      } catch {
        try {
          localStorage.setItem(
            `thalamus_chat_messages_${activeChatId}`,
            JSON.stringify(capped.slice(-50), dropImages)
          );
        } catch {
          showToast(t('toast.storageFull'), t('toast.storageFullMsg'), 'error', undefined, '[507] localStorage quota exceeded');
        }
      }
    }
  }, [messages, activeChatId]);

  // Save chats and activeChatId whenever they change
  useEffect(() => {
    localStorage.setItem('thalamus_chats', JSON.stringify(chats));
  }, [chats]);

  useEffect(() => {
    if (activeChatId) {
      localStorage.setItem('thalamus_active_chat_id', activeChatId);
    } else {
      localStorage.removeItem('thalamus_active_chat_id');
    }
  }, [activeChatId]);

  const handleNewChat = () => {
    // C1: uzerinde hic mesaj olmayan bir sohbet zaten aciksa yenisini
    // olusturma (listede ust uste "New Chat Session" satirlari birikiyordu);
    // mevcut bos sohbeti resetleyip kullan.
    if (activeChatId && messages.length <= 1) {
      let storedEmpty = true;
      try {
        const raw = localStorage.getItem(`thalamus_chat_messages_${activeChatId}`);
        const parsed = raw ? JSON.parse(raw) : [];
        storedEmpty = !Array.isArray(parsed) || parsed.length <= 1;
      } catch { storedEmpty = true; }
      if (storedEmpty) {
        setMessages(getDefaultMessages());
        return;
      }
    }
    const newId = 'chat_' + Date.now();
    const newChat: ChatItem = {
      id: newId,
      title: t('app.newChatTitle')
    };
    setChats(prev => [newChat, ...prev]);
    setActiveChatId(newId);
    setMessages([]);
  };

  const handleDeleteChat = (chatId: string) => {
    const remainingChats = chats.filter(c => c.id !== chatId);
    setChats(remainingChats);
    localStorage.removeItem(`thalamus_chat_messages_${chatId}`);
    if (activeChatId === chatId) {
      if (remainingChats.length > 0) {
        setActiveChatId(remainingChats[0].id);
      } else {
        setActiveChatId('');
        setMessages([]);
      }
    }
    showToast(t('toast.chatDeleted'), t('toast.chatDeletedMsg'), 'success');
  };

  const handleRenameChat = (chatId: string, newTitle: string) => {
    setChats(prev => prev.map(c => c.id === chatId ? { ...c, title: newTitle } : c));
    showToast(t('toast.chatRenamed'), t('toast.chatRenamedMsg'), 'success');
  };

  /** Sabitleme sohbet listesiyle birlikte kalıcılaşır (thalamus_chats). */
  const handlePinChat = useCallback((chatId: string, pinned: boolean) => {
    setChats(prev => prev.map(c => c.id === chatId ? { ...c, pinned } : c));
  }, []);

// Optimized scroll: only in 'chat' view, with instant (auto) scrolling
  // Otomatik scroll: nur yukarıda okurken her yeni mesaj kullanıcıyı alta
  // fırlatmayı durdurur — yalnızca alt bölgeye (±140px) yakınsak kaydırırız.
  useEffect(() => {
    if (!chatEndRef.current || currentView !== 'chat') return;
    const container = chatEndRef.current.closest('[data-chat-scroll]') as HTMLElement | null;
    if (!container) {
      chatEndRef.current.scrollIntoView({ behavior: 'auto' });
      return;
    }
    const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distFromBottom < 140) container.scrollTop = container.scrollHeight;
  }, [messages, currentView]);

  const handleSendMessage = async (
    userText: string,
    isRegenerate = false,
    imagesFromRegenerate?: AttachedImage[],
    /** Ekli dosyalar: input'a YAZILMAZ, modele görünmez bağlam (code_blocks) olarak gider. */
    fileContext?: { name: string; body: string }[],
    /** Düzenlenen mesajı yeniden göndermede: geçmiş, o mesajdan ÖNCEKİLER. */
    historyOverride?: Message[]
  ) => {
    const nowTime = ts();
    let currentId = activeChatId;

    // T2: aktif isteğin AbortSignal'i; Stop düğmesi bunu iptal eder.
    const currentAbort = new AbortController();
    abortControllerRef.current = currentAbort;
    const signal = currentAbort.signal;

    /** İstek iptal mi geldi: kullanıcı Stop (abort) mi, 180s timeout mu? */
    const abortKind = (): 'stop' | 'timeout' | null => {
      if (!signal.aborted) return null;
      const reason = signal.reason;
      return reason instanceof Error && String((reason as Error).message).includes('TIMEOUT')
        ? 'timeout'
        : 'stop';
    };

    const isNewChat = !currentId || chats.length === 0;
    if (isNewChat) {
      currentId = 'chat_' + Date.now();
      const generatedTitle = userText.length > 22 ? userText.slice(0, 22) + '...' : userText;
      const newChat: ChatItem = {
        id: currentId,
        title: generatedTitle
      };
      // V2: onceki sohbetleri SİLME; listeye başa ekle. (setChats([newChat])
      // tüm sohbet geçmişini tek mesajlık yeni sohbetle değiştiriyordu.)
      // Kalıcılık zaten chats/activeChatId efektlerinin işi; buradan elle
      // localStorage yazmak yarısı silinmiş kayıtlar üretiyordu.
      setChats(prev => (prev.some(c => c.id === newChat.id) ? prev : [newChat, ...prev]));
      setActiveChatId(currentId);
      activeChatIdRef.current = currentId;
    } else if (messages.length <= 1 && !isRegenerate) {
      const generatedTitle = userText.length > 22 ? userText.slice(0, 22) + '...' : userText;
      setChats(prev => prev.map(c => c.id === currentId ? { ...c, title: generatedTitle } : c));
    }

    // Regenerate, mesaj üzerinde saklanan görselleri yeniden kullanır; aksi
    // halde pendingImages ilk gönderimde silinmiş olduğundan regenerate sessizce
    // metin-sıkıştırma yoluna düşüyordu.
    const activeImages = historyOverride
      ? (imagesFromRegenerate ?? [])
      : pendingImages.length > 0 ? pendingImages : (imagesFromRegenerate ?? []);

    // Rozet gerçekten ne işleyeceğini söyler: görsel → provider yolu, metin →
    // asistan yolu (motor backend'de sessizdir; P2 katmanı orada çalışır).
    const userMsg: Message = {
      role: 'user',
      content: userText.trim()
        || (activeImages.length ? `[${activeImages.length} image${activeImages.length > 1 ? 's' : ''}]` : '')
        || (fileContext && fileContext.length ? `[${fileContext.length} file${fileContext.length > 1 ? 's' : ''}]` : userText),
      timestamp: nowTime,
      ...(activeImages.length > 0 ? { modelName: t('app.visionModel') } : {}),
      ...(activeImages.length > 0 ? { images: activeImages } : {}),
    };

    if (!isRegenerate) {
      if (isNewChat) {
        try {
          localStorage.setItem(`thalamus_chat_messages_${currentId}`, JSON.stringify([userMsg]));
        } catch { /* yok say */ }
      }
      setMessages(prev => [...prev, userMsg]);
    }
    setLoading(true);
    // Yerel model boşta kapatıldıysa isteği göndermeden önce geri aç.
    await ensureLocalModelReady();

    // V3: istek sürerken kullanıcı başka sohbete geçerse yanıt bu sohbete
    // dönmeli: hâlâ aynı sohbetteysek ekrana, değilsek o sohbetin kalıcı
    // kopyasına yazılır (dönünce localStorage'dan yüklenecek).
    const ownerChatId = currentId;
    /**
     * Akış sürerken kullanıcı başka sohbete geçerse cevap sahibi sohbetin
     * kalıcı kopyasına yazılır. `throttled` yalnız 40 ms'lik boyama
     * çağrılarında true olur: senkron localStorage'ı saniyede 25 kez
     * yazmayız. Görseller ve 200 mesaj sınırı normal kayıt yoluyla aynıdır
     * (data URL'ler 5 MB kotasını patlatmasın).
     */
    const applyMessages = (fn: (prev: Message[]) => Message[], throttled = false) => {
      if (activeChatIdRef.current === ownerChatId) {
        setMessages(fn);
        return;
      }
      const now = Date.now();
      if (throttled && now - ownerPersistAtRef.current < 1000) return;
      ownerPersistAtRef.current = now;
      try {
        const key = `thalamus_chat_messages_${ownerChatId}`;
        const stored = JSON.parse(localStorage.getItem(key) || '[]') as Message[];
        const next = fn(stored);
        const capped = next.length > MAX_STORED_MESSAGES ? next.slice(-MAX_STORED_MESSAGES) : next;
        const dropImages = (k: string, value: unknown) => (k === 'images' ? undefined : value);
        localStorage.setItem(key, JSON.stringify(capped, dropImages));
      } catch {
        if (ownerQuotaWarnedRef.current !== ownerChatId) {
          ownerQuotaWarnedRef.current = ownerChatId;
          showToast(t('toast.storageFull'), t('toast.storageFullMsg'), 'error', undefined, '[507] localStorage quota exceeded');
        }
      }
    };

    // Images attached → a single vision call. This is the only branch that uses
    // a model, so text-only chats stay on the local, zero-model path below.
    if (activeImages.length > 0) {
      const images = activeImages;
      // Sadece taze eklenen görseller içeride temizlenir; regenerate görselleri
      // mesaj üzerinde zaten durur.
      if (pendingImages.length > 0) setPendingImages([]);
      try {
        const provider = await getActiveProvider();
        if (!provider) {
          const fallback = images.map((i) => `- ${i.name}: ${i.summary}`).join('\n');
          applyMessages(prev => [...prev, {
            role: 'assistant',
            content: `No model key is set, so the image was measured on this device instead:\n\n${fallback}\n\nAdd a provider key in Settings to let a vision model look at the image.`,
            timestamp: ts(),
            modelName: t('app.localDeviceMeasurement'),
          }]);
        } else {
          // D3/D14: son 8 mesaj baglam gonderilir; regenerate'te yeniden
          // sorulan soru ve yerine uretilecek eski yanit baglama ALINMAZ.
          let historySrc = historyOverride ?? messages;
          if (isRegenerate) {
            const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
            if (lastUserIdx !== -1) historySrc = messages.slice(0, lastUserIdx);
          }
          const history = cacheAwareHistory(
            historySrc
              .map(m => ({ role: m.role, content: askQuestionHistoryText(m) }))
              .filter(m => m.content.trim().length > 0),
            ownerChatId,
            m => m.content.length
          );
          const visionStartedAt = performance.now();
          const res = await aiChat([
            ...history,
            userMessage(userText.trim() || t('app.describeImage'), images.map((i) => ({ url: i.url, detail: i.detail }))),
          ], [], null, signal, { closeAfter: true });
          const parsed = parseAskQuestion(expandCompactDiff(res.content));
          const hasAnswer = parsed.content.trim().length > 0 || !!parsed.question;
          applyMessages(prev => [...prev, {
            role: 'assistant',
            content: hasAnswer ? parsed.content : res.reasoning ? t('chat.emptyReasoning') : t('chat.emptyResponse'),
            question: parsed.question,
            // Düşünme metni (destekleyen sağlayıcılarda) ayrı gösterilir.
            reasoning: res.reasoning || undefined,
            timestamp: ts(),
            latencyMs: Math.round(performance.now() - visionStartedAt),
            usage: res.usage,
            // D1: gercekten cagrilan saglayici + model yazilir.
            modelName: `${provider.name} · ${provider.model}`,
          }]);
        }
      } catch (err) {
        // T2: kullanıcı Stop'a bastıysa hata mesajı yazılmaz; dürüst not düşülür.
        const kind = abortKind();
        if (kind) {
          applyMessages(prev => [...prev, {
            role: 'assistant',
            content: kind === 'stop' ? t('chat.requestStopped') : t('chat.requestTimedOut'),
            timestamp: ts(),
            modelName: t('app.visionAborted'),
          }]);
        } else {
          const x = explainError(err, 'Vision request');
          // Ham JSON dump gosterilmez. Baslik "ne oldu"yu soyler; tekrar eden
          // ilk cumle atilir, yalniz aksiyon/aciklama satiri kalir.
          applyMessages(prev => [...prev, {
            role: 'assistant',
            content: chatErrorContent(x),
            timestamp: ts(),
            modelName: t('app.visionFailed'),
          }]);
        }
      } finally {
        setLoading(false);
        abortControllerRef.current = null;
      }
      return;
    }

    // ── Metin yolu: gerçek AI yanıtı ─────────────────────────────────────
    // Ürün kararı (2026-10): ana yüzey "sohbet asistanı"dır; sıkıştırma
    // motoru backend `/api/ai/chat` içinde istek başına sessizce ve lossless
    // çalışır (P2), ön yüz sıkıştırmayı içerik olarak göstermez.
    try {
      const provider = await getActiveProvider();
      if (!provider) {
        applyMessages(prev => [...prev, {
          role: 'assistant',
          content: t('app.noProvider'),
          timestamp: ts(),
          modelName: localEngineStamp(),
        }]);
      } else {
        // Regenerate'te yeniden sorulan soru, bağlama tekrar girilmez.
        let historySrc = historyOverride ?? messages;
        if (isRegenerate) {
          const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
          if (lastUserIdx !== -1) historySrc = messages.slice(0, lastUserIdx);
        }
        const history = cacheAwareHistory(
          historySrc
            .map(m => ({ role: m.role, content: askQuestionHistoryText(m) }))
            .filter(m => m.content.trim().length > 0 && !m.content.startsWith('**[')),
          ownerChatId,
          m => m.content.length
        );
        // OTURUM PLANLAYICI (lab'da ölçülmüş, kayıpsız): değişmeyen ve hâlâ
        // bağlamda olan dosyalar referansa dönüşür — içerik yeniden gönderilmez.
        const ctxPlan = planFileContext(ownerChatId, messages.length + 1, fileContext ?? []);
        if (ctxPlan.avoidedChars > 0) {
          setSessionSave(addSavings(ownerChatId, ctxPlan.avoidedChars, ctxPlan.referenced.length));
        }
        const textStartedAt = performance.now();
        // KULLANICI NİYETİ: varsayılan maliyet politikası (kısa prose,
        // diff-only, görünmez sıkıştırma) yalnız kullanıcı açıkça aksini
        // istemediğinde geçerli. Yönerge isteğin KUYRUĞUNA eklenir; sabit
        // sistem öneki ve cache bozulmaz.
        // Politika YALNIZ açık ayardan gelir; kelime eşleştirmesi yok.
        const answerMode = (() => {
          try {
            const v = localStorage.getItem('tlm_answer_mode');
            return v === 'terse' || v === 'detailed' ? v : 'auto';
          } catch { return 'auto'; }
        })() as AnswerMode;
        const rawMode = (() => {
          try { return localStorage.getItem('tlm_raw_context') === 'true'; } catch { return false; }
        })();
        const policy = policyFromSettings(answerMode, rawMode);
        const directive = policyDirective(policy);

        // MODEL ROUTER — varsayılan KAPALI. Gömülü model adı yok: hızlı model
        // kullanıcının seçtiği model, derin model Ayarlar'da elle girilir.
        // Auto yalnız ilk turda ve yalnız yapısal veri ekinde yönlendirir;
        // sohbet ortasında önek cache'ini korumak için seçim sabit kalır.
        const routerEnabled = (() => {
          try { return localStorage.getItem('tlm_router_enabled') === 'true'; } catch { return false; }
        })();
        const routerMode = (() => {
          try {
            const v = localStorage.getItem('tlm_router_mode');
            return v === 'fast' || v === 'deep' ? v : 'auto';
          } catch { return 'auto'; }
        })() as RoutingMode;
        const deepModel = (() => {
          try { return localStorage.getItem('tlm_deep_model_' + provider.id) || null; } catch { return null; }
        })();
        const routeKey = 'tlm_route_' + ownerChatId;
        let previousRoute: { model: string; task: TaskClass } | undefined;
        try {
          const raw = localStorage.getItem(routeKey);
          if (raw) {
            const r = JSON.parse(raw) as { providerId?: string; model?: string; task?: TaskClass };
            if (r.providerId === provider.id && r.model && r.task) {
              previousRoute = { model: r.model, task: r.task };
            }
          }
        } catch { /* yok say */ }
        const structuredExts = new Set(['json','jsonl','csv','tsv','xml','yaml','yml','toml','ini','sql','ndjson','log']);
        const codeExts = new Set(['ts','tsx','js','jsx','py','rs','go','java','kt','c','h','cpp','hpp','cs','rb','php','swift','css','scss','html','vue','svelte','sh']);
        let hasStructuredData = false;
        let hasCodeFiles = false;
        for (const b of ctxPlan.blocks) {
          const ext = (b.name.split('.').pop() || '').toLowerCase();
          if (structuredExts.has(ext)) hasStructuredData = true;
          else if (codeExts.has(ext)) hasCodeFiles = true;
          else {
            const t = b.body.trimStart();
            if (t.startsWith('{') || t.startsWith('[')) hasStructuredData = true;
          }
        }
        const route = routeModel({
          enabled: routerEnabled,
          mode: routerMode,
          fastModel: provider.model,
          activeModel: provider.model,
          deepModel,
          hasStructuredData,
          hasCodeFiles,
          isFirstTurn: messages.every((m) => m.role !== 'user'),
          previous: previousRoute,
        });
        // AUTO yalnız ÖNERİR (UI'da tek tıkla geçilir). Yalnız açık
        // Hızlı/Derin modu isteği doğrudan yönlendirir.
        const applyRoute = routerMode !== 'auto';
        const usedModel = applyRoute ? (route.model ?? provider.model) : provider.model;
        if (applyRoute && route.model) {
          try {
            localStorage.setItem(routeKey, JSON.stringify({
              providerId: provider.id, model: route.model, task: route.task,
            }));
          } catch { /* yok say */ }
        }
        // Yerel modeller (1–3B) uzun politika ve @T talimatlarında kaybolur;
        // onlara kısa, doğrudan bir sistem istemi gönderilir.
        const localActive = isLocalProvider(provider.id);
        const policyMsgs = directive && !localActive ? [{ role: 'system' as const, content: directive }] : [];
        // Akış: balon hemen görünür, parçalar ~40 ms'de bir boyanır. ChatView
        // metni her zaman biçimli çizer (dondurulmuş bloklar + canlı kuyruk).
        streamingChatIdRef.current = ownerChatId;
        applyMessages(prev => [...prev, {
          role: 'assistant',
          content: '',
          timestamp: ts(),
          modelName: `${provider.name} · ${usedModel}`,
          streaming: true,
        } satisfies Message]);

        let streamed = '';
        let reasoningAcc = '';
        let toolCalls: string[] = [];
        let engineMeta: Message['engine'];
        let flushTimer: number | undefined;
        const paint = () => {
          flushTimer = undefined;
          const contentSnapshot = streamed;
          const reasoningSnapshot = reasoningAcc;
          const toolsSnapshot = toolCalls.length ? [...toolCalls] : undefined;
          applyMessages(prev => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].streaming) {
                copy[i] = {
                  ...copy[i],
                  content: contentSnapshot,
                  reasoning: reasoningSnapshot || undefined,
                  toolActivity: toolsSnapshot,
                };
                break;
              }
            }
            return copy;
          }, true);
        };
        const schedulePaint = () => {
          if (flushTimer !== undefined) return;
          flushTimer = window.setTimeout(paint, 40);
        };
        const stopPaint = () => {
          if (flushTimer !== undefined) {
            window.clearTimeout(flushTimer);
            flushTimer = undefined;
          }
        };
        /** Akışı bitirir: son hâli yazar (yarım cevap SİLİNMEZ, not düşülür). */
        const settle = (patch: Partial<Message>) => {
          stopPaint();
          streamingChatIdRef.current = null;
          // Son araç çağrısı 40 ms'lik boyamaya sığmamış olabilir: bitiş
          // yaması araç geçmişini de kesin taşır.
          const toolsFinal = toolCalls.length ? [...toolCalls] : undefined;
          applyMessages(prev => {
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].streaming) {
                copy[i] = { ...copy[i], ...patch, streaming: false };
                if (toolsFinal) copy[i] = { ...copy[i], toolActivity: toolsFinal };
                break;
              }
            }
            return copy;
          });
        };

        try {
          const res = await aiChatStream([
            {
              role: 'system',
              content: localActive
                ? 'You are Thalamus, a helpful desktop assistant. Answer in the same language the user writes in. Lead with the direct answer; keep it short unless the user asks for detail. Never claim to see files or context you were not given.'
                : 'You are Thalamus, a helpful desktop assistant for coding. Always answer in the same language the user writes in (Turkish user → Turkish answer). ' +
                'Keep prose minimal: at most two short sentences unless the user asks for more detail. ' +
                // Sözcükten bağımsız güvenlik ağı: kullanıcı tercihi her zaman varsayılanı ezer.
                'EXCEPTION: whenever the user asks for more detail, a complete file, or exact/original text — however they phrase it — honor that request; never let the brevity or diff default override an explicit user preference. ' +
                'If the request is genuinely ambiguous and guessing could waste work, ask one short clarifying question instead of guessing. ' +
                'QUESTION PROTOCOL: output ONLY a fenced code block tagged question, containing JSON shaped like ' +
                '{"question":"...","header":"...","options":[{"label":"...","description":"..."}],"multiple":false,"allowOther":true}. ' +
                'Write the question and options in the user’s language. Give 2–4 concrete, mutually exclusive options; ' +
                'use multiple:true only when several apply. Never ask for details already present in the conversation or attached files. ' +
                'If the request is clear enough, answer normally — do not ask a question just to be safe. ' +
                // Kod yanıtı biçimi (ölçülmüş karar, lab TRIALS-014): dosyayı baştan
                // yazmak yerine yalnız değişen satırları `git diff` biçiminde yaz.
                // Çıktı token'ı ~%82 azalıyor; anlama farkı ölçülemedi.
                'When you propose a change to existing code, DO NOT rewrite the whole file. ' +
                'Emit a COMPACT diff inside a single ```diff block, plus a one-line explanation. ' +
                'Format: a line `F <path>`, then hunks. A hunk starts with ' +
                '`@<old_start>[,<old_count>] <new_start>[,<new_count>]`, followed by -removed and ' +
                '+added lines (context lines start with a space). Do NOT emit diff --git/---/+++/@@ ' +
                'headers; the app expands them. Write a file in full ONLY when it is brand new. ' +
                'If the user attaches a file marked as "DEĞİŞMEDİ" (unchanged), its content is already ' +
                'above in this conversation — rely on it and do not ask for it again.',
            },
            ...history,
            ...policyMsgs,
            userMessage(userText),
          ], ctxPlan.blocks, null, signal, { preserve: policy.preserve, model: applyRoute ? route.model ?? undefined : undefined }, {
            onDelta: (chunk) => {
              streamed += chunk;
              schedulePaint();
            },
            onReasoning: (chunk) => {
              reasoningAcc += chunk;
              schedulePaint();
            },
            onMeta: (meta) => {
              if (meta.engine) {
                engineMeta = {
                  originalTokens: meta.engine.original_tokens ?? 0,
                  compressedTokens: meta.engine.compressed_tokens ?? 0,
                  compressedMessages: meta.engine.compressed_messages,
                };
              }
            },
            onToolCall: (name) => {
              toolCalls = [...toolCalls, name];
              schedulePaint();
            },
          });
          if (res.content) streamed = res.content;
          if (res.reasoning) reasoningAcc = res.reasoning;
          const parsed = parseAskQuestion(expandCompactDiff(streamed));
          const hasAnswer = parsed.content.trim().length > 0 || !!parsed.question;
          const hitLimit = res.finishReason === 'length';
          const emptyReply = !hasAnswer
            ? (hitLimit ? t('chat.lengthEmpty') : reasoningAcc.trim() ? t('chat.emptyReasoning') : t('chat.emptyResponse'))
            : '';
          // Ajan çıktısı görünürlüğü: kaydedilen edit'ler ve adım listesi
          // akışta geldiyse mesaja dürüstçe yazılır (App sohbeti dosyaya
          // yazmaz; sessizce yutmak yerine Copilot'a işaret edilir).
          let finalContent = hasAnswer ? parsed.content : emptyReply;
          if (res.edits?.some(e => e.applied)) {
            const files = [...new Set(res.edits!.filter(e => e.applied).map(e => e.file || '?'))];
            finalContent += `\n\n${t('chat.editsNote')}\n${files.map(f => `- \`${f}\``).join('\n')}`;
          }
          if (res.todos?.length) {
            const done = res.todos!.filter(x => x.status === 'done').length;
            const marks = res.todos!.map(x => (x.status === 'done' ? '[x]' : x.status === 'in_progress' ? '[>]' : '[ ]') + ' ' + x.content).join('\n');
            finalContent += `\n\n${t('chat.todoProgress', { done, total: res.todos!.length })}\n${marks}`;
          }
          settle({
            content: finalContent,
            question: parsed.question,
            reasoning: reasoningAcc || undefined,
            latencyMs: Math.round(performance.now() - textStartedAt),
            streamed: true,
            usage: res.usage,
            engine: engineMeta,
            stopped: hitLimit && hasAnswer ? 'length' : undefined,
          });
        } catch (streamErr) {
          const timedOut = String((streamErr as Error)?.message ?? '').includes('TIMEOUT');
          const kind = abortKind() ?? (timedOut ? 'timeout' : null);
          if (!kind && !streamed.trim()) {
            // Hiç metin gelmedi: yarım balon bırakma, normal hata yoluna düş.
            stopPaint();
            streamingChatIdRef.current = null;
            applyMessages(prev => {
              const idx = prev.map(m => !!m.streaming).lastIndexOf(true);
              return idx === -1 ? prev : [...prev.slice(0, idx), ...prev.slice(idx + 1)];
            });
            throw streamErr;
          }
          // Karar: yazılan kısım KALIR; sebebi küçük bir not olarak gösterilir.
          const partial = parseAskQuestion(expandCompactDiff(streamed));
          settle({
            content: partial.content,
            question: partial.question,
            reasoning: reasoningAcc || undefined,
            latencyMs: Math.round(performance.now() - textStartedAt),
            stopped: kind ?? 'error',
            streamed: true,
          });
        }
      }
  } catch (err) {
      const kind = abortKind();
      if (kind) {
        applyMessages(prev => [...prev, {
          role: 'assistant',
          content: kind === 'stop' ? t('chat.requestStopped') : t('chat.requestTimedOut'),
          timestamp: ts(),
          modelName: localEngineStamp(),
        }]);
      } else {
        const x = explainError(err, 'Assistant request');
        // Sohbet balonu zaten hatayi gosteriyor: ayrica toast acmak cift
        // mesaj olurdu. Baslik + aksiyon; tekrar eden ilk cumle atilir.
        applyMessages(prev => [...prev, {
          role: 'assistant',
          content: chatErrorContent(x),
          timestamp: ts(),
          modelName: localEngineStamp(),
        }]);
      }
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
    }
};

  /**
   * Dev olcumu: sohbet gecisinde tiklamadan boyanma anina kadar gecen sure.
   * Uzun suruyorsa konsoldaki [longtask]/[ipc]/[net] satirlari nerede
   * harcandigini gosterir (bkz. lib/perfTrace.ts). Prod'da gorunmez.
   */
  useEffect(() => {
    if (!import.meta.env.DEV || messages.length === 0) return;
    reportSwitchPaint(`chat switch (${messages.length} messages)`);
  }, [messages]);

  /** T2: süren isteği durdurur; fetch AbortError fırlatır, mesaj "Request stopped." yazılır. */
  const handleStopRequest = () => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
  };

  /**
   * ChatView memo'lu: bu handler'lar sabit kimlikli olmali, yoksa her tus
   * vurusunde yeni referans uretilir ve tum mesajlar yeniden reconcile edilir.
   */
  const handleSampleCode = useCallback((code: string) => {
    setInput(code);
    showToast(t('preset.snippetLoaded'), t('preset.snippetLoadedMsg'), 'info');
  }, [showToast]);

  /**
   * Kullanıcı mesajını düzeltip o noktadan yeniden yanıt üretir: düzenlenen
   * mesajın ardındaki her şey atılır, istem yeni bir kullanıcı mesajı olarak
   * gönderilir (görseller korunur).
   */
  const handleEditMessage = async (idx: number, content: string) => {
    if (loading || engineLoading) return;
    const original = messages[idx];
    const history = messages.slice(0, idx);
    setMessages(history);
    await handleSendMessage(content, false, original?.images, undefined, history);
  };

  const handleOpenProjectView = useCallback(() => setCurrentView('project'), []);
  const handleOpenSettings = useCallback(() => setIsSettingsOpen(true), []);

  const handleNucleusAction = (action: NucleusAction) => {
    if (action.type === 'navigate') {
      setCurrentView(action.view);
    } else if (action.type === 'new_chat') {
      handleNewChat();
      setCurrentView('chat');
    } else if (action.type === 'open_settings') {
      setIsSettingsOpen(true);
    } else if (action.type === 'toggle_sidebar') {
      setIsSidebarOpen((open) => !open);
    } else if (action.type === 'stop_generation') {
      handleStopRequest();
    }
  };

  const handleSend = async (e: FormEvent, files?: { name: string; body: string }[]) => {
    e.preventDefault();
    // Bir görsel ya da ekli dosya tek başına geçerli mesajdır; yalnızca hiçbiri
    // yokken engelle.
    const hasFiles = !!files && files.length > 0;
    if ((!input.trim() && pendingImages.length === 0 && !hasFiles) || loading) return;
    const userText = input.trim();
    setInput('');
    await handleSendMessage(userText, false, undefined, files);
  };

  const handleAnswerQuestion = async (idx: number, answer: string) => {
    if (loading || engineLoading) return;
    const text = answer.trim();
    if (!text) return;
    setMessages(prev => prev.map((message, i) => (
      i === idx && message.question ? { ...message, questionAnswer: text } : message
    )));
    await handleSendMessage(text);
  };

  const handleRegenerate = async (assistantIdx: number) => {
    if (loading || engineLoading) return;
    let userText = "";
    let userImages: AttachedImage[] | undefined;
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userText = messages[i].content;
        userImages = messages[i].images;
        break;
      }
    }
    if (!userText && !userImages) {
      // Selamlama gibi kendinden önce kullanıcı mesajı olmayan yanıtlar
      // yeniden üretilemez: sessiz no-op yerine dürüst bilgi.
      showToast(t('chat.nothingToRegen'), t('chat.nothingToRegenMsg'), 'info');
      return;
    }
    setMessages(prev => prev.slice(0, assistantIdx));
    await handleSendMessage(userText, true, userImages);
  };

  const handleExportChat = (chatId: string, format: 'md' | 'json') => {
    const chat = chats.find((item) => item.id === chatId);
    if (!chat) {
      showToast(t('chat.noChat'), t('chat.noChatMsg'), 'info');
      return;
    }
    let exported = messages;
    if (chatId !== activeChatId) {
      try {
        const raw = localStorage.getItem(`thalamus_chat_messages_${chatId}`);
        exported = raw ? (JSON.parse(raw) as Message[]) : [];
      } catch {
        exported = [];
      }
    }
    if (exported.length === 0) {
      showToast(t('chat.noChat'), t('chat.noChatMsg'), 'info');
      return;
    }
    const text = format === 'json'
      ? chatToJson(chat.title, exported)
      : chatToMarkdown(chat.title, exported);
    const filename = `${safeFilename(chat.title)}.${format === 'json' ? 'json' : 'md'}`;
    const mime = format === 'json' ? 'application/json' : 'text/markdown';
    if (!downloadText(filename, text, mime)) {
      showToast(t('toast.exportFailed'), t('toast.exportFailedMsg'), 'error', undefined, '[500] blob download unavailable');
      return;
    }
    showToast(t('toast.chatExported'), t('toast.chatExportedMsg', { name: filename }), 'success');
  };

  const handleCopyChat = () => {
    if (messages.length === 0) {
      showToast(t('chat.noChat'), t('chat.noChatMsg'), 'info');
      return;
    }
    navigator.clipboard
      .writeText(chatToMarkdown(activeChat.title, messages))
      .then(() => showToast(t('chat.copied'), undefined, 'success'))
      .catch(() => showToast(t('chat.copyFailed'), t('chat.copyFailedMsg'), 'error', undefined, '[500] clipboard unavailable'));
  };

  // Remember the configured workspace so it shows up in the projects list.
  useEffect(() => {
    const root = getWorkspaceRoot();
    if (root) {
      rememberProject(root);
      setWorkspaceVersion(v => v + 1);
    }
    // C9: diskte artik olmayan proje girdilerini listedan dusur.
    pruneRecentProjects()
      .then(kept => {
        const root2 = getWorkspaceRoot();
        if (root2 && !kept.some(p => p.root === root2)) rememberProject(root2);
        setWorkspaceVersion(v => v + 1);
      })
      .catch(() => {});
  }, []);

  const handleOpenProject = async (root: string) => {
    // V6: backend klasörü kabul etmezse (silinmis/tasinmis) durust toast;
    // hayalet girdi son kullanilanlardan duser, gorunum degistirilmez.
    const result = await openProject(root);
    if (!result.ok) {
      const openErr = explainError(result.error, 'Project open');
      showToast(
        t('app.projectUnavailable'),
        t('app.projectUnavailableMsg', { root, explanation: openErr.explanation }),
        'error',
        undefined,
        `[${openErr.code}] ${openErr.detail ?? openErr.explanation}`
      );
      setWorkspaceVersion(v => v + 1);
      return;
    }
    setWorkspaceVersion(v => v + 1);
    setCurrentView('project');
  };

  const projectName = getWorkspaceName();
  const activePath = currentView === 'project' 
    ? `projects / ${projectName} / ${activeTab}` 
    : `chats / ${activeChat.title}`;

  const nucleusTranscript = messages
    .slice(-NUCLEUS_LIMITS.transcriptMessages)
    .map((message) => {
      const content = askQuestionHistoryText(message).trim();
      if (!content) return '';
      return `${message.role === 'user' ? 'User' : 'Assistant'}: ${content}`;
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(-NUCLEUS_LIMITS.transcriptChars);

  const paletteActions: PaletteAction[] = [
    {
      id: 'palette:new-chat',
      label: t('palette.newChat'),
      run: () => {
        handleNewChat();
        setCurrentView('chat');
      },
    },
    {
      id: 'palette:settings',
      label: t('palette.settings'),
      run: handleOpenSettings,
    },
    {
      id: 'palette:sidebar',
      label: t('palette.toggleSidebar'),
      run: () => setIsSidebarOpen((open) => !open),
    },
    {
      id: 'palette:project',
      label: t('palette.openProject'),
      run: handleOpenProjectView,
    },
    {
      id: 'palette:chat',
      label: t('palette.chatView'),
      run: () => setCurrentView('chat'),
    },
    {
      id: 'palette:nucleus',
      label: t('nucleus.title'),
      hint: 'Alt+N',
      keywords: 'ai assistant command overlay',
      run: openNucleus,
    },
    {
      id: 'palette:export-md',
      label: t('palette.exportMd'),
      run: () => handleExportChat(activeChatId, 'md'),
    },
    {
      id: 'palette:export-json',
      label: t('palette.exportJson'),
      run: () => handleExportChat(activeChatId, 'json'),
    },
    {
      id: 'palette:copy-chat',
      label: t('palette.copyChat'),
      run: handleCopyChat,
    },
    ...(loading
      ? [{
          id: 'palette:stop',
          label: t('palette.stop'),
          run: handleStopRequest,
        }]
      : []),
    ...chats.slice(0, 12).map((chat) => ({
      id: `palette:chat:${chat.id}`,
      label: chat.title,
      hint: t('palette.chat'),
      keywords: chat.title,
      run: () => {
        markSwitchStart();
        setActiveChatId(chat.id);
        setCurrentView('chat');
      },
    })),
  ];

  if (!user) {
    return <AuthScreen onLogin={(u) => setUser(u)} />;
  }

  return (
    <div className="app-container">
      <div className="header-wrapper">
        <Header
          activePath={activePath}
          onOpenNucleus={toggleNucleus}
          onOpenPalette={() => setIsPaletteOpen(true)}
        />
      </div>

      <div className="body-container">
        <Sidebar 
          currentView={currentView}
          isOpen={isSidebarOpen}
          setCurrentView={setCurrentView}
          setIsOpen={setIsSidebarOpen}
          chats={chats}
          activeChatId={activeChatId}
          onSelectChat={(id) => {
            markSwitchStart();
            setActiveChatId(id);
            setCurrentView('chat');
          }}
          onNewChat={handleNewChat}
          onOpenSettings={() => setIsSettingsOpen(true)}
          user={user}
          userAvatarUrl={user?.avatar}
          onLogout={() => {
            localStorage.removeItem('thalamus_user');
            setUser(null);
          }}
          onDeleteChat={handleDeleteChat}
          onRenameChat={handleRenameChat}
          onPinChat={handlePinChat}
          onExportChat={handleExportChat}
          onOpenProject={handleOpenProject}
          projectsVersion={workspaceVersion}
        />

        <main className="main-content">
          {currentView === 'chat' && (
            <div className="chat-layout">
              {/* Satır sarmalayıcı: chat sütunu + (açıksa) önizleme sütunu.
                  .chat-layout CSS'i column!important olduğu için satır burada. */}
              <div style={{ display: 'flex', flexDirection: 'row', height: '100%', width: '100%', overflow: 'hidden' }}>
              <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div className="message-list" data-chat-scroll style={{ flex: 1, overflowY: 'auto' }}>
                <ChatView
                  messages={messages}
                  loading={loading}
                  loadingLabel={localLoadingLabel ? t('local.loadingModel', { model: localLoadingLabel }) : undefined}
                  userName={user?.name?.trim()?.toLowerCase() === 'guest user' ? '' : (user?.name?.trim() || '')}
                  targetModel={activeModel}
                  onlinePricing={onlinePricing}
                  projectName={projectName}
                  chatEndRef={chatEndRef}
                  chatKey={activeChatId}
                  onSampleCode={handleSampleCode}
                  onOpenProject={handleOpenProjectView}
                  onOpenSettings={handleOpenSettings}
                  onEngineDiagnostic={handleEngineDiagnostic}
                  onRegenerate={handleRegenerate}
                  onEditMessage={handleEditMessage}
                  onAnswerQuestion={handleAnswerQuestion}
                  hasProvider={!!activeProviderId}
                />
              </div>

              {sessionSave.avoidedChars > 0 && (
                <div
                  className="flex items-center gap-2 px-3 py-1 text-[10.5px] font-mono text-[#3AA99F] border-t border-[#34332F]/60 select-none"
                  title={t('session.savedTitle')}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[#3AA99F]" />
                  <span>
                    {t('session.saved', {
                      kb: (sessionSave.avoidedChars / 1024).toFixed(1),
                      tokens: estimateTokens(sessionSave.avoidedChars).toLocaleString('en-US'),
                      files: sessionSave.files,
                      turns: sessionSave.turns,
                    })}
                  </span>
                </div>
              )}
              <div className="command-bar-wrapper" style={{ flexShrink: 0 }}>
                <CommandBar 
                  input={input}
                  loading={loading}
                  onSend={handleSend}
                  onStop={handleStopRequest}
                  setInput={setInput}
                  onSelectProviderModel={selectProviderModel}
                  currentModel={activeModel}
                  activeModelLabel={activeModelLabel}
                  activeProviderId={activeProviderId}
                  onUseLocalEndpoint={useLocalEndpoint}
                  onActivateLocalFile={activateLocalFile}
                  images={pendingImages}
                  setImages={setPendingImages}
                  onOpenPreview={openPreview}
                  onClosePreview={() => setPreviewItem(null)}
                />
              </div>
              </div>

              {previewItem && (
                <>
                  {/* Sol kenar tutamacı: çekip bırakarak önizleme genişliğini ayarla. */}
                  <div
                    onPointerDown={startPreviewResize}
                    title={t('preview.resize')}
                    className="w-[5px] flex-shrink-0 cursor-col-resize bg-transparent hover:bg-[#dcb67a]/40 active:bg-[#dcb67a]/60 transition-colors"
                    role="separator"
                    aria-orientation="vertical"
                  />
                  <div ref={previewColRef} style={{ width: previewWidth, maxWidth: 'calc(100vw - 560px)', flexShrink: 1, minWidth: 320, height: '100%', overflow: 'hidden' }}>
                    <FilePreviewDrawer
                      item={previewItem}
                      onClose={() => setPreviewItem(null)}
                      inline
                      contentWidth={previewContentW}
                    />
                  </div>
                </>
              )}
              </div>
            </div>
          )}

          {/* Proje paneli bir kez açıldıktan sonra unmount EDİLMEZ: görünüm
              değişince yalnız gizlenir. Böylece terminal PTY oturumu ve açık
              sekmeler sohbete geçip dönünce yaşamaya devam eder. */}
          {projectMounted && (
            <div
              style={{
                display: currentView === 'project' ? 'flex' : 'none',
                flexDirection: 'column',
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                height: '100%',
              }}
            >
              <ProjectDashboard
                key={workspaceVersion}
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                onOpenPreview={openPreview}
                onContextChange={handleProjectContext}
                onOpenProject={handleOpenProject}
                previewItem={currentView === 'project' ? previewItem : null}
                onClosePreview={() => setPreviewItem(null)}
              />
            </div>
          )}
        </main>
      </div>
      <CommandPalette
        open={isPaletteOpen}
        onClose={() => setIsPaletteOpen(false)}
        actions={paletteActions}
      />
      <NucleusCommand
        open={isNucleusOpen}
        onClose={() => setIsNucleusOpen(false)}
        context={{
          view: currentView,
          projectName,
          chatTitle: activeChat.title,
          modelLabel: activeModelLabel || activeModel,
          hasProvider: !!activeProviderId,
          messageCount: messages.length,
          activeFile: currentView === 'project' ? (projectContextRef.current.activeFile || activeTab || undefined) : undefined,
          activeFileCode: currentView === 'project' && projectContextRef.current.activeFile === activeTab
            ? projectContextRef.current.code
            : undefined,
          activeFileLine: currentView === 'project' && projectContextRef.current.activeFile === activeTab
            ? projectContextRef.current.cursorLine
            : undefined,
          activeFileSelection: currentView === 'project' && projectContextRef.current.activeFile === activeTab && projectContextRef.current.selection
            ? projectContextRef.current.selection
            : undefined,
          sidebarOpen: isSidebarOpen,
          transcript: nucleusTranscript,
        }}
        onAction={handleNucleusAction}
      />
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        user={user}
        onUpdateUser={(updated) => {
          setUser(updated);
          try { localStorage.setItem('thalamus_user', JSON.stringify(updated)); } catch {}
        }}
        onSaved={() => {
          // Apply theme + default model changes immediately (no relaunch needed)
          let savedTheme: string | null = 'dark';
          try { savedTheme = localStorage.getItem('tlm_theme'); } catch {}
          applyTheme(savedTheme === 'nord-red' ? 'nord-red' : 'dark');
          // Sağlayıcı/model değişikliği 'thalamus_config_changed' ile çözülür.
          // A workspace path may have been set/changed in General — surface it
          // in the projects list and refresh the dashboard.
          const savedRoot = getWorkspaceRoot();
          if (savedRoot) {
            rememberProject(savedRoot);
            setWorkspaceVersion(v => v + 1);
          }
        }}
      />
      
      {showOnboarding && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 select-none font-sans">
          <div className="w-full max-w-md bg-[#1C1B1A] border border-[#34332F] rounded-xl shadow-2xl p-6 flex flex-col gap-4 text-xs animate-in fade-in zoom-in-95 duration-150">
            <div className="flex flex-col gap-1.5">
              <h2 className="text-sm font-semibold text-[#F2F0E5] tracking-tight">{t('onb.title')}</h2>
              <p className="text-[#A8A49E] leading-relaxed text-[11.5px]">
                {t('onb.body')}
              </p>
            </div>
            
            <div className="p-3 bg-[#100F0F]/60 border border-[#34332F] rounded-lg text-[#A8A49E] leading-relaxed text-[11px]">
              <strong className="text-[#CECDC3] block mb-1">{t('onb.effects')}</strong>
              {t('onb.liveLine')}<br/>
              {t('onb.offlineLine')}
            </div>

            <div className="flex items-center justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={() => {
                  localStorage.setItem('tlm_online_pricing', 'false');
                  setOnlinePricing(false);
                  setShowOnboarding(false);
                }}
                className="px-3.5 py-2 rounded-md border border-[#34332F] hover:bg-[#282726] text-[#CECDC3] font-medium transition-colors cursor-pointer"
              >
                {t('onb.offlineBtn')}
              </button>
              <button
                type="button"
                onClick={() => {
                  localStorage.setItem('tlm_online_pricing', 'true');
                  setOnlinePricing(true);
                  setShowOnboarding(false);
                }}
                className="px-3.5 py-2 rounded-md bg-[#3AA99F] hover:bg-[#45B8AD] text-[#100F0F] font-semibold shadow transition-colors cursor-pointer"
              >
                {t('onb.liveBtn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}