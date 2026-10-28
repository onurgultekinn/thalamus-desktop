import { useState, useRef, useEffect } from 'react';
import { 
  Plus, 
  MessageSquare, 
  Folder,
  FolderOpen,
  Settings, 
  ChevronLeft, 
  ChevronRight,
  LogOut as LogoutIcon,
  Pencil,
  Trash2,
  Check,
  UserRound,
  ChevronUp,
  X,
  Search,
  Pin,
  PinOff,
  Download,
  MoreHorizontal
} from 'lucide-react';
import type { ChatItem, User } from '../types';
import { getWorkspaceName, getWorkspaceRoot, listRecentProjects, forgetProject, pickFolder } from '../lib/workspace';
import { searchChats, type ChatSearchHit } from '../lib/chatSearch';
import { visiblePlanLabel } from '../lib/plan';
import { useT } from '../lib/i18n';
import { useToast } from './Toast';

interface SidebarProps {
  currentView: 'chat' | 'project';
  isOpen: boolean;
  setCurrentView: (view: 'chat' | 'project') => void;
  setIsOpen: (open: boolean) => void;
  chats?: ChatItem[];
  activeChatId?: string;
  onSelectChat?: (id: string) => void;
  onNewChat?: () => void;
  onOpenSettings?: () => void;
  user?: User | null;
  onLogout?: () => void;
  userAvatarUrl?: string;
  onDeleteChat?: (id: string) => void;
  onRenameChat?: (id: string, title: string) => void;
  onPinChat?: (id: string, pinned: boolean) => void;
  onExportChat?: (id: string, format: 'md' | 'json') => void;
  onOpenProject?: (root: string) => void;
  projectsVersion?: number;
}

export function Sidebar({ 
  currentView, 
  isOpen, 
  setCurrentView, 
  setIsOpen,
  chats = [],
  activeChatId,
  onSelectChat,
  onNewChat,
  onOpenSettings,
  user,
  onLogout,
  userAvatarUrl,
  onDeleteChat,
  onRenameChat,
  onPinChat,
  onExportChat,
  onOpenProject,
  projectsVersion
}: SidebarProps) {
  const t = useT();
  const { showToast } = useToast();
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [isNewBtnHovered, setIsNewBtnHovered] = useState(false);
  const [projects, setProjects] = useState(() => listRecentProjects());
  const [sessionMenu, setSessionMenu] = useState<'closed' | 'split' | 'project'>('closed');
  // "Open project" opens the OS-native folder picker directly (no typed path).
  const handleChooseFolder = async () => {
    try {
      const selected = await pickFolder(t('sidebar.chooseFolder'));
      if (selected) { setSessionMenu('closed'); onOpenProject?.(selected); }
    } catch (e) {
      showToast(t('sidebar.chooseFolder'), String(e), 'error');
    }
  };
  // Destructive actions are two-step: first click arms, second confirms.
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'chat' | 'project'; id: string } | null>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);

  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState<string>("");
  // Sohbet satırının "⋯" menüsü: açıkken hangi sohbete ait olduğu.
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);

  // Menü açıkken dışarı tık / Escape kapatır.
  useEffect(() => {
    if (!rowMenuId) return;
    const close = () => setRowMenuId(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setRowMenuId(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); };
  }, [rowMenuId]);

  // Sohbet araması: yazarken kısa bir gecikmeyle tüm sohbetlerin mesajları
  // taranır (localStorage okuması senkron; her tuşta yapılmaz).
  const [chatQuery, setChatQuery] = useState('');
  const [searchHits, setSearchHits] = useState<ChatSearchHit[]>([]);

  useEffect(() => {
    const q = chatQuery.trim();
    if (q.length < 2) {
      setSearchHits([]);
      return;
    }
    const id = window.setTimeout(() => setSearchHits(searchChats(q, chats)), 140);
    return () => window.clearTimeout(id);
  }, [chatQuery, chats]);

  /** Sabitlenen sohbetler listede önce gelir; kendi içinde sıra korunur. */
  const orderedChats = [...chats].sort(
    (a, b) => Number(!!b.pinned) - Number(!!a.pinned)
  );

  // Profile menu: closes on outside click and Escape.
  useEffect(() => {
    if (!profileMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setProfileMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [profileMenuOpen]);

  // Refresh the recent-projects list when the app reports a change or the sidebar reopens.
  useEffect(() => {
    setProjects(listRecentProjects());
  }, [projectsVersion, isOpen]);

  // An armed delete disarms itself if the user does nothing for a few seconds.
  useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => setPendingDelete(null), 4000);
    return () => clearTimeout(t);
  }, [pendingDelete]);

  // New-session menu: closes on outside click and Escape.
  useEffect(() => {
    if (sessionMenu === 'closed') return;
    const onDown = (e: MouseEvent) => {
      if (sessionMenuRef.current && !sessionMenuRef.current.contains(e.target as Node)) {
        setSessionMenu('closed');
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSessionMenu('closed');
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [sessionMenu]);

  // Display name: falls back to "Anonymous User" when missing or when it is the
  // legacy "Guest User" value (the person may want to stay anonymous — no "guest" tag).
  const rawName = user?.name?.trim();
  const displayName =
    rawName && rawName.toLowerCase() !== 'guest user' ? rawName : t('sidebar.anonymous');
  // Optional plan label; hidden entirely while the plan feature is off.
  const planLabel = visiblePlanLabel(user);

  const activeRoot = getWorkspaceRoot();
  const projectName = getWorkspaceName();

  return (
    <aside 
      className="h-full bg-obsidian-bg border-r border-obsidian-border flex flex-col justify-between p-4 flex-shrink-0 text-[11px] text-obsidian-muted transition-all duration-200 ease-in-out relative select-none"
      /* Genişlik inline style ile veriliyor, Tailwind sınıfıyla değil:
         `w-[220px]`/`w-[64px]` sınıfları çalışırken aynı anda üretilen
         `max-w-*` kuralı eski değeri tutup daralmayı engelliyordu (ölçüldü:
         sınıf w-[64px] iken hesaplanan genişlik 220px kalıyordu). Inline
         style sınıf sırasından bağımsız ve deterministik. minWidth: 0 ise
         flex öğesinin varsayılan `min-width: auto` dayatmasını kaldırır —
         onsuz içerik 220px'in altına inmiyordu. */
      style={{ width: isOpen ? 220 : 64, minWidth: 0, maxWidth: isOpen ? 220 : 64 }}
    >
      <button 
        type="button"
        onClick={() => setIsOpen(!isOpen)} 
        aria-label={isOpen ? t('sidebar.collapse') : t('sidebar.expand')}
        aria-expanded={isOpen}
        className="absolute top-1/2 -right-2.5 -translate-y-1/2 w-5 h-5 bg-obsidian-panel border border-obsidian-border rounded-full flex items-center justify-center text-obsidian-muted hover:border-obsidian-muted/40 hover:text-obsidian-text cursor-pointer z-50 transition-colors duration-150"
        title={isOpen ? t('sidebar.collapse') : t('sidebar.expand')}
      >
        {isOpen ? <ChevronLeft size={11} /> : <ChevronRight size={11} />}
      </button>

      <div className="flex flex-col gap-2.5 w-full flex-1 min-h-0 overflow-hidden">
        
        {/* NEW SESSION — splits into Chat / Project when opened */}
        <div className="relative w-full" ref={sessionMenuRef}>
          <div className="relative h-9 w-full">
            {/* idle: single button */}
            <button
              type="button"
              onClick={() => {
                if (!isOpen) setIsOpen(true);
                setSessionMenu(m => (m === 'closed' ? 'split' : 'closed'));
              }}
              onMouseEnter={() => setIsNewBtnHovered(true)}
              onMouseLeave={() => setIsNewBtnHovered(false)}
              aria-expanded={sessionMenu !== 'closed'}
              aria-hidden={sessionMenu !== 'closed'}
              disabled={sessionMenu !== 'closed'}
              tabIndex={sessionMenu === 'closed' ? 0 : -1}
              title={t('sidebar.newSession')}
              className={`absolute inset-0 flex items-center gap-2 p-2 rounded-md border transition-all duration-300 ease-out ${
                isOpen ? 'justify-start pl-3' : 'justify-center'
              } ${
                sessionMenu === 'closed'
                  ? 'opacity-100 scale-100'
                  : 'pointer-events-none opacity-0 scale-90'
              }`}
              style={{
                backgroundColor: isNewBtnHovered ? '#575654' : '#282f3d',
                borderColor: isNewBtnHovered ? '#575654' : '#353f4f',
                color: isNewBtnHovered ? '#F2F0E5' : '#A8A49E'
              }}
            >
              <Plus size={14} className="flex-shrink-0" />
              {isOpen && <span className="text-[12px] font-medium">{t('sidebar.newSession')}</span>}
            </button>

            {/* split: chat | project */}
            <div
              className={`absolute inset-0 flex gap-1.5 transition-all duration-300 ease-out ${
                sessionMenu === 'closed' ? 'pointer-events-none opacity-0 scale-90' : 'opacity-100 scale-100'
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  setSessionMenu('closed');
                  setCurrentView('chat');
                  if (onNewChat) onNewChat();
                }}
                title={t('sidebar.newChat')}
                className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 rounded-md border border-[#353f4f] bg-[#282f3d] text-[#A8A49E] hover:border-[#575654] hover:bg-[#575654] hover:text-obsidian-text cursor-pointer transition-colors ${
                  isOpen ? 'text-[11.5px] font-medium' : ''
                }`}
              >
                <MessageSquare size={13} className="flex-shrink-0" />
                {isOpen && <span className="truncate">{t('sidebar.chat')}</span>}
              </button>
              <button
                type="button"
                onClick={handleChooseFolder}
                title={t('sidebar.openProject')}
                className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 rounded-md border border-[#353f4f] bg-[#282f3d] text-[#A8A49E] hover:border-[#575654] hover:bg-[#575654] hover:text-obsidian-text cursor-pointer transition-colors ${
                  isOpen ? 'text-[11.5px] font-medium' : ''
                }`}
              >
                <FolderOpen size={13} className="flex-shrink-0" />
                {isOpen && <span className="truncate">{t('sidebar.project')}</span>}
              </button>
            </div>
          </div>

          {/* open project → OS-native folder picker (direct; recents listed below) */}
        </div>

        <div className="flex flex-col w-full flex-1 min-h-0 overflow-y-auto overflow-x-hidden pretty-scrollbar">
        {/* PROJECTS Group — most recently opened first */}
        <div className="flex flex-col gap-0.5 w-full mt-1">
          {isOpen && (
            /* Semantik başlık: ekran okuyucu bölümler arasında gezinebilsin.
               Tailwind preflight h2'yi görsel olarak nötrler, sınıflar aynı
               kaldığı için görünüm değişmez. */
            <h2 className="px-1.5 mb-2 text-[11px] font-semibold uppercase tracking-widest text-obsidian-muted">
              {t('sidebar.projects')}
            </h2>
          )}

          {!isOpen && (
            <button
              type="button"
              onClick={() => setCurrentView('project')}
              title={projectName}
              className="w-full flex justify-center p-1.5 rounded-md text-obsidian-muted hover:bg-obsidian-panel/30 hover:text-obsidian-text cursor-pointer transition-colors"
            >
              {/* Kapalı kenar çubuğunda da doğru durum: proje gerçekten açıkken
                  açık klasör, aksi halde kapalı klasör ikonu. */}
              {currentView === 'project'
                ? <FolderOpen size={13} className="text-[#dcb67a]" />
                : <Folder size={13} className="opacity-70" />}
            </button>
          )}

          {isOpen && projects.length === 0 && (
            <span className="px-2 py-1 text-[11px] text-obsidian-muted/60">{t('sidebar.noProjects')}</span>
          )}

          {isOpen && projects.map(project => {
            // Highlight the open project only while the project view is showing;
            // in chat view the list stays neutral.
            const isActive = currentView === 'project' && activeRoot === project.root;

            if (pendingDelete?.kind === 'project' && pendingDelete.id === project.root) {
              return (
                <div
                  key={project.root}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-[#2b1918] border border-rose-600/40"
                >
                  <Trash2 size={12} className="text-rose-400 flex-shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-[11px] text-rose-200">{t('sidebar.removeFromListQ')}</span>
                  <button
                    type="button"
                    onClick={() => { setProjects(forgetProject(project.root)); setPendingDelete(null); }}
                    title={t('common.remove')}
                    className="text-rose-300 hover:text-rose-200 p-0.5 cursor-pointer"
                  >
                    <Check size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(null)}
                    title={t('common.cancel')}
                    className="text-obsidian-muted hover:text-obsidian-soft p-0.5 cursor-pointer"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            }

            return (
              <div
                key={project.root}
                className={`group/project w-full flex items-center rounded-md border border-transparent transition-colors duration-150 ${
                  isActive
                    ? 'text-obsidian-text'
                    : 'text-obsidian-muted hover:bg-obsidian-panel/30 hover:text-obsidian-text'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onOpenProject?.(project.root)}
                  title={project.root}
                  className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-left"
                >
                  {/* Aktif proje: acik klasor + pop animasyonu. Digerleri: kapali klasor. */}
                  {isActive ? (
                    <FolderOpen
                      key={`open-${project.root}`}
                      size={13}
                      className="flex-shrink-0 text-[#dcb67a] folder-pop"
                    />
                  ) : (
                    <Folder
                      key={`closed-${project.root}`}
                      size={13}
                      className="flex-shrink-0 opacity-50"
                    />
                  )}
                  <span className="truncate text-[11.5px]">{project.name}</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDelete({ kind: 'project', id: project.root });
                  }}
                  title={t('sidebar.removeFromList')}
                  className="flex-shrink-0 pr-2 opacity-0 group-hover/project:opacity-100 text-obsidian-muted hover:text-rose-400 cursor-pointer transition-opacity"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>

        {/* CHATS Group */}
        <div className="flex flex-col gap-0.5 w-full mt-4">
          {/* Başlık ile arama arasında dengeli nefes payı: başlık 8px, arama
              kutusundan sonra da aynı ritim korunur. */}
          {isOpen && <h2 className="px-1.5 mb-2 text-[11px] font-semibold uppercase tracking-widest text-obsidian-muted">{t('sidebar.chats')}</h2>}

          {/* Arama: başlık + mesaj içeriği; sonuçlar aşağıda listelenir.
              Kutu kompakt: listeye baskın gelmesin. */}
          {isOpen && (
            <div className="relative mb-1.5 mx-0.5">
              <Search size={10} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-obsidian-muted/60" />
              <input
                type="text"
                value={chatQuery}
                onChange={(e) => setChatQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setChatQuery(''); }}
                placeholder={t('sidebar.searchPlaceholder')}
                spellCheck={false}
                autoComplete="off"
                className="w-full rounded-md border border-white/[0.06] bg-white/[0.02] py-[3px] pl-6 pr-5 text-[10.5px] text-obsidian-text outline-none transition-colors placeholder:text-obsidian-muted/45 focus:border-[#dcb67a]/40"
              />
              {chatQuery && (
                <button
                  type="button"
                  onClick={() => setChatQuery('')}
                  title={t('common.cancel')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 cursor-pointer rounded p-0.5 text-obsidian-muted hover:text-obsidian-text"
                >
                  <X size={10} />
                </button>
              )}
            </div>
          )}

          {isOpen && !!chatQuery.trim() && (
            <div className="flex flex-col gap-0.5 w-full">
              <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-obsidian-muted/40">
                {t('sidebar.searchResults', { n: searchHits.length })}
              </span>
              {chatQuery.trim().length === 1 && (
                <span className="px-2 py-1 text-[11px] text-obsidian-muted/60">{t('sidebar.searchMin')}</span>
              )}
              {searchHits.length === 0 && chatQuery.trim().length >= 2 && (
                <span className="px-2 py-1 text-[11px] text-obsidian-muted/60">{t('sidebar.noSearchResults')}</span>
              )}
              {searchHits.map((hit) => (
                <button
                  key={`${hit.chatId}-${hit.messageIndex}`}
                  type="button"
                  onClick={() => {
                    onSelectChat?.(hit.chatId);
                    setChatQuery('');
                  }}
                  title={`${hit.chatTitle} · ${hit.snippet}`}
                  className="w-full rounded-md px-2 py-1 text-left transition-colors hover:bg-obsidian-panel/40"
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <MessageSquare size={10} className="flex-shrink-0 text-[#dcb67a]/70" />
                    <span className="truncate text-[11px] font-medium text-obsidian-soft">{hit.chatTitle}</span>
                    {/* Rol rozeti okumaya karışmasın: minik ve soluk. */}
                    <span className="ml-auto flex-shrink-0 rounded border border-white/[0.06] px-1 py-px text-[8px] uppercase tracking-wide text-obsidian-muted/40">
                      {hit.role === 'user' ? t('sidebar.you') : t('chat.thalamus')}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] leading-snug text-obsidian-muted/70">
                    {hit.snippet}
                  </span>
                </button>
              ))}
            </div>
          )}

          {!chatQuery.trim() && orderedChats.map(chat => {
            const isActive = currentView === 'chat' && activeChatId === chat.id;

            if (editingChatId === chat.id) {
              return (
                <div 
                  key={chat.id}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md bg-white/[0.04] border border-white/[0.08]"
                >
                  <MessageSquare size={13} className="text-obsidian-text flex-shrink-0" />
                  <input
                    type="text"
                    autoFocus
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={() => {
                      if (editTitle.trim() && onRenameChat) {
                        onRenameChat(chat.id, editTitle.trim());
                      }
                      setEditingChatId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        if (editTitle.trim() && onRenameChat) {
                          onRenameChat(chat.id, editTitle.trim());
                        }
                        setEditingChatId(null);
                      } else if (e.key === 'Escape') {
                        setEditingChatId(null);
                      }
                    }}
                    className="flex-1 min-w-0 bg-transparent text-white text-[11.5px] outline-none border-none p-0 font-sans"
                  />
                  <button
                    type="button"
                    aria-label={t('sidebar.renameSave')}
                    className="text-emerald-400 hover:text-emerald-300 p-0.5 cursor-pointer"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (editTitle.trim() && onRenameChat) {
                        onRenameChat(chat.id, editTitle.trim());
                      }
                      setEditingChatId(null);
                    }}
                  >
                    <Check size={12} />
                  </button>
                </div>
              );
            }

            if (pendingDelete?.kind === 'chat' && pendingDelete.id === chat.id) {
              return (
                <div
                  key={chat.id}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-[#2b1918] border border-rose-600/40"
                >
                  <Trash2 size={12} className="text-rose-400 flex-shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-[11px] text-rose-200">{t('sidebar.deleteChatQ')}</span>
                  <button
                    type="button"
                    onClick={() => { if (onDeleteChat) onDeleteChat(chat.id); setPendingDelete(null); }}
                    title={t('common.delete')}
                    className="text-rose-300 hover:text-rose-200 p-0.5 cursor-pointer"
                  >
                    <Check size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(null)}
                    title={t('common.cancel')}
                    className="text-obsidian-muted hover:text-obsidian-soft p-0.5 cursor-pointer"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            }

            return (
              <div
                key={chat.id}
                className={`w-full group relative flex items-center rounded-md border border-transparent transition-colors duration-150 ${
                  isActive
                    ? 'bg-white/[0.06] text-obsidian-text'
                    : 'text-obsidian-muted hover:bg-obsidian-panel/30 hover:text-obsidian-text'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (onSelectChat) onSelectChat(chat.id);
                  }}
                  className={`flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors duration-150 cursor-pointer ${
                    isOpen ? 'justify-start' : 'justify-center'
                  }`}
                  // Başlıksız (henüz adlandırılmamış) sohbetlerde düğme
                  // tamamen isimsiz kalıyordu; ekran okuyucu için fallback.
                  aria-label={chat.title || t('sidebar.untitledChat')}
                  title={chat.title}
                >
                  {/* Aktif sohbet: pop animasyonlu ikon. Digerleri: sade, soluk. */}
                  {isActive ? (
                    <MessageSquare key={`chat-open-${chat.id}`} size={13} className="flex-shrink-0 text-[#C6C0B2] chat-pop" />
                  ) : (
                    <MessageSquare size={13} className="flex-shrink-0 opacity-50" />
                  )}
                  {/* Eylem düğmeleri satırın içinden çıkarıldı: başlık artık
                      tam genişlikte akar, yarıya kadar "…" ile kırpılmaz. */}
                  {isOpen && <span className="truncate text-[11.5px]">{chat.title}</span>}
                  {isOpen && chat.pinned && (
                    <Pin size={9} className="ml-auto flex-shrink-0 text-[#dcb67a]/80" aria-label={t('sidebar.pinned')} />
                  )}
                </button>

                {/* Eylemler: hover'da yalnız TEK bir "⋯" düğmesi belirir
                    (satır sağ kenarında, başlığın sonuna oturur). Menüye
                    tıklayınca Pin/Dışa aktar/Yeniden adlandır/Sil listesi
                    açılır — ne başlığın yarısı yiten sabit butonlar ne de
                    alttaki satırı örten bir şerit. */}
                {isOpen && (
                  <button
                    type="button"
                    aria-label={t('sidebar.chatActions')}
                    // Dışarı-tık kapatıcısı bu mousedown'u görmesin: aksi halde
                    // menü kapanıp click ile yeniden açılıyor (kapatılamıyordu).
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRowMenuId(rowMenuId === chat.id ? null : chat.id);
                    }}
                    className={`absolute right-1 top-1/2 z-30 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded cursor-pointer text-obsidian-muted opacity-0 transition-opacity hover:text-obsidian-text focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ${
                      rowMenuId === chat.id ? 'opacity-100 text-obsidian-text' : ''
                    }`}
                  >
                    <MoreHorizontal size={12} />
                  </button>
                )}
                {rowMenuId === chat.id && (
                  <div
                    className="absolute right-1 top-[calc(100%+2px)] z-40 w-[170px] rounded-md border border-white/[0.08] bg-obsidian-panel py-1 shadow-[0_14px_32px_-12px_rgba(0,0,0,0.9)]"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => { setRowMenuId(null); onPinChat?.(chat.id, !chat.pinned); }}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-obsidian-soft hover:bg-white/[0.05] hover:text-obsidian-text cursor-pointer transition-colors"
                    >
                      {chat.pinned ? <PinOff size={12} className="text-[#dcb67a]" /> : <Pin size={12} className="text-obsidian-muted" />}
                      {chat.pinned ? t('sidebar.unpin') : t('sidebar.pin')}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setRowMenuId(null); onExportChat?.(chat.id, 'md'); }}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-obsidian-soft hover:bg-white/[0.05] hover:text-obsidian-text cursor-pointer transition-colors"
                    >
                      <Download size={12} className="text-obsidian-muted" /> {t('sidebar.exportChat')}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setRowMenuId(null); setEditingChatId(chat.id); setEditTitle(chat.title); }}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-obsidian-soft hover:bg-white/[0.05] hover:text-obsidian-text cursor-pointer transition-colors"
                    >
                      <Pencil size={12} className="text-obsidian-muted" /> {t('sidebar.renameChat')}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setRowMenuId(null); setPendingDelete({ kind: 'chat', id: chat.id }); }}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-[#D14D41] hover:bg-rose-500/10 hover:text-[#E0685C] cursor-pointer transition-colors"
                    >
                      <Trash2 size={12} /> {t('sidebar.deleteChat')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </div>
      </div>

      {/* FOOTER: ACCOUNT */}
      <div className="flex flex-col w-full pt-3 mt-2 border-t border-obsidian-border/50 flex-shrink-0">

        <div className="relative" ref={profileMenuRef}>
          {profileMenuOpen && isOpen && (
            <div className="absolute bottom-full left-0 right-0 mb-1.5 overflow-hidden rounded-md bg-obsidian-panel border border-[#282726] shadow-[0_12px_32px_-14px_rgba(0,0,0,0.8)] z-50">

              <div className="p-1">
                <button
                  type="button"
                  onClick={() => { setProfileMenuOpen(false); if (onOpenSettings) onOpenSettings(); }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[#A8A49E] hover:bg-obsidian-surface hover:text-obsidian-text text-left cursor-pointer transition-colors"
                >
                  <Settings size={14} className="flex-shrink-0" />
                  <span className="flex-1 text-[12px]">{t('common.settings')}</span>
                </button>
              </div>

              <div className="border-t border-[#282726]" />

              <div className="p-1">
                <button
                  type="button"
                  onClick={() => { setProfileMenuOpen(false); if (onLogout) onLogout(); }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[#A8A49E] hover:bg-obsidian-surface hover:text-[#D14D41] text-left cursor-pointer transition-colors"
                >
                  <LogoutIcon size={14} className="flex-shrink-0" />
                  <span className="flex-1 text-[12px]">{t('sidebar.signOut')}</span>
                </button>
              </div>
            </div>
          )}

          {/* Trigger */}
          <button
            type="button"
            onClick={() => {
              if (!isOpen) {
                setIsOpen(true);
                setProfileMenuOpen(true);
              } else {
                setProfileMenuOpen(v => !v);
              }
            }}
            title={profileMenuOpen ? t('sidebar.closeMenu') : t('sidebar.menu', { name: displayName })}
            aria-expanded={profileMenuOpen}
            aria-haspopup="menu"
            className={`group w-full flex items-center rounded-md border p-1.5 cursor-pointer transition-colors duration-150 ${
              isOpen ? 'justify-start gap-2.5' : 'justify-center'
            } ${
              profileMenuOpen
                ? 'bg-obsidian-surface border-[#3a3936]'
                : 'border-transparent hover:bg-obsidian-panel/40'
            }`}
          >
            <span className="w-7 h-7 rounded-full bg-obsidian-surface border border-[#3a3936] flex items-center justify-center flex-shrink-0 overflow-hidden text-obsidian-muted group-hover:text-obsidian-soft transition-colors">
              {userAvatarUrl ? (
                <img src={userAvatarUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <UserRound size={13} />
              )}
            </span>
            {isOpen && (
              <>
                <span className="min-w-0 flex-1 flex flex-col items-start leading-tight text-left">
                  <span className="text-[12px] text-obsidian-soft group-hover:text-obsidian-text truncate w-full transition-colors">{displayName}</span>
                  {planLabel && (
                    <span className="text-[11px] text-obsidian-muted truncate w-full">{planLabel}</span>
                  )}
                </span>
                <ChevronUp
                  size={12}
                  className={`flex-shrink-0 text-obsidian-muted transition-transform duration-150 ${
                    profileMenuOpen ? 'rotate-180' : ''
                  }`}
                />
              </>
            )}
          </button>
        </div>

      </div>
    </aside>
  );
}