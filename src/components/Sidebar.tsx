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
  X
} from 'lucide-react';
import type { ChatItem, User } from '../types';
import { getWorkspaceName, getWorkspaceRoot, listRecentProjects, forgetProject } from '../lib/workspace';
import { visiblePlanLabel } from '../lib/plan';
import { useT } from '../lib/i18n';

interface SidebarProps {
  currentView: 'chat' | 'diff' | 'project';
  isOpen: boolean;
  setCurrentView: (view: 'chat' | 'diff' | 'project') => void;
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
  onOpenProject,
  projectsVersion
}: SidebarProps) {
  const t = useT();
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [isNewBtnHovered, setIsNewBtnHovered] = useState(false);
  const [projects, setProjects] = useState(() => listRecentProjects());
  const [sessionMenu, setSessionMenu] = useState<'closed' | 'split' | 'project'>('closed');
  const [projectPath, setProjectPath] = useState('');
  // Destructive actions are two-step: first click arms, second confirms.
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'chat' | 'project'; id: string } | null>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);

  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState<string>("");

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
      className={`h-full bg-obsidian-bg border-r border-obsidian-border flex flex-col justify-between p-4 flex-shrink-0 text-[11px] text-obsidian-muted transition-all duration-200 ease-in-out relative select-none ${
        isOpen ? 'w-[220px]' : 'w-[64px]'
      }`}
    >
      <button 
        type="button"
        onClick={() => setIsOpen(!isOpen)} 
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
                className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 rounded-md border border-[#353f4f] bg-[#282f3d] text-[#A8A49E] hover:border-[#575654] hover:bg-[#575654] hover:text-[#F2F0E5] cursor-pointer transition-colors ${
                  isOpen ? 'text-[11.5px] font-medium' : ''
                }`}
              >
                <MessageSquare size={13} className="flex-shrink-0" />
                {isOpen && <span className="truncate">{t('sidebar.chat')}</span>}
              </button>
              <button
                type="button"
                onClick={() => setSessionMenu(m => (m === 'project' ? 'split' : 'project'))}
                title={t('sidebar.openProject')}
                className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 rounded-md border cursor-pointer transition-colors ${
                  sessionMenu === 'project'
                    ? 'border-[#575654] bg-[#575654] text-[#F2F0E5]'
                    : 'border-[#353f4f] bg-[#282f3d] text-[#A8A49E] hover:border-[#575654] hover:bg-[#575654] hover:text-[#F2F0E5]'
                } ${isOpen ? 'text-[11.5px] font-medium' : ''}`}
              >
                <FolderOpen size={13} className="flex-shrink-0" />
                {isOpen && <span className="truncate">{t('sidebar.project')}</span>}
              </button>
            </div>
          </div>

          {/* project path prompt */}
          {sessionMenu === 'project' && isOpen && (
            <div className="mt-1.5 w-full overflow-hidden rounded-md border border-[#282726] bg-[#1C1B1A] p-2">
              <label className="block px-0.5 pb-1.5 text-[11px] font-mono uppercase tracking-wider text-[#87857F]">
                {t('sidebar.projectPath')}
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  autoFocus
                  value={projectPath}
                  onChange={(e) => setProjectPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const p = projectPath.trim();
                      if (p) { setProjectPath(''); setSessionMenu('closed'); onOpenProject?.(p); }
                    }
                  }}
                  placeholder="C:\\dev\\my-project"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1.5 font-mono text-[11.5px] text-[#F2F0E5] placeholder-white/20 focus:border-[#575654] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    const p = projectPath.trim();
                    if (p) { setProjectPath(''); setSessionMenu('closed'); onOpenProject?.(p); }
                  }}
                  className="flex-shrink-0 rounded-md border border-[#353f4f] bg-[#282f3d] px-2.5 py-1.5 text-[11.5px] font-medium text-[#CECDC3] hover:border-[#575654] hover:bg-[#575654] hover:text-[#F2F0E5] cursor-pointer transition-colors"
                >
                  {t('common.open')}
                </button>
              </div>
              <p className="px-0.5 pt-1.5 text-[11px] leading-snug text-[#87857F]">
                {t('sidebar.tipRecent')}
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-col w-full flex-1 min-h-0 overflow-y-auto overflow-x-hidden pretty-scrollbar">
        {/* PROJECTS Group — most recently opened first */}
        <div className="flex flex-col gap-0.5 w-full mt-1">
          {isOpen && (
            <span className="px-1.5 mb-0.5 text-[11px] font-semibold uppercase tracking-widest text-obsidian-muted/50">
              {t('sidebar.projects')}
            </span>
          )}

          {!isOpen && (
            <button
              type="button"
              onClick={() => setCurrentView('project')}
              title={projectName}
              className="w-full flex justify-center p-1.5 rounded-md text-obsidian-muted hover:bg-obsidian-panel/30 hover:text-obsidian-text cursor-pointer transition-colors"
            >
              <FolderOpen size={13} className="opacity-70" />
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
                    className="text-[#87857F] hover:text-[#CECDC3] p-0.5 cursor-pointer"
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
          {isOpen && <span className="px-1.5 mb-0.5 text-[11px] font-semibold uppercase tracking-widest text-obsidian-muted/50">{t('sidebar.chats')}</span>}
          
          {chats.map(chat => {
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
                    className="text-[#87857F] hover:text-[#CECDC3] p-0.5 cursor-pointer"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            }

            return (
              <div
                key={chat.id}
                className={`w-full group flex items-center justify-between rounded-md border border-transparent transition-colors duration-150 relative ${
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
                  className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors duration-150 cursor-pointer min-w-0 ${
                    isOpen ? 'justify-start' : 'justify-center'
                  }`}
                  title={chat.title}
                >
                  {/* Aktif sohbet: pop animasyonlu ikon. Digerleri: sade, soluk. */}
                  {isActive ? (
                    <MessageSquare key={`chat-open-${chat.id}`} size={13} className="flex-shrink-0 text-[#C6C0B2] chat-pop" />
                  ) : (
                    <MessageSquare size={13} className="flex-shrink-0 opacity-50" />
                  )}
                  {isOpen && <span className="truncate text-[11.5px]">{chat.title}</span>}
                </button>
                
                {isOpen && (
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1.5 pr-2 flex-shrink-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingChatId(chat.id);
                        setEditTitle(chat.title);
                      }}
                      className="text-obsidian-muted hover:text-white p-0.5 rounded cursor-pointer transition-colors"
                      title={t('sidebar.renameChat')}
                    >
                      <Pencil size={11} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDelete({ kind: 'chat', id: chat.id });
                      }}
                      className="text-obsidian-muted hover:text-rose-400 p-0.5 rounded cursor-pointer transition-colors"
                      title={t('sidebar.deleteChat')}
                    >
                      <Trash2 size={11} />
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
            <div className="absolute bottom-full left-0 right-0 mb-1.5 overflow-hidden rounded-md bg-[#1C1B1A] border border-[#282726] shadow-[0_12px_32px_-14px_rgba(0,0,0,0.8)] z-50">

              <div className="p-1">
                <button
                  type="button"
                  onClick={() => { setProfileMenuOpen(false); if (onOpenSettings) onOpenSettings(); }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[#A8A49E] hover:bg-[#282726] hover:text-[#F2F0E5] text-left cursor-pointer transition-colors"
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
                  className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[#A8A49E] hover:bg-[#282726] hover:text-[#D14D41] text-left cursor-pointer transition-colors"
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
                ? 'bg-[#282726] border-[#3a3936]'
                : 'border-transparent hover:bg-obsidian-panel/40'
            }`}
          >
            <span className="w-7 h-7 rounded-full bg-[#282726] border border-[#3a3936] flex items-center justify-center flex-shrink-0 overflow-hidden text-[#87857F] group-hover:text-[#CECDC3] transition-colors">
              {userAvatarUrl ? (
                <img src={userAvatarUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <UserRound size={13} />
              )}
            </span>
            {isOpen && (
              <>
                <span className="min-w-0 flex-1 flex flex-col items-start leading-tight text-left">
                  <span className="text-[12px] text-[#CECDC3] group-hover:text-[#F2F0E5] truncate w-full transition-colors">{displayName}</span>
                  {planLabel && (
                    <span className="text-[11px] text-[#87857F] truncate w-full">{planLabel}</span>
                  )}
                </span>
                <ChevronUp
                  size={12}
                  className={`flex-shrink-0 text-[#87857F] transition-transform duration-150 ${
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