import React, { useState, useEffect, useRef } from 'react';
import { 
  FileCode, 
  Folder, 
  FolderOpen, 
  Terminal as TerminalIcon, 
  Plus, 
  FolderPlus, 
  ChevronDown,
  ChevronRight,
  X,
  Play,
  AlertTriangle,
  ChevronLeft,
  MessageSquare,
  Save,
  Trash2,
  Pencil,
  Search as SearchIcon
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { SyntaxHighlighter, vscDarkPlus } from '../lib/codeHighlight';
import { explainError } from '../lib/errors';
import { API_BASE } from '../services/ThalamusClient';
import { RealTerminal } from './RealTerminal';
import { ThalamusCopilot } from './ThalamusCopilot';
import { useToast } from './Toast';
import { fetchWorkspaceInfo, getWorkspaceName, getWorkspaceRoot, saveWorkspaceRoot } from '../lib/workspace';

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
}

interface PendingMove {
  targetNodeId: string;
  targetNodeName: string;
  targetFolderId: string | null;
  targetFolderName: string;
}

export function ProjectDashboard({ activeTab, setActiveTab }: ProjectDashboardProps) {
  const { showToast } = useToast();

  /** Ayarlarla canlı senkron: localStorage config'ini okur. */
  const readAppearance = () => {
    let fz = '13px', tab = 4, lines = true;
    try {
      const configStr = localStorage.getItem('thalamus_config');
      if (configStr) {
        const config = JSON.parse(configStr);
        if (config.appearance) {
          if (config.appearance.fontSize) fz = config.appearance.fontSize;
          if (config.appearance.tabSize) tab = config.appearance.tabSize;
          if (config.appearance.showLineNumbers !== undefined) lines = config.appearance.showLineNumbers;
        }
      }
    } catch {}
    return { fontSize: fz, tabSize: tab, showLineNumbers: lines };
  };

  // Editör görünüm ayarları state'tedir; Settings kaydettiğinde
  // 'thalamus_config_changed' olayıyla 20 sn / remount beklemeden uygulanır.
  const [fontSize, setFontSize] = useState<string>(() => readAppearance().fontSize);
  const [tabSize, setTabSize] = useState<number>(() => readAppearance().tabSize);
  const [showLineNumbers, setShowLineNumbers] = useState<boolean>(() => readAppearance().showLineNumbers);
  useEffect(() => {
    const sync = () => {
      const a = readAppearance();
      setFontSize(a.fontSize);
      setTabSize(a.tabSize);
      setShowLineNumbers(a.showLineNumbers);
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
  const [workspaceName, setWorkspaceName] = useState<string>(() => getWorkspaceName());
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editorHighlightRef = useRef<HTMLPreElement>(null);

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
          isOpen: e.is_dir && depth === 0,
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
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

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

  // Tamponlari her degisiklikte localStorage'a yansit; kaydedilen dosyalardan
  // sonra temizle.
  useEffect(() => {
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
        'Unsaved edits restored',
        `${file}: your last unsaved editor changes were restored instead of the disk copy. Save to write them to disk, or close the tab to discard.`,
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
  const [isCopilotOpen, setIsCopilotOpen] = useState<boolean>(true);

  // 🎯 MIN / MAX WIDTH LIMITS
  const MIN_COPILOT_WIDTH = 340;
  const MAX_COPILOT_WIDTH = 470;
  const DEFAULT_COPILOT_WIDTH = 470;

  const [copilotWidth, setCopilotWidth] = useState<number>(DEFAULT_COPILOT_WIDTH);
  const [isResizingCopilot, setIsResizingCopilot] = useState<boolean>(false);

  const [creationMode, setCreationMode] = useState<'file' | 'folder' | null>(null);
  const [newItemName, setNewItemName] = useState<string>('');
  // F5: gezgin arama filtresi (boşken tüm ağaç).
  const [treeSearch, setTreeSearch] = useState<string>('');
  // F7b: oluşturmanın hedef klasörü ("" = kök) + sağ-tık menüsü durumu.
  const [creatingIn, setCreatingIn] = useState<string>('');
  const [ctxMenu, setCtxMenu] = useState<{ node: FileNode; x: number; y: number } | null>(null);

  // DRAG STATES
  const [draggedNode, setDraggedNode] = useState<FileNode | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  // The pressed node + press origin; a drag only begins after a movement threshold.
  const pointerRef = useRef<{ node: FileNode; startX: number; startY: number } | null>(null);

  // 🎯 SMOOTH RESIZE MECHANISM
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

  const activeNode = findFileNode(fileTree, activeTab);
  const noFileOpen = !activeTab || !activeNode;
  const currentCode = activeNode ? (fileContents[activeTab] ?? '') : '';
  const codeLines = currentCode.split('\n');
  const editorLanguage = editorLanguageFor(activeTab);
  const highlightEnabled = currentCode.length <= 100000;
  // Highlighting the whole file on every keystroke is expensive on large files.
  // Deferring it keeps typing responsive: the textarea updates immediately and
  // the colors catch up on the next idle render.
  const deferredCode = React.useDeferredValue(currentCode);

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
        setActiveTab(finalId);
      }
    } catch (err) {
      console.error('Could not create entry:', err);
      showToast('Create Error', 'Could not write the file/folder to disk.', 'error');
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
    setFileTree(prev => toggleRecursive(prev));
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
    setFileTree(prev => open(prev));
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
      showToast('Move Error', 'Could not move the entry.', 'error');
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
    const raw = window.prompt(`Rename "${node.name}"`, node.name);
    const newName = raw?.trim();
    if (!newName || newName === node.name) return;
    // Windows dosya adında geçersiz karakterler — diske gitmeden dur.
    if (/[\\/:*?"<>|]/.test(newName)) {
      showToast('Invalid name', 'Name contains characters Windows does not allow (\\ / : * ? " < > |).', 'error');
      return;
    }
    const parent = node.id.includes('/') ? node.id.slice(0, node.id.lastIndexOf('/')) : '';
    const newPath = parent ? `${parent}/${newName}` : newName;
    try {
      await invoke('move_entry', { from: node.id, to: newPath });
      await loadTree();
      remapPathKeys(node.id, newPath);
      showToast('Renamed', `${node.name} → ${newName}`, 'success');
    } catch (err) {
      console.error('Rename error:', err);
      showToast('Rename Error', `Could not rename ${node.id}.`, 'error');
    }
  };

  /** F5: aktif dosyayı yeniden adlandırır (breadcrumb kalem düğmesi). */
  const handleRenameActiveFile = () => {
    if (!activeTab || !activeNode) {
      showToast('Nothing to rename', 'Open a file from the explorer first.', 'info');
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
      if (!window.confirm(`"${name}" has unsaved changes. Close anyway and lose them? (Tip: Ctrl+S saves.)`)) {
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
    if (activeTab === fileName && updatedTabs.length > 0) {
      setActiveTab(updatedTabs[updatedTabs.length - 1]);
    }
  };

  const handleOpenFile = async (node: FileNode) => {
    if (node.isFolder) {
      handleToggleFolder(node.id);
      return;
    }
    // Read from disk if content is not loaded yet (lazy loading)
    if (fileContents[node.id] === undefined) {
      try {
        const code = await invoke<string>('thalamus_read_file', { path: node.id });
        storeFileContent(node.id, code);
      } catch (err) {
        console.error('Could not read file:', err);
        const x = explainError(err, 'File read');
        showToast(
          x.title,
          `"${node.id}" could not be opened. ${x.explanation}`,
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

  const handleRunActiveFile = async () => {
    if (!activeTab || !activeNode) return;
    const fileCode = fileContents[activeTab];
    if (fileCode !== undefined) {
      try {
        await invoke('thalamus_write_file', { path: activeTab, content: fileCode });
        setSavedContents(prev => ({ ...prev, [activeTab]: fileCode }));
      } catch (e) {
        console.error("Could not save file to disk:", e);
        showToast('Save Failed', `${activeTab} was not saved — running the DISK copy, which may differ from the editor.`, 'error');
      }
    }

    // V1 (C-dizi): bosluklu/yol tureten isimler komutu kirmasın diye tırnakla.
    const quoted = `"${activeTab.replace(/"/g, '\\"')}"`;
    const isScript = activeTab.endsWith('.py') || activeTab.endsWith('.rs');
    const cmd = activeTab.endsWith('.py')
      ? `python ${quoted}`
      : activeTab.endsWith('.rs')
        ? `cargo run`
        : `Get-Content ${quoted}`;

    // Çalıştırma dürüstlüğü: script olmayan dosya "çalıştırılmaz", içeriği
    // ekrana basılır — kullanıcıya önceden söyle + komutu onayla.
    if (!isScript) {
      if (!window.confirm(
        `"${activeTab}" is not a runnable script (.py/.rs). Its CONTENTS will be printed instead of running.\n\nCommand: ${cmd}\n\nProceed?`
      )) return;
    } else if (!window.confirm(`Run "${activeTab}"?\n\nCommand: ${cmd}`)) return;

    // Calisma gercekten gorulebilsin: terminal katlamaysa ac, sonra yaz.
    // (Katli terminalde gonderilen komut gorunmez "sessiz islem" olurdu.)
    setIsTerminalOpen(true);
    setTimeout(() => {
      invoke('write_terminal', { data: cmd + '\r' }).catch(console.error);
    }, 150);
  };

  const handleSaveActiveFile = async () => {
    if (!activeTab || !activeNode) {
      showToast('Nothing to save', 'Open a file from the explorer first.', 'info');
      return;
    }
    const fileCode = fileContents[activeTab];
    if (fileCode !== undefined) {
      try {
        await invoke('thalamus_write_file', { path: activeTab, content: fileCode });
        setSavedContents(prev => ({ ...prev, [activeTab]: fileCode }));
        showToast('File Saved', `${activeTab} successfully saved to disk.`, 'success');
      } catch (e) {
        console.error("Could not save file to disk:", e);
        showToast('Save Error', `An error occurred while saving ${activeTab}.`, 'error');
      }
    }
  };

  /** F7b: herhangi bir dosya/klasörü çöp kutusuna gönderir. */
  const handleDeleteEntry = async (node: FileNode) => {
    if (!window.confirm(`Delete "${node.name}"? It will be moved to the recycle bin.`)) return;
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
        showToast('Deleted', `${node.name} moved to the recycle bin.`, 'success');
      } else {
        showToast('Permanently Deleted', `${node.name} was NOT sent to the recycle bin (${mode}). It cannot be restored from the app.`, 'error');
      }
    } catch (err) {
      console.error('Delete error:', err);
      showToast('Delete Error', `Could not delete ${node.id}.`, 'error');
    }
  };

  /** Sends the active file to the recycle bin (breadcrumb trash button). */
  const handleDeleteActiveFile = () => {
    if (!activeTab || !activeNode) {
      showToast('Nothing to delete', 'Open a file from the explorer first.', 'info');
      return;
    }
    void handleDeleteEntry(activeNode);
  };

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
        else showToast('Nothing to run', 'Open a file from the explorer first.', 'info');
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
            <div className="px-2.5 py-1.5 text-[10px] font-mono text-[#575654] truncate border-b border-[#34332F]/60">
              {ctxMenu.node.isFolder ? <Folder size={11} className="inline mr-1 text-[#dcb67a]" /> : <FileCode size={11} className="inline mr-1 text-[#3AA99F]" />}
              {ctxMenu.node.name}
            </div>
            <button
              type="button"
              onClick={() => { setCtxMenu(null); startCreate('file', dir); }}
              className="w-full text-left px-2.5 py-1.5 text-[11.5px] font-sans text-[#CECDC3] hover:bg-[#34332F] hover:text-white cursor-pointer transition-colors"
            >
              <Plus size={11} className="mr-1.5 inline text-[#3AA99F]" /> New File Here
            </button>
            <button
              type="button"
              onClick={() => { setCtxMenu(null); startCreate('folder', dir); }}
              className="w-full text-left px-2.5 py-1.5 text-[11.5px] font-sans text-[#CECDC3] hover:bg-[#34332F] hover:text-white cursor-pointer transition-colors"
            >
              <FolderPlus size={11} className="mr-1.5 inline text-[#dcb67a]" /> New Folder Here
            </button>
            <button
              type="button"
              onClick={() => { setCtxMenu(null); void handleRenameEntry(ctxMenu.node); }}
              className="w-full text-left px-2.5 py-1.5 text-[11.5px] font-sans text-[#CECDC3] hover:bg-[#34332F] hover:text-white cursor-pointer transition-colors"
            >
              <Pencil size={11} className="mr-1.5 inline text-[#4385BE]" /> Rename…
            </button>
            <button
              type="button"
              onClick={() => { setCtxMenu(null); void handleDeleteEntry(ctxMenu.node); }}
              className="w-full text-left px-2.5 py-1.5 text-[11.5px] font-sans text-[#D14D41] hover:bg-[#34332F] hover:text-[#E0685C] cursor-pointer transition-colors"
            >
              <Trash2 size={11} className="mr-1.5 inline" /> Delete…
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
                <h3 className="text-[13px] font-semibold text-white">Confirm Move</h3>
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

      {/* SECTION 1: EXPLORER */}
      <div 
        data-root-zone="true"
        className="w-[220px] bg-[#1C1B1A] border-r border-[#34332F] flex flex-col justify-between flex-shrink-0"
      >
        <div className="flex flex-col w-full h-full">
          <div className="px-3 py-2 text-[11px] font-bold text-[#87857F] tracking-wider uppercase flex items-center justify-between border-b border-[#34332F]">
            <span>EXPLORER</span>
            <div className="flex items-center gap-1 text-[#CECDC3]">
              <button 
                title="New File (workspace root)" 
                type="button" 
                onClick={() => startCreate('file', '')}
                className="p-1 hover:bg-[#282726] rounded cursor-pointer text-[#CECDC3] hover:text-white transition-colors"
              >
                <Plus size={13} />
              </button>
              <button 
                title="New Folder (workspace root)" 
                type="button" 
                onClick={() => startCreate('folder', '')}
                className="p-1 hover:bg-[#282726] rounded cursor-pointer text-[#CECDC3] hover:text-white transition-colors"
              >
                <FolderPlus size={13} />
              </button>
            </div>
          </div>

          <button
            type="button"
            data-root-zone="true"
            onClick={() => setRootExpanded(v => !v)}
            className="px-2 py-1.5 flex items-center gap-1 text-[11px] font-semibold border-b border-[#34332F] bg-[#282726] text-[#CECDC3] hover:bg-[#34332F] cursor-pointer transition-all select-none w-full text-left"
            title={rootExpanded ? 'Collapse workspace tree' : 'Expand workspace tree'}
          >
            <ChevronDown size={14} className={`text-[#87857F] transition-transform duration-150 ${rootExpanded ? '' : 'rotate-180'}`} />
            <span className="truncate">{workspaceName}</span>
          </button>

          <div 
            data-root-zone="true"
            className="p-1 flex flex-col gap-0.5 flex-1 overflow-y-auto pretty-scrollbar"
          >
            <div className="px-1 pb-1 flex items-center gap-1 border-b border-[#34332F]/50 pb-1.5 mb-0.5">
              <SearchIcon size={11} className="text-[#87857F] flex-shrink-0" />
              <input
                type="text"
                value={treeSearch}
                onChange={(e) => setTreeSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setTreeSearch(''); }}
                placeholder="Search files…"
                className="w-full bg-[#100F0F] border border-[#34332F] focus:border-[#4385BE]/60 text-[#F2F0E5] font-mono text-[11px] px-1.5 py-0.5 rounded outline-none placeholder-[#575654]"
                spellCheck={false}
              />
            </div>
            {creationMode && (
              <form onSubmit={handleCreateItem} className="px-1 py-0.5 flex items-center gap-1">
                {creationMode === 'folder' ? (
                  <Folder size={14} className="text-[#dcb67a]" />
                ) : (
                  <FileCode size={14} className="text-[#3AA99F]" />
                )}
                {/* F7b: hedef klasör düz yazıyla görünür — "aktif sekmenin
                    klasörüne gizlice yaz" davranışı kalktı. */}
                <span className="truncate font-mono text-[10px] text-[#575654]" title={creatingIn || 'workspace root'}>
                  {creatingIn ? `${creatingIn.split('/').pop()}/` : './'}
                </span>
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
                  className="w-full bg-[#100F0F] border border-[#4385BE] text-white font-mono text-[11px] px-1.5 py-0.5 rounded outline-none"
                />
              </form>
            )}

            {rootExpanded && renderTreeNodes(filterTree(fileTree, treeSearch))}
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
            {engineOnline === null ? 'Engine check…' : engineOnline ? 'Engine active' : 'Engine offline'}
          </span>
          <span className="text-[#3AA99F]">{workspaceName}</span>
        </div>
      </div>

      {/* SECTION 2: EDITOR AND TERMINAL — M8: dar pencerede editör 0px'e
          ezilmesin; alt sinir sabit (pencere küçülünce taşma tercih edilir). */}
      <div className="flex-1 flex flex-col min-w-[280px] bg-[#282726]">
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
                    title="Unsaved changes"
                  />
                )}
                <button
                  type="button"
                  aria-label={`Close ${fileName}`}
                  onClick={(e) => handleCloseTab(e, fileName)}
                  title="Close tab"
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
              title="Rename active file"
            >
              <Pencil size={12} />
            </button>
          )}
          {!noFileOpen && (
            <button
              type="button"
              onClick={handleDeleteActiveFile}
              className="p-0.5 rounded text-[#87857F] hover:text-[#D14D41] hover:bg-[#282726] cursor-pointer transition-colors flex-shrink-0"
              title="Delete active file (moves to recycle bin)"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-hidden p-2 font-mono leading-[1.6] bg-[#282726] text-[#CECDC3] flex">
          {noFileOpen ? (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[#87857F] select-none">
              <span>No file open — pick one from the explorer, or create a new file.</span>
            </div>
          ) : (
            <>
            {showLineNumbers && (
            <div 
              ref={lineNumbersRef}
              style={{ fontSize }}
              className="pr-4 border-r border-[#34332F]/50 text-[#87857F] text-right select-none flex flex-col min-w-[32px] overflow-hidden"
            >
              {codeLines.map((_, i) => (
                <span key={i} className="hover:text-[#CECDC3]">{i + 1}</span>
              ))}
            </div>
            )}
          <div className="relative flex-1 min-w-0">
            {/* Colored layer — the visible text; the textarea on top is transparent. */}
            <pre
              ref={editorHighlightRef}
              aria-hidden="true"
              className="absolute inset-0 m-0 overflow-hidden whitespace-pre font-mono pointer-events-none select-none"
              style={{ fontSize, lineHeight: 1.6, paddingLeft: '1rem', tabSize }}
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
              onChange={(e) => handleApplyCode(activeTab, e.target.value)}
              onKeyDown={handleEditorKeyDown}
              wrap="off"
              style={{ fontSize, lineHeight: 1.6, paddingLeft: '1rem', tabSize, caretColor: '#F2F0E5', color: 'transparent' }}
              className="absolute inset-0 bg-transparent font-mono outline-none border-none resize-none whitespace-pre overflow-auto pretty-scrollbar selection:bg-[#4385BE]/30"
              spellCheck={false}
            />
          </div>
            </>
          )}
        </div>

        {/* TERMINAL */}
        <div className={`border-t border-[#34332F] bg-[#1C1B1A] flex flex-col flex-shrink-0 ${
          isTerminalOpen ? 'h-[200px] min-h-[200px]' : 'h-7'
        }`}>
          <div className="h-7 px-3 flex items-center justify-between text-[11px] font-mono border-b border-[#34332F] bg-[#282726] flex-shrink-0">
            <button
              type="button"
              className="flex items-center gap-2 cursor-pointer bg-transparent border-none outline-none focus:outline-none focus:ring-1 focus:ring-[#4385BE]/40 rounded px-1 text-left"
              onClick={() => setIsTerminalOpen(!isTerminalOpen)}
            >
              <TerminalIcon size={13} className="text-[#4385BE]" />
              <span className="font-semibold text-[#CECDC3]">TERMINAL (PowerShell Native)</span>
            </button>
            
            <div className="flex items-center gap-2">
              <button 
                type="button" 
                onClick={handleSaveActiveFile}
                className="flex items-center gap-1 px-2 py-0.5 bg-[#282726] hover:bg-[#34332F] text-[#CECDC3] hover:text-white border border-[#34332F] rounded text-[11px] font-sans font-medium cursor-pointer"
                title="Save File (Ctrl+S)"
              >
                <Save size={10} /> Save
              </button>
              <button 
                type="button" 
                onClick={handleRunActiveFile}
                className="flex items-center gap-1 px-2 py-0.5 bg-[#205EA6] hover:bg-[#4385BE] text-white rounded text-[11px] font-sans font-medium cursor-pointer"
              >
                <Play size={10} /> Run Active Code
              </button>
            </div>
          </div>

          {/* M2: katlama terminali UNMOUNT etmez — unmount temizligi
              close_terminal cagirisıyla calisan prosesi OLDURUYORDU.
              hidden ile PTY + xterm tamponu yasiya kalir; acilinda
              ResizeObserver yeniden fit eder. */}
          <div className={`flex-1 w-full bg-[#1C1B1A] overflow-hidden ${isTerminalOpen ? 'h-[173px]' : 'hidden'}`}>
            <RealTerminal />
          </div>
        </div>
      </div>

      {/* 🎯 SECTION 3: COPILOT PANEL (MINIMAL CLOSED STATE & FULLY FIXED DRAGGING) */}
<div 
  style={{ width: isCopilotOpen ? `${copilotWidth}px` : '36px' }}
  className={`bg-[#100F0F] border-l border-[#282726] flex flex-col flex-shrink-0 relative select-none ${
    isResizingCopilot ? '' : 'transition-[width] duration-150 ease-out'
  }`}
>
  {/* Resizer Handle */}
  {isCopilotOpen && (
    <div
      onMouseDown={() => setIsResizingCopilot(true)}
      onDoubleClick={() => setCopilotWidth(DEFAULT_COPILOT_WIDTH)}
      className="absolute top-0 -left-1.5 bottom-0 w-3 cursor-col-resize hover:bg-[#4385BE]/40 transition-colors z-20 group flex items-center justify-center"
      title="Drag (340px - 470px) or double-click to reset the size"
    >
      <div className="w-[2px] h-full bg-transparent group-hover:bg-[#4385BE]" />
    </div>
  )}

  {/* 🎯 Aligned circular toggle button */}
  <button
    type="button"
    onClick={() => setIsCopilotOpen(!isCopilotOpen)}
    className="absolute top-1/2 -translate-y-1/2 -left-3 w-6 h-6 bg-[#282726] border border-[#34332F] hover:border-[#4385BE] rounded-full flex items-center justify-center text-[#CECDC3] hover:text-white shadow-xl cursor-pointer z-30 transition-all hover:scale-110"
    title={isCopilotOpen ? "Collapse Panel" : "Expand Panel"}
  >
    {isCopilotOpen ? (
      <ChevronRight size={13} />
    ) : (
      <ChevronLeft size={13} />
    )}
  </button>

  {/* Panel header or sleek minimal closed state */}
  {isCopilotOpen ? (
    <div className="h-8 border-b border-[#282726] px-2.5 flex items-center justify-between font-mono text-[11px] text-[#CECDC3] flex-shrink-0 bg-[#1C1B1A]">
      <div className="flex items-center gap-1 font-bold text-[#3AA99F] pl-1">
        <span>Thalamus</span>
      </div>
    </div>
  ) : (
    /* 🎯 CLEAN CLOSED STATE: a single icon centered on the strip */
    <div className="h-full w-full flex flex-col items-center pt-2.5 bg-[#1C1B1A]">
      <button
        type="button"
        onClick={() => setIsCopilotOpen(true)}
        className="p-1 hover:bg-[#282726] rounded text-[#4385BE] hover:text-white transition-colors cursor-pointer"
        title="Open Thalamus Copilot"
      >
        <MessageSquare size={15} />
      </button>
    </div>
  )}

  {/* Panel content — M2-tarzı: katlama unmount DEĞİL; sohbet + undo +
      pending editler katlayıp açarken yaşar kalır. */}
  <div 
    className="flex-1 flex flex-col min-h-0"
    style={{ display: isCopilotOpen ? 'flex' : 'none', visibility: isCopilotOpen ? 'visible' : 'hidden' }}
  >
    <ThalamusCopilot 
      activeFile={activeTab}
      activeFileCode={currentCode}
      workspaceFiles={collectFilePaths(fileTree)}
      onApplyCode={handleApplyCode}
      onOpenTerminal={() => setIsTerminalOpen(true)}
    />
  </div>
</div>

    </div>
  );
}