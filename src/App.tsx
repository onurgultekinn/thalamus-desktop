import { useState, useRef, useEffect, type FormEvent } from 'react';
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
import type { Message, ChatItem, User } from './types';
export type { Message, MessageMetrics, ChatItem } from './types';
import './App.css';

const getDefaultMessages = (modelName: string): Message[] => {
  return [
    {
      role: 'assistant',
      content: 'Thalamus AI Assistant is ready. Ask questions about your code or projects.',
      timestamp: ts(),
      modelName
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

  const { compressPrompt, isEngineReady, isLoading: engineLoading, checkHealth } = useThalamus();

  /** Welcome card 4: a real engine health check (HTTP + latency). */
  const handleEngineDiagnostic = async () => {
    const t0 = performance.now();
    try {
      const ok = await checkHealth();
      const ms = Math.max(1, Math.round(performance.now() - t0));
      if (ok) {
        showToast('Engine Active', `Local engine is running · ${API_BASE} · ~${ms}ms`, 'success');
      } else {
        showToast('Engine Offline', `Could not reach the engine · ${API_BASE}. Is the backend running?`, 'error');
      }
    } catch {
      showToast('Engine Offline', `Could not reach the engine · ${API_BASE}`, 'error');
    }
  };
  const [loading, setLoading] = useState<boolean>(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

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

  // Load messages whenever activeChatId changes
  useEffect(() => {
    if (!activeChatId) {
      setMessages([]);
      return;
    }
    const savedMsg = localStorage.getItem(`thalamus_chat_messages_${activeChatId}`);
    if (savedMsg) {
      try {
        setMessages(JSON.parse(savedMsg));
      } catch {
        setMessages(getDefaultMessages(targetModel));
      }
    } else {
      setMessages(getDefaultMessages(targetModel));
    }
  }, [activeChatId, targetModel]);

  // Save messages whenever they change. The stored copy is capped (UI keeps
  // everything in memory) and quota failures degrade to a toast instead of
  // crashing the app — localStorage's 5 MB limit is a real boundary.
  useEffect(() => {
    if (activeChatId && messages.length > 0) {
      const toStore = messages.length > MAX_STORED_MESSAGES
        ? messages.slice(-MAX_STORED_MESSAGES)
        : messages;
      try {
        localStorage.setItem(`thalamus_chat_messages_${activeChatId}`, JSON.stringify(toStore));
      } catch {
        try {
          localStorage.setItem(
            `thalamus_chat_messages_${activeChatId}`,
            JSON.stringify(toStore.slice(-50))
          );
        } catch {
          showToast('Storage Full', 'Chat history could not be saved — storage quota exceeded.', 'error');
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
        modelName: targetModel
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
  useEffect(() => {
    if (chatEndRef.current && currentView === 'chat') {
      chatEndRef.current.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages, currentView]);

  const handleSendMessage = async (userText: string, isRegenerate = false) => {
    const nowTime = ts();
    let currentId = activeChatId;

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

    const unitPrice = modelPricing[targetModel] || 0.000003;
    const approxTokens = Math.max(1, Math.ceil(userText.length / 4));
    const userCost = '$' + (approxTokens * unitPrice).toFixed(6);

    const userMsg: Message = {
      role: 'user',
      content: userText.trim() || (pendingImages.length ? `[${pendingImages.length} image${pendingImages.length > 1 ? 's' : ''}]` : userText),
      timestamp: nowTime,
      modelName: targetModel,
      metrics: {
        originalTokens: approxTokens,
        compressedTokens: approxTokens,
        savingsPercentage: 0,
        executionTimeMs: 0,
        classId: 0,
        cost: userCost,
        financialSavings: '+$0.000000'
      }
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
    if (pendingImages.length > 0) {
      const images = pendingImages;
      setPendingImages([]);
      try {
        const provider = await getActiveProvider();
        if (!provider) {
          const fallback = images.map((i) => `- ${i.name}: ${i.summary}`).join('\n');
          applyMessages(prev => [...prev, {
            role: 'assistant',
            content: `No model key is set, so the image was measured on this device instead:\n\n${fallback}\n\nAdd a provider key in Settings to let a vision model look at the image.`,
            timestamp: ts(),
            modelName: targetModel,
          }]);
        } else {
          const res = await aiChat([userMessage(userText.trim() || 'Describe this image in detail.', images.map((i) => ({ url: i.url, detail: i.detail })))]);
          applyMessages(prev => [...prev, {
            role: 'assistant',
            content: res.content,
            timestamp: ts(),
            modelName: targetModel,
          }]);
        }
      } catch (err) {
        applyMessages(prev => [...prev, {
          role: 'assistant',
          content: `⚠️ **Vision request failed:** ${err instanceof Error ? err.message : String(err)}`,
          timestamp: ts(),
          modelName: targetModel,
        }]);
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      // 1. Call the real compression engine (Tauri Rust IPC)
      const startTime = performance.now();
      const metrics = await compressPrompt(userText);
      const elapsed = performance.now() - startTime;

      // Anti-flicker floor only: long enough to avoid a spinner flash, short
      // enough that the engine's real speed is what the user experiences.
      const MIN_LOADING_TIME = 250;
      if (elapsed < MIN_LOADING_TIME) {
        await new Promise(resolve => setTimeout(resolve, MIN_LOADING_TIME - elapsed));
      }

      // If the engine is unreachable, tell the user honestly — never present a
      // fake "successful" passthrough result as a normal compression response.
      if (metrics.degraded) {
        showToast(
          'Compression Unavailable',
          `Could not reach the compression engine (${metrics.error ?? 'unknown error'}). The raw prompt was sent uncompressed.`,
          'error'
        );
      }

      // Real price and savings calculation for the selected model
      const realCost = '$' + (metrics.compressed_tokens * unitPrice).toFixed(6);
      const savedCost = '+$' + (metrics.saved_tokens * unitPrice).toFixed(6);

      // Update the user message's approximate token count with the real count
      applyMessages(prev => {
        const updated = [...prev];
        const lastUserIdx = updated.map(m => m.role).lastIndexOf('user');
        if (lastUserIdx !== -1) {
          updated[lastUserIdx] = {
            ...updated[lastUserIdx],
            metrics: {
              ...updated[lastUserIdx].metrics!,
              originalTokens: metrics.original_tokens,
              compressedTokens: metrics.compressed_tokens,
              cost: '$' + (metrics.compressed_tokens * unitPrice).toFixed(6),
            }
          };
        }
        return updated;
      });

      const responseText = metrics.is_compressed
        ? `Your prompt was successfully compressed by Thalamus Local Compression Engine.\n\n**Compressed Prompt Output (@TLM):**\n\n\`\`\`text\n${metrics.processed_prompt}\n\`\`\``
        : metrics.degraded
          ? `⚠️ **The local compression engine could not be reached** (${metrics.error}). Your prompt was sent as-is, uncompressed.\n\nIn desktop mode the backend runs at \`${API_BASE}\`; start it with \`${'npm run tauri:dev'}\`.`
          : isEngineReady
            ? `Your prompt was analyzed but no compression was needed or it was bypassed by the semantic veto (raw text preserved).`
            : `⚠️ The local compression engine is not connected — this preview runs in a browser, but compression, files and terminal only work inside the desktop app. Launch it with \`npm run tauri:dev\`.`;

      const assistantMsg: Message = {
        role: 'assistant',
        content: responseText,
        timestamp: ts(),
        modelName: targetModel,
        originalCodeSnippet: userText,
        compressedCodeSnippet: metrics.processed_prompt,
        metrics: {
          originalTokens: metrics.original_tokens,
          compressedTokens: metrics.compressed_tokens,
          savingsPercentage: metrics.savings_percentage,
          executionTimeMs: metrics.execution_time_ms,
          classId: metrics.is_compressed ? 1 : 0,
          cost: realCost,
          financialSavings: savedCost
        }
      };

      applyMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      console.error(err);
      applyMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: '⚠️ **Thalamus Compression Engine Error:** Rust backend could not be reached.',
          timestamp: nowTime,
          modelName: targetModel
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

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
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userText = messages[i].content;
        break;
      }
    }
    if (!userText) return;
    setMessages(prev => prev.slice(0, assistantIdx));
    await handleSendMessage(userText, true);
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
      showToast('Project Unavailable', `Could not open ${root}: ${result.error ?? 'unknown error'}. It was removed from the recent list.`, 'error');
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
              <div className="message-list" style={{ flex: 1, overflowY: 'auto' }}>
                <ChatView
                  messages={messages}
                  loading={loading}
                  userName={user?.name?.trim()?.toLowerCase() === 'guest user' ? '' : (user?.name?.trim() || '')}
                  targetModel={targetModel}
                  onlinePricing={onlinePricing}
                  projectName={projectName}
                  chatEndRef={chatEndRef}
                  onSampleCode={(code) => {
                    setInput(code);
                    showToast('Snippet Loaded', 'Sample code loaded into input. Hit send to analyze compression.', 'info');
                  }}
                  onOpenProject={() => setCurrentView('project')}
                  onOpenSettings={() => setIsSettingsOpen(true)}
                  onEngineDiagnostic={handleEngineDiagnostic}
                  onRegenerate={handleRegenerate}
                  onInspectDiff={(msg) => {
                    setSelectedDiffData({
                      originalCode: msg.originalCodeSnippet || msg.content,
                      optimizedCode: msg.compressedCodeSnippet || '',
                      originalTokens: msg.metrics?.originalTokens,
                      compressedTokens: msg.metrics?.compressedTokens,
                      savingsPercentage: msg.metrics?.savingsPercentage,
                      engineTimeMs: msg.metrics?.executionTimeMs
                    });
                    setCurrentView('diff');
                  }}
                />
              </div>

              <div className="command-bar-wrapper" style={{ flexShrink: 0 }}>
                <CommandBar 
                  input={input}
                  loading={loading}
                  onSend={handleSend}
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
            
            <div className="p-3 bg-[#100F0F]/60 border border-[#34332F] rounded-lg text-[#A8A49E] leading-relaxed text-[10.5px]">
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