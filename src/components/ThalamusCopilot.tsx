import React, { useState, useRef } from 'react';
import { ts } from '../lib/format';
import { 
  FileText, 
  Check, 
  Paperclip, 
  Send, 
  GitPullRequest, 
  User, 
  Eye, 
  ListChecks, 
  ClipboardList, 
  CircleCheck, 
  Zap, 
  Bot, 
  Lightbulb, 
  ShieldCheck, 
  Terminal, 
  ScrollText, 
  FolderOpen, 
  Search, 
  Undo2, 
  ImagePlus, 
  X, 
  PictureInPicture2, 
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { pickFiles } from '../lib/workspace';
import { aiChat, userMessage, type AiChatResponse, type AiEditResult } from '../services/aiClient';
import { prepareImageFile, IMAGE_MODE_ORDER, DEFAULT_IMAGE_MODE, type AttachedImage, type ImageMode } from '../lib/imageAttach';
import { MarkdownMessage } from './MarkdownMessage';
import { CopilotDiffModal } from './CopilotDiffModal';
import { useT, type TranslationKey } from '../lib/i18n';

export interface ActionPayload {
  type: 'RUN_TERMINAL' | 'APPLY_PATCH';
  label: string;
  command?: string;
  codeSnippet?: string;
  targetFile?: string;
  originalCodeSnippet?: string;
}

export interface Message {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: string;
  modeUsed?: 'chat' | 'agent';
  actionPayload?: ActionPayload;
}

interface ThalamusCopilotProps {
  activeFile?: string;
  activeFileCode?: string;
  workspaceFiles?: string[];
  onApplyCode?: (file: string, code: string) => void;
  onOpenTerminal?: () => void;
  /** True when the panel is rendered as an in-app floating window. */
  floating?: boolean;
  /** Toggle between docked and floating. */
  onToggleFloat?: () => void;
  /** Drag handler for the header while floating. */
  onHeaderPointerDown?: React.PointerEventHandler<HTMLDivElement>;
  /** Ref to the header row (used to measure the unbreakable minimum width). */
  headerRef?: React.RefObject<HTMLDivElement | null>;
}

/** Slash command templates (Claude Code / ZCode style). */
const SLASH_TEMPLATES: Record<string, TranslationKey> = {
  '/explain': 'cop.cmdExplain',
  '/review': 'cop.cmdReview',
  '/refactor': 'cop.cmdRefactor',
  '/tests': 'cop.cmdTests',
};

/** Autonomy/approval levels, from safest to most hands-off. */
type PermissionMode = 'readonly' | 'plan' | 'ask' | 'auto' | 'safe' | 'autonomous';

/** Everything except 'plan' — the run-time behaviour a mode maps to. */
type ExecMode = Exclude<PermissionMode, 'plan'>;

/** 'plan' is a workflow wrapper: once a plan is approved it behaves like 'auto'. */
function effectivePerm(p: PermissionMode): ExecMode {
  return p === 'plan' ? 'auto' : p;
}

const PERMISSION_MODES = [
  { id: 'readonly', icon: Eye, labelKey: 'perm.readonly', descKey: 'perm.readonly.desc', shortKey: 'perm.readonly' },
  { id: 'plan', icon: Lightbulb, labelKey: 'perm.plan', descKey: 'perm.plan.desc', shortKey: 'perm.plan' },
  { id: 'ask', icon: CircleCheck, labelKey: 'perm.ask', descKey: 'perm.ask.desc', shortKey: 'cop.confirm' },
  { id: 'auto', icon: Zap, labelKey: 'perm.auto', descKey: 'perm.auto.desc', shortKey: 'cop.auto' },
  { id: 'safe', icon: ShieldCheck, labelKey: 'perm.safe', descKey: 'perm.safe.desc', shortKey: 'perm.safe' },
  { id: 'autonomous', icon: Bot, labelKey: 'perm.autonomous', descKey: 'perm.autonomous.desc', shortKey: 'cop.autonomous' },
] as const satisfies readonly { id: PermissionMode; icon: typeof CircleCheck; labelKey: TranslationKey; descKey: TranslationKey; shortKey: TranslationKey }[];

/** Read-only shell commands that are safe to auto-run in "Safe commands" mode. */
const SAFE_COMMAND_PATTERNS: RegExp[] = [
  /^(ls|dir|pwd|cat|type|head|tail|wc|echo)\b/i,
  /^git\s+(status|diff|log|show|branch|remote|stash\s+list|rev-parse)\b/i,
  /^npm\s+(run\s+)?(test|lint|typecheck|build)\b/i,
  /^(node|npx|cargo|rustc|python|py|pip|go|tsc)\s+(-v|--version|version)\b/i,
  /^(rg|grep|find|where|which|findstr)\b/i,
];

/** True only for read-only commands with no chaining/redirect/substitution. */
function isSafeCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  if (/[;&|`$><\n]/.test(trimmed)) return false;
  return SAFE_COMMAND_PATTERNS.some((re) => re.test(trimmed));
}

/** Language tags that mark a fenced block as a shell command, not a patch. */
const SHELL_LANGS = ['sh', 'bash', 'shell', 'zsh', 'ps1', 'powershell', 'cmd', 'bat'];

/** Generates a message id (against Date.now collisions). */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Header tool button: on hover the caption unfolds sideways (to the left,
 * towards the panel body) so the toolbar stays compact but self-explanatory.
 */
function HeaderAction({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  active = false,
  activeClassName,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  activeClassName?: string;
}) {
  const stateClass = disabled
    ? 'text-[#575654] cursor-not-allowed opacity-40'
    : active
      ? `${activeClassName ?? 'bg-white/[0.06] text-[#F2F0E5]'} cursor-pointer`
      : 'text-[#87857F] hover:bg-white/[0.04] hover:text-[#CECDC3] cursor-pointer';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`group relative flex h-6 w-6 items-center justify-center rounded-md transition-colors ${stateClass}`}
    >
      <Icon size={15} strokeWidth={1.75} className="flex-shrink-0" />
      <span className="pointer-events-none absolute right-full top-1/2 z-20 mr-1 max-w-0 -translate-y-1/2 overflow-hidden whitespace-nowrap rounded-md border border-[#34332F] bg-[#282726] px-0 py-1 text-[10px] font-medium leading-none text-[#CECDC3] opacity-0 shadow-lg transition-all duration-200 ease-out group-hover:max-w-[160px] group-hover:px-2 group-hover:opacity-100">
        {label}
      </span>
    </button>
  );
}

export function ThalamusCopilot({
  activeFile = "",
  activeFileCode = "",
  workspaceFiles = [],
  onApplyCode,
  onOpenTerminal,
  floating = false,
  onToggleFloat,
  onHeaderPointerDown,
  headerRef,
}: ThalamusCopilotProps) {
  const t = useT();
  const IMAGE_LABEL_KEY = { auto: 'image.auto', economy: 'image.economy', balanced: 'image.balanced', high: 'image.high' } as const;
  const IMAGE_HINT_KEY = { auto: 'image.auto.hint', economy: 'image.economy.hint', balanced: 'image.balanced.hint', high: 'image.high.hint' } as const;
  // Görünen ad yerel profilden alınır; profil yoksa ChatView ile aynı nötr
  // etiket ('Anonymous User') kullanılır — sabit koda gömülü kimlik yalanı yok.
  const userName = (() => {
    try {
      const u = JSON.parse(localStorage.getItem('thalamus_user') || 'null') as { name?: string } | null;
      return u?.name?.trim() || t('sidebar.anonymous');
    } catch {
      return t('sidebar.anonymous');
    }
  })();
  const [mode, setMode] = useState<'chat' | 'agent'>('chat');
  const [input, setInput] = useState("");
  const [executedActions, setExecutedActions] = useState<Record<string, boolean>>({});
  const [lastEdit, setLastEdit] = useState<{ file: string; prev: string }[]>([]);
  // ZCode/Claude Code style: plan mode, permission mode, context, summarization
  const [planMode, setPlanMode] = useState(false);
  const [permission, setPermission] = useState<PermissionMode>('ask');
  const [showPermMenu, setShowPermMenu] = useState(false);
  const [lastUsage, setLastUsage] = useState<AiChatResponse['usage'] | null>(null);
  const [pendingEdits, setPendingEdits] = useState<AiEditResult[] | null>(null);
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);

  // Images attached to the next message, sent as real image parts to the model.
  const [pendingImages, setPendingImages] = useState<AttachedImage[]>([]);
  const [imageMode, setImageMode] = useState<ImageMode>(DEFAULT_IMAGE_MODE);
  const pendingImagesRef = useRef<AttachedImage[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const addPendingImages = (imgs: AttachedImage[]) => {
    const next = [...pendingImagesRef.current, ...imgs];
    pendingImagesRef.current = next;
    setPendingImages(next);
  };

  const clearPendingImages = () => {
    pendingImagesRef.current = [];
    setPendingImages([]);
  };

  const handleImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const prepared: AttachedImage[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        prepared.push(await prepareImageFile(file, imageMode));
      } catch {
        // Unreadable image — skip it rather than failing the whole attach.
      }
    }
    if (prepared.length) addPendingImages(prepared);
  };

  /** Reverts the last applied edit batch (safety net), one entry at a time. */
  const undoLastEdit = () => {
    setLastEdit(prev => {
      const entry = prev[prev.length - 1];
      if (entry) onApplyCode?.(entry.file, entry.prev);
      return prev.slice(0, -1);
    });
  };

  

  // Refs to reliably read values at send time
  const planModeRef = useRef(planMode);
  planModeRef.current = planMode;
  const permRef = useRef(permission);
  permRef.current = permission;
  // Set right before re-running a plan so the execution turn bypasses planning.
  const forceExecRef = useRef(false);

  const handleSend = () => doSend(input);

  /** Second-turn send to apply the plan generated in plan mode. */
  const applyPlan = () => {
    if (!pendingPlan) return;
    forceExecRef.current = true;
    doSend(`IMPLEMENT YOUR PLAN (step by step, with SEARCH/REPLACE blocks):\n${pendingPlan}`);
    setPendingPlan(null);
  };

  /** Applies pending edits with user confirmation when permission mode is 'ask'. */
  const applyPendingEdits = () => {
    if (!pendingEdits) return;
    // TÜM bekleyen editler uygulanır — eski davranış yalnızca birini uygulayıp
    // kalanını sessizce atıyordu. Her edit kendi dosyasına yazılır (file alanı
    // boşsa aktif dosyaya). Geri al: yalnızca aktif dosyanın eski içeriği
    // bileşende bilinir; diğer dosyalar için undo girdisi üretilemez.
    const undoStack: { file: string; prev: string }[] = [];
    for (const e of pendingEdits) {
      if (!e.new_body) continue;
      const target = e.file || activeFile;
      if (target === activeFile) undoStack.push({ file: target, prev: activeFileCode });
      onApplyCode?.(target, e.new_body);
    }
    if (undoStack.length) setLastEdit(undoStack);
    setPendingEdits(null);
  };

  /** Claude Code `/compact` equivalent: summarizes the chat and clears the window. */
  const compactConversation = async () => {
    const history = messages
      .map(m => `${m.sender === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
      .join('\n---\n')
      .slice(-10000);
    try {
      const data = await aiChat([{
        role: 'user',
        content: `Summarize the following chat comprehensively but with as few tokens as possible; preserve the requests made, decisions taken and edits performed. In the same language:\n\n${history}`,
      }]);
      setMessages([{ id: newId(), sender: 'ai', text: `[SUMMARY]\n${data.content}`, timestamp: ts(), modeUsed: 'chat' }]);
      setPendingEdits(null);
      setPendingPlan(null);
      setLastEdit([]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages(prev => [...prev, { id: newId(), sender: 'ai', text: msg === 'API_KEY_MISSING' ? 'A key is required for summarization (Settings → Providers).' : `Summarization failed: ${msg}`, timestamp: ts(), modeUsed: 'chat' }]);
    }
  };

  const [activeModalMessage, setActiveModalMessage] = useState<Message | null>(null);

  const [showFileMentionMenu, setShowFileMentionMenu] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [mentionSearch, setMentionSearch] = useState('');
  const mentionInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Yazı alanı içeriğe göre KENDİLİĞİNDEN büyür (elle boyutlandırma yok);
  // sınırı aşınca kendi içinde kaydırır.
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden';
  }, [input]);

  // When the "@" menu opens, reset its search and focus the search box so the
  // user can filter right away (like a small command palette).
  React.useEffect(() => {
    if (!showFileMentionMenu) return;
    setMentionSearch('');
    const id = window.setTimeout(() => mentionInputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [showFileMentionMenu]);

  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      sender: "ai",
      text: activeFile
        ? t('cop.activeFile', { file: activeFile })
        : t('cop.howCanIHelp'),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      modeUsed: 'chat'
    }
  ]);

  /** Opens the terminal and types a command. Used by both the Run button and
   *  the auto-run paths of the Safe/Autonomous modes. */
  const runCommand = async (command: string) => {
    onOpenTerminal?.();
    await invoke('write_terminal', { data: command + '\r' });
  };

  const executeAgentAction = async (msgId: string, action: ActionPayload) => {
    try {
      if (action.type === 'RUN_TERMINAL' && action.command) {
        await runCommand(action.command);
      } else if (action.type === 'APPLY_PATCH' && action.targetFile && action.codeSnippet) {
        if (effectivePerm(permRef.current) === 'ask') {
          // 'Confirm' modu TÜM yazma yollarını kapsar: bu "Apply" düğmesi de
          // dosyaya doğrudan yazmaz — bekleyen edit olarak onaya düşer.
          setPendingEdits([{ file: action.targetFile, applied: true, message: '', new_body: action.codeSnippet }]);
          return; // onay bekleniyor; "Applied" rozetini yanlış göstermeyiz
        }
        onApplyCode?.(action.targetFile, action.codeSnippet);
        // Geri alma yalnızca aktif dosya için mümkün (önceki içerik bilinir).
        setLastEdit(action.targetFile === activeFile ? [{ file: activeFile, prev: activeFileCode }] : []);
      }
      setExecutedActions(prev => ({ ...prev, [msgId]: true }));
    } catch (err) {
      // Make the failure visible in the chat — no "Applied" lie.
      setMessages(prev => [...prev, {
        id: newId(),
        sender: 'ai',
        text: t('cop.actionFailed', { error: err instanceof Error ? err.message : String(err) }),
        timestamp: ts(),
        modeUsed: 'chat',
      }]);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);

    const lastAtIndex = val.lastIndexOf('@');
    if (lastAtIndex !== -1 && lastAtIndex === val.length - 1) {
      setShowFileMentionMenu(true);
    } else if (showFileMentionMenu && !val.includes('@')) {
      setShowFileMentionMenu(false);
    }
  };

  const handleSelectFileMention = (fileName: string) => {
    const lastAtIndex = input.lastIndexOf('@');
    const newInput = input.substring(0, lastAtIndex) + `@${fileName} `;
    setInput(newInput);
    setShowFileMentionMenu(false);
    if (!selectedFiles.includes(fileName)) {
      setSelectedFiles(prev => [...prev, fileName]);
    }
    textareaRef.current?.focus();
  };

  // Attach files straight from disk (native picker) — handy for files that are
  // not part of the workspace tree.
  const handleBrowseFiles = async () => {
    const paths = await pickFiles(t('cop.chooseFiles'));
    if (paths.length === 0) return;
    setSelectedFiles(prev => {
      const next = [...prev];
      for (const p of paths) if (!next.includes(p)) next.push(p);
      return next;
    });
    setShowFileMentionMenu(false);
  };

  // Live filter for the "@" mention menu driven by its own search box, so a
  // large workspace tree never dumps every path at once.
  const filteredWorkspaceFiles = workspaceFiles.filter((f) =>
    f.toLowerCase().includes(mentionSearch.trim().toLowerCase())
  );

  const currentPermission = PERMISSION_MODES.find((m) => m.id === permission) ?? PERMISSION_MODES[0];
  // The selected mode tints the header button: plan=amber, auto=blue, safe=teal,
  // autonomous=red; readonly/ask stay neutral.
  const permActive = permission === 'plan' || permission === 'auto' || permission === 'safe' || permission === 'autonomous';
  const permActiveClass = permission === 'plan'
    ? 'bg-[#D0A215]/15 text-[#D0A215]'
    : permission === 'safe'
      ? 'bg-[#3AA99F]/15 text-[#3AA99F]'
      : permission === 'autonomous'
        ? 'bg-[#D14D41]/15 text-[#D14D41]'
        : 'bg-[#4385BE]/20 text-[#4385BE]';

  const callRealAI = async (
    prompt: string
  ): Promise<AiChatResponse> => {
    // Code context: a SCHEMA is sent instead of the body; the LLM requests the body via get_code_body.
    // No loss — the original code stays in the editor/locally.
    const codeBlocks = activeFileCode.trim()
      ? [{ id: activeFile, name: activeFile, body: activeFileCode }]
      : [];
    const images = pendingImagesRef.current.map((i) => ({ url: i.url, detail: i.detail }));
    clearPendingImages();
    // D3: konusma DURUMU gonderilir (son 10 gercek mesaj) — copilot artik
    // "hafizasiz" degil; "Thinking..." placeholder'i ve bos mesajlar elenir.
    const history = messages
      .filter(m => m.text.trim().length > 0 && m.text !== t('cop.thinking'))
      .slice(-10)
      .map(m => ({
        role: (m.sender === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.text,
      }));
    return aiChat([...history, userMessage(prompt, images)], codeBlocks);
  };

  const doSend = (raw: string) => {
    const imageCount = pendingImagesRef.current.length;
    if (!raw.trim() && imageCount === 0) return;

    const userText = raw.trim();
    const contextInfo = selectedFiles.length > 0 ? ` [Reference: ${selectedFiles.join(', ')}]` : '';
    // D4: @referansi SUS donanin otesi — modele dosya adlari verilir ve
    // read_file araciyla gercekten acabilecekleri soylenir (backend araclari
    // workspace icinde dosya okuyabiliyor).
    const referenceNote = selectedFiles.length > 0
      ? `\nAttached file references (open their contents with the read_file tool when needed): ${selectedFiles.join(', ')}`
      : '';

    // Slash command expansion: /explain, /review, /refactor, /tests
    const firstTok = userText.split(/\s+/)[0];
    const slashKey = SLASH_TEMPLATES[firstTok];
    const slashTemplate = slashKey ? t(slashKey) : undefined;
    const aiText = slashTemplate
      ? slashTemplate + (userText.length > firstTok.length ? ' ' + userText.slice(firstTok.length).trim() : '')
      : (userText || t('cop.lookAtImage'));

    const userMsg: Message = {
      id: newId(),
      sender: 'user',
      text: (userText || `[${imageCount} image${imageCount > 1 ? 's' : ''}]`) + contextInfo,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      modeUsed: mode
    };

    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setSelectedFiles([]);
    setShowFileMentionMenu(false);

    const isAgent = mode === 'agent';
    const placeholderId = newId();

    // Add temporary "Thinking..." message
    setMessages(prev => [...prev, {
      id: placeholderId,
      sender: 'ai',
      text: t('cop.thinking'),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      modeUsed: mode
    }]);

    const forceExec = forceExecRef.current;
    forceExecRef.current = false;
    const permRaw = permRef.current;
    const perm = effectivePerm(permRaw);
    // 'plan' (as a mode) and the quick plan toggle both force a plan turn, unless
    // this is the execution turn that follows an approved plan.
    const inPlanMode = (planModeRef.current || permRaw === 'plan') && isAgent && !forceExec;
    // Tell the model how hands-off the user wants it to be.
    const permHint = perm === 'readonly'
      ? ' Read-only: do NOT edit code — answer and explain only.'
      : perm === 'ask'
        ? " Edits require the user's approval before they are applied."
        : perm === 'auto'
          ? ' Apply file edits directly; running commands still needs approval.'
          : perm === 'safe'
            ? ' Apply file edits directly and run read-only shell commands freely; other commands need approval.'
            : ' You are fully autonomous: apply edits and run commands directly.';
    // Let the agent propose a shell command (e.g. to verify its change).
    const commandHint = isAgent && !inPlanMode && perm !== 'readonly'
      ? '\nIf running one shell command would help (e.g. to verify your change), put ONLY that command in a fenced block tagged ```sh.'
      : '';
    let systemPrompt = "";
    if (isAgent) {
      if (inPlanMode) {
        systemPrompt = `Agent Mode (PLAN MODE). Active file: ${activeFile}${referenceNote}\n\nTask: ${aiText}\n\nProduce ONLY a detailed PLAN; do NOT edit code (do not write a SEARCH/REPLACE block). Steps, functions to touch, risks and a verification suggestion.`;
      } else if (perm === 'readonly') {
        systemPrompt = `Agent Mode (READ-ONLY). Active file: ${activeFile}${referenceNote}\n\nUser request: ${aiText}\n\nExplain and propose an approach; do NOT edit code (no SEARCH/REPLACE block). Give concrete guidance and, if helpful, an illustrative diff inside the answer.`;
      } else {
        systemPrompt = `Agent Mode. Active file: ${activeFile}${referenceNote}\n\nUser request: ${aiText}\n\nApply your changes as SEARCH/REPLACE blocks (format is provided to you).${commandHint}${permHint}`;
      }
    } else {
      // D5: "Answer in English" kaldirildi — kullanicinin diline saygi
      // (Türkce yazana Türkce yanit) birinci kural.
      systemPrompt = `You are Nucleus, Thalamus' coding assistant. Help the user analyze or understand their code. Always answer in the same language the user writes in (Turkish user → answer in Turkish).\nActive file: ${activeFile}${referenceNote}\n\nUser question: ${aiText}`;
    }

    callRealAI(systemPrompt)
      .then(async res => {
        // Remove "Thinking..." message
        setMessages(prev => prev.filter(m => m.id !== placeholderId));
        if (res.usage) setLastUsage(res.usage);

        let explanation = res.content;
        let codeSnippet = "";
        let shellCommand = "";
        const fencedRegex = /```([a-zA-Z0-9]*)\n([\s\S]*?)```/;
        const match = explanation.match(fencedRegex);
        if (match && match[2]) {
          const lang = (match[1] || '').toLowerCase();
          const raw = match[2].trim();
          if (SHELL_LANGS.includes(lang)) {
            shellCommand = raw;
            explanation = explanation.replace(fencedRegex, "").trim();
          } else {
            const isSearchReplace =
              /<{3,}\s*SEARCH/.test(raw) && /={3,}/.test(raw) && /[{>]}{3,}\s*REPLACE/.test(raw);
            if (isSearchReplace) {
              // SEARCH/REPLACE bloğu tam-dosya değildir; "Apply" bunu dosyaya
              // yapıştırdığında marker'lar koda sızmıştı. Bloğu açıkalamada bırak,
              // Apply düğmesi üretime.
            } else {
              codeSnippet = raw;
              explanation = explanation.replace(fencedRegex, "").trim();
            }
          }
        }

        const applied = (res.edits || []).filter(e => e.applied && e.new_body);

        // PLAN MODE: a plan arrived instead of an edit → waits for "Apply Plan".
        if (inPlanMode) {
          setPendingPlan(explanation);
        } else if (perm === 'readonly') {
          // Read-only: never write. The answer/diff is shown, nothing is applied.
        } else if (applied.length > 0 && perm === 'ask') {
          setPendingEdits(applied);
        } else if (applied.length > 0) {
          // Otomatik mod: yine TÜM editler, her biri kendi dosyasına.
          const undoStack: { file: string; prev: string }[] = [];
          applied.forEach(e => {
            const target = e.file || activeFile;
            if (target === activeFile) undoStack.push({ file: target, prev: activeFileCode });
            onApplyCode?.(target, e.new_body as string);
          });
          setLastEdit(undoStack);
        }
        (res.edits || []).filter(e => !e.applied).forEach(e =>
          console.warn('edit could not be applied:', e.file, e.message)
        );

        let text = explanation || (isAgent ? "Patch package prepared:" : "");
        if (applied.length > 0) {
          if (perm === 'readonly') {
            text += `\n\n${t('cop.readOnlyNote')}`;
          } else if (perm === 'ask') {
            text += `\n\n${t('cop.editsReady', { n: applied.length })}`;
          } else {
            text += `\n\n${t('cop.editsApplied', { n: applied.length, file: activeFile })}`;
          }
        }
        if (inPlanMode && !text.trim()) {
          text = t('cop.noPlan');
        }

        // Autonomous mode: apply the returned patch immediately (no click).
        const autoApplyPatch =
          isAgent && !inPlanMode && !applied.length && !!codeSnippet && perm === 'autonomous';
        if (autoApplyPatch) {
          onApplyCode?.(activeFile, codeSnippet);
          if (activeFileCode) setLastEdit([{ file: activeFile, prev: activeFileCode }]);
          text += `\n\n${t('cop.editsApplied', { n: 1, file: activeFile })}`;
        }

        // One action bar per message: a shell command takes priority, else a patch.
        let actionPayload: ActionPayload | undefined;
        if (isAgent && !inPlanMode && perm !== 'readonly' && shellCommand) {
          if (perm === 'autonomous' || (perm === 'safe' && isSafeCommand(shellCommand))) {
            await runCommand(shellCommand);
            text += `\n\n${t('cop.commandAutoRan')}`;
          } else {
            actionPayload = { type: 'RUN_TERMINAL', label: t('cop.runCommand'), command: shellCommand };
            text += `\n\n${t('cop.commandReady')}`;
          }
        } else if (isAgent && !applied.length && codeSnippet && !autoApplyPatch && perm !== 'readonly') {
          actionPayload = {
            type: 'APPLY_PATCH',
            label: `Apply Patch to ${activeFile}`,
            originalCodeSnippet: activeFileCode || "",
            codeSnippet: codeSnippet,
            targetFile: activeFile
          };
        }

        const responseMsg: Message = {
          id: newId(),
          sender: 'ai',
          text,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          modeUsed: mode,
          ...(actionPayload ? { actionPayload } : {})
        };

        setMessages(prev => [...prev, responseMsg]);
      })
      .catch(err => {
        // Remove "Thinking..." message
        setMessages(prev => prev.filter(m => m.id !== placeholderId));

        const isKeyMissing = err instanceof Error && err.message === 'API_KEY_MISSING';
        const errorText = isKeyMissing
          ? t('cop.noKey')
          : t('cop.requestFailed', { error: err instanceof Error ? err.message : String(err) });

        setMessages(prev => [...prev, {
          id: newId(),
          sender: 'ai',
          text: errorText,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          modeUsed: mode
        }]);
      });
  };

  return (
    <div className="w-full h-full bg-[#1C1B1A] flex flex-col font-sans select-none text-xs relative overflow-hidden">
      {/* Code inspection modal */}
      {activeModalMessage && activeModalMessage.actionPayload && (
        <CopilotDiffModal
          message={activeModalMessage}
          executed={!!executedActions[activeModalMessage.id]}
          activeFile={activeFile}
          onApply={(payload) => {
            executeAgentAction(activeModalMessage.id, payload);
            setActiveModalMessage(null);
          }}
          onClose={() => setActiveModalMessage(null)}
        />
      )}

      {/* Header: brand · mode · actions */}
      <div
        ref={headerRef}
        onPointerDown={floating ? onHeaderPointerDown : undefined}
        className={`h-10 px-2 bg-[#282726] border-b border-[#34332F] flex items-center gap-2 overflow-hidden whitespace-nowrap flex-shrink-0 ${floating ? 'cursor-move' : ''}`}
      >
        <span className="font-mono text-xs font-bold tracking-tight text-[#3AA99F] flex-shrink-0">Nucleus</span>

        <div className="flex items-center bg-[#1C1B1A] p-[3px] rounded-md border border-[#34332F] flex-shrink-0 whitespace-nowrap">
          <button
            type="button"
            onClick={() => setMode('chat')}
            className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
              mode === 'chat' ? 'bg-[#34332F] text-[#F2F0E5]' : 'text-[#87857F] hover:text-[#CECDC3]'
            }`}
          >
            {t('cop.chat')}
          </button>
          <button
            type="button"
            onClick={() => setMode('agent')}
            className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
              mode === 'agent' ? 'bg-[#34332F] text-[#F2F0E5]' : 'text-[#87857F] hover:text-[#CECDC3]'
            }`}
          >
            {t('cop.agent')}
          </button>
        </div>

        <div className="flex-1 min-w-0" />

        {lastUsage && (
          <div
            className="flex items-center flex-shrink-0 cursor-default"
            title={`${t('cop.usageTitle')} — ${lastUsage.total_tokens ?? '—'}`}
          >
            <div className="flex gap-[2px]">
              {Array.from({ length: 8 }).map((_, i) => {
                const frac = Math.min(1, (lastUsage.total_tokens ?? 0) / 128000);
                const on = i < Math.ceil(frac * 8);
                return (
                  <span
                    key={i}
                    className={`w-[2px] h-3 rounded-full ${
                      on
                        ? frac > 0.8
                          ? 'bg-rose-400'
                          : frac > 0.5
                            ? 'bg-amber-400'
                            : 'bg-emerald-400'
                        : 'bg-[#34332F]'
                    }`}
                  />
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-center gap-0.5 flex-shrink-0">
          <HeaderAction
            icon={ClipboardList}
            label={t('cop.plan')}
            onClick={() => { if (mode === 'agent') setPlanMode(v => !v); }}
            disabled={mode !== 'agent'}
            active={planMode}
            activeClassName="bg-[#D0A215]/15 text-[#D0A215]"
          />
          <div className="relative flex-shrink-0">
            <HeaderAction
              icon={currentPermission.icon}
              label={t(currentPermission.shortKey)}
              onClick={() => setShowPermMenu(v => !v)}
              active={permActive}
              activeClassName={permActiveClass}
            />
            {showPermMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowPermMenu(false)} />
                <div className="absolute right-0 top-full mt-1.5 w-[250px] bg-[#282726] border border-[#34332F] rounded-md shadow-2xl z-50 overflow-hidden p-1">
                  {PERMISSION_MODES.map(opt => {
                    const OptIcon = opt.icon;
                    const selected = permission === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => { setPermission(opt.id); setShowPermMenu(false); }}
                        className="w-full flex items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-[#1C1B1A] transition-colors cursor-pointer"
                      >
                        <OptIcon size={14} strokeWidth={1.75} className={`mt-0.5 flex-shrink-0 ${selected ? 'text-[#3AA99F]' : 'text-[#87857F]'}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-medium text-[#F2F0E5]">{t(opt.labelKey)}</span>
                            {selected && <Check size={11} className="text-[#3AA99F] flex-shrink-0" />}
                          </div>
                          <div className="text-[10px] leading-snug text-[#87857F]">{t(opt.descKey)}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          <HeaderAction
            icon={ScrollText}
            label={t('cop.summarize')}
            onClick={compactConversation}
          />
          {onToggleFloat && (
            <HeaderAction
              icon={PictureInPicture2}
              label={floating ? t('float.dock') : t('float.undock')}
              onClick={onToggleFloat}
              active={floating}
              activeClassName="bg-[#4385BE]/20 text-[#4385BE]"
            />
          )}
        </div>
      </div>

      {/* 2. MESSAGE FLOW */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5 pretty-scrollbar">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex flex-col gap-0.5 ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
            <div className="flex items-center gap-1 text-[11px] text-[#87857F] px-1 font-mono">
              {msg.sender === 'user' && <User size={9} className="text-[#4385BE]" />}
              <span className="text-[#A8A49E] font-medium">
                {msg.sender === 'user' ? userName : t('cop.sender')}
              </span>
              <span>•</span>
              <span>{msg.timestamp}</span>
              {msg.modeUsed === 'agent' && (
                <span className="bg-[#4385BE]/20 text-[#4385BE] px-1 py-0.5 rounded text-[8.5px]">{t('cop.agent')}</span>
              )}
            </div>

            <div className={`p-2 rounded-md max-w-[98%] text-[11px] leading-normal border ${
              msg.sender === 'user' 
                ? 'bg-[#1E3A52] border-[#35639E] text-white' 
                : 'bg-[#282726] border-[#34332F] text-[#CECDC3]'
            }`}>
              <MarkdownMessage content={msg.text} />

              {msg.actionPayload && msg.actionPayload.type === 'RUN_TERMINAL' && (
                <div className="mt-2 rounded border border-[#2a2a2c] bg-[#0E0E0E] p-2 flex items-center justify-between gap-2 overflow-hidden">
                  <div className="flex items-center gap-1.5 min-w-0 font-mono text-[11px]">
                    <Terminal size={12} className="text-[#3AA99F] flex-shrink-0" />
                    <span className="text-[#CECDC3] truncate">{msg.actionPayload.command}</span>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {executedActions[msg.id] ? (
                      <span className="text-[#3AA99F] text-[11px] font-medium flex items-center gap-0.5 px-1.5 py-0.5 bg-[#3AA99F]/10 rounded">
                        <Check size={9} /> {t('cop.ran')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => executeAgentAction(msg.id, msg.actionPayload!)}
                        className="px-2 py-0.5 bg-[#205EA6] hover:bg-[#4385BE] text-white font-medium rounded text-[11px] flex items-center gap-1 cursor-pointer transition-colors shadow-sm"
                      >
                        <Terminal size={9} /> {t('cop.run')}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {msg.actionPayload && msg.actionPayload.type === 'APPLY_PATCH' && (
                <div className="mt-2 rounded border border-[#2a2a2c] bg-[#1C1B1A] p-2 flex items-center justify-between gap-2 overflow-hidden">
                  <div className="flex items-center gap-1.5 min-w-0 font-mono text-[11px]">
                    <GitPullRequest size={12} className="text-[#3AA99F] flex-shrink-0" />
                    <span className="font-medium text-[#CECDC3] truncate max-w-[100px]">
                      {msg.actionPayload.targetFile}
                    </span>
                    <div className="flex items-center gap-1 flex-shrink-0 text-[8.5px]">
                      {(() => {
                        const aLen = (msg.actionPayload?.originalCodeSnippet ?? '').split('\n').length;
                        const bLen = (msg.actionPayload?.codeSnippet ?? '').split('\n').length;
                        const added = Math.max(0, bLen - aLen);
                        const removed = Math.max(0, aLen - bLen);
                        return (
                          <>
                            {added > 0 && <span className="text-[#3AA99F] bg-[#3AA99F]/10 px-1 py-0.5 rounded">+{added}</span>}
                            {removed > 0 && <span className="text-[#D14D41] bg-[#D14D41]/10 px-1 py-0.5 rounded">-{removed}</span>}
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => setActiveModalMessage(msg)}
                      className="px-2 py-0.5 bg-[#205EA6] hover:bg-[#4385BE] text-white font-medium rounded text-[11px] flex items-center gap-1 cursor-pointer transition-colors shadow-sm"
                    >
                      <Eye size={10} /> {t('cop.inspect')}
                    </button>

                    {executedActions[msg.id] ? (
                      <span className="text-[#3AA99F] text-[11px] font-medium flex items-center gap-0.5 px-1.5 py-0.5 bg-[#3AA99F]/10 rounded">
                        <Check size={9} /> {t('cop.applied')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => executeAgentAction(msg.id, msg.actionPayload!)}
                        className="px-2 py-0.5 bg-[#205EA6] hover:bg-[#4385BE] text-white font-medium rounded text-[11px] flex items-center gap-1 cursor-pointer transition-colors shadow-sm"
                      >
                        <GitPullRequest size={9} /> {t('cop.apply')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 3. INPUT AREA */}
      <div className="p-2 border-t border-[#34332F] bg-[#1C1B1A] flex flex-col gap-1 flex-shrink-0 z-10 relative">
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 px-0.5">
            <span className="text-[11px] font-mono uppercase tracking-wider text-[#87857F]">{t('cop.image')}</span>
            {(IMAGE_MODE_ORDER).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setImageMode(m)}
                title={t(IMAGE_HINT_KEY[m])}
                className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors cursor-pointer ${
                  imageMode === m
                    ? 'border-[#dcb67a]/50 bg-[#dcb67a]/10 text-[#dcb67a]'
                    : 'border-[#34332F] text-[#87857F] hover:text-[#CECDC3]'
                }`}
              >
                {t(IMAGE_LABEL_KEY[m])}
              </button>
            ))}
          </div>
        )}
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-0.5">
            {pendingImages.map((img, idx) => (
              <div key={`${img.name}-${idx}`} className="relative">
                <img
                  src={img.url}
                  alt={img.name}
                  title={`${img.name} · ${img.width}×${img.height} · detail:${img.detail} · ${img.reason}${img.visionDiag ? ' · ' + img.visionDiag : ''}\n${img.options.map((o) => `${o.label}: ${Math.round(o.ratio * 100)}% · ≈${o.tokens} tok · ${o.retention}% detail`).join('\n')}`}
                  className="h-10 w-10 rounded-md object-cover border border-[#34332F]"
                />
                <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded bg-[#1C1B1A]/90 px-1 text-[8px] font-mono text-[#dcb67a] whitespace-nowrap">
                  ≈{img.estTokens} · %{img.retention}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const next = pendingImagesRef.current.filter((_, i) => i !== idx);
                    pendingImagesRef.current = next;
                    setPendingImages(next);
                  }}
                  className="absolute -top-1.5 -right-1.5 bg-[#1C1B1A] border border-[#34332F] rounded-full p-0.5 text-[#87857F] hover:text-rose-400 cursor-pointer"
                  title={t('cop.removeImage')}
                >
                  <X size={9} />
                </button>
              </div>
            ))}
          </div>
        )}
        {pendingPlan && (
          <div className="flex items-center justify-between px-0.5">
            <span className="flex items-center gap-1 text-[11px] font-mono text-[#D0A215]">
              <ListChecks size={11} /> {t('cop.planReady')}
            </span>
            <button
              type="button"
              onClick={applyPlan}
              className="text-[11px] font-semibold text-[#D0A215] hover:underline cursor-pointer"
            >
              {t('cop.applyPlan')}
            </button>
          </div>
        )}
        {pendingEdits && pendingEdits.length > 0 && (
          <div className="flex items-center justify-between px-0.5">
            <span className="text-[11px] font-mono text-[#3AA99F]">
              {t('cop.editsPending', { n: pendingEdits.length })}
            </span>
            <button
              type="button"
              onClick={applyPendingEdits}
              className="text-[11px] font-semibold text-[#3AA99F] hover:underline cursor-pointer"
            >
              {t('cop.apply')}
            </button>
          </div>
        )}
        {lastEdit.length > 0 && (
          <div className="flex items-center justify-between px-0.5">
            <span className="text-[11px] font-mono text-[#D0A215]">
              {t('cop.undoInfo', { n: lastEdit.length })}
            </span>
            <button
              type="button"
              onClick={undoLastEdit}
              className="flex items-center gap-1 text-[11px] font-medium text-[#3AA99F] hover:underline cursor-pointer"
            >
              <Undo2 size={11} /> {t('cop.undo')}
            </button>
          </div>
        )}
        {showFileMentionMenu && (
          <div className="absolute bottom-full left-2 mb-1.5 w-[260px] bg-[#282726] border border-[#34332F] rounded-md shadow-2xl z-50 overflow-hidden flex flex-col">
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[#34332F]">
              <Search size={12} className="text-[#87857F] flex-shrink-0" />
              <input
                ref={mentionInputRef}
                value={mentionSearch}
                onChange={(e) => setMentionSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const first = filteredWorkspaceFiles[0];
                    if (first) handleSelectFileMention(first);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setShowFileMentionMenu(false);
                    textareaRef.current?.focus();
                  }
                }}
                placeholder={t('cop.searchFiles')}
                className="w-full bg-transparent text-[11px] text-[#F2F0E5] placeholder-[#87857F] outline-none"
              />
            </div>
            <div className="max-h-[220px] overflow-y-auto pretty-scrollbar p-1">
              {filteredWorkspaceFiles.length === 0 ? (
                <div className="px-2 py-3 text-center text-[11px] text-[#87857F]">{t('cop.noFiles')}</div>
              ) : (
                filteredWorkspaceFiles.slice(0, 100).map(file => (
                  <button
                    key={file}
                    type="button"
                    onClick={() => handleSelectFileMention(file)}
                    className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-[#1C1B1A] text-[#CECDC3] hover:text-white font-mono text-[11px] text-left cursor-pointer transition-colors"
                  >
                    <FileText size={11} className="text-[#87857F] flex-shrink-0" />
                    <span className="truncate">{file}</span>
                  </button>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={handleBrowseFiles}
              className="flex items-center gap-1.5 px-2 py-1.5 border-t border-[#34332F] text-[11px] text-[#CECDC3] hover:bg-[#1C1B1A] hover:text-white transition-colors cursor-pointer"
            >
              <FolderOpen size={12} className="text-[#4385BE] flex-shrink-0" />
              {t('cop.chooseFiles')}
            </button>
          </div>
        )}

        <div className="relative bg-[#100F0F] border border-[#34332F] focus-within:border-[#4385BE] rounded p-1.5 transition-all">
          {selectedFiles.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mb-1 pb-1 border-b border-[#282726]">
              {selectedFiles.map(file => (
                <span key={file} className="flex items-center gap-1 max-w-[190px] bg-[#282726] border border-[#34332F] text-[#3AA99F] px-1.5 py-0.5 rounded text-[11px] font-mono">
                  <FileText size={9} className="flex-shrink-0" />
                  <span className="truncate">@{file}</span>
                  <button
                    type="button"
                    onClick={() => setSelectedFiles(selectedFiles.filter(f => f !== file))}
                    className="hover:text-red-400 ml-0.5 cursor-pointer flex-shrink-0"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && showFileMentionMenu) {
                setShowFileMentionMenu(false);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !showFileMentionMenu) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={mode === 'agent' ? t('cop.placeholderAgent') : t('cop.placeholderChat')}
            className="w-full bg-transparent text-[#F2F0E5] placeholder-[#87857F] text-[11px] resize-none overflow-hidden outline-none min-h-[36px] max-h-[120px] leading-relaxed pretty-scrollbar"
            rows={2}
          />

          <div className="flex items-center justify-between pt-1 border-t border-[#1C1B1A]">
            <div className="flex items-center gap-0.5 text-[#87857F]">
              <button
                type="button"
                title={t('cop.attachFile')}
                onClick={() => {
                  setInput(prev => prev + '@');
                  setShowFileMentionMenu(true);
                  textareaRef.current?.focus();
                }}
                className="p-1 rounded hover:bg-[#282726] text-[#87857F] hover:text-[#CECDC3] transition-colors cursor-pointer"
              >
                <Paperclip size={13} />
              </button>
              <button
                type="button"
                title={t('cop.attachImage')}
                onClick={() => imageInputRef.current?.click()}
                className="p-1 rounded hover:bg-[#282726] text-[#87857F] hover:text-[#CECDC3] transition-colors cursor-pointer"
              >
                <ImagePlus size={13} />
              </button>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleImagePick}
              />
            </div>

            <button 
              type="button"
              onClick={handleSend}
              disabled={!input.trim()}
              className={`p-1 rounded transition-all ${
                input.trim() 
                  ? 'bg-[#205EA6] text-white hover:bg-[#4385BE] cursor-pointer' 
                  : 'bg-[#282726] text-[#575654] cursor-not-allowed'
              }`}
            >
              <Send size={11} />
            </button>
          </div>
        </div>
      </div>

    </div>
  );
}