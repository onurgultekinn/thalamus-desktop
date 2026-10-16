import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react';
import { ts } from './lib/format';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { DiffView } from './components/DiffView';
import { ProjectDashboard } from './components/ProjectDashboard';
import { CommandBar } from './components/CommandBar';
import type { AttachedImage } from './lib/imageAttach';
import { ChatView } from './components/ChatView';
import type { DiffCodeData } from './components/DiffView';
import { useThalamus } from './hooks/useThalamus';
import { SettingsModal } from './components/SettingsModal';
import { AuthScreen } from './components/auth/AuthScreen';
import { useToast } from './components/Toast';
import { API_BASE } from './services/ThalamusClient';
import { aiChat, userMessage, getActiveProvider } from './services/aiClient';
import { DEFAULT_MODEL_NAME, MODEL_PRICING } from './constants';
import { getWorkspaceName, getWorkspaceRoot, openProject, pruneRecentProjects, rememberProject } from './lib/workspace';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { explainError, splitExplanation } from './lib/errors';
import type { Message, ChatItem, User } from './types';
export type { Message, MessageMetrics, ChatItem } from './types';
import './App.css';

// D1: metin sohbeti model ÇAĞIRMAZ — yerel sıkıştırma motoru çalışır.
// Mesaj rozetleri pazarlama modeli adı (Claude/GPT…) değil, gerçekte
// kullanılanı yazar.
const LOCAL_ENGINE_STAMP = 'Local Compression Engine';

const getDefaultMessages = (): Message[] => {
  return [
    {
      role: 'assistant',
      content: 'Thalamus AI Assistant is ready. Ask questions about your code or projects.',
      timestamp: ts(),
      modelName: LOCAL_ENGINE_STAMP
    }
  ];
};

/** Maximum number of messages written to localStorage per chat. */
const MAX_STORED_MESSAGES = 200;

export default function App() {
  const { showToast } = useToast();
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  // Bumped whenever the active project changes so the sidebar list and the
  // project dashboard both refresh.
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  // Images attached to the next message. A model is only called when this is
  // non-empty, so text-only chats keep the zero-model compression path.
  const [pendingImages, setPendingImages] = useState<AttachedImage[]>([]);
  const [currentView, setCurrentView] = useState<'chat' | 'diff' | 'project'>(() => {
    const saved = localStorage.getItem('tlm_start_view');
    return saved === 'project' ? 'project' : 'chat';
  });
  const [targetModel, setTargetModel] = useState<string>(() => {
    return localStorage.getItem('tlm_default_model') || DEFAULT_MODEL_NAME;
  });
  const [input, setInput] = useState<string>('');

  /**
   * The theme is applied via the `html[data-theme]` attribute (rules live in App.css).
   * A single attribute swap replaces the old document.head <style> injection.
   */
  const applyTheme = (theme: 'dark' | 'nord-red') => {
    document.documentElement.setAttribute('data-theme', theme === 'nord-red' ? 'nord-red' : 'dark');
  };

  useEffect(() => {
    let savedTheme: string | null = 'dark';
    try { savedTheme = localStorage.getItem('tlm_theme'); } catch {}
    applyTheme(savedTheme === 'nord-red' ? 'nord-red' : 'dark');
  }, []);

  // T1 close-guard: Rust CloseRequested'i önler ve bu olayı iletir; kirli
  // editör tamponu varsa kullanıcıya sorulur, aksi hâlde destroy ile kapatılır.
  useEffect(() => {
    const win = getCurrentWebviewWindow();
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
        `${dirtyFiles.length} file(s) have unsaved changes: ${names}. Close anyway and lose them? (Tip: Ctrl+S saves.)`
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

  // 🎯 Live data state for DiffView
  const [selectedDiffData, setSelectedDiffData] = useState<DiffCodeData | null>(null);
  
  // ⚙️ Ayarlar paneli state'i
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  
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

  // 💰 Live / local price map state
  const [modelPricing, setModelPricing] = useState<Record<string, number>>(MODEL_PRICING);

  useEffect(() => {
    if (onlinePricing) {
      // Dynamically fetch the latest price list from GitHub/LiteLLM
      fetch('https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json')
        .then(res => res.json())
        .then(data => {
          const updatedPricing = { ...MODEL_PRICING };
          
          if (data['claude-3-5-sonnet-20241022']?.input_cost_per_token) {
            updatedPricing['Claude 3.5 Sonnet'] = data['claude-3-5-sonnet-20241022'].input_cost_per_token;
          }
          if (data['gpt-4o']?.input_cost_per_token) {
            updatedPricing['GPT-4o'] = data['gpt-4o'].input_cost_per_token;
          }
          if (data['deepseek-chat']?.input_cost_per_token) {
            updatedPricing['DeepSeek V3'] = data['deepseek-chat'].input_cost_per_token;
          }
          
          setModelPricing(updatedPricing);
          console.log('✓ Prices updated from live source:', updatedPricing);
        })
        .catch(err => {
          console.log('⚠️ Live price list could not be fetched, built-in list in use:', err);
        });
    } else {
      setModelPricing(MODEL_PRICING);
    }
  }, [onlinePricing]);

  const { isLoading: engineLoading, checkHealth } = useThalamus();

  /** Welcome card 4: a real engine health check (HTTP + latency). */
  const handleEngineDiagnostic = async () => {
    const t0 = performance.now();
    try {
      const ok = await checkHealth();
      const ms = Math.max(1, Math.round(performance.now() - t0));
      if (ok) {
        showToast('Engine Active', `Local engine is running · ${API_BASE} · ~${ms}ms`, 'success');
      } else {
        showToast('Engine Offline', `Could not reach the engine at ${API_BASE}. Restart the app via thalamus_baslat.bat — terminal, explorer and chat need it.`, 'error', undefined, '[503] health check failed');
      }
    } catch {
      showToast('Engine Offline', `Could not reach the engine at ${API_BASE}. Restart the app via thalamus_baslat.bat.`, 'error', undefined, '[503] health check failed');
    }
  };
  const [loading, setLoading] = useState<boolean>(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  // T2: süren AI isteğini iptal etmek için (Stop düğmesi).
  const abortControllerRef = useRef<AbortController | null>(null);

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

  const activeChat = chats.find(c => c.id === activeChatId) || chats[0] || { id: '', title: 'New Chat Session' };

  const [messages, setMessages] = useState<Message[]>([]);
  // Perf: acilista okunan sohbetin hemen geri yazilmasini engelleyen isaret
  // (bkz. kalicilik efektindeki loadedChatRef).
  const loadedChatRef = useRef<string | null>(null);
  /** Sohbet gecisi olcumunun baslangici (dev perf logu icin). */
  const switchT0Ref = useRef<number>(0);

  // Load messages whenever activeChatId changes
  useEffect(() => {
    if (!activeChatId) {
      setMessages([]);
      return;
    }
    const savedMsg = localStorage.getItem(`thalamus_chat_messages_${activeChatId}`);
    if (savedMsg) {
      try {
        loadedChatRef.current = activeChatId;
        setMessages(JSON.parse(savedMsg));
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
          showToast('Storage Full', 'Chat history could not be saved — storage quota exceeded.', 'error', undefined, '[507] localStorage quota exceeded');
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
      title: 'New Chat Session'
    };
    setChats(prev => [newChat, ...prev]);
    setActiveChatId(newId);
    setMessages([
      {
        role: 'assistant',
        content: 'Thalamus AI Assistant is ready. You can ask questions about your project or code snippets.',
        timestamp: ts(),
        modelName: LOCAL_ENGINE_STAMP
      }
    ]);
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
    showToast('Chat Deleted', 'The chat session has been permanently removed.', 'success');
  };

  const handleRenameChat = (chatId: string, newTitle: string) => {
    setChats(prev => prev.map(c => c.id === chatId ? { ...c, title: newTitle } : c));
    showToast('Chat Renamed', 'The chat title was updated successfully.', 'success');
  };

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
    imagesFromRegenerate?: AttachedImage[]
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

    if (!currentId || chats.length === 0) {
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
    const activeImages = pendingImages.length > 0 ? pendingImages : (imagesFromRegenerate ?? []);

    // Rozet gerçekten ne işleyeceğini söyler: görsel → provider yolu, metin →
    // asistan yolu (motor backend'de sessizdir; P2 katmanı orada çalışır).
    const userMsg: Message = {
      role: 'user',
      content: userText.trim() || (activeImages.length ? `[${activeImages.length} image${activeImages.length > 1 ? 's' : ''}]` : userText),
      timestamp: nowTime,
      ...(activeImages.length > 0 ? { modelName: 'Vision model' } : {}),
      ...(activeImages.length > 0 ? { images: activeImages } : {}),
    };

    if (!isRegenerate) {
      setMessages(prev => [...prev, userMsg]);
    }
    setLoading(true);

    // V3: istek sürerken kullanıcı başka sohbete geçerse yanıt bu sohbete
    // dönmeli: hâlâ aynı sohbetteysek ekrana, değilsek o sohbetin kalıcı
    // kopyasına yazılır (dönünce localStorage'dan yüklenecek).
    const ownerChatId = currentId;
    const applyMessages = (fn: (prev: Message[]) => Message[]) => {
      if (activeChatIdRef.current === ownerChatId) {
        setMessages(fn);
        return;
      }
      try {
        const key = `thalamus_chat_messages_${ownerChatId}`;
        const stored = JSON.parse(localStorage.getItem(key) || '[]') as Message[];
        localStorage.setItem(key, JSON.stringify(fn(stored)));
      } catch {}
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
            modelName: 'Local device measurement',
          }]);
        } else {
          // D3/D14: son 8 mesaj baglam gonderilir; regenerate'te yeniden
          // sorulan soru ve yerine uretilecek eski yanit baglama ALINMAZ.
          let historySrc = messages;
          if (isRegenerate) {
            const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
            if (lastUserIdx !== -1) historySrc = messages.slice(0, lastUserIdx);
          }
          const history = historySrc
            .filter(m => typeof m.content === 'string' && m.content.trim().length > 0)
            .slice(-8)
            .map(m => ({ role: m.role, content: m.content as string }));
          const res = await aiChat([
            ...history,
            userMessage(userText.trim() || 'Describe this image in detail.', images.map((i) => ({ url: i.url, detail: i.detail }))),
          ], [], null, signal);
          applyMessages(prev => [...prev, {
            role: 'assistant',
            content: res.content,
            timestamp: ts(),
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
            content: kind === 'stop' ? 'Request stopped.' : '**Request timed out** after 180 s — no response arrived.',
            timestamp: ts(),
            modelName: 'Vision model (request aborted)',
          }]);
        } else {
          const x = explainError(err, 'Vision request');
          // Ham JSON dump gosterilmez. Baslik "ne oldu"yu soyler; tekrar eden
          // ilk cumle atilir, yalniz aksiyon/aciklama satiri kalir.
          applyMessages(prev => [...prev, {
            role: 'assistant',
            content: `**[${x.code}] ${x.title}**\n\n${splitExplanation(x.explanation).rest ?? x.explanation}\n\n*For more info, check the wiki*`,
            timestamp: ts(),
            modelName: 'Vision model (request failed)',
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
          content: '**No AI provider is configured.** Add a key in Settings → Providers to get answers. File explorer, terminal and the compression engine keep working without a key.',
          timestamp: ts(),
          modelName: LOCAL_ENGINE_STAMP,
        }]);
      } else {
        // Regenerate'te yeniden sorulan soru, bağlama tekrar girilmez.
        let historySrc = messages;
        if (isRegenerate) {
          const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
          if (lastUserIdx !== -1) historySrc = messages.slice(0, lastUserIdx);
        }
        const history = historySrc
          .filter(m =>
            typeof m.content === 'string' &&
            m.content.trim().length > 0 &&
            !m.content.startsWith('**[')
          )
          .slice(-8)
          .map(m => ({ role: m.role, content: m.content as string }));
        const res = await aiChat([
          {
            role: 'system',
            content: 'You are Thalamus, a helpful desktop assistant for coding. Always answer in the same language the user writes in (Turkish user → Turkish answer).',
          },
          ...history,
          userMessage(userText),
        ], [], null, signal);
        applyMessages(prev => [...prev, {
          role: 'assistant',
          content: res.content,
          timestamp: ts(),
          modelName: `${provider.name} · ${provider.model}`,
        }]);
      }
  } catch (err) {
      const kind = abortKind();
      if (kind) {
        applyMessages(prev => [...prev, {
          role: 'assistant',
          content: kind === 'stop' ? 'Request stopped.' : '**Request timed out** after 180 s — no response arrived.',
          timestamp: ts(),
          modelName: LOCAL_ENGINE_STAMP,
        }]);
      } else {
        const x = explainError(err, 'Assistant request');
        // Sohbet balonu zaten hatayi gosteriyor: ayrica toast acmak cift
        // mesaj olurdu. Baslik + aksiyon; tekrar eden ilk cumle atilir.
        applyMessages(prev => [...prev, {
          role: 'assistant',
          content: `**[${x.code}] ${x.title}**\n\n${splitExplanation(x.explanation).rest ?? x.explanation}\n\n*For more info, check the wiki*`,
          timestamp: ts(),
          modelName: LOCAL_ENGINE_STAMP,
        }]);
      }
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
    }
};

  /**
   * Dev olcumu: sohbet gecisi kac ms suruyor ve kac mesaj render edildi.
   * Prod build'de gorunmez; konsola sadece DEV'de yazar.
   */
  useEffect(() => {
    if (!import.meta.env.DEV || !switchT0Ref.current) return;
    const ms = Math.round(performance.now() - switchT0Ref.current);
    switchT0Ref.current = 0;
    console.log(`[perf] chat switch → ${ms}ms (${messages.length} messages)`);
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
    showToast('Snippet Loaded', 'Sample code loaded into input. Hit send to analyze compression.', 'info');
  }, [showToast]);

  const handleOpenProjectView = useCallback(() => setCurrentView('project'), []);
  const handleOpenSettings = useCallback(() => setIsSettingsOpen(true), []);

  const handleInspectDiff = useCallback((msg: Message) => {
    // Silinen/olmayan sohbetten gelen eski mesajda İncele artık ölü veriyle
    // diff açmaz — dürüst mesaj görüntülenir.
    if (!chats.some(c => c.id === activeChatId)) {
      showToast('No Chat', 'This message is no longer attached to a chat session — Inspect cannot open.', 'info');
      return;
    }
    setSelectedDiffData({
      originalCode: msg.originalCodeSnippet || msg.content,
      optimizedCode: msg.compressedCodeSnippet || '',
      originalTokens: msg.metrics?.originalTokens,
      compressedTokens: msg.metrics?.compressedTokens,
      savingsPercentage: msg.metrics?.savingsPercentage,
      engineTimeMs: msg.metrics?.executionTimeMs,
      losslessVerified: msg.metrics?.losslessVerified
    });
    setCurrentView('diff');
  }, [chats, activeChatId, showToast]);

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    // An image alone is a valid message; only block when there is neither text nor image.
    if ((!input.trim() && pendingImages.length === 0) || loading) return;
    const userText = input.trim();
    setInput('');
    await handleSendMessage(userText, false);
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
    if (!userText && !userImages) return;
    setMessages(prev => prev.slice(0, assistantIdx));
    await handleSendMessage(userText, true, userImages);
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
        'Project Unavailable',
        `"${root}" could not be opened and was removed from the recent list. ${openErr.explanation}`,
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

  if (!user) {
    return <AuthScreen onLogin={(u) => setUser(u)} />;
  }

  return (
    <div className="app-container">
      <div className="header-wrapper">
        <Header activePath={activePath} targetModel={targetModel} />
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
            if (import.meta.env.DEV) switchT0Ref.current = performance.now();
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
          onOpenProject={handleOpenProject}
          projectsVersion={workspaceVersion}
        />

        <main className="main-content">
          {currentView === 'chat' && (
            <div className="chat-layout" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
              <div className="message-list" data-chat-scroll style={{ flex: 1, overflowY: 'auto' }}>
                <ChatView
                  messages={messages}
                  loading={loading}
                  userName={user?.name?.trim()?.toLowerCase() === 'guest user' ? '' : (user?.name?.trim() || '')}
                  targetModel={targetModel}
                  onlinePricing={onlinePricing}
                  projectName={projectName}
                  chatEndRef={chatEndRef}
                  chatKey={activeChatId}
                  onSampleCode={handleSampleCode}
                  onOpenProject={handleOpenProjectView}
                  onOpenSettings={handleOpenSettings}
                  onEngineDiagnostic={handleEngineDiagnostic}
                  onRegenerate={handleRegenerate}
                  onInspectDiff={handleInspectDiff}
                />
              </div>

              <div className="command-bar-wrapper" style={{ flexShrink: 0 }}>
                <CommandBar 
                  input={input}
                  loading={loading}
                  onSend={handleSend}
                  onStop={handleStopRequest}
                  setInput={setInput}
                  setTargetModel={(m) => {
                    setTargetModel(m);
                    localStorage.setItem('tlm_default_model', m);
                  }}
                  targetModel={targetModel}
                  images={pendingImages}
                  setImages={setPendingImages}
                />
              </div>
            </div>
          )}

          {currentView === 'diff' && (
            <DiffView 
              onCloseDiff={() => setCurrentView('chat')} 
              diffData={selectedDiffData ?? undefined}
              title={activeChat.title}
              modelName={targetModel}
              pricePerToken={modelPricing[targetModel] || 0.000003}
            />
          )}

          {currentView === 'project' && (
            <ProjectDashboard 
              key={workspaceVersion}
              activeTab={activeTab} 
              setActiveTab={setActiveTab} 
            />
          )}
        </main>
      </div>
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
          setTargetModel(localStorage.getItem('tlm_default_model') || DEFAULT_MODEL_NAME);
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
              <h2 className="text-sm font-semibold text-[#F2F0E5] tracking-tight">Live Pricing & Update Permission</h2>
              <p className="text-[#A8A49E] leading-relaxed text-[11.5px]">
                Thalamus fetches the latest AI model prices live from the public registry (GitHub). Token counts still come from the local engine.
              </p>
            </div>
            
            <div className="p-3 bg-[#100F0F]/60 border border-[#34332F] rounded-lg text-[#A8A49E] leading-relaxed text-[11px]">
              <strong className="text-[#CECDC3] block mb-1">Effects of your choice:</strong>
              • <strong>Live Updates (Yes):</strong> Always view costs and dollar-based savings updated in real time.<br/>
              • <strong>Stay Offline (No):</strong> Pricing indicators are hidden, running local offline token estimations only.
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
                No, Stay Offline
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
                Yes, Live Update (Recommended)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}