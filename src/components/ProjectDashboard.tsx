import React, { useState, useEffect, useRef } from 'react';
import { 
  FileCode, 
  Folder, 
  FolderOpen,
  PanelLeft, 
  Terminal as TerminalIcon, 
  Plus, 
  FolderPlus, 
  ChevronDown,
  ChevronRight,
  ChevronUp,
  X,
  Play,
  AlertTriangle,
  Save,
  Trash2,
  Pencil,
  Search as SearchIcon,
  PictureInPicture2,
  Building2,
  Eye,
  RefreshCw
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { SyntaxHighlighter, vscDarkPlus } from '../lib/codeHighlight';
import { explainError } from '../lib/errors';
import { API_BASE } from '../services/ThalamusClient';
import { RealTerminal } from './RealTerminal';
import { ThalamusCopilot } from './ThalamusCopilot';
import { AgentCompany } from './AgentCompany';
import { FilePreviewDrawer } from './FilePreviewDrawer';
import { useToast } from './Toast';
import { fetchWorkspaceInfo, getWorkspaceName, getWorkspaceRoot, pickFolder, saveWorkspaceRoot } from '../lib/workspace';
import { useFloatingPanel, useAutoMinWidth, FloatResizeHandle, FLOATING_CHROME } from './floating';
import { useT } from '../lib/i18n';
import { NUCLEUS_LIMITS, editorExcerpt } from '../lib/nucleusPolicy';
import type { PreviewItem } from './FilePreviewDrawer';

export interface FileNode {
  id: string;
  name: string;
  isFolder: boolean;
  children?: FileNode[];
  code?: string;
  lang?: string;
  isOpen?: boolean;
}

interface DirEntry {
  name: string;
  is_dir: boolean;
}

/** Heavy folders excluded from the tree */
const FILTERED_DIRS = ['node_modules', 'target', 'dist', '.git', '.vscode', '__pycache__', 'src_backup_before_copy'];

// Language ids for the editor's syntax highlighting, keyed by file extension.
const EDITOR_LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
  md: 'markdown', py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'toml',
};

function editorLanguageFor(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase() || '';
  return EDITOR_LANGUAGES[ext] || 'text';
}
/** Tree scan depth limit (prevents freezing on huge projects) */
const MAX_TREE_DEPTH = 5;

const detectLanguage = (fileName: string): string => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  if (ext === 'rs') return 'rust';
  if (ext === 'json') return 'json';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  if (ext === 'js' || ext === 'ts' || ext === 'tsx') return 'typescript';
  return 'python';
};

/** Flattens all file paths in the tree (for the Copilot @-menu) */
const collectFilePaths = (nodes: FileNode[]): string[] =>
  nodes.flatMap(node =>
    node.isFolder ? (node.children ? collectFilePaths(node.children) : []) : [node.id]
  );

/** F5: ağaç adına göre filtreleme — klasörler altında eşleşme varsa otomatik açık. */
const filterTree = (nodes: FileNode[], q: string): FileNode[] => {
  if (!q.trim()) return nodes;
  const query = q.trim().toLowerCase();
  return nodes.flatMap(node => {
    if (!node.isFolder) return node.name.toLowerCase().includes(query) ? [node] : [];
    const children = node.children ? filterTree(node.children, q) : [];
    return children.length > 0 || node.name.toLowerCase().includes(query)
      ? [{ ...node, isOpen: true, children }]
      : [];
  });
};

interface ProjectDashboardProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Dosyayı mini önizleme/düzenleyici çekmecesinde açar (yol bilgisiyle). */
  onOpenPreview?: (item: PreviewItem) => void;
  onContextChange?: (context: { activeFile: string; code: string; cursorLine: number; selection: string }) => void;
  onOpenProject?: (root: string) => void;
  /** Proje görünümünde sağ panelde gösterilecek önizleme (bkz. App). */
  previewItem?: PreviewItem | null;
  onClosePreview?: () => void;
}

interface PendingMove {
  targetNodeId: string;
  targetNodeName: string;
  targetFolderId: string | null;
  targetFolderName: string;
}

export function ProjectDashboard({ activeTab, setActiveTab, onOpenPreview, onContextChange, onOpenProject, previewItem, onClosePreview }: ProjectDashboardProps) {
  const { showToast } = useToast();

  /** Ayarlarla canlı senkron: localStorage config'ini okur. */
  const readAppearance = () => {
    let fz = '13px', tab = 4;
    let lines = true, autosave = false;
    try {
      const configStr = localStorage.getItem('thalamus_config');
      if (configStr) {
        const config = JSON.parse(configStr);
        if (config.appearance) {
          if (config.appearance.fontSize) fz = config.appearance.fontSize;
          if (config.appearance.tabSize) tab = config.appearance.tabSize;
          if (typeof config.appearance.showLineNumbers === 'boolean') lines = config.appearance.showLineNumbers;
          if (typeof config.appearance.autosave === 'boolean') autosave = config.appearance.autosave;
        }
      }
    } catch {}
    return { fontSize: fz, tabSize: tab, showLineNumbers: lines, autosave };
  };

  // Editör görünüm ayarları state'tedir; Settings kaydettiğinde
  // 'thalamus_config_changed' olayıyla 20 sn / remount beklemeden uygulanır.
  const [fontSize, setFontSize] = useState<string>(() => readAppearance().fontSize);
  const [tabSize, setTabSize] = useState<number>(() => readAppearance().tabSize);
  const [showLineNumbers, setShowLineNumbers] = useState<boolean>(() => readAppearance().showLineNumbers);
  const [autosave, setAutosave] = useState<boolean>(() => readAppearance().autosave);
  useEffect(() => {
    const sync = () => {
      const a = readAppearance();
      setFontSize(a.fontSize);
      setTabSize(a.tabSize);
      setShowLineNumbers(a.showLineNumbers);
      setAutosave(a.autosave);
    };
    window.addEventListener('thalamus_config_changed', sync);
    return () => window.removeEventListener('thalamus_config_changed', sync);
  }, []);
  const sortNodes = (nodes: FileNode[]): FileNode[] => {
    return [...nodes].sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.name.localeCompare(b.name);
    }).map(node => {
      if (node.isFolder && node.children) {
        return { ...node, children: sortNodes(node.children) };
      }
      return node;
    });
  };

  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  // Açık klasörler her ağaç yeniden yüklemesinde korunur: işlem sonrası
  // loadTree() tüm iç klasörleri katlıyordu, kullanıcı her seferinde
  // yeniden açmak zorunda kalıyordu.
  const openFoldersRef = useRef<Set<string>>(new Set());
  const treeLoadedRef = useRef(false);
  const syncOpenFolders = (nodes: FileNode[]) => {
    const s = new Set<string>();
    const rec = (ns: FileNode[]) => ns.forEach(n => {
      if (n.isFolder) {
        if (n.isOpen) s.add(n.id);
        if (n.children) rec(n.children);
      }
    });
    rec(nodes);
    openFoldersRef.current = s;
  };
  // Workspace title toggles the tree view (default: open)
  const [rootExpanded, setRootExpanded] = useState<boolean>(true);
  // Engine status — a real /api/health probe instead of an innocent green dot
  const [engineOnline, setEngineOnline] = useState<boolean | null>(null);
  // File contents are SEPARATE from the tree state: instead of re-walking the
  // whole tree on every keystroke, only the single key in this map is updated.
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  // V1: diske yazilan son icerigin anlik goruntusu. fileContents bundan
  // farkliysa dosya "dirty"dir (kaydedilmemis degisiklik var).
  const [savedContents, setSavedContents] = useState<Record<string, string>>({});
  // Dosyanın DİSKTEKİ satır sonu biçimi. Tarayıcı textarea değeri CRLF'i LF'e
  // normalize ettiği için kaydederken geri uygulanmazsa .bat/.ps1 gibi dosyalar
  // bozulur. Kaydetmede bu biçim yeniden uygulanır.
  const fileEolRef = useRef<Record<string, string>>({});
  const t = useT();
  const [workspaceName, setWorkspaceName] = useState<string>(() => getWorkspaceName());
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editorHighlightRef = useRef<HTMLPreElement>(null);
  const editorRangeRef = useRef({ start: 0, end: 0 });

  // 📂 Loads the real file system tree
  const loadTree = React.useCallback(async () => {
    let root = getWorkspaceRoot();
    if (!root) {
      const info = await fetchWorkspaceInfo();
      if (info) {
        saveWorkspaceRoot(info.root);
        root = info.root;
      }
    }
    if (!root) return;
    setWorkspaceName(getWorkspaceName());

    const walk = async (relPath: string, depth: number): Promise<FileNode[]> => {
      if (depth > MAX_TREE_DEPTH) return [];
      let entries: DirEntry[] = [];
      try {
        entries = await invoke<DirEntry[]>('list_dir', { path: relPath });
      } catch (err) {
        console.error('list_dir error:', err);
        return [];
      }
      const nodes: FileNode[] = [];
      for (const e of entries) {
        if (e.is_dir && FILTERED_DIRS.includes(e.name)) continue;
        const childPath = relPath ? `${relPath}/${e.name}` : e.name;
        const node: FileNode = {
          id: childPath,
          name: e.name,
          isFolder: e.is_dir,
          isOpen: e.is_dir && (openFoldersRef.current.has(childPath) || (!treeLoadedRef.current && depth === 0)),
          ...(e.is_dir
            ? { children: [] as FileNode[] }
            : { lang: detectLanguage(e.name) }),
        };
        if (e.is_dir) {
          node.children = await walk(childPath, depth + 1);
        }
        nodes.push(node);
      }
      return sortNodes(nodes);
    };

    const tree = await walk('', 0);
    setFileTree(tree);
    syncOpenFolders(tree);
    treeLoadedRef.current = true;
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  // Dışarıdan (başka editör, git, AI) gelen dosya değişiklikleri: pencere
  // odağa dönünce ağacı sessizce tazele. Açık klasörler korunur.
  useEffect(() => {
    let timer: number | null = null;
    const onFocus = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void loadTree();
      }, 600);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loadTree]);

  const handleChooseFolder = async () => {
    try {
      const selected = await pickFolder(t('sidebar.chooseFolder'));
      if (selected) onOpenProject?.(selected);
    } catch (err) {
      const x = explainError(err, 'Open folder');
      showToast(t('sidebar.chooseFolder'), x.explanation, 'error', undefined, `[${x.code}] ${x.detail ?? String(err)}]`);
    }
  };

  // Real engine health: HTTP /api/health every 5 sec
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(3000), method: 'GET' });
        if (!cancelled) setEngineOnline(res.ok);
      } catch {
        if (!cancelled) setEngineOnline(false);
      }
    };
    check();
    const id = setInterval(check, 20000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // V1: kaydedilmemis tamponlari calisma oturumlari arasinda tasiyan anahtar.
  // Gorunum degisiminde (ProjectDashboard unmount) veya uygulama kapanirken
  // editor icerigi kaybolmasin; dosya acilinca disk yerine bu tampon donerse
  // kullanıcı DÜRÜSTÇE bilgilendirilir.
  const DIRTY_BUFFER_KEY = 'thalamus_dirty_buffers_v1';

  const isDirty = (file: string) => {
    const cur = fileContents[file];
    if (cur === undefined) return false;
    const saved = savedContents[file];
    return saved === undefined || cur !== saved;
  };

  const clearDirtyBuffer = (file: string) => {
    try {
      const map = JSON.parse(localStorage.getItem(DIRTY_BUFFER_KEY) || '{}');
      if (map[file] !== undefined) {
        delete map[file];
        localStorage.setItem(DIRTY_BUFFER_KEY, JSON.stringify(map));
      }
    } catch {}
  };

  // Tamponlari localStorage'a yansit; kaydedilen dosyalardan sonra temizle.
  // Perf: her tus vurusunda degil, yazma durduktan 400 ms sonra calisir —
  // tamponlar dosya icerigi tasidigi icin burada tam parse+stringify var.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const map: Record<string, string> = JSON.parse(localStorage.getItem(DIRTY_BUFFER_KEY) || '{}');
        let changed = false;
        for (const f of Object.keys(fileContents)) {
          if (isDirty(f)) {
            if (map[f] !== fileContents[f]) {
              map[f] = fileContents[f];
              changed = true;
            }
          } else if (map[f] !== undefined) {
            delete map[f];
            changed = true;
          }
        }
        if (changed) localStorage.setItem(DIRTY_BUFFER_KEY, JSON.stringify(map));
      } catch {}
    }, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileContents, savedContents]);

  // V1: kaydedilmemis is varken pencere/app kapanirken tarayici uyarisi.
  useEffect(() => {
    const anyDirty = Object.keys(fileContents).some(isDirty);
    if (!anyDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileContents, savedContents]);

  // Writes the file content into the content map (lazy loading on open).
  // V1: disk icerigi snapshot'a alinir; kaydedilmemis tampon varsa o dondurulur.
  const storeFileContent = (file: string, code: string) => {
    setSavedContents(prev => (prev[file] === code ? prev : { ...prev, [file]: code }));
    let effective = code;
    let restored = false;
    try {
      const map = JSON.parse(localStorage.getItem(DIRTY_BUFFER_KEY) || '{}');
      if (typeof map[file] === 'string' && map[file] !== code) {
        effective = map[file];
        restored = true;
      }
    } catch {}
    setFileContents(prev => (prev[file] === effective ? prev : { ...prev, [file]: effective }));
    if (restored) {
      showToast(
        t('ide.unsavedRestored'),
        t('ide.unsavedRestoredMsg', { file }),
        'info'
      );
    }
  };

  const handleTextareaScroll = () => {
    const ta = editorTextareaRef.current;
    if (!ta) return;
    if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = ta.scrollTop;
    if (editorHighlightRef.current) {
      editorHighlightRef.current.scrollTop = ta.scrollTop;
      editorHighlightRef.current.scrollLeft = ta.scrollLeft;
    }
  };
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [isTerminalOpen, setIsTerminalOpen] = useState<boolean>(true);
  /** Nucleus yalnızca çağrıldığında açılan yüzen pencere. */
  const [nucleusOpen, setNucleusOpen] = useState<boolean>(false);

  // Merkez pano modu: 'code' = editör+terminal, 'agents' = Ajan Ağı.
  // Mod değişince editör/terminal UNMOUNT edilmez (PTY ve tampon yaşasın).
  const [paneMode, setPaneMode] = useState<'code' | 'agents'>(() => {
    try {
      const v = localStorage.getItem('tlm_pane_mode');
      // Eski 'mesh' tercihi tek ajan yüzeyine taşındı.
      return v === 'agents' || v === 'company' || v === 'mesh' ? 'agents' : 'code';
    } catch { return 'code'; }
  });
  useEffect(() => {
    try { localStorage.setItem('tlm_pane_mode', paneMode); } catch { /* noop */ }
  }, [paneMode]);

  // Explorer yalnız kod modunda görünür; daraltma tercihi hatırlanır.
  const [explorerOpen, setExplorerOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('tlm_explorer_open') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('tlm_explorer_open', explorerOpen ? '1' : '0'); } catch { /* noop */ }
  }, [explorerOpen]);

  /**
   * Ajan panosunu boşta (idle) önceden kur. Geçişte AgentCompany yeniden
   * mount edilmediği için kod ↔ ajan geçişi anlık olur; ilk kurulum maliyeti
   * kullanıcı beklemediği anda ödenir.
   */
  const [agentsReady, setAgentsReady] = useState(false);
  useEffect(() => {
    if (agentsReady) return;
    if (paneMode === 'agents') {
      setAgentsReady(true);
      return;
    }
    let idleId: number | undefined;
    const warm = () => setAgentsReady(true);
    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(warm, { timeout: 1500 });
    } else {
      idleId = window.setTimeout(warm, 600);
    }
    return () => {
      if (idleId === undefined) return;
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId);
      window.clearTimeout(idleId);
    };
  }, [paneMode, agentsReady]);

  // In-app floating windows (draggable, freely resizable, remembered). Content
  // is never CSS-scaled: it stays native (crisp) and reflows to the window,
  // with a minimum size so it stays readable/usable.
  const termFloat = useFloatingPanel('terminal', { def: { x: 140, y: 140, w: 660, h: 200 }, min: { w: 240, h: 110 } });
  const nucleusFloat = useFloatingPanel('nucleus', {
    def: { x: 300, y: 110, w: 470, h: 580 },
    min: { w: 340, h: 280 },
    alwaysFloating: true,
  });
  // Her panelin başlığı kırpılmadan sığabileceği genişliği ölç → altına inilemez.
  useAutoMinWidth(termFloat.headerRef, termFloat.setMinWidth);
  useAutoMinWidth(nucleusFloat.headerRef, nucleusFloat.setMinWidth);

  // Uygulama genelinden (Alt+N, başlık, komut paleti) yüzen Nucleus'u çağır.
  useEffect(() => {
    const open = () => setNucleusOpen(true);
    const toggle = () => setNucleusOpen((v) => !v);
    window.addEventListener('tlm:nucleus-open', open);
    window.addEventListener('tlm:nucleus-toggle', toggle);
    return () => {
      window.removeEventListener('tlm:nucleus-open', open);
      window.removeEventListener('tlm:nucleus-toggle', toggle);
    };
  }, []);
  useEffect(() => {
    if (!nucleusOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNucleusOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nucleusOpen]);

  // Min / max panel width limits
  const MIN_COPILOT_WIDTH = 340;
  const MAX_COPILOT_WIDTH = 470;
  const DEFAULT_COPILOT_WIDTH = 470;

  const [copilotWidth, setCopilotWidth] = useState<number>(DEFAULT_COPILOT_WIDTH);
  const [isResizingCopilot, setIsResizingCopilot] = useState<boolean>(false);

  const [creationMode, setCreationMode] = useState<'file' | 'folder' | null>(null);
  const [newItemName, setNewItemName] = useState<string>('');
  // F5: gezgin arama filtresi (boşken tüm ağaç). Yazarken gecikmeli uygulanır.
  const [treeSearch, setTreeSearch] = useState<string>('');
  // F7b: oluşturmanın hedef klasörü ("" = kök) + sağ-tık menüsü durumu.
  const [creatingIn, setCreatingIn] = useState<string>('');
  const [ctxMenu, setCtxMenu] = useState<{ node: FileNode; x: number; y: number } | null>(null);
  // Explorer "+" düğmesinin Dosya/Klasör menüsü.
  const [newMenuOpen, setNewMenuOpen] = useState(false);

  // DRAG STATES
  const [draggedNode, setDraggedNode] = useState<FileNode | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  // The pressed node + press origin; a drag only begins after a movement threshold.
  const pointerRef = useRef<{ node: FileNode; startX: number; startY: number } | null>(null);

  // Smooth panel resize
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingCopilot) return;
      
      e.preventDefault();
      const newWidth = window.innerWidth - e.clientX;

      if (newWidth >= MIN_COPILOT_WIDTH && newWidth <= MAX_COPILOT_WIDTH) {
        setCopilotWidth(newWidth);
      } else if (newWidth > MAX_COPILOT_WIDTH) {
        setCopilotWidth(MAX_COPILOT_WIDTH);
      } else if (newWidth < MIN_COPILOT_WIDTH) {
        setCopilotWidth(MIN_COPILOT_WIDTH);
      }
    };

    const handleMouseUp = () => {
      setIsResizingCopilot(false);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };

    if (isResizingCopilot) {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingCopilot]);

  const findFileNode = (nodes: FileNode[], id: string): FileNode | null => {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.isFolder && node.children) {
        const found = findFileNode(node.children, id);
        if (found) return found;
      }
    }
    return null;
  };

  const findParentFolderId = (nodes: FileNode[], childId: string, parentId: string | null = null): string | null | undefined => {
    for (const node of nodes) {
      if (node.id === childId) return parentId;
      if (node.isFolder && node.children) {
        const res = findParentFolderId(node.children, childId, node.id);
        if (res !== undefined) return res;
      }
    }
    return undefined;
  };

  // Perf: agac taramalari her render'da degil, yalniz agac/sekme degisince.
  const activeNode = React.useMemo(() => findFileNode(fileTree, activeTab), [fileTree, activeTab]);
  const workspaceFiles = React.useMemo(() => collectFilePaths(fileTree), [fileTree]);
  const noFileOpen = !activeTab || !activeNode;
  const currentCode = activeNode ? (fileContents[activeTab] ?? '') : '';
  /**
   * Nucleus bağlamı: `editorExcerpt` tüm dosyayı satırlara böler. Her tuşta
   * iki kez çalıştırmak büyük dosyalarda yazmayı geciktiriyordu; bu yüzden
   * yalnız 140 ms hareketsizlikten sonra hesaplanır.
   */
  const contextTimerRef = React.useRef<number | null>(null);
  const emitEditorContext = React.useCallback(() => {
    const el = editorTextareaRef.current;
    const value = el?.value ?? currentCode;
    const { start, end } = editorRangeRef.current;
    const { text, line } = editorExcerpt(value, start, end);
    const selection = end > start ? value.slice(start, end).slice(0, NUCLEUS_LIMITS.selectionChars) : '';
    onContextChange?.({ activeFile: activeTab, code: text, cursorLine: line, selection });
  }, [activeTab, currentCode, onContextChange]);
  const scheduleEditorContext = React.useCallback(() => {
    if (contextTimerRef.current !== null) window.clearTimeout(contextTimerRef.current);
    contextTimerRef.current = window.setTimeout(() => {
      contextTimerRef.current = null;
      emitEditorContext();
    }, 140);
  }, [emitEditorContext]);
  const reportEditorContext = React.useCallback((el: HTMLTextAreaElement) => {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    editorRangeRef.current = { start, end };
    scheduleEditorContext();
  }, [scheduleEditorContext]);

  React.useEffect(() => {
    editorRangeRef.current = { start: 0, end: 0 };
  }, [activeTab]);

  React.useEffect(() => {
    scheduleEditorContext();
  }, [activeTab, currentCode, scheduleEditorContext]);

  React.useEffect(() => () => {
    if (contextTimerRef.current !== null) window.clearTimeout(contextTimerRef.current);
  }, []);
  const codeLines = React.useMemo(() => currentCode.split('\n'), [currentCode]);
  const editorLanguage = editorLanguageFor(activeTab);
  // Prism tüm dosyayı her tuşta yeniden renklendiriyor; ölçülen gecikme:
  // 600 satır ~376 ms, 1500 satır ~855 ms, 2500 satır ~1,4 sn. Bu yüzden
  // büyük dosyalarda renklendirme tamamen kapanır; orta boyda yazarken düz
  // metin gösterilir, 450 ms boşluktan sonra renkler geri gelir.
  const HIGHLIGHT_MAX_CHARS = 30000;
  const highlightAllowed = currentCode.length <= HIGHLIGHT_MAX_CHARS;
  const [highlightIdle, setHighlightIdle] = React.useState(true);
  const highlightTimer = React.useRef<number | null>(null);
  const noteTyping = React.useCallback(() => {
    setHighlightIdle(false);
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlightIdle(true), 450);
  }, []);
  React.useEffect(() => {
    setHighlightIdle(true);
    return () => {
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    };
  }, [activeTab]);
  const highlightEnabled = highlightAllowed && highlightIdle;
  // Cok satirli dosyada satir numarasi sutunu da binlerce DOM dugumu uretir.
  const MAX_GUTTER_LINES = 2000;
  const gutterLines = codeLines.length <= MAX_GUTTER_LINES ? codeLines : null;
  // Highlighting the whole file on every keystroke is expensive on large files.
  // Deferring it keeps typing responsive: the textarea updates immediately and
  // the colors catch up on the next idle render.
  const deferredCode = React.useDeferredValue(currentCode);

  // Renklendirme katmanı yeniden çizildiğinde (düz metin ↔ renkli geçişi veya
  // içerik değişimi) scroll konumu sıfırlanabilir; textarea'nın konumunu geri
  // uygula. Aksi halde alt satırlarda içerik "kaybolmuş" gibi görünür.
  React.useLayoutEffect(() => {
    const ta = editorTextareaRef.current;
    if (!ta) return;
    if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = ta.scrollTop;
    const pre = editorHighlightRef.current;
    if (pre) {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    }
  }, [highlightEnabled, activeTab]);

  const handleCreateItem = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmedName = newItemName.trim();

    if (!trimmedName || !creationMode) {
      setCreationMode(null);
      setNewItemName('');
      return;
    }

    // F7b: hedef artık aktif sekmeyen değil, oluşturma başlangıcında seçilen
    // klasör (creatingIn; "" = kök). Sağ-tıkla "buraya oluştur" seçilebilir.
    const parentPath = creatingIn.trim();
    const finalId = parentPath ? `${parentPath}/${trimmedName}` : trimmedName;
    const isFolder = creationMode === 'folder';

    try {
      await invoke('create_entry', { path: finalId, isDir: isFolder });
      await loadTree();

      if (!isFolder) {
        if (!openTabs.includes(finalId)) {
          setOpenTabs(prev => [...prev, finalId]);
        }
        setPaneMode('code');
        setActiveTab(finalId);
      }
    } catch (err) {
      console.error('Could not create entry:', err);
      const x = explainError(err, 'Create');
      showToast(t('ide.createError'), t('ide.createErrorMsg', { name: trimmedName, explanation: x.explanation }), 'error', undefined, `[${x.code}] ${x.detail ?? String(err)}]`);
    }

    setNewItemName('');
    setCreationMode(null);
  };

  const handleToggleFolder = (folderId: string) => {
    const toggleRecursive = (nodes: FileNode[]): FileNode[] => {
      return nodes.map(node => {
        if (node.id === folderId) {
          return { ...node, isOpen: !node.isOpen };
        }
        if (node.isFolder && node.children) {
          return { ...node, children: toggleRecursive(node.children) };
        }
        return node;
      });
    };
    setFileTree(prev => {
      const next = toggleRecursive(prev);
      syncOpenFolders(next);
      return next;
    });
  };

  /** F7b: oluştur hedefi klasörün anne zinciri açılır (yeni öğe görünsün). */
  const openFolderPath = (dir: string) => {
    if (!dir) return;
    const ancestors = new Set<string>();
    let acc = '';
    for (const p of dir.split('/')) {
      acc = acc ? `${acc}/${p}` : p;
      ancestors.add(acc);
    }
    const open = (nodes: FileNode[]): FileNode[] =>
      nodes.map(n => {
        if (!n.isFolder) return n;
        const isOpen = n.isOpen || ancestors.has(n.id);
        return { ...n, isOpen, children: n.children ? open(n.children) : n.children };
      });
    setFileTree(prev => {
      const next = open(prev);
      syncOpenFolders(next);
      return next;
    });
  };

  /** F7b: oluştur akışını hedef klasörle başlatır. */
  const startCreate = (mode: 'file' | 'folder', dir: string) => {
    setCreatingIn(dir);
    setCreationMode(mode);
    setNewItemName('');
    if (dir) openFolderPath(dir);
  };

  /** F7b: ağaç satırında sağ tık → menü; dosyada üst klasörü hedef alır. */
  const openCtxMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    setCtxMenu({ node, x: e.clientX, y: e.clientY });
  };

  // F7b: menü dışında tık/Esc kapatır.
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [ctxMenu]);

  // "+" menüsü dışında tık/Esc kapatır.
  useEffect(() => {
    if (!newMenuOpen) return;
    const close = () => setNewMenuOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNewMenuOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); };
  }, [newMenuOpen]);

  const handleMouseDown = (e: React.MouseEvent, node: FileNode) => {
    if (e.button !== 0) return;
    // Record the press only; a drag starts later, once the pointer has moved
    // past a small threshold (see the effect below). This keeps a plain click
    // from ever being mistaken for a move.
    pointerRef.current = { node, startX: e.clientX, startY: e.clientY };
  };

  useEffect(() => {
    const DRAG_THRESHOLD = 6;

    const handleMouseMove = (e: MouseEvent) => {
      const press = pointerRef.current;
      if (!press) return;
      if (!draggedNode) {
        if (Math.hypot(e.clientX - press.startX, e.clientY - press.startY) < DRAG_THRESHOLD) return;
        setDraggedNode(press.node);
      }
      setDragPos({ x: e.clientX, y: e.clientY });
    };

    const handleMouseUp = (e: MouseEvent) => {
      const press = pointerRef.current;
      pointerRef.current = null;

      // No drag started (press without movement) → treat as a click, not a drop.
      if (!draggedNode || !press) {
        setDraggedNode(null);
        return;
      }

      const dropTarget = document.elementFromPoint(e.clientX, e.clientY);

      if (dropTarget) {
        const folderElement = dropTarget.closest('[data-folder-id]');
        const isRootZone = dropTarget.closest('[data-root-zone="true"]');

        let targetFolderId: string | null | undefined = undefined;

        if (folderElement) {
          targetFolderId = folderElement.getAttribute('data-folder-id');
        } else if (isRootZone) {
          targetFolderId = null;
        }

        if (targetFolderId !== undefined && targetFolderId !== draggedNode.id) {
          // F7b: klasör kendi alt klasörüne taşınamaz.
          if (
            draggedNode.isFolder &&
            targetFolderId &&
            targetFolderId.startsWith(draggedNode.id + '/')
          ) {
            setDraggedNode(null);
            return;
          }
          const currentParentId = findParentFolderId(fileTree, draggedNode.id) ?? null;

          if (currentParentId !== targetFolderId) {
            const targetFolderNode = targetFolderId ? findFileNode(fileTree, targetFolderId) : null;

            setPendingMove({
              targetNodeId: draggedNode.id,
              targetNodeName: draggedNode.name,
              targetFolderId: targetFolderId,
              targetFolderName: targetFolderNode ? targetFolderNode.name : `${getWorkspaceName()} (root)`
            });
          }
        }
      }

      setDraggedNode(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggedNode, fileTree]);

  // Switching files starts at the top; keep the colored layer and gutter in step.
  useEffect(() => {
    if (editorHighlightRef.current) {
      editorHighlightRef.current.scrollTop = 0;
      editorHighlightRef.current.scrollLeft = 0;
    }
    if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = 0;
  }, [activeTab]);

  const confirmMove = async () => {
    if (!pendingMove) return;

    const { targetNodeId, targetNodeName, targetFolderId } = pendingMove;
    const targetPath = targetFolderId
      ? `${targetFolderId}/${targetNodeName}`
      : targetNodeName;

    try {
      await invoke('move_entry', { from: targetNodeId, to: targetPath });
      await loadTree();

      if (targetNodeId !== targetPath) {
        // If a whole folder moved, remap every open tab and the active file
        // beneath it so saves keep pointing at the real (moved) file.
        // F5: content buffers + dirty buffers de yeniden eslenir — eski
        // davranista tasinan kirli dosyanin tamponu sizintili olarak duseyordu.
        remapPathKeys(targetNodeId, targetPath);
      }
    } catch (err) {
      console.error('Move error:', err);
      const x = explainError(err, 'Move');
      showToast(t('ide.moveError'), t('ide.moveErrorMsg', { explanation: x.explanation }), 'error', undefined, `[${x.code}] ${x.detail ?? String(err)}]`);
    }

    setPendingMove(null);
  };

  /** F5: tasima/yeniden adlandirmada path-key'li tum durum tasimalari. */
  const remapPathKeys = (from: string, to: string) => {
    const remapPath = (p: string): string => {
      if (p === from) return to;
      if (p.startsWith(from + '/')) return to + p.slice(from.length);
      return p;
    };
    setOpenTabs(prev => prev.map(remapPath));
    setActiveTab(remapPath(activeTab));
    setFileContents(prev => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) next[remapPath(k)] = v;
      return next;
    });
    setSavedContents(prev => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) next[remapPath(k)] = v;
      return next;
    });
    try {
      const map: Record<string, string> = JSON.parse(localStorage.getItem(DIRTY_BUFFER_KEY) || '{}');
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(map)) next[remapPath(k)] = v;
      localStorage.setItem(DIRTY_BUFFER_KEY, JSON.stringify(next));
    } catch {}
  };

  /** F7b: herhangi bir düğümü yeniden adlandırır (move_entry, aynı dizinde). */
  const handleRenameEntry = async (node: FileNode) => {
    const raw = window.prompt(t('ide.renamePrompt', { name: node.name }), node.name);
    const newName = raw?.trim();
    if (!newName || newName === node.name) return;
    // Windows dosya adında geçersiz karakterler — diske gitmeden dur.
    if (/[\\/:*?"<>|]/.test(newName)) {
      showToast(t('ide.invalidName'), t('ide.invalidNameMsg'), 'error', undefined, '[400] invalid name characters');
      return;
    }
    const parent = node.id.includes('/') ? node.id.slice(0, node.id.lastIndexOf('/')) : '';
    const newPath = parent ? `${parent}/${newName}` : newName;
    try {
      await invoke('move_entry', { from: node.id, to: newPath });
      await loadTree();
      remapPathKeys(node.id, newPath);
      showToast(t('ide.renamed'), `${node.name} → ${newName}`, 'success');
    } catch (err) {
      console.error('Rename error:', err);
      const x = explainError(err, 'Rename');
      showToast(t('ide.renameError'), t('ide.renameErrorMsg', { id: node.id, explanation: x.explanation }), 'error', undefined, `[${x.code}] ${x.detail ?? String(err)}]`);
    }
  };

  /** F5: aktif dosyayı yeniden adlandırır (breadcrumb kalem düğmesi). */
  const handleRenameActiveFile = () => {
    if (!activeTab || !activeNode) {
      showToast(t('ide.nothingToRename'), t('ide.openFileFirst'), 'info');
      return;
    }
    void handleRenameEntry(activeNode);
  };

  const handleCloseTab = (e: React.MouseEvent, fileName: string) => {
    e.stopPropagation();
    // V1: kaydedilmemis degisiklik varsa kullaniciyi onayla uyandır;
    // "kapat" denirse tampon ve bellek kopyasi atilir (kaybolur, ama bilerek).
    if (isDirty(fileName)) {
      const name = fileName.split('/').pop();
      if (!window.confirm(t('ide.unsavedClose', { name: name ?? '' }))) {
        return;
      }
      setFileContents(prev => {
        const next = { ...prev };
        delete next[fileName];
        return next;
      });
      setSavedContents(prev => {
        const next = { ...prev };
        delete next[fileName];
        return next;
      });
      clearDirtyBuffer(fileName);
    }
    const updatedTabs = openTabs.filter(t => t !== fileName);
    setOpenTabs(updatedTabs);
    if (activeTab === fileName) {
      setActiveTab(updatedTabs.length > 0 ? updatedTabs[updatedTabs.length - 1] : '');
    }
  };

  const handleOpenFile = async (node: FileNode) => {
    if (node.isFolder) {
      handleToggleFolder(node.id);
      return;
    }
    // Ajan panosundayken explorer'dan dosya açılırsa editör gizli kalıyordu
    // (kullanıcı "dosya açılmıyor / düzenleyemiyorum" görüyordu). Kod panosuna geç.
    setPaneMode('code');
    // Read from disk if content is not loaded yet (lazy loading)
    if (fileContents[node.id] === undefined) {
      try {
        const code = await invoke<string>('thalamus_read_file', { path: node.id });
        fileEolRef.current[node.id] = code.includes('\r\n') ? '\r\n' : '\n';
        storeFileContent(node.id, code);
      } catch (err) {
        console.error('Could not read file:', err);
        const x = explainError(err, 'File read');
        showToast(
          x.title,
          t('ide.openFailedMsg', { file: node.id, explanation: x.explanation }),
          'error',
          undefined,
          `[${x.code}] ${x.detail ?? node.id}`
        );
      }
    } else if (!isDirty(node.id)) {
      // V1: disk kopyasi AI araclari/baska bir kanalla degismis olabilir.
      // Kaydedilmemis duzenleme yoksa sessizce taze kopyayi getir; kullanci
      // istek sirasinda yazmaya basladiysa editor ezilmez (imza karsilastirmasi).
      const savedAtClick = savedContents[node.id];
      const bufferAtClick = fileContents[node.id];
      invoke<string>('thalamus_read_file', { path: node.id })
        .then(code => {
          if (code === savedAtClick) return;
          fileEolRef.current[node.id] = code.includes('\r\n') ? '\r\n' : '\n';
          setFileContents(prev => {
            const cur = prev[node.id];
            if (cur !== bufferAtClick) return prev; // kullanci yazdi — dokunma
            return { ...prev, [node.id]: code };
          });
          setSavedContents(prev => (prev[node.id] === code ? prev : { ...prev, [node.id]: code }));
        })
        .catch(() => {});
    }
    if (!openTabs.includes(node.id)) {
      setOpenTabs([...openTabs, node.id]);
    }
    setActiveTab(node.id);
  };

  const handlePreviewNode = async (node: FileNode) => {
    if (node.isFolder || !onOpenPreview) return;
    try {
      let body = fileContents[node.id];
      if (body === undefined) {
        body = await invoke<string>('thalamus_read_file', { path: node.id });
        fileEolRef.current[node.id] = body.includes('\r\n') ? '\r\n' : '\n';
        storeFileContent(node.id, body);
      }
      onOpenPreview({ name: node.name, kind: 'text', body, path: node.id });
    } catch (err) {
      const x = explainError(err, 'File read');
      showToast(
        x.title,
        t('ide.openFailedMsg', { file: node.id, explanation: x.explanation }),
        'error',
        undefined,
        `[${x.code}] ${x.detail ?? node.id}`
      );
    }
  };

  /** Önizleme çekmecesinde düzenlenebilecek (metin) dosya adları. */
  const isPreviewText = (name: string) => (
    /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|env|log|csv|tsv|xml|html?|css|scss|less|jsx?|tsx?|mjs|cjs|py|rb|go|rs|java|kt|kts|c|cc|cpp|h|hpp|cs|php|swift|sh|bash|zsh|ps1|psm1|bat|cmd|sql|gql|graphql|vue|svelte|astro|lock|properties|gradle|r|jl|lua|pl|dart|ex|exs|erl|hs|scala|clj|asm|tex|bib)$/i.test(name)
    || !/\.[A-Za-z0-9]+$/.test(name)
  );

  /** Diske yazılacak metni dosyanın özgün satır sonu biçimine çevirir. */
  const withOriginalEol = (file: string, code: string) =>
    fileEolRef.current[file] === '\r\n' ? code.replace(/\r?\n/g, '\r\n') : code.replace(/\r\n/g, '\n');

  const handleRunActiveFile = async () => {
    if (!activeTab || !activeNode) return;

    // V1 (C-dizi): bosluklu/yol tureten isimler komutu kirmasın diye tırnakla.
    // PowerShell ic tirnagi "" ile kacirir; '\"' gecerli degil ve dosya adindan
    // cikip komut enjeksiyonuna izin verirdi.
    const quoted = `"${activeTab.replace(/"/g, '""')}"`;
    const isScript = activeTab.endsWith('.py') || activeTab.endsWith('.rs');
    const cmd = activeTab.endsWith('.py')
      ? `python ${quoted}`
      : activeTab.endsWith('.rs')
        ? `cargo run`
        : `Get-Content ${quoted}`;

    // Çalıştırma dürüstlüğü: script olmayan dosya "çalıştırılmaz", içeriği
    // ekrana basılır — kullanıcıya önceden söyle + komutu onayla.
    // ONAY ÖNCE GELİR: kullanıcı vazgeçerse dosya diske de yazılmaz.
    if (!isScript) {
      if (!window.confirm(t('ide.notRunnable', { name: activeTab, cmd }))) return;
    } else if (!window.confirm(t('ide.runConfirm', { name: activeTab, cmd }))) return;

    // Onaydan SONRA kaydet (vazgeçilen bir çalıştırma diske yazmasın).
    const fileCode = fileContents[activeTab];
    if (fileCode !== undefined) {
      try {
        await invoke('thalamus_write_file', { path: activeTab, content: withOriginalEol(activeTab, fileCode) });
        setSavedContents(prev => ({ ...prev, [activeTab]: fileCode }));
      } catch (e) {
        console.error("Could not save file to disk:", e);
        const x = explainError(e, 'Save');
        showToast(t('ide.saveFailed'), t('ide.saveFailedMsg', { file: activeTab, explanation: x.explanation }), 'error', undefined, `[${x.code}] ${x.detail ?? String(e)}]`);
      }
    }

    // Calisma gercekten gorulebilsin: terminal katlamaysa ac, sonra yaz.
    // (Katli terminalde gonderilen komut gorunmez "sessiz islem" olurdu.)
    setIsTerminalOpen(true);
    setTimeout(() => {
      invoke('write_terminal', { data: cmd + '\r' }).catch(console.error);
    }, 150);
  };

  const handleSaveActiveFile = async () => {
    if (!activeTab || !activeNode) {
      showToast(t('ide.nothingToSave'), t('ide.openFileFirst'), 'info');
      return;
    }
    const fileCode = fileContents[activeTab];
    if (fileCode !== undefined) {
      try {
        await invoke('thalamus_write_file', { path: activeTab, content: withOriginalEol(activeTab, fileCode) });
        setSavedContents(prev => ({ ...prev, [activeTab]: fileCode }));
        showToast(t('ide.fileSaved'), t('ide.fileSavedMsg', { file: activeTab }), 'success');
      } catch (e) {
        console.error('Save error:', e);
        const x = explainError(e, 'Save');
        showToast(t('ide.saveError'), t('ide.saveErrorMsg', { file: activeTab, explanation: x.explanation }), 'error', undefined, `[${x.code}] ${x.detail ?? String(e)}]`);
      }
    }
  };

  /** F7b: herhangi bir dosya/klasörü çöp kutusuna gönderir. */
  const handleDeleteEntry = async (node: FileNode) => {
    if (!window.confirm(t('ide.deleteConfirm', { name: node.name }))) return;
    try {
      // D9: Rust tarafı hangi yolun KULLANILDIĞINI döner; UI ona göre
      // konuşur — kalıcı silme olduysa "çöp kutusuna taşındı" denmez.
      const mode = await invoke<string>('delete_entry', { path: node.id });
      const affected = (p: string) => p === node.id || p.startsWith(node.id + '/');
      const closed = openTabs.filter(affected);
      const remaining = openTabs.filter(t => !affected(t));
      if (closed.length > 0) {
        setOpenTabs(remaining);
        if (affected(activeTab)) setActiveTab(remaining[remaining.length - 1] ?? '');
        for (const t of closed) clearDirtyBuffer(t);
        setFileContents(prev => {
          const n = { ...prev };
          for (const t of closed) delete n[t];
          return n;
        });
        setSavedContents(prev => {
          const n = { ...prev };
          for (const t of closed) delete n[t];
          return n;
        });
      }
      await loadTree();
      if (mode === 'recycled') {
        showToast(t('ide.deleted'), t('ide.deletedMsg', { name: node.name }), 'success');
      } else {
        showToast(t('ide.permanentlyDeleted'), t('ide.permanentlyDeletedMsg', { name: node.name, mode }), 'error');
      }
    } catch (err) {
      console.error('Delete error:', err);
      const x = explainError(err, 'Delete');
      showToast(t('ide.deleteError'), t('ide.deleteErrorMsg', { id: node.id, explanation: x.explanation }), 'error', undefined, `[${x.code}] ${x.detail ?? String(err)}]`);
    }
  };

  /** Sends the active file to the recycle bin (breadcrumb trash button). */
  const handleDeleteActiveFile = () => {
    if (!activeTab || !activeNode) {
      showToast(t('ide.nothingToDelete'), t('ide.openFileFirst'), 'info');
      return;
    }
    void handleDeleteEntry(activeNode);
  };

  // Otomatik kaydet (Ayarlar > Editör): yazma durduktan ~1.5 sn sonra kirli
  // aktif dosyayı diske yazar. Hata sessizdir; kullanıcı yine de elle
  // kaydedebilir.
  useEffect(() => {
    if (!autosave || !activeTab || !activeNode) return;
    if (!isDirty(activeTab)) return;
    const timer = window.setTimeout(() => {
      const code = fileContents[activeTab];
      if (code === undefined || !isDirty(activeTab)) return;
      void (async () => {
        try {
          await invoke('thalamus_write_file', { path: activeTab, content: withOriginalEol(activeTab, code) });
          setSavedContents(prev => (prev[activeTab] === code ? prev : { ...prev, [activeTab]: code }));
        } catch { /* sessiz: Kaydet her zaman elle kullanılabilir */ }
      })();
    }, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosave, fileContents, activeTab, activeNode]);

  useEffect(() => {
    const handleKeyDownGlobal = (e: KeyboardEvent) => {
      // T3: focus terminaldeyse Ctrl+S/Ctrl+R editör kısayolu olarak yutulmaz —
      // xterm'in PowerShell'e giden Control+S/R (Ctrl+R = geçmiş arama) korunur.
      const inTerminal = e.target instanceof HTMLElement && !!e.target.closest('.xterm');
      if (inTerminal) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSaveActiveFile();
      }
      // F5: Ctrl+R — aktif dosyayı çalıştır (sekmeli görünümde tarayıcı
      // yenilemesine dönüşmesin).
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        if (activeTab && activeNode) handleRunActiveFile();
        else showToast(t('ide.nothingToRun'), t('ide.openFileFirst'), 'info');
      }
    };
    window.addEventListener('keydown', handleKeyDownGlobal);
    return () => window.removeEventListener('keydown', handleKeyDownGlobal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, fileContents, activeNode]);

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = e.currentTarget.selectionStart;
      const end = e.currentTarget.selectionEnd;
      const value = e.currentTarget.value;
      const newValue = value.substring(0, start) + ' '.repeat(tabSize) + value.substring(end);
      handleApplyCode(activeTab, newValue);
      const target = e.currentTarget;
      setTimeout(() => {
        target.selectionStart = target.selectionEnd = start + tabSize;
      }, 0);
    }
  };

  const handleApplyCode = (file: string, newCode: string) => {
    setFileContents(prev => (prev[file] === newCode ? prev : { ...prev, [file]: newCode }));
  };

  const renderTreeNodes = (nodes: FileNode[], level = 0) => {
    return nodes.map(node => {
      const isActive = activeTab === node.id;
      const paddingLeft = `${level * 12 + 8}px`;

      if (node.isFolder) {
        return (
          <div key={node.id} className="flex flex-col">
            <div
              data-folder-id={node.id}
              onMouseDown={(e) => handleMouseDown(e, node)}
              onContextMenu={(e) => openCtxMenu(e, node)}
              onClick={() => handleToggleFolder(node.id)}
              style={{ paddingLeft }}
              className="w-full flex items-center gap-1.5 py-1 rounded text-[12px] font-mono text-[#CECDC3] cursor-pointer hover:bg-[#282726] transition-all select-none"
            >
              {node.isOpen ? (
                <ChevronDown size={14} className="text-[#87857F]" />
              ) : (
                <ChevronRight size={14} className="text-[#87857F]" />
              )}
              {node.isOpen ? <FolderOpen size={14} className="text-[#dcb67a]" /> : <Folder size={14} className="text-[#dcb67a]" />}
              <span className="truncate font-medium">{node.name}</span>
            </div>
            {node.isOpen && node.children && (
              <div className="flex flex-col">
                {renderTreeNodes(node.children, level + 1)}
              </div>
            )}
          </div>
        );
      }

      return (
        <div
          key={node.id}
          onMouseDown={(e) => handleMouseDown(e, node)}
          onContextMenu={(e) => openCtxMenu(e, node)}
          onClick={() => handleOpenFile(node)}
          style={{ paddingLeft }}
          className={`w-full flex items-center gap-1.5 py-1 rounded text-[12px] font-mono cursor-pointer transition-colors select-none ${
            isActive 
              ? 'bg-[#34332F] text-[#F2F0E5] font-medium' 
              : 'text-[#A8A49E] hover:bg-[#282726] hover:text-[#CECDC3]'
          }`}
        >
          <div className="w-[14px] flex-shrink-0" />
          <FileCode size={14} className={isActive ? 'text-[#3AA99F]' : 'text-[#87857F]'} />
          <span className="truncate">{node.name}</span>
        </div>
      );
    });
  };

  // Arama hızı: filtre + satır üretimi her tuşta yeniden çalışmasın.
  // useDeferredValue yazmayı anında gösterir, ağaç bir kare geriden gelir;
  // useMemo yalnız ağaç/arama/sekme gerçekten değişince yeniden kurar.
  const deferredTreeSearch = React.useDeferredValue(treeSearch);
  const visibleTree = React.useMemo(
    () => filterTree(fileTree, deferredTreeSearch),
    [fileTree, deferredTreeSearch]
  );
  const treeRows = React.useMemo(
    () => (rootExpanded ? renderTreeNodes(visibleTree) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootExpanded, visibleTree, activeTab, fileContents, openTabs]
  );

  return (
    <div className="w-full h-full flex bg-[#1C1B1A] text-[#CECDC3] font-sans overflow-hidden select-none border-t border-[#34332F] relative">
      
      {/* DRAGGED ITEM BADGE */}
      {draggedNode && (
        <div 
          style={{ left: `${dragPos.x + 12}px`, top: `${dragPos.y + 12}px` }}
          className="fixed pointer-events-none z-50 bg-[#282726] border border-[#4385BE] px-2.5 py-1 rounded shadow-2xl flex items-center gap-2 text-[11px] font-mono text-white opacity-90"
        >
          {draggedNode.isFolder ? <Folder size={13} className="text-[#dcb67a]" /> : <FileCode size={13} className="text-[#3AA99F]" />}
          <span>{draggedNode.name}</span>
        </div>
      )}

      {/* F7b: AĞAÇ SAĞ-TIK MENÜSÜ */}
      {ctxMenu && (() => {
        const dir = ctxMenu.node.isFolder
          ? ctxMenu.node.id
          : (ctxMenu.node.id.includes('/') ? ctxMenu.node.id.slice(0, ctxMenu.node.id.lastIndexOf('/')) : '');
        return (
          <div
            style={{ left: Math.min(ctxMenu.x, window.innerWidth - 190), top: Math.min(ctxMenu.y, window.innerHeight - 180) }}
            className="fixed z-50 w-[176px] bg-[#282726] border border-[#34332F] rounded-md shadow-2xl py-1 animate-in fade-in zoom-in-95 duration-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2.5 py-1.5 text-[11px] font-sans text-[#A8A49E] truncate border-b border-[#34332F]/60 flex items-center gap-1.5">
              {ctxMenu.node.isFolder ? <Folder size={11} className="flex-shrink-0 text-[#dcb67a]" /> : <FileCode size={11} className="flex-shrink-0 text-[#3AA99F]" />}
              <span className="truncate font-medium text-[#CECDC3]">{ctxMenu.node.name}</span>
            </div>
            <button
              type="button"
              onClick={() => { setCtxMenu(null); startCreate('file', dir); }}
              className="w-full text-left px-2.5 py-1.5 text-[11.5px] font-sans text-[#CECDC3] hover:bg-[#34332F] hover:text-white cursor-pointer transition-colors"
            >
              <Plus size={11} className="mr-1.5 inline text-[#3AA99F]" /> {t('ide.newFileHere')}
            </button>
            <button
              type="button"
              onClick={() => { setCtxMenu(null); startCreate('folder', dir); }}
              className="w-full text-left px-2.5 py-1.5 text-[11.5px] font-sans text-[#CECDC3] hover:bg-[#34332F] hover:text-white cursor-pointer transition-colors"
            >
              <FolderPlus size={11} className="mr-1.5 inline text-[#dcb67a]" /> {t('ide.newFolderHere')}
            </button>
            {!ctxMenu.node.isFolder && onOpenPreview && isPreviewText(ctxMenu.node.name) && (
              <button
                type="button"
                onClick={() => { const target = ctxMenu.node; setCtxMenu(null); void handlePreviewNode(target); }}
                className="w-full text-left px-2.5 py-1.5 text-[11.5px] font-sans text-[#CECDC3] hover:bg-[#34332F] hover:text-white cursor-pointer transition-colors"
              >
                <Eye size={11} className="mr-1.5 inline text-[#dcb67a]" /> {t('ide.preview')}
              </button>
            )}
            <button
              type="button"
              onClick={() => { setCtxMenu(null); void handleRenameEntry(ctxMenu.node); }}
              className="w-full text-left px-2.5 py-1.5 text-[11.5px] font-sans text-[#CECDC3] hover:bg-[#34332F] hover:text-white cursor-pointer transition-colors"
            >
              <Pencil size={11} className="mr-1.5 inline text-[#4385BE]" /> {t('ide.rename')}
            </button>
            <button
              type="button"
              onClick={() => { setCtxMenu(null); void handleDeleteEntry(ctxMenu.node); }}
              className="w-full text-left px-2.5 py-1.5 text-[11.5px] font-sans text-[#D14D41] hover:bg-[#34332F] hover:text-[#E0685C] cursor-pointer transition-colors"
            >
              <Trash2 size={11} className="mr-1.5 inline" /> {t('ide.delete')}
            </button>
          </div>
        );
      })()}

      {/* CONFIRMATION MODAL */}
      {pendingMove && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[#282726] border border-[#34332F] rounded-lg shadow-2xl w-[360px] p-4 flex flex-col gap-3 font-sans animate-in fade-in zoom-in-95 duration-100">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-[#dcb67a]/10 rounded-full text-[#dcb67a] flex-shrink-0">
                <AlertTriangle size={20} />
              </div>
              <div className="flex flex-col gap-1">
                <h3 className="text-[13px] font-semibold text-white">{t('ide.confirmMove')}</h3>
                <p className="text-[11.5px] text-[#A8A49E] leading-relaxed">
                  Move <span className="font-mono text-[#3AA99F] font-medium">{pendingMove.targetNodeName}</span>{' '}
                  into <span className="font-mono text-[#dcb67a] font-medium">{pendingMove.targetFolderName}</span>?
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={() => setPendingMove(null)}
                className="px-3 py-1.5 rounded text-[11px] font-medium bg-[#34332F] hover:bg-[#34332F] text-[#CECDC3] cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmMove}
                className="px-3 py-1.5 rounded text-[11px] font-medium bg-[#205EA6] hover:bg-[#4385BE] text-white cursor-pointer transition-colors"
              >
                Yes, Move
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SECTION 1: EXPLORER — yalnız kod modunda; daraltılabilir. */}
      {paneMode === 'code' && (
        <div
          data-root-zone="true"
          style={{ width: explorerOpen ? 220 : 0 }}
          className={`bg-[#1C1B1A] flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
            explorerOpen ? 'border-r border-[#34332F]' : 'border-r border-transparent'
          }`}
        >
        <div className="w-[220px] h-full flex flex-col justify-between">
        <div className="flex flex-col w-full h-full">
          <div className="px-3 py-2 text-[11px] font-bold text-[#87857F] tracking-wider uppercase flex items-center justify-between border-b border-[#34332F]">
            <span>{t('ide.explorer')}</span>
            <div className="flex items-center gap-1 text-[#CECDC3]">
              <button
                title={t('ide.openFolder')}
                type="button"
                onClick={handleChooseFolder}
                className="p-1 hover:bg-[#282726] rounded cursor-pointer text-[#CECDC3] hover:text-white transition-colors"
              >
                <FolderOpen size={13} />
              </button>
              <button
                title={t('ide.refreshTree')}
                type="button"
                onClick={() => void loadTree()}
                className="p-1 hover:bg-[#282726] rounded cursor-pointer text-[#CECDC3] hover:text-white transition-colors"
              >
                <RefreshCw size={13} />
              </button>
              {/* Tek "+" düğmesi: tıklayınca Dosya / Klasör'e ayrılır. */}
              <div className="relative">
                <button
                  title={t('ide.newFileRoot')}
                  type="button"
                  onClick={() => setNewMenuOpen(v => !v)}
                  className={`p-1 rounded cursor-pointer transition-colors ${
                    newMenuOpen ? 'bg-[#282726] text-white' : 'hover:bg-[#282726] text-[#CECDC3] hover:text-white'
                  }`}
                >
                  <Plus size={13} />
                </button>
                {newMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 z-40 w-[150px] rounded-md border border-[#34332F] bg-[#282726] shadow-2xl py-1 animate-in fade-in zoom-in-95 duration-100">
                    <button
                      type="button"
                      onClick={() => { setNewMenuOpen(false); startCreate('file', ''); }}
                      title={t('ide.newFileRoot')}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11.5px] font-sans text-[#CECDC3] hover:bg-[#34332F] hover:text-white cursor-pointer transition-colors"
                    >
                      <FileCode size={12} className="flex-shrink-0 text-[#3AA99F]" /> {t('ide.newFileHere')}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setNewMenuOpen(false); startCreate('folder', ''); }}
                      title={t('ide.newFolderRoot')}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11.5px] font-sans text-[#CECDC3] hover:bg-[#34332F] hover:text-white cursor-pointer transition-colors"
                    >
                      <FolderPlus size={12} className="flex-shrink-0 text-[#dcb67a]" /> {t('ide.newFolderHere')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Arama: doğrudan Explorer başlığının altında; ağaç onun altında
              başlar. */}
          <div className="px-2 py-1.5 border-b border-[#34332F]/60">
            <div className="flex items-center gap-1.5 rounded-md border border-[#34332F] bg-[#100F0F] focus-within:border-[#4385BE]/60 transition-colors px-2 py-1">
              <SearchIcon size={11} className="text-[#87857F] flex-shrink-0" />
              <input
                type="text"
                value={treeSearch}
                onChange={(e) => setTreeSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setTreeSearch(''); }}
                placeholder={t('ide.searchFiles')}
                className="w-full bg-transparent text-[#F2F0E5] font-mono text-[11px] outline-none placeholder-[#575654]"
                spellCheck={false}
              />
              {treeSearch && (
                <button
                  type="button"
                  onClick={() => setTreeSearch('')}
                  className="text-[#575654] hover:text-[#CECDC3] cursor-pointer flex-shrink-0"
                  title={t('common.cancel')}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          </div>

          <button
            type="button"
            data-root-zone="true"
            onClick={() => setRootExpanded(v => !v)}
            className="px-2 py-1.5 flex items-center gap-1 text-[11px] font-semibold border-b border-[#34332F] bg-[#282726] text-[#CECDC3] hover:bg-[#34332F] cursor-pointer transition-all select-none w-full text-left"
            title={rootExpanded ? t('ide.collapseTree') : t('ide.expandTree')}
          >
            <ChevronDown size={14} className={`text-[#87857F] transition-transform duration-150 ${rootExpanded ? '' : 'rotate-180'}`} />
            <span className="truncate">{workspaceName}</span>
          </button>

          <div
            data-root-zone="true"
            className="p-1 flex flex-col gap-0.5 flex-1 overflow-y-auto pretty-scrollbar"
          >
            {creationMode && (
              <form onSubmit={handleCreateItem} className="mx-0.5 mb-1 rounded-md border border-[#dcb67a]/40 bg-[#100F0F] p-1.5 flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  {creationMode === 'folder' ? (
                    <Folder size={13} className="text-[#dcb67a] flex-shrink-0" />
                  ) : (
                    <FileCode size={13} className="text-[#3AA99F] flex-shrink-0" />
                  )}
                  {/* F7b: hedef klasör düz yazıyla görünür — "aktif sekmenin
                      klasörüne gizlice yaz" davranışı kalktı. */}
                  <span className="truncate font-sans text-[10px] text-[#87857F]" title={creatingIn || 'workspace root'}>
                    {creatingIn ? `${creatingIn.split('/').pop()}/` : './'}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setCreationMode(null); setNewItemName(''); }}
                    className="ml-auto text-[#575654] hover:text-[#CECDC3] cursor-pointer flex-shrink-0"
                    title={t('common.cancel')}
                  >
                    <X size={11} />
                  </button>
                </div>
                <input
                  type="text"
                  autoFocus
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setCreationMode(null);
                      setNewItemName('');
                    }
                  }}
                  placeholder={creationMode === 'folder' ? 'folder_name' : 'file.py'}
                  className="w-full bg-transparent border-b border-[#dcb67a]/40 focus:border-[#dcb67a] text-[#F2F0E5] font-mono text-[12px] px-0.5 py-1 outline-none transition-colors placeholder:text-[#575654]"
                />
                <span className="text-[9.5px] text-[#575654]">{t('ide.createHint')}</span>
              </form>
            )}

            {rootExpanded && treeRows}
            {rootExpanded && fileTree.length === 0 && !treeSearch.trim() && !creationMode && (
              <div className="px-2 py-3 flex flex-col items-start gap-2">
                <p className="text-[10.5px] leading-relaxed text-[#87857F]">{t('ide.emptyWorkspace')}</p>
                <button
                  type="button"
                  onClick={handleChooseFolder}
                  className="flex items-center gap-1.5 rounded border border-[#575654] px-2 py-1 text-[10.5px] text-[#CECDC3] hover:bg-[#282726] hover:text-white transition-colors"
                >
                  <FolderOpen size={12} />
                  {t('ide.openFolder')}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="p-2 border-t border-[#34332F] text-[11px] font-mono text-[#87857F] flex items-center justify-between bg-[#1C1B1A]">
          <span className="flex items-center gap-1">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                engineOnline === null
                  ? 'bg-[#575654]'
                  : engineOnline
                    ? 'bg-[#3AA99F]'
                    : 'bg-[#D0A215]'
              }`}
            />
            {engineOnline === null
              ? t('ide.engineCheck')
              : engineOnline
                ? t('ide.engineActive')
                : t('ide.engineOffline')}
          </span>
          <span className="text-[#3AA99F]">{workspaceName}</span>
        </div>
        </div>
        </div>
      )}

      {/* SECTION 2: EDITOR AND TERMINAL — M8: dar pencerede editör 0px'e
          ezilmesin; alt sinir sabit (pencere küçülünce taşma tercih edilir). */}
      <div className="flex-1 flex flex-col min-w-[280px] bg-[#282726]">
        {/* Pano seçici: Kod editörü ↔ Ajan Ağı (Projeler bölümünün ajan sistemi). */}
        <div className="h-8 bg-[#1C1B1A] border-b border-[#34332F] flex items-center gap-1 px-2 flex-shrink-0">
          {paneMode === 'code' && (
            <>
              <button
                type="button"
                onClick={() => setExplorerOpen(v => !v)}
                aria-expanded={explorerOpen}
                aria-label={explorerOpen ? t('ide.hideExplorer') : t('ide.showExplorer')}
                title={explorerOpen ? t('ide.hideExplorer') : t('ide.showExplorer')}
                className={`flex h-6 w-6 items-center justify-center rounded transition-colors cursor-pointer ${
                  explorerOpen
                    ? 'text-[#CECDC3] hover:bg-[#282726] hover:text-white'
                    : 'text-[#87857F] hover:bg-[#282726] hover:text-white'
                }`}
              >
                <PanelLeft size={13} />
              </button>
              <div className="w-px h-3.5 bg-[#34332F] mr-0.5" />
            </>
          )}
          <button
            type="button"
            onClick={() => setPaneMode('code')}
            className={`px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer transition-colors ${
              paneMode === 'code' ? 'bg-[#4385BE]/15 text-[#4385BE]' : 'text-[#87857F] hover:text-[#CECDC3]'
            }`}
          >
            {t('agents.paneCode')}
          </button>
          <button
            type="button"
            onClick={() => setPaneMode('agents')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer transition-colors ${
              paneMode === 'agents' ? 'bg-[#3AA99F]/15 text-[#3AA99F]' : 'text-[#87857F] hover:text-[#CECDC3]'
            }`}
          >
            <Building2 size={12} />
            {t('agents.paneAgents')}
          </button>
        </div>

        <div className={`flex flex-col flex-1 min-h-0 ${paneMode !== 'code' ? 'hidden' : 'animate-in fade-in duration-150'}`}>
        <div className="h-9 bg-[#282726] border-b border-[#34332F] flex items-center px-1 overflow-x-auto gap-0.5 flex-shrink-0">
          {openTabs.map(fileName => {
            const isActive = activeTab === fileName;
            return (
              <div
                key={fileName}
                onClick={() => setActiveTab(fileName)}
                className={`h-9 px-3 flex items-center gap-2 text-[12px] font-mono cursor-pointer border-t-2 transition-colors ${
                  isActive 
                    ? 'bg-[#282726] border-[#4385BE] text-[#F2F0E5]' 
                    : 'bg-[#34332F] border-transparent text-[#A8A49E] hover:bg-[#282726]'
                }`}
              >
                <FileCode size={13} className={isActive ? 'text-[#3AA99F]' : 'text-[#87857F]'} />
                <span>{fileName.split('/').pop()}</span>
                {/* V1: kaydedilmemis degisiklik gostergesi (VS Code tarzı nokta) */}
                {isDirty(fileName) && (
                  <span
                    className="w-2 h-2 rounded-full bg-[#dcb67a] flex-shrink-0"
                    title={t('ide.unsaved')}
                  />
                )}
                <button
                  type="button"
                  aria-label={`Close ${fileName}`}
                  onClick={(e) => handleCloseTab(e, fileName)}
                  title={t('ide.closeTab')}
                  className="w-[18px] h-[18px] flex items-center justify-center flex-shrink-0 rounded hover:text-[#D14D41] hover:bg-[#34332F]/40 cursor-pointer transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="h-6 bg-[#282726] border-b border-[#34332F]/60 px-3 flex items-center gap-1 text-[11px] font-mono text-[#87857F] flex-shrink-0">
          <span>{workspaceName}</span>
          <ChevronRight size={12} />
          <span className="text-[#CECDC3] font-medium flex-1 truncate">{activeTab}</span>
          {!noFileOpen && (
            <button
              type="button"
              onClick={handleRenameActiveFile}
              className="p-0.5 rounded text-[#87857F] hover:text-[#4385BE] hover:bg-[#282726] cursor-pointer transition-colors flex-shrink-0"
              title={t('ide.renameActive')}
            >
              <Pencil size={12} />
            </button>
          )}
          {!noFileOpen && (
            <button
              type="button"
              onClick={handleDeleteActiveFile}
              className="p-0.5 rounded text-[#87857F] hover:text-[#D14D41] hover:bg-[#282726] cursor-pointer transition-colors flex-shrink-0"
              title={t('ide.deleteActive')}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>

        {/* select-text: kök kapsayıcı select-none olmasına rağmen düzenleyici
            tıklamaları/seçimleri güvenilir olsun (webview'da caret kayması). */}
        <div className="flex-1 overflow-hidden p-2 font-mono leading-[1.6] bg-[#282726] text-[#CECDC3] flex select-text">
          {noFileOpen ? (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[#87857F] select-none">
              <span>{t('ide.noFileOpen')}</span>
            </div>
          ) : (
            <>
            {showLineNumbers && (
              <div
                ref={lineNumbersRef}
                style={{ fontSize }}
                className="pr-4 border-r border-[#34332F]/50 text-[#87857F] text-right select-none flex flex-col min-w-[32px] overflow-hidden flex-shrink-0"
              >
                {/* Cok satirli dosyada sutun uretilmez: binlerce span yazmayi kilitler. */}
                {gutterLines ? (
                  gutterLines.map((_, i) => (
                    <span key={i} className="hover:text-[#CECDC3]">{i + 1}</span>
                  ))
                ) : (
                  <span className="text-[10px] pr-1 text-[#5F5C57]" title={`Line numbers hidden above ${MAX_GUTTER_LINES} lines for speed`}>
                    {codeLines.length} ln
                  </span>
                )}
              </div>
            )}
          <div className="relative flex-1 min-w-0">
            {/* Colored layer — the visible text; the textarea on top is transparent. */}
            <pre
              ref={editorHighlightRef}
              aria-hidden="true"
              className="absolute inset-0 m-0 overflow-hidden whitespace-pre font-mono pointer-events-none select-none"
              style={{ fontSize, lineHeight: 1.6, padding: '0 0 0 1rem', boxSizing: 'border-box', tabSize }}
            >
              {highlightEnabled ? (
                <SyntaxHighlighter
                  language={editorLanguage}
                  style={vscDarkPlus as unknown as Record<string, React.CSSProperties>}
                  customStyle={{ background: 'transparent', margin: 0, padding: 0, fontSize, lineHeight: 1.6, fontFamily: 'inherit', tabSize }}
                  codeTagProps={{ style: { fontFamily: 'inherit', fontSize, lineHeight: 1.6 } }}
                  wrapLongLines={false}
                >
                  {deferredCode}
                </SyntaxHighlighter>
              ) : (
                currentCode
              )}
            </pre>
            <textarea
              ref={editorTextareaRef}
              onScroll={handleTextareaScroll}
              value={currentCode}
              onChange={(e) => { noteTyping(); handleApplyCode(activeTab, e.target.value); reportEditorContext(e.currentTarget); }}
              onKeyDown={handleEditorKeyDown}
              onKeyUp={(e) => reportEditorContext(e.currentTarget)}
              onClick={(e) => reportEditorContext(e.currentTarget)}
              onFocus={(e) => reportEditorContext(e.currentTarget)}
              onSelect={(e) => reportEditorContext(e.currentTarget)}
              wrap="off"
              style={{ fontSize, lineHeight: 1.6, padding: '0 0 0 1rem', boxSizing: 'border-box', tabSize, caretColor: 'rgb(var(--tlm-fg))', color: 'transparent' }}
              className="absolute inset-0 bg-transparent font-mono outline-none border-none resize-none whitespace-pre overflow-auto pretty-scrollbar selection:bg-[#4385BE]/30"
              spellCheck={false}
            />
          </div>
            </>
          )}
        </div>

        {/* TERMINAL */}
        <div
          ref={termFloat.frameRef}
          style={termFloat.style}
          className={`relative bg-[#1C1B1A] ${
            termFloat.floating
              ? FLOATING_CHROME
              : `flex flex-col flex-shrink-0 border-t border-[#34332F] transition-[height] duration-150 ease-out ${isTerminalOpen ? 'h-[200px] min-h-[200px]' : 'h-7'}`
          }`}
        >
          {/* İçerik native boyutta (keskin) kalır; pencereye göre akar/kaydırılır. */}
          <div style={termFloat.contentStyle}>
          {/* Sidebar'daki gibi kenara oturan yuvarlak aç/kapa düğmesi:
              açıkken aşağı (kapan), kapalıyken yukarı (aç). Yüzerken gizlenir. */}
          {!termFloat.floating && (
            <button
              type="button"
              onClick={() => setIsTerminalOpen(v => !v)}
              className="absolute -top-2.5 left-1/2 -translate-x-1/2 w-5 h-5 bg-obsidian-panel border border-obsidian-border rounded-full flex items-center justify-center text-obsidian-muted hover:border-obsidian-muted/40 hover:text-obsidian-text cursor-pointer z-50 transition-colors duration-150"
              title={isTerminalOpen ? t('ide.collapseTerminal') : t('ide.expandTerminal')}
            >
              {isTerminalOpen ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
            </button>
          )}
          <div
            ref={termFloat.headerRef}
            onPointerDown={termFloat.floating ? termFloat.onDragStart : undefined}
            className={`h-7 px-3 flex items-center justify-between gap-2 overflow-hidden whitespace-nowrap text-[11px] font-mono border-b border-[#34332F] bg-[#282726] flex-shrink-0 ${termFloat.floating ? 'cursor-move' : ''}`}
          >
            <button
              type="button"
              className="flex items-center gap-2 flex-shrink-0 cursor-pointer bg-transparent border-none outline-none focus:outline-none focus:ring-1 focus:ring-[#4385BE]/40 rounded px-1 text-left"
              onClick={() => setIsTerminalOpen(!isTerminalOpen)}
            >
              <TerminalIcon size={13} className="text-[#4385BE] flex-shrink-0" />
              <span className="font-semibold text-[#CECDC3] flex-shrink-0 whitespace-nowrap">{t('ide.terminal')}</span>
            </button>
            
            <div className="flex items-center gap-2 flex-shrink-0 whitespace-nowrap">
              <button 
                type="button" 
                onClick={handleSaveActiveFile}
                className="flex items-center gap-1 px-2 py-0.5 bg-[#282726] hover:bg-[#34332F] text-[#CECDC3] hover:text-white border border-[#34332F] rounded text-[11px] font-sans font-medium cursor-pointer"
                title={t('ide.saveFile')}
              >
                <Save size={10} /> Save
              </button>
              <button 
                type="button" 
                onClick={handleRunActiveFile}
                className="flex items-center gap-1 px-2 py-0.5 bg-[#205EA6] hover:bg-[#4385BE] text-white rounded text-[11px] font-sans font-medium cursor-pointer"
                title="Run Active Code"
              >
                <Play size={10} /> Run Active Code
              </button>
              <button
                type="button"
                onClick={termFloat.toggle}
                className={`flex h-6 w-6 items-center justify-center rounded transition-colors cursor-pointer flex-shrink-0 ${
                  termFloat.floating ? 'bg-[#4385BE]/15 text-[#4385BE]' : 'text-[#87857F] hover:bg-[#34332F] hover:text-[#CECDC3]'
                }`}
                title={termFloat.floating ? t('float.dock') : t('float.undock')}
              >
                <PictureInPicture2 size={12} />
              </button>
            </div>
          </div>

          {/* M2: katlama terminali UNMOUNT etmez — unmount temizligi
              close_terminal cagirisıyla calisan prosesi OLDURUYORDU.
              hidden ile PTY + xterm tamponu yasiya kalir; acilinda
              ResizeObserver yeniden fit eder. */}
          <div className={`flex-1 min-h-0 w-full bg-[#1C1B1A] overflow-hidden ${
            termFloat.floating ? '' : isTerminalOpen ? 'h-[173px]' : 'hidden'
          }`}>
            <RealTerminal />
          </div>
          </div>

          {termFloat.floating && <FloatResizeHandle onPointerDown={termFloat.onResizeStart} />}
        </div>
        </div>{/* /kod panosu (ajan modunda gizli; unmount DEĞİL) */}

        {/* Tek ajan yüzeyi: plan + hiyerarşi + gerçek çalıştırma + ofis.
            Boşta önceden kurulur, gizlenir; geçişte yeniden mount edilmez. */}
        {(agentsReady || paneMode === 'agents') && (
          <div className={`flex-1 min-h-0 ${
            paneMode === 'agents' ? 'flex animate-in fade-in duration-150' : 'hidden'
          }`}>
            <AgentCompany active={paneMode === 'agents'} />
          </div>
        )}
      </div>

      {/* Sağ sütun yalnızca önizleme için açılır. Nucleus artık kalıcı bir
          panel değil: çağrıldığında açılan yüzen pencere (Alt+N / başlık). */}
      {previewItem && (
        <div
          style={{ width: `${copilotWidth}px` }}
          className={`flex flex-col flex-shrink-0 relative select-none border-l border-[#282726] ${
            isResizingCopilot ? '' : 'transition-[width] duration-150 ease-out'
          }`}
        >
          <div
            onMouseDown={() => setIsResizingCopilot(true)}
            onDoubleClick={() => setCopilotWidth(DEFAULT_COPILOT_WIDTH)}
            className="absolute top-0 -left-1.5 bottom-0 w-3 cursor-col-resize hover:bg-[#4385BE]/40 transition-colors z-20 group flex items-center justify-center"
            title={t('ide.resizeTitle')}
          >
            <div className="w-[2px] h-full bg-transparent group-hover:bg-[#4385BE]" />
          </div>
          <div className="flex-1 min-h-0">
            <FilePreviewDrawer
              item={previewItem}
              onClose={() => onClosePreview?.()}
              inline
              contentWidth={copilotWidth - 8}
            />
          </div>
        </div>
      )}

      {/* Yüzen Nucleus: kapanınca unmount edilmez; sohbet, undo ve bekleyen
          düzenlemeler korunur. Konum/boyut hatırlanır. */}
      <div
        ref={nucleusFloat.frameRef}
        style={nucleusFloat.style
          ? { ...nucleusFloat.style, display: nucleusOpen ? 'flex' : 'none' }
          : { display: 'none' }}
        className={`bg-[#100F0F] relative ${FLOATING_CHROME}`}
      >
        <div style={nucleusFloat.contentStyle}>
          <div className="flex-1 flex flex-col min-h-0">
            <ThalamusCopilot
              activeFile={activeTab}
              activeFileCode={currentCode}
              workspaceFiles={workspaceFiles}
              onApplyCode={handleApplyCode}
              onOpenTerminal={() => setIsTerminalOpen(true)}
              floating
              onClose={() => setNucleusOpen(false)}
              onHeaderPointerDown={nucleusFloat.onDragStart}
              headerRef={nucleusFloat.headerRef}
            />
          </div>
        </div>
        <FloatResizeHandle onPointerDown={nucleusFloat.onResizeStart} />
      </div>

    </div>
  );
}