import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
  type ChangeEvent,
  type ComponentType,
} from 'react';
import {
  X,
  Eye,
  EyeOff,
  Save,
  UserRound,
  Upload,
  Trash2,
  Search,
  SlidersHorizontal,
  Palette,
  Code2,
  Server,
  CircleUser,
  Database,
  RefreshCw,
  Sparkles,
  Plus,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from './Toast';
import { fetchModelList, getProviderModel, modelChoices } from '../lib/models';
import {
  buildLocalModelEntries,
  getCachedLocalScan,
  listServing,
  localEndpointsFresh,
  scanLocalModels,
  clearPendingLocalModel,
  getPendingLocalModel,
  type LocalEndpoint,
  type LocalModelEntry,
  type LocalScan,
} from '../lib/localModels';
import type { User } from '../types';
import { activeProviderStorageKey } from '../lib/providers';
import {
  deleteConnection,
  dismissEndpoint,
  ensureConnectionsMigrated,
  getConnection,
  isLocalBaseUrl,
  listConnections,
  newConnectionId,
  readDismissedEndpoints,
  saveConnection,
  undismissEndpoint,
  type Connection,
} from '../lib/connections';
import { hasStoredKey, setStoredKey, clearStoredKeys } from '../lib/secrets';
import { readShowReasoning, writeShowReasoning } from '../lib/reasoning';
import { getWorkspaceRoot } from '../lib/workspace';
import { explainError } from '../lib/errors';
import { useT, LANGUAGES, getLang, setLang, type TranslationKey } from '../lib/i18n';

export type SettingsTab =
  | 'general'
  | 'appearance'
  | 'editor'
  | 'chat'
  | 'providers'
  | 'profile'
  | 'data';

type IconCmp = ComponentType<{ size?: number; className?: string }>;

/** Left-rail navigation: grouped sections (mirrors the app-settings pattern). */
const NAV_GROUPS: { groupKey: TranslationKey; items: { id: SettingsTab; labelKey: TranslationKey; icon: IconCmp }[] }[] = [
  {
    groupKey: 'settings.group.basics',
    items: [
      { id: 'general', labelKey: 'settings.tab.general', icon: SlidersHorizontal },
      { id: 'appearance', labelKey: 'settings.tab.appearance', icon: Palette },
      { id: 'editor', labelKey: 'settings.tab.editor', icon: Code2 },
    ],
  },
  {
    groupKey: 'settings.group.ai',
    items: [
      { id: 'chat', labelKey: 'settings.tab.chat', icon: Sparkles },
      { id: 'providers', labelKey: 'settings.tab.providers', icon: Server },
    ],
  },
  {
    groupKey: 'settings.group.account',
    items: [{ id: 'profile', labelKey: 'settings.tab.profile', icon: CircleUser }],
  },
  {
    groupKey: 'settings.group.system',
    items: [{ id: 'data', labelKey: 'settings.tab.data', icon: Database }],
  },
];

const ALL_SECTIONS = NAV_GROUPS.flatMap((g) => g.items);
const sectionLabelKey = (id: SettingsTab): TranslationKey =>
  ALL_SECTIONS.find((s) => s.id === id)?.labelKey ?? 'settings.tab.general';
/** One-line, section-specific description shown under the header. */
const sectionDescKey = (id: SettingsTab): TranslationKey => `settings.desc.${id}` as TranslationKey;

/** Flat index of individual rows so the search box can jump across sections. */
const SEARCH_INDEX: { section: SettingsTab; labelKey: TranslationKey }[] = [
  { section: 'general', labelKey: 'settings.language' },
  { section: 'general', labelKey: 'settings.startupScreen' },
  { section: 'appearance', labelKey: 'settings.theme' },
  { section: 'editor', labelKey: 'settings.editorFontSize' },
  { section: 'editor', labelKey: 'settings.editorTabSize' },
  { section: 'editor', labelKey: 'settings.editorLineNumbers' },
  { section: 'editor', labelKey: 'settings.editorAutosave' },
  { section: 'chat', labelKey: 'settings.answerMode' },
  { section: 'chat', labelKey: 'settings.showReasoning' },
  { section: 'chat', labelKey: 'settings.rawContext' },
  { section: 'chat', labelKey: 'settings.router' },
  { section: 'chat', labelKey: 'settings.routerMode' },
  { section: 'chat', labelKey: 'settings.deepModel' },
  { section: 'providers', labelKey: 'settings.provider' },
  { section: 'providers', labelKey: 'settings.baseUrl' },
  { section: 'providers', labelKey: 'settings.apiKey' },
  { section: 'providers', labelKey: 'settings.models' },
  { section: 'data', labelKey: 'settings.livePrices' },
  { section: 'profile', labelKey: 'settings.displayName' },
  { section: 'data', labelKey: 'settings.resetTitle' },
  { section: 'data', labelKey: 'settings.clearChats' },
];

/** A plain settings row: label on the left, control on the right. */
function Row({ label, hint, control }: { label: string; hint?: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12.5px] text-[#CECDC3]">{label}</span>
        {hint && <span className="text-[11px] leading-snug text-[#87857F]">{hint}</span>}
      </div>
      <div className="flex flex-shrink-0 items-center">{control}</div>
    </div>
  );
}

/**
 * A group of rows. The header is optional: sections whose heading already names
 * the content use a bare group so the title is never repeated on the rows.
 */
function Card({
  title,
  desc,
  action,
  children,
}: {
  title?: string;
  desc?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-4 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-1">
      {title && (
        <div className="flex items-start justify-between gap-3 pt-3.5">
          <div className="min-w-0">
            <h3 className="text-[12.5px] font-semibold text-[#F2F0E5]">{title}</h3>
            {desc && <p className="mt-0.5 text-[11px] leading-snug text-[#87857F]">{desc}</p>}
          </div>
          {action && <div className="flex-shrink-0 pt-0.5">{action}</div>}
        </div>
      )}
      <div className="divide-y divide-white/[0.05]">{children}</div>
    </section>
  );
}

/** Bilgi amaçlı model listesi: burada seçim YOK, model sohbette seçilir. */
function ModelRows({ entries }: { entries: LocalModelEntry[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      {entries.map((entry) => (
        <div
          key={entry.key}
          title={entry.model}
          className="truncate rounded-md px-2.5 py-2 text-[12.5px] text-[#CECDC3]"
        >
          {entry.label}
        </div>
      ))}
    </div>
  );
}

/** Theme picker with a live mini-preview so the choice is obvious at a glance. */
function ThemeSwatches({
  value,
  onChange,
}: {
  value: 'dark' | 'nord-red';
  onChange: (v: 'dark' | 'nord-red') => void;
}) {
  const swatches = [
    { id: 'dark' as const, label: 'Obsidian', bg: '#100F0F', panel: '#1C1B1A', accent: '#3AA99F' },
    { id: 'nord-red' as const, label: 'Nord Red', bg: '#17100F', panel: '#211A18', accent: '#D99A6C' },
  ];
  return (
    <div className="flex gap-2.5">
      {swatches.map((s) => {
        const active = value === s.id;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(s.id)}
            className={`group flex cursor-pointer flex-col gap-1.5 rounded-lg border p-2 transition-colors ${
              active ? 'border-[#3AA99F]/70 bg-[#3AA99F]/[0.06]' : 'border-white/[0.08] hover:border-white/[0.18]'
            }`}
          >
            {/* Küçük pencere maketi: başlık çubuğu + kenar çubuğu + içerik
                satırları — tema seçimi nokta/dikdörtgen değil, gerçek önizleme. */}
            <span
              className="flex h-[52px] w-[84px] flex-col overflow-hidden rounded-md border border-black/40"
              style={{ backgroundColor: s.bg }}
            >
              <span className="flex h-3 items-center gap-1 px-1.5" style={{ backgroundColor: s.panel }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.accent }} />
                <span className="h-[2px] w-5 rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.28)' }} />
                <span className="ml-auto h-[2px] w-3 rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.14)' }} />
              </span>
              <span className="flex min-h-0 flex-1">
                <span className="w-4 border-r border-black/30" style={{ backgroundColor: s.panel }} />
                <span className="flex min-w-0 flex-1 flex-col gap-[5px] p-2">
                  <span className="h-[3px] w-3/4 rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.22)' }} />
                  <span className="h-[3px] w-1/2 rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.13)' }} />
                  <span className="h-[3px] w-2/3 rounded-full" style={{ backgroundColor: s.accent, opacity: 0.55 }} />
                </span>
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className={`text-[11.5px] ${active ? 'text-[#F2F0E5]' : 'text-[#87857F] group-hover:text-[#CECDC3]'}`}>{s.label}</span>
              {active && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3AA99F" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Erişilebilir ad; verilmezse yanındaki görünür etiketten miras alınır. */
  label?: string;
}) {
  const t = useT();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ?? t('common.toggle')}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 cursor-pointer rounded-full transition-colors duration-200 ${
        checked ? 'bg-[#3AA99F]' : 'bg-white/15'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`cursor-pointer rounded-md border px-3 py-1.5 text-[11.5px] transition-colors ${
            value === o.value
              ? 'border-white/[0.12] bg-white/[0.07] text-[#F2F0E5]'
              : 'border-white/[0.07] bg-transparent text-[#87857F] hover:text-[#CECDC3]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 font-mono text-[12.5px] text-[#F2F0E5] placeholder-white/20 transition-colors focus:border-[#3AA99F]/60 focus:outline-none';
const selectCls =
  'rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 font-mono text-[12px] text-[#F2F0E5] focus:outline-none cursor-pointer';
const labelCls = 'text-[11.5px] text-[#87857F]';
/** Bağlantı formu etiketleri: providers bölümünün sabit ölçeği (12px). */
const connLabelCls = 'text-[12px] text-[#CECDC3]';

const AVATAR_SIZE = 256;

/** Center-crops an image file to a square data URL so it stays small in localStorage. */
async function fileToAvatarDataUrl(file: File): Promise<string> {
  const rawUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = rawUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return rawUrl;
  const side = Math.min(img.width, img.height);
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export function SettingsModal({
  isOpen,
  onClose,
  initialTab = 'providers',
  user,
  onUpdateUser,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: SettingsTab;
  user?: User | null;
  /** Persists profile field edits (name, avatar) back to the app. */
  onUpdateUser?: (user: User) => void;
  /** Called after a successful save so the app can apply changes live. */
  onSaved?: () => void;
}) {
  const t = useT();
  const [activeSection, setActiveSection] = useState<SettingsTab>(initialTab);
  const { showToast } = useToast();
  const [resetArmed, setResetArmed] = useState(false);
  const [clearChatsArmed, setClearChatsArmed] = useState(false);
  const [query, setQuery] = useState('');

  // Bağlantılar (kullanıcı tanımlı sağlayıcı kayıtları — lib/connections).
  const [connections, setConnections] = useState<Connection[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  // V4: vault anahtarlari async yuklenir. Yukleme bitmeden kaydetmek, bos
  // kalan inputlar yuzunden vault'taki anahtarlari SILERDI (yaris kosulu —
  // denetim M10/V4). Save, yukleme bitene kadar kilitli; yukleme hatasinda
  // anahtar yazimi hic yapilmaz (mevcut anahtarlar korunur).
  const [keysLoaded, setKeysLoaded] = useState<boolean>(false);
  const keysStatusRef = useRef<'loading' | 'ok' | 'error'>('loading');
  const loadedKeysRef = useRef<Record<string, string>>({});
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [activeProvider, setActiveProvider] = useState<string>('');
  // Yerel (dosya tabanlı) modeller bağlantı listesinde ayrı bir satırdır;
  // seçildiğinde sohbet sağlayıcısı değişmez, yalnızca model yönetimi açılır.
  const [activeLocal, setActiveLocal] = useState(false);
  const [visibleProvider, setVisibleProvider] = useState<string | null>(null);

  // Appearance / Editor
  const [fontSize, setFontSize] = useState('13');
  const [tabSize, setTabSize] = useState('4');
  const [theme, setTheme] = useState<'dark' | 'nord-red'>('dark');
  const [editorLineNumbers, setEditorLineNumbers] = useState(true);
  const [editorAutosave, setEditorAutosave] = useState(false);

  // General
  const [livePricing, setLivePricing] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  /** Son uygulanan kök: aynı yolu blur'da tekrar göndermeyi önler. */
  const appliedWorkspaceRef = useRef('');
  const [showReasoning, setShowReasoning] = useState<boolean>(() => readShowReasoning());
  // Yanıt politikası: kullanıcı kelime yazmasa da açık tercih (H43).
  const [answerMode, setAnswerMode] = useState<'auto' | 'terse' | 'detailed'>(() => {
    try {
      const v = localStorage.getItem('tlm_answer_mode');
      return v === 'terse' || v === 'detailed' ? v : 'auto';
    } catch { return 'auto'; }
  });
  // Ham bağlam: motor sıkıştırmasını tamamen kapat (birebir/orijinal işler).
  const [rawContext, setRawContext] = useState<boolean>(() => {
    try { return localStorage.getItem('tlm_raw_context') === 'true'; } catch { return false; }
  });
  // Model yönlendirici: gömülü model adı yok; kullanıcı hızlı/derin modeli seçer.
  const [routerEnabled, setRouterEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('tlm_router_enabled') === 'true'; } catch { return false; }
  });
  const [routerMode, setRouterMode] = useState<'auto' | 'fast' | 'deep'>(() => {
    try {
      const v = localStorage.getItem('tlm_router_mode');
      return v === 'fast' || v === 'deep' ? v : 'auto';
    } catch { return 'auto'; }
  });
  const [deepModels, setDeepModels] = useState<Record<string, string>>({});

  // Üretim parametreleri (boş = sağlayıcı varsayılanı). aiClient bunları her
  // istekte okur; burada yalnız yazılır.
  const [temperature, setTemperature] = useState<string>(() => {
    try { return localStorage.getItem('tlm_temperature') || ''; } catch { return ''; }
  });
  const [maxTokens, setMaxTokens] = useState<string>(() => {
    try { return localStorage.getItem('tlm_max_tokens') || ''; } catch { return ''; }
  });
  const [customInstructions, setCustomInstructions] = useState<string>(() => {
    try { return localStorage.getItem('tlm_custom_instructions') || ''; } catch { return ''; }
  });

  const writeGenSetting = (key: string, value: string) => {
    try {
      if (value.trim()) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch { /* kota/kapalı depolama: sessizce yok say */ }
  };

  // Sağlayıcı başına model seçimi (tlm_model_<id>); boşsa sağlayıcı varsayılanı.
  const [models, setModels] = useState<Record<string, string>>({});
  // Bilgisayardaki yerel model sunucuları ve model dosyaları.
  const [localScan, setLocalScan] = useState<LocalScan | null>(() => getCachedLocalScan());
  const [servers, setServers] = useState<
    { id: string; kind: string; label: string; model: string; base_url: string; port: number; pid: number }[]
  >([]);
  const [scanning, setScanning] = useState(false);
  const [scanFailed, setScanFailed] = useState(false);
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({});
  const [modelsError, setModelsError] = useState<Record<string, string>>({});
  /** En az bir kez çekme denendi mi — boş liste mesajı için. */
  const [modelsTouched, setModelsTouched] = useState<Record<string, boolean>>({});
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Silme onayı (adım 2) bir süre dokunulmazsa kendiliğinden geri döner.
  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = window.setTimeout(() => setConfirmingDelete(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmingDelete]);
  /** Sağlayıcıdan çekilen gerçek model listesi (bağlantı başına). */
  const [fetchedModels, setFetchedModels] = useState<Record<string, string[]>>({});
  const [startView, setStartView] = useState<'chat' | 'project'>('chat');

  // Profile
  const [displayName, setDisplayName] = useState('');
  const [avatar, setAvatar] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // V4: her açılışta anahtar yükleme durumu sıfırlanır; Save yüklenene kadar kilitli.
    keysStatusRef.current = 'loading';
    setKeysLoaded(false);
    loadedKeysRef.current = {};
    // Bağlantılar önce göç eder (eski preset ayarları → kayıt), sonra liste
    // ve anahtarlar vault'tan async okunur.
    void (async () => {
      await ensureConnectionsMigrated();
      if (cancelled) return;
      const conns = listConnections();
      setConnections(conns);
      const localNames: Record<string, string> = {};
      const localBases: Record<string, string> = {};
      const localModels: Record<string, string> = {};
      const localDeep: Record<string, string> = {};
      const localFetched: Record<string, string[]> = {};
      for (const c of conns) {
        localNames[c.id] = c.name;
        localBases[c.id] = c.baseUrl;
        localModels[c.id] = getProviderModel(c.id);
        localDeep[c.id] = localStorage.getItem('tlm_deep_model_' + c.id) || '';
        if (c.models?.length) localFetched[c.id] = c.models;
      }
      // Sohbette yerel model seçildiyse (henüz yüklenmemiş olsa da) yerel
      // bölüm seçili açılır.
      const pending = getPendingLocalModel();
      localModels.managed = pending?.model || getProviderModel('managed');
      setNames(localNames);
      setBaseUrls(localBases);
      setModels(localModels);
      setDeepModels(localDeep);
      setFetchedModels(localFetched);
      let sel = '';
      try { sel = localStorage.getItem(activeProviderStorageKey) || ''; } catch { /* noop */ }
      if (sel === 'managed' || pending) {
        setActiveProvider('managed');
        setActiveLocal(true);
      } else {
        if (!conns.some((c) => c.id === sel)) sel = conns[0]?.id || '';
        setActiveProvider(sel);
        setActiveLocal(false);
      }
      // DEĞER OKUNMAZ: yalnız "kayıtlı mı" bilgisi. Anahtar hiçbir zaman
      // webview'a alınmaz; input boş başlar, placeholder kayıtlı olduğunu
      // söyler. Değiştirilmezse mevcut anahtar korunur.
      const map: Record<string, string> = {};
      try {
        await Promise.all(
          conns.map(async (c) => {
            map[c.id] = (await hasStoredKey(c.id)) ? '__STORED__' : '';
          })
        );
      } catch {
        if (cancelled) return;
        // Anahtarlar okunamadı: inputlar BOŞ kalır ama bu "sil" demek değildir.
        keysStatusRef.current = 'error';
        setKeysLoaded(true);
        showToast(t('settings.keyLoadFailed'), t('settings.keyLoadFailedMsg'), 'error', undefined, '[500] secrets vault read failed');
        return;
      }
      if (cancelled) return;
      setKeys(map);
      loadedKeysRef.current = map;
      keysStatusRef.current = 'ok';
      setKeysLoaded(true);
    })();
    setLivePricing(localStorage.getItem('tlm_online_pricing') === 'true');
    const loadedTheme = (localStorage.getItem('tlm_theme') as 'dark' | 'nord-red') || 'dark';
    setTheme(loadedTheme);
    setShowReasoning(readShowReasoning());
    const am = localStorage.getItem('tlm_answer_mode');
    setAnswerMode(am === 'terse' || am === 'detailed' ? am : 'auto');
    setRawContext(localStorage.getItem('tlm_raw_context') === 'true');
    setRouterEnabled(localStorage.getItem('tlm_router_enabled') === 'true');
    const rm = localStorage.getItem('tlm_router_mode');
    setRouterMode(rm === 'fast' || rm === 'deep' ? rm : 'auto');
    setStartView(localStorage.getItem('tlm_start_view') === 'project' ? 'project' : 'chat');
    setResetArmed(false);
    setClearChatsArmed(false);
    setQuery('');
    setDisplayName(user?.name || '');
    setAvatar(user?.avatar || '');

    try {
      const cfg = JSON.parse(localStorage.getItem('thalamus_config') || '{}');
      if (cfg.appearance?.fontSize) setFontSize(cfg.appearance.fontSize.replace('px', ''));
      if (cfg.appearance?.tabSize) setTabSize(String(cfg.appearance.tabSize));
      if (typeof cfg.appearance?.showLineNumbers === 'boolean') setEditorLineNumbers(cfg.appearance.showLineNumbers);
      if (typeof cfg.appearance?.autosave === 'boolean') setEditorAutosave(cfg.appearance.autosave);
      if (typeof cfg.workspace_root === 'string') { setWorkspaceRoot(cfg.workspace_root); appliedWorkspaceRef.current = cfg.workspace_root; }
    } catch {}

    // Keep the workspace field in sync with the backend's actual root.
    invoke<{ root: string; name: string; file_count: number }>('get_workspace_info')
      .then((info) => {
        if (cancelled) return;
        if (info?.root) setWorkspaceRoot(info.root);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => setActiveSection(initialTab), [initialTab]);

  /**
   * Taranan sunucular kendi adlarıyla (Ollama, LM Studio…) bağlantı listesine
   * eklenir; modelleri orada, tek yerde görünür. Silinen sunucu tekrar eklenmez.
   */
  const registerEndpoints = useCallback((endpoints: LocalEndpoint[]) => {
    if (endpoints.length === 0) return;
    const key = (url: string) => (url || '').trim().toLowerCase().replace(/\/+$/, '');
    const dismissed = new Set(readDismissedEndpoints().map(key));
    let list = listConnections();
    let added = false;
    for (const ep of endpoints) {
      const base = (ep.baseUrl || '').trim().replace(/\/+$/, '');
      if (!base || dismissed.has(key(base))) continue;
      if (list.some((c) => key(c.baseUrl) === key(base))) continue;
      const id = list.some((c) => c.id === ep.provider) ? newConnectionId() : ep.provider;
      list = saveConnection({
        id,
        name: ep.label || ep.provider,
        baseUrl: base,
        models: ep.models,
      });
      added = true;
    }
    if (!added) return;
    setConnections(list);
    setNames((prev) => {
      const next = { ...prev };
      for (const c of list) next[c.id] = prev[c.id] ?? c.name;
      return next;
    });
    setBaseUrls((prev) => {
      const next = { ...prev };
      for (const c of list) next[c.id] = prev[c.id] ?? c.baseUrl;
      return next;
    });
    setFetchedModels((prev) => {
      const next = { ...prev };
      for (const c of list) if (c.models?.length && !next[c.id]) next[c.id] = c.models;
      return next;
    });
  }, []);

  /** Bilgisayardaki yerel sunucuları, motorları ve model dosyalarını tarar. */
  const runLocalScan = useCallback(async (extra: string[]) => {
    setScanning(true);
    setScanFailed(false);
    try {
      const scan = await scanLocalModels(extra);
      setLocalScan(scan);
      registerEndpoints(scan.endpoints);
      setServers(await listServing());
    } catch {
      setScanFailed(true);
    } finally {
      setScanning(false);
    }
  }, [registerEndpoints]);

  // Sağlayıcılar bölümü açıldığında tarama KENDİLİĞİNDEN yapılır (önbellek
  // tazeyse yalnız çalışan sunucular yenilenir) — kullanıcı "Tara"ya basmasın.
  useEffect(() => {
    if (!isOpen || activeSection !== 'providers') return;
    const cached = getCachedLocalScan();
    setLocalScan(cached);
    if (cached) registerEndpoints(cached.endpoints);
    void listServing().then(setServers);
    if (localEndpointsFresh()) return;
    void runLocalScan([]);
  }, [isOpen, activeSection, runLocalScan, registerEndpoints]);

  // Tema seçimi ANINDA kalıcıdır (previewTheme localStorage'a yazar); bu yüzden
  // kapatmak temayı geri almaz. Diğer (Kaydet'e bağlı) alanlar için Cancel iptal sayılır.
  const requestClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // Esc closes the dialog (same semantics as the X button).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, requestClose]);

  const conn = activeLocal ? null : (connections.find((c) => c.id === activeProvider) ?? null);
  const connIsLocal = !!conn && isLocalBaseUrl(conn.baseUrl);
  // Yerel tarama sonucunun kısaltmaları (tarama yoksa boş).
  const localFiles = localScan?.files ?? [];
  const localEndpoints = localScan?.endpoints ?? [];
  const localEntries = buildLocalModelEntries({
    endpoints: localEndpoints,
    files: localFiles,
    servers,
    activeProvider,
    currentModel: models[activeProvider] || '',
  });
  // Dosya tabanlı modeller (paket içi motor). Ollama'nın yönettiği modeller ve
  // bir sunucunun servis ettikleri burada TEKRAR etmez — onlar kendi
  // bağlantılarında (ör. "Ollama") görünür.
  const localFileEntries = localEntries.filter((e) => {
    if (!e.key.startsWith('file:')) return false;
    const file = localFiles.find((f) => `file:${f.id}` === e.key);
    if (file && (file.kind === 'ollama' || file.engine === 'ollama')) return false;
    return !e.running || e.provider === 'managed';
  });
  const showLocal = activeLocal || localFileEntries.length > 0;

  /** Bağlantı listesinden bir kayıt seçer ve etkin yapar. */
  const selectConnection = (id: string) => {
    clearPendingLocalModel();
    setActiveLocal(false);
    setActiveProvider(id);
    try { localStorage.setItem(activeProviderStorageKey, id); } catch { /* noop */ }
    window.dispatchEvent(new Event('thalamus_config_changed'));
    setVisibleProvider(null);
    setConfirmingDelete(false);
  };

  const addConnection = () => {
    const id = newConnectionId();
    const name = t('settings.conn.untitled');
    setConnections(saveConnection({ id, name, baseUrl: '' }));
    setNames((prev) => ({ ...prev, [id]: name }));
    setBaseUrls((prev) => ({ ...prev, [id]: '' }));
    setModels((prev) => ({ ...prev, [id]: '' }));
    setDeepModels((prev) => ({ ...prev, [id]: '' }));
    setFetchedModels((prev) => ({ ...prev, [id]: [] }));
    setKeys((prev) => ({ ...prev, [id]: '' }));
    selectConnection(id);
  };

  const deleteSelectedConnection = () => {
    if (!conn) return;
    // İlk tıklama onay ister (satır içi), ikincisi siler.
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setConfirmingDelete(false);
    // Silinen yerel sunucu bir sonraki taramada kendiliğinden geri gelmesin.
    if (isLocalBaseUrl(conn.baseUrl)) dismissEndpoint(conn.baseUrl);
    void setStoredKey(conn.id, '');
    const remaining = deleteConnection(conn.id);
    setConnections(remaining);
    if (activeProvider === conn.id) {
      const next = remaining[0]?.id || '';
      try {
        if (next) localStorage.setItem(activeProviderStorageKey, next);
        else localStorage.removeItem(activeProviderStorageKey);
      } catch { /* noop */ }
      setActiveProvider(next);
      window.dispatchEvent(new Event('thalamus_config_changed'));
    }
  };

  /** Ad ya da taban URL değişikliği ANINDA kayda yazılır. */
  const updateConnectionField = (field: 'name' | 'baseUrl', value: string) => {
    if (!conn) return;
    if (field === 'name') setNames((prev) => ({ ...prev, [conn.id]: value }));
    else {
      setBaseUrls((prev) => ({ ...prev, [conn.id]: value }));
      // Elle girilen yerel adres "yok sayılanlar"dan çıkar.
      if (isLocalBaseUrl(value)) undismissEndpoint(value);
    }
    setConnections(saveConnection({ ...conn, [field]: value }));
    window.dispatchEvent(new Event('thalamus_config_changed'));
  };

  /** Model listesini sessizce yeniden çeker (formdaki yenile ikonu). */
  const refreshModels = useCallback(async (id: string) => {
    const base = (baseUrls[id] ?? '').trim();
    const key = (keys[id] || '').trim();
    if (!base) return;
    if (!isLocalBaseUrl(base) && key.length < 8) return;
    setModelsLoading((prev) => ({ ...prev, [id]: true }));
    setModelsTouched((prev) => ({ ...prev, [id]: true }));
    try {
      const listed = await fetchModelList(base, key);
      setFetchedModels((prev) => ({ ...prev, [id]: listed }));
      setModelsError((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      // Liste BAĞLANTIYA kalıcı yazılır → sonraki açılışta anında hazır.
      const current = getConnection(id);
      if (current) setConnections(saveConnection({ ...current, models: listed }));
    } catch (e) {
      const x = explainError(e, 'Model list');
      setModelsError((prev) => ({ ...prev, [id]: x.explanation }));
    } finally {
      setModelsLoading((prev) => ({ ...prev, [id]: false }));
    }
  }, [baseUrls, keys]);

  // Liste KENDİLİĞİNDEN gelir: base URL + (uzakta) anahtar hazır olduğunda
  // 700ms debounce ile çekilir — "Test"e basmak gerekmez.
  const autoBase = activeProvider ? (baseUrls[activeProvider] ?? '') : '';
  const autoKey = activeProvider ? (keys[activeProvider] || '') : '';
  useEffect(() => {
    if (!isOpen || !activeProvider) return;
    const base = autoBase.trim();
    if (!base) return;
    if (!isLocalBaseUrl(base) && autoKey.trim().length < 8) return;
    const timer = window.setTimeout(() => { void refreshModels(activeProvider); }, 700);
    return () => window.clearTimeout(timer);
  }, [isOpen, activeProvider, autoBase, autoKey, refreshModels]);

  /**
   * Ayar değişikliğini ANINDA kalıcılaştırır ve uygular (Kaydet beklenmez).
   * Görünüm ayarları 'thalamus_config' + 'thalamus_config_changed' ile
   * ProjectDashboard'a, model/fiyatlandırma aynı olayla App'e iletilir.
   */
  const persistConfig = (
    patch: Partial<{
      fontSize: string;
      tabSize: string;
      onlinePricing: boolean;
      showLineNumbers: boolean;
      autosave: boolean;
    }> = {}
  ) => {
    const cfg = {
      appearance: {
        fontSize: `${patch.fontSize ?? fontSize}px`,
        tabSize: Number(patch.tabSize ?? tabSize),
        showLineNumbers: patch.showLineNumbers ?? editorLineNumbers,
        autosave: patch.autosave ?? editorAutosave,
      },
      onlinePricing: patch.onlinePricing ?? livePricing,
      workspace_root: getWorkspaceRoot() ?? '',
    };
    try { localStorage.setItem('thalamus_config', JSON.stringify(cfg)); } catch {}
    window.dispatchEvent(new Event('thalamus_config_changed'));
  };

  /**
   * Applies the theme immediately AND commits it: a display preference must
   * stick even if the dialog is dismissed without pressing Save. Writing it here
   * makes the chosen theme the one the app starts with on the next launch.
   */
  const previewTheme = (next: 'dark' | 'nord-red') => {
    setTheme(next);
    try { localStorage.setItem('tlm_theme', next); } catch {}
    const el = document.documentElement;
    if (next === 'nord-red') el.setAttribute('data-theme', 'nord-red');
    else el.removeAttribute('data-theme');
  };

  async function handleAvatarPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast(t('settings.invalidImage'), t('settings.invalidImageMsg'), 'error', undefined, '[400] wrong file type');
      return;
    }
    try {
      setAvatar(await fileToAvatarDataUrl(file));
    } catch {
      showToast(t('settings.imageReadFailed'), t('settings.imageReadFailedMsg'), 'error', undefined, '[400] image decode failed');
    }
  }

  async function handleSave() {
    // V4: anahtarlar henuz yuklenmediyse kaydetme anahtarlara DOKUNMAZ —
    // bos input yuzunden vault silinmesi (V4 yaris kosulu) artik imkansiz.
    if (keysStatusRef.current === 'loading') {
      showToast(t('settings.notReady'), t('settings.notReadyMsg'), 'info');
      return;
    }
    if (keysStatusRef.current === 'ok') {
      // Yalnizca kullaniciyi gercekten degistirdigi anahtarlari yaz.
      // '__STORED__' = "dokunma" isareti: kullanici inputa bir sey yazmadiysa
      // mevcut kasitli anahtar oldugu gibi kalir (silme kazasi imkansiz).
      const STORED = '__STORED__';
      const changed = connections.filter(
        (c) => (keys[c.id] || '').trim() !== (loadedKeysRef.current[c.id] || '').trim()
      );
      const writes = changed.filter((c) => (keys[c.id] || '').trim() !== STORED);
      const unchangedStored = changed.length - writes.length;
      const removed = writes.filter((c) => !(keys[c.id] || '').trim());
      if (removed.length > 0) {
        const names = removed.map((c) => c.name).join(', ');
        if (!window.confirm(t('settings.removeKeyConfirm', { names }))) {
          return;
        }
      }
      await Promise.all(writes.map((c) => setStoredKey(c.id, (keys[c.id] || '').trim())));
      void unchangedStored;
    }
    localStorage.setItem(activeProviderStorageKey, activeProvider);

    // Taban URL'ler zaten kayıt anında yazıldı (updateConnectionField).

    localStorage.setItem('tlm_online_pricing', String(livePricing));
    localStorage.setItem('tlm_theme', theme);
    localStorage.setItem('tlm_start_view', startView);

    // Ayarlar: workspace yolu ÖNCE doğrulanır; bozuk yol hiçbir config'e
    // yazılmaz (eski akış, hatadan sonra bozuk kaydis bırakıyordu).
    let validatedRoot: string | null = null;
    if (workspaceRoot.trim()) {
      try {
        const info = await invoke<{ root: string }>('set_workspace_root', { path: workspaceRoot.trim() });
        if (info?.root) validatedRoot = info.root;
      } catch (e) {
        console.error('Could not set workspace root:', e);
        const x = explainError(e, 'Workspace');
        showToast(t('settings.workspaceError'), `${t('settings.workspaceErrorMsg', { path: workspaceRoot.trim() })} ${x.explanation}`, 'error', undefined, `[${x.code}] ${x.detail ?? String(e)}]`);
      }
    }

    const config = {
      appearance: {
        fontSize: `${fontSize}px`,
        tabSize: Number(tabSize),
        showLineNumbers: editorLineNumbers,
        autosave: editorAutosave,
      },
      onlinePricing: livePricing,
      workspace_root: validatedRoot ?? getWorkspaceRoot() ?? '',
    };
    localStorage.setItem('thalamus_config', JSON.stringify(config));

    try {
      await invoke('thalamus_save_config', { configJson: JSON.stringify(config, null, 2) });
    } catch {}

    if (user && onUpdateUser) {
      onUpdateUser({
        ...user,
        name: displayName.trim() || user.name,
        avatar: avatar || undefined,
      });
    }

    showToast(t('settings.saved'), t('settings.savedMsg'), 'success');
    onSaved?.();
    // Editor ayağı (ProjectDashboard) fontSize/tabSize'ı anında alabilsin diye
    // config değişti bilgisini yay (remount beklemeden uygulanır).
    window.dispatchEvent(new Event('thalamus_config_changed'));
  }

  /** Clears stored keys + preferences; chats, files and the connection list are kept. */
  async function handleReset() {
    await clearStoredKeys(listConnections().map((c) => c.id));
    // Backend config dosyası da silinir; yoksa workspace_root %APPDATA'da
    // kalıp bir sonraki açılışta "sıfırlandı" denen ayarı geri getirir.
    try {
      await invoke('reset_app_config');
    } catch (e) {
      showToast(t('settings.resetIncomplete'), t('settings.resetIncompleteMsg'), 'error', undefined, `[500] ${String(e)}`);
    }
    for (const key of Object.keys(localStorage)) {
      // Bağlantı listesi SIFIRLAMADA korunur (yeniden anahtar girmek yeterli).
      if (key.startsWith('tlm_') && key !== 'tlm_connections_v1') localStorage.removeItem(key);
    }
    localStorage.removeItem('thalamus_config');
    showToast(t('settings.resetDone'), t('settings.resetDoneMsg'), 'info');
    setTimeout(() => window.location.reload(), 600);
  }

  /** Removes every chat session (files and settings are kept). */
  function handleClearChats() {
    try {
      const doomed: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k === 'thalamus_chats' || k === 'thalamus_active_chat_id' || k.startsWith('thalamus_chat_messages_'))) {
          doomed.push(k);
        }
      }
      doomed.forEach((k) => localStorage.removeItem(k));
    } catch {}
    showToast(t('settings.clearChatsDone'), t('settings.clearChatsDoneMsg'), 'info');
    setTimeout(() => window.location.reload(), 500);
  }

  const q = query.trim().toLowerCase();
  const searchResults = q
    ? SEARCH_INDEX.filter((r) => t(r.labelKey).toLowerCase().includes(q))
    : [];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="absolute inset-0" onClick={requestClose} />

      <div className="relative flex h-[620px] w-[860px] max-w-[94vw] overflow-hidden rounded-lg border border-white/[0.08] bg-[#100F0F] shadow-2xl font-sans text-xs">

        {/* left: search + grouped section list */}
        <aside className="flex w-[208px] flex-shrink-0 flex-col border-r border-white/[0.06] bg-[#100F0F] p-2">
          <div className="relative px-0.5 pb-1.5 pt-0.5">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#575654]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('settings.searchPlaceholder')}
              spellCheck={false}
              className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] py-1.5 pl-7 pr-6 text-[12px] text-[#F2F0E5] placeholder-white/25 transition-colors focus:border-[#3AA99F]/60 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('settings.searchClear')}
                className="absolute right-2 top-1/2 -translate-y-1/2 flex h-4 w-4 items-center justify-center rounded text-[#575654] transition-colors hover:text-[#CECDC3] cursor-pointer"
              >
                <X size={11} />
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto pretty-scrollbar">
            {NAV_GROUPS.map((group) => (
              <div key={group.groupKey} className="mb-1">
                <div className="px-2.5 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-wider text-[#575654]">
                  {t(group.groupKey)}
                </div>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = activeSection === item.id && !q;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => { setActiveSection(item.id); setQuery(''); }}
                      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors cursor-pointer ${
                        active
                          ? 'bg-white/[0.06] text-[#F2F0E5]'
                          : 'text-[#87857F] hover:bg-white/[0.03] hover:text-[#CECDC3]'
                      }`}
                    >
                      <Icon size={14} />
                      {t(item.labelKey)}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </aside>

        {/* right: content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex flex-shrink-0 items-start justify-between px-6 pb-3 pt-5">
            <div className="flex flex-col">
              <span className="text-[14px] font-semibold tracking-tight text-[#F2F0E5]">
                {q ? t('settings.title') : t(sectionLabelKey(activeSection))}
              </span>
              <span className="mt-0.5 max-w-[540px] text-[11px] leading-snug text-[#87857F]">
                {q ? t('settings.searchEmpty', { query: query.trim() }) : t(sectionDescKey(activeSection))}
              </span>
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label={t('settings.closeAria')}
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-[#575654] transition-colors hover:bg-white/[0.06] hover:text-[#CECDC3] cursor-pointer"
            >
              <X size={14} />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-6 pb-5 pretty-scrollbar">
            {/* ── SEARCH RESULTS ── */}
            {q && (
              searchResults.length === 0 ? (
                <p className="pt-2 text-[12px] text-[#87857F]">{t('settings.searchEmpty', { query: query.trim() })}</p>
              ) : (
                <div className="flex flex-col">
                  {searchResults.map((r) => (
                    <button
                      key={`${r.section}:${r.labelKey}`}
                      type="button"
                      onClick={() => { setActiveSection(r.section); setQuery(''); }}
                      className="flex items-center justify-between gap-4 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04] cursor-pointer"
                    >
                      <span className="text-[12.5px] text-[#CECDC3]">{t(r.labelKey)}</span>
                      <span className="text-[11px] text-[#575654]">{t(sectionLabelKey(r.section))}</span>
                    </button>
                  ))}
                </div>
              )
            )}

            {/* ── GENERAL ── */}
            {!q && activeSection === 'general' && (
              <Card>
                <Row
                  label={t('settings.language')}
                  hint={t('settings.languageHint')}
                  control={
                    <select
                      value={getLang()}
                      onChange={(e) => setLang(e.target.value === 'tr' ? 'tr' : 'en')}
                      className={selectCls}
                    >
                      {LANGUAGES.map((l) => (
                        <option key={l.id} value={l.id}>{l.label}</option>
                      ))}
                    </select>
                  }
                />
                <Row
                  label={t('settings.startupScreen')}
                  hint={t('settings.startupScreenHint')}
                  control={
                    <Segmented
                      value={startView}
                      onChange={(v) => { setStartView(v); try { localStorage.setItem('tlm_start_view', v); } catch {} }}
                      options={[
                        { value: 'chat', label: t('sidebar.chat') },
                        { value: 'project', label: t('sidebar.project') },
                      ]}
                    />
                  }
                />
              </Card>
            )}

            {/* ── APPEARANCE ── */}
            {!q && activeSection === 'appearance' && (
              <Card>
                <Row
                  label={t('settings.theme')}
                  hint={t('settings.themeHint')}
                  control={<ThemeSwatches value={theme} onChange={previewTheme} />}
                />
              </Card>
            )}

            {/* ── EDITOR ── */}
            {!q && activeSection === 'editor' && (
              <Card>
                <Row
                  label={t('settings.editorFontSize')}
                  control={
                    <select value={fontSize} onChange={(e) => { setFontSize(e.target.value); persistConfig({ fontSize: e.target.value }); }} className={selectCls}>
                      {['11', '12', '13', '14', '15', '16'].map((s) => (
                        <option key={s} value={s}>{s}px</option>
                      ))}
                    </select>
                  }
                />
                <Row
                  label={t('settings.editorTabSize')}
                  control={
                    <select value={tabSize} onChange={(e) => { setTabSize(e.target.value); persistConfig({ tabSize: e.target.value }); }} className={selectCls}>
                      {['2', '4', '8'].map((s) => (
                        <option key={s} value={s}>{t('settings.tabSizeSpaces', { n: s })}</option>
                      ))}
                    </select>
                  }
                />
                <Row
                  label={t('settings.editorLineNumbers')}
                  hint={t('settings.editorLineNumbersHint')}
                  control={
                    <Switch
                      checked={editorLineNumbers}
                      onChange={(v) => { setEditorLineNumbers(v); persistConfig({ showLineNumbers: v }); }}
                    />
                  }
                />
                <Row
                  label={t('settings.editorAutosave')}
                  hint={t('settings.editorAutosaveHint')}
                  control={
                    <Switch
                      checked={editorAutosave}
                      onChange={(v) => { setEditorAutosave(v); persistConfig({ autosave: v }); }}
                    />
                  }
                />
              </Card>
            )}

            {/* ── CONNECTIONS ── Bölüm modal başlığında adlandığı için burada
                başlık tekrar edilmez. Liste + form tek kartta, modalın diğer
                bölümleriyle aynı satır dilinde. */}
            {!q && activeSection === 'providers' && (
              <>
                <Card>
                  <div className="flex flex-col gap-0.5 py-2">
                    {showLocal && (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveLocal(true);
                          setVisibleProvider(null);
                          setConfirmingDelete(false);
                        }}
                        className={`flex w-full items-center rounded-md px-2.5 py-2 text-left transition-colors ${
                          activeLocal ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                        }`}
                      >
                        <span
                          className={`min-w-0 truncate text-[12.5px] ${activeLocal ? 'text-[#F2F0E5]' : 'text-[#CECDC3]'}`}
                        >
                          {t('settings.conn.local')}
                        </span>
                      </button>
                    )}
                    {connections.map((c) => {
                      const selected = !activeLocal && c.id === activeProvider;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => selectConnection(c.id)}
                          className={`flex w-full items-center rounded-md px-2.5 py-2 text-left transition-colors ${
                            selected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                          }`}
                        >
                          <span
                            className={`min-w-0 truncate text-[12.5px] ${selected ? 'text-[#F2F0E5]' : 'text-[#CECDC3]'}`}
                          >
                            {c.name || c.id}
                          </span>
                        </button>
                      );
                    })}
                    {connections.length === 0 && !showLocal && (
                      <p className="px-2.5 py-1.5 text-[12px] text-[#87857F]">
                        {t('settings.conn.empty')}
                      </p>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={addConnection}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] text-[#87857F] transition-colors hover:bg-white/[0.03] hover:text-[#CECDC3]"
                      >
                        <Plus size={12} />
                        {t('settings.conn.new')}
                      </button>
                      <button
                        type="button"
                        disabled={scanning}
                        onClick={() => void runLocalScan([])}
                        className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] text-[#575654] transition-colors hover:text-[#CECDC3] disabled:cursor-default disabled:opacity-50"
                      >
                        <RefreshCw size={11} className={scanning ? 'animate-spin' : ''} />
                        {t('settings.localScan')}
                      </button>
                    </div>
                  </div>

                  {activeLocal && (
                    <div className="flex flex-col gap-2 py-4">
                      <span className={connLabelCls}>{t('settings.models')}</span>
                      {localFileEntries.length > 0 ? (
                        <ModelRows entries={localFileEntries} />
                      ) : (
                        <p className="px-2.5 py-1.5 text-[12px] text-[#87857F]">
                          {scanFailed ? t('settings.localScanFailed') : t('settings.localNone')}
                        </p>
                      )}
                    </div>
                  )}

                  {conn && (
                    <div className="flex flex-col gap-4 py-4">
                      <label className="flex flex-col gap-1.5">
                        <span className={connLabelCls}>{t('settings.conn.name')}</span>
                        <input
                          type="text"
                          value={names[conn.id] ?? conn.name}
                          onChange={(e) => updateConnectionField('name', e.target.value)}
                          placeholder={t('settings.conn.untitled')}
                          className={inputCls}
                          spellCheck={false}
                        />
                      </label>

                      <label className="flex flex-col gap-1.5">
                        <span className={connLabelCls}>{t('settings.baseUrl')}</span>
                        <input
                          type="text"
                          value={baseUrls[conn.id] ?? conn.baseUrl}
                          onChange={(e) => updateConnectionField('baseUrl', e.target.value)}
                          placeholder="https://api.example.com/v1"
                          className={inputCls}
                          spellCheck={false}
                        />
                      </label>

                      <div className="flex flex-col gap-1.5">
                        <span className={connLabelCls}>{t('settings.apiKey')}</span>
                        <div className="relative">
                          <input
                            type={visibleProvider === conn.id ? 'text' : 'password'}
                            value={
                              (keys[conn.id] || '') === '__STORED__'
                                ? ''
                                : keys[conn.id] || ''
                            }
                            onChange={(e) =>
                              setKeys((prev) => ({ ...prev, [conn.id]: e.target.value }))
                            }
                            placeholder={
                              connIsLocal
                                ? '—'
                                : (keys[conn.id] || '') === '__STORED__'
                                  ? t('settings.keySaved')
                                  : 'sk-...'
                            }
                            className={inputCls}
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <button
                            type="button"
                            onClick={() => setVisibleProvider(visibleProvider === conn.id ? null : conn.id)}
                            aria-label={visibleProvider === conn.id ? t('settings.hideKey') : t('settings.showKey')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#575654] transition-colors hover:text-[#CECDC3] cursor-pointer"
                            tabIndex={-1}
                          >
                            {visibleProvider === conn.id ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        </div>
                      </div>

                      {/* Modeller: seçim yok — sağlayıcının tüm listesi burada,
                          modeli sohbet sırasında seçersin. */}
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className={connLabelCls}>{t('settings.models')}</span>
                          <span className="flex items-center gap-1.5">
                            <span
                              title={modelsError[conn.id] || undefined}
                              className={`text-[11.5px] ${modelsError[conn.id] ? 'text-red-300/80' : 'text-[#575654]'}`}
                            >
                              {modelsLoading[conn.id]
                                ? t('settings.modelsLoading')
                                : modelsError[conn.id]
                                  ? t('settings.modelsError')
                                  : (fetchedModels[conn.id]?.length ?? 0) > 0
                                    ? t('settings.modelsCount', { count: fetchedModels[conn.id].length })
                                    : ''}
                            </span>
                            <button
                              type="button"
                              onClick={() => void refreshModels(conn.id)}
                              aria-label={t('settings.modelsRefresh')}
                              title={t('settings.modelsRefresh')}
                              className="cursor-pointer text-[#575654] transition-colors hover:text-[#CECDC3]"
                            >
                              <RefreshCw size={11} className={modelsLoading[conn.id] ? 'animate-spin' : ''} />
                            </button>
                          </span>
                        </div>

                        {(fetchedModels[conn.id]?.length ?? 0) > 0 && !modelsError[conn.id] && (
                          <div className="max-h-[168px] overflow-y-auto rounded-md border border-white/[0.06] pretty-scrollbar">
                            {fetchedModels[conn.id].map((m) => (
                              <div
                                key={m}
                                title={m}
                                className="truncate px-2.5 py-1.5 font-mono text-[11.5px] text-[#CECDC3]"
                              >
                                {m}
                              </div>
                            ))}
                          </div>
                        )}

                        {modelsTouched[conn.id] &&
                          !modelsLoading[conn.id] &&
                          !modelsError[conn.id] &&
                          (fetchedModels[conn.id]?.length ?? 0) === 0 && (
                            <p className="text-[11.5px] text-[#575654]">{t('settings.modelsEmpty')}</p>
                          )}
                      </div>

                      {/* Sil (sağ, iki adımlı onay). */}
                      <div className="flex items-center justify-end border-t border-white/[0.05] pt-3.5">
                        <button
                          type="button"
                          onClick={deleteSelectedConnection}
                          className={`cursor-pointer px-1 text-[12px] transition-colors ${
                            confirmingDelete
                              ? 'text-rose-300/90'
                              : 'text-[#87857F] hover:text-[#CECDC3]'
                          }`}
                        >
                          {confirmingDelete ? t('settings.conn.deleteAsk') : t('settings.conn.delete')}
                        </button>
                      </div>
                    </div>
                  )}
                </Card>
              </>
            )}

            {/* ── CHAT & AI ── */}
            {!q && activeSection === 'chat' && (
              <>
                <Card title={t('settings.card.answerTitle')} desc={t('settings.card.answerDesc')}>
                  <Row
                    label={t('settings.answerMode')}
                    hint={t('settings.answerModeHint')}
                    control={
                      <select
                        value={answerMode}
                        onChange={(e) => {
                          const v = e.target.value as 'auto' | 'terse' | 'detailed';
                          setAnswerMode(v);
                          try { localStorage.setItem('tlm_answer_mode', v); } catch {}
                        }}
                        className={selectCls}
                      >
                        <option value="auto">{t('settings.answerAuto')}</option>
                        <option value="terse">{t('settings.answerTerse')}</option>
                        <option value="detailed">{t('settings.answerDetailed')}</option>
                      </select>
                    }
                  />
                  <Row
                    label={t('settings.showReasoning')}
                    hint={t('settings.showReasoningHint')}
                    control={
                      <Switch
                        checked={showReasoning}
                        onChange={(v) => {
                          setShowReasoning(v);
                          writeShowReasoning(v);
                          window.dispatchEvent(new Event('thalamus_config_changed'));
                        }}
                      />
                    }
                  />
                </Card>

                <Card title={t('settings.card.instructionsTitle')} desc={t('settings.card.instructionsDesc')}>
                  <div className="flex flex-col gap-1.5 py-3.5">
                    <label className={labelCls} htmlFor="settings-instructions">{t('settings.instructions')}</label>
                    <textarea
                      id="settings-instructions"
                      rows={3}
                      value={customInstructions}
                      onChange={(e) => {
                        setCustomInstructions(e.target.value);
                        writeGenSetting('tlm_custom_instructions', e.target.value);
                      }}
                      placeholder={t('settings.instructionsPlaceholder')}
                      className={`${inputCls} min-h-[72px] resize-y`}
                    />
                    <p className="text-[11px] text-[#87857F]">{t('settings.instructionsHint')}</p>
                  </div>
                </Card>

                <Card title={t('settings.card.generationTitle')} desc={t('settings.card.generationDesc')}>
                  <div className="grid grid-cols-1 gap-3 py-3.5 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <label className={labelCls} htmlFor="settings-temperature">{t('settings.temperature')}</label>
                      <input
                        id="settings-temperature"
                        type="number"
                        min={0}
                        max={2}
                        step={0.1}
                        value={temperature}
                        placeholder={t('settings.providerDefault')}
                        onChange={(e) => {
                          setTemperature(e.target.value);
                          writeGenSetting('tlm_temperature', e.target.value);
                        }}
                        className={inputCls}
                      />
                      <p className="text-[11px] leading-snug text-[#87857F]">{t('settings.temperatureHint')}</p>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className={labelCls} htmlFor="settings-max-tokens">{t('settings.maxTokens')}</label>
                      <input
                        id="settings-max-tokens"
                        type="number"
                        min={1}
                        max={32768}
                        step={1}
                        value={maxTokens}
                        placeholder="4096"
                        onChange={(e) => {
                          setMaxTokens(e.target.value);
                          writeGenSetting('tlm_max_tokens', e.target.value);
                        }}
                        className={inputCls}
                      />
                      <p className="text-[11px] leading-snug text-[#87857F]">{t('settings.maxTokensHint')}</p>
                    </div>
                  </div>
                </Card>

                <Card title={t('settings.card.contextTitle')} desc={t('settings.card.contextDesc')}>
                  <Row
                    label={t('settings.rawContext')}
                    hint={t('settings.rawContextHint')}
                    control={
                      <Switch
                        checked={rawContext}
                        onChange={(v) => {
                          setRawContext(v);
                          try { localStorage.setItem('tlm_raw_context', String(v)); } catch {}
                        }}
                      />
                    }
                  />
                  <Row
                    label={t('settings.router')}
                    hint={t('settings.routerHint')}
                    control={
                      <Switch
                        checked={routerEnabled}
                        onChange={(v) => {
                          setRouterEnabled(v);
                          try { localStorage.setItem('tlm_router_enabled', String(v)); } catch {}
                        }}
                      />
                    }
                  />
                  {routerEnabled && (
                    <Row
                      label={t('settings.routerMode')}
                      hint={t('settings.routerModeHint')}
                      control={
                        <select
                          value={routerMode}
                          onChange={(e) => {
                            const v = e.target.value as 'auto' | 'fast' | 'deep';
                            setRouterMode(v);
                            try { localStorage.setItem('tlm_router_mode', v); } catch {}
                          }}
                          className={selectCls}
                        >
                          <option value="auto">{t('settings.routerAuto')}</option>
                          <option value="fast">{t('settings.routerFast')}</option>
                          <option value="deep">{t('settings.routerDeep')}</option>
                        </select>
                      }
                    />
                  )}
                  {routerEnabled && (
                    <div className="flex flex-col gap-1.5 py-3.5">
                      <label className={labelCls} htmlFor="settings-deep-model">{t('settings.deepModel')}</label>
                      <input
                        id="settings-deep-model"
                        type="text"
                        list={`model-list-${activeProvider}`}
                        value={deepModels[activeProvider] ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          setDeepModels((prev) => ({ ...prev, [activeProvider]: v }));
                          try { localStorage.setItem('tlm_deep_model_' + activeProvider, v); } catch {}
                        }}
                        placeholder={t('settings.deepModelPlaceholder')}
                        className={inputCls}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <datalist id={`model-list-${activeProvider}`}>
                        {modelChoices(activeProvider).map((m) => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                      </datalist>
                      <p className="text-[11px] text-[#87857F]">{t('settings.deepModelHint')}</p>
                    </div>
                  )}
                </Card>
              </>
            )}

            {/* ── PROFILE ── */}
            {!q && activeSection === 'profile' && (
              !user ? (
                <p className="pt-2 text-[11.5px] leading-relaxed text-[#87857F]">
                  {t('settings.noProfile')}
                </p>
              ) : (
                <Card>
                  <div className="flex items-center gap-4 py-3.5">
                    <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/[0.08] bg-white/[0.03] text-[#87857F]">
                      {avatar ? (
                        <img src={avatar} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <UserRound size={26} />
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/[0.08] px-3 py-1.5 text-[11.5px] text-[#CECDC3] transition-colors hover:border-white/[0.14]">
                          <Upload size={12} />
                          {avatar ? t('settings.changePhoto') : t('settings.uploadPhoto')}
                          <input type="file" accept="image/*" className="hidden" onChange={handleAvatarPick} />
                        </label>
                        {avatar && (
                          <button
                            type="button"
                            onClick={() => setAvatar('')}
                            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/[0.08] px-3 py-1.5 text-[11.5px] text-[#87857F] transition-colors hover:border-rose-600/50 hover:text-rose-300"
                          >
                            <Trash2 size={12} />
                            {t('common.remove')}
                          </button>
                        )}
                      </div>
                      <span className="text-[11px] text-[#87857F]">{t('settings.avatarHint')}</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5 py-3.5">
                    <label className={labelCls} htmlFor="profile-display-name">{t('settings.displayName')}</label>
                    <input
                      id="profile-display-name"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder={t('sidebar.anonymous')}
                      className={inputCls}
                      spellCheck={false}
                    />
                    <span className="text-[11px] text-[#87857F]">{t('settings.displayNameHint')}</span>
                  </div>

                  {user.email && (
                    <div className="py-3.5">
                      <span className="text-[11px] text-[#87857F]">{t('settings.signedInAs', { email: user.email })}</span>
                    </div>
                  )}
                </Card>
              )
            )}

            {/* ── DATA & RESET ── */}
            {!q && activeSection === 'data' && (
              <>
              <Card title={t('settings.card.privacyTitle')} desc={t('settings.card.privacyDesc')}>
                <Row
                  label={t('settings.livePrices')}
                  hint={t('settings.livePricesHint')}
                  control={
                    <Switch
                      checked={livePricing}
                      onChange={(v) => {
                        setLivePricing(v);
                        try { localStorage.setItem('tlm_online_pricing', String(v)); } catch {}
                        persistConfig({ onlinePricing: v });
                      }}
                    />
                  }
                />
              </Card>
              <Card>
                <Row
                  label={t('settings.resetTitle')}
                  hint={t('settings.resetHint')}
                  control={
                    <button
                      type="button"
                      onClick={() => {
                        if (!resetArmed) {
                          setResetArmed(true);
                          setTimeout(() => setResetArmed(false), 4000);
                        } else {
                          handleReset();
                        }
                      }}
                      className={`flex-shrink-0 rounded-md border px-3 py-1.5 text-[11.5px] transition-colors cursor-pointer ${
                        resetArmed
                          ? 'border-rose-600/60 bg-rose-600/15 text-rose-300'
                          : 'border-white/[0.08] text-[#87857F] hover:border-white/[0.14] hover:text-[#CECDC3]'
                      }`}
                    >
                      {resetArmed ? t('settings.resetConfirm') : t('settings.reset')}
                    </button>
                  }
                />
                <Row
                  label={t('settings.clearChats')}
                  hint={t('settings.clearChatsHint')}
                  control={
                    <button
                      type="button"
                      onClick={() => {
                        if (!clearChatsArmed) {
                          setClearChatsArmed(true);
                          setTimeout(() => setClearChatsArmed(false), 4000);
                        } else {
                          handleClearChats();
                        }
                      }}
                      className={`flex-shrink-0 rounded-md border px-3 py-1.5 text-[11.5px] transition-colors cursor-pointer ${
                        clearChatsArmed
                          ? 'border-rose-600/60 bg-rose-600/15 text-rose-300'
                          : 'border-white/[0.08] text-[#87857F] hover:border-white/[0.14] hover:text-[#CECDC3]'
                      }`}
                    >
                      {clearChatsArmed ? t('settings.clearChatsConfirm') : t('settings.clearChats')}
                    </button>
                  }
                />
              </Card>
              </>
            )}
          </div>

          <footer className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-white/[0.06] px-6 py-3">
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[10.5px] text-[#575654]">{t('settings.instantHint')}</span>
              <span
                className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[#575654]/80"
                title={t('settings.versionHint')}
              >
                <span className="font-medium text-[#87857F]">Thalamus</span>
                <span className="tabular-nums">v{__APP_VERSION__}</span>
                <span className="text-[#575654]/60">·</span>
                <span>beta</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={requestClose}
              className="rounded-md border border-white/[0.08] px-3.5 py-1.5 text-[11.5px] text-[#87857F] transition-colors hover:border-white/[0.14] hover:text-[#CECDC3] cursor-pointer"
            >
              {t('common.close')}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!keysLoaded}
              title={keysLoaded ? undefined : t('settings.keysLoadingTitle')}
              className="flex items-center gap-1.5 rounded-md bg-[#3AA99F] px-4 py-1.5 text-[11.5px] font-semibold text-[#071310] transition-colors hover:bg-[#45B8AD] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Save size={12} />
              {keysLoaded ? t('settings.save') : t('settings.save') + '…'}
            </button>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
