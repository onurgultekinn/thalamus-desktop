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
  Keyboard,
  Info,
  Database,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useToast } from './Toast';
import { MODELS, DEFAULT_MODEL_NAME } from '../constants';
import type { User } from '../types';
import {
  API_PROVIDERS,
  type ProviderFamily,
  baseStorageKey,
  providerRequiresKey,
  activeProviderStorageKey,
} from '../lib/providers';
import { getStoredKey, setStoredKey, clearStoredKeys } from '../lib/secrets';
import { getWorkspaceRoot } from '../lib/workspace';
import { explainError } from '../lib/errors';
import { useT, LANGUAGES, getLang, setLang, type TranslationKey } from '../lib/i18n';

export type SettingsTab =
  | 'general'
  | 'appearance'
  | 'editor'
  | 'providers'
  | 'profile'
  | 'shortcuts'
  | 'about'
  | 'data';

const FAMILY_LABEL: Record<ProviderFamily, string> = {
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic',
  local: 'Local',
};

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
    items: [{ id: 'providers', labelKey: 'settings.tab.providers', icon: Server }],
  },
  {
    groupKey: 'settings.group.account',
    items: [{ id: 'profile', labelKey: 'settings.tab.profile', icon: CircleUser }],
  },
  {
    groupKey: 'settings.group.system',
    items: [
      { id: 'shortcuts', labelKey: 'settings.tab.shortcuts', icon: Keyboard },
      { id: 'about', labelKey: 'settings.tab.about', icon: Info },
      { id: 'data', labelKey: 'settings.tab.data', icon: Database },
    ],
  },
];

const ALL_SECTIONS = NAV_GROUPS.flatMap((g) => g.items);
const sectionLabelKey = (id: SettingsTab): TranslationKey =>
  ALL_SECTIONS.find((s) => s.id === id)?.labelKey ?? 'settings.tab.general';

/** Flat index of individual rows so the search box can jump across sections. */
const SEARCH_INDEX: { section: SettingsTab; labelKey: TranslationKey }[] = [
  { section: 'general', labelKey: 'settings.language' },
  { section: 'general', labelKey: 'settings.startupScreen' },
  { section: 'general', labelKey: 'settings.workspaceRoot' },
  { section: 'appearance', labelKey: 'settings.theme' },
  { section: 'editor', labelKey: 'settings.editorFontSize' },
  { section: 'editor', labelKey: 'settings.editorTabSize' },
  { section: 'editor', labelKey: 'settings.lineNumbers' },
  { section: 'providers', labelKey: 'settings.provider' },
  { section: 'providers', labelKey: 'settings.baseUrl' },
  { section: 'providers', labelKey: 'settings.apiKey' },
  { section: 'providers', labelKey: 'settings.defaultModel' },
  { section: 'providers', labelKey: 'settings.livePrices' },
  { section: 'profile', labelKey: 'settings.displayName' },
  { section: 'shortcuts', labelKey: 'settings.card.shortcutsTitle' },
  { section: 'about', labelKey: 'settings.aboutVersion' },
  { section: 'about', labelKey: 'settings.aboutEngine' },
  { section: 'about', labelKey: 'settings.aboutWorkspace' },
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

/** A titled group of rows ("card"), matching the section-card layout. */
function Card({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="mb-4 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-1">
      <div className="pt-3.5">
        <h3 className="text-[12.5px] font-semibold text-[#F2F0E5]">{title}</h3>
        {desc && <p className="mt-0.5 text-[11px] leading-snug text-[#87857F]">{desc}</p>}
      </div>
      <div className="divide-y divide-white/[0.05]">{children}</div>
    </section>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
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

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-white/[0.1] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10.5px] text-[#CECDC3]">
      {children}
    </kbd>
  );
}

const inputCls =
  'w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 font-mono text-[12.5px] text-[#F2F0E5] placeholder-white/20 transition-colors focus:border-[#3AA99F]/60 focus:outline-none';
const selectCls =
  'rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 font-mono text-[12px] text-[#F2F0E5] focus:outline-none cursor-pointer';
const labelCls = 'text-[11.5px] text-[#87857F]';

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

  // Providers
  const [keys, setKeys] = useState<Record<string, string>>({});
  // V4: vault anahtarlari async yuklenir. Yuklenme bitmeden kaydetmek, bos
  // kalan inputlar yuzunden vault'taki anahtarlari SILERDI (yaris kosulu —
  // denetim M10/V4). Save, yukleme bitene kadar kilitli; yukleme hatasinda
  // anahtar yazimi hic yapilmaz (mevcut anahtarlar korunur).
  const [keysLoaded, setKeysLoaded] = useState<boolean>(false);
  const keysStatusRef = useRef<'loading' | 'ok' | 'error'>('loading');
  const loadedKeysRef = useRef<Record<string, string>>({});
  // D10: modalin acilis anindaki tema (Cancel'da geri alinacak deger).
  const themeAtOpenRef = useRef<'dark' | 'nord-red'>('dark');
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});
  const [activeProvider, setActiveProvider] = useState<string>('openai');
  const [visibleProvider, setVisibleProvider] = useState<string | null>(null);

  // Appearance / Editor
  const [fontSize, setFontSize] = useState('13');
  const [tabSize, setTabSize] = useState('4');
  const [lineNumbers, setLineNumbers] = useState(true);
  const [theme, setTheme] = useState<'dark' | 'nord-red'>('dark');

  // General
  const [livePricing, setLivePricing] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [defaultModel, setDefaultModel] = useState<string>(DEFAULT_MODEL_NAME);
  const [startView, setStartView] = useState<'chat' | 'project'>('chat');

  // Profile
  const [displayName, setDisplayName] = useState('');
  const [avatar, setAvatar] = useState('');

  // About
  const [appVersion, setAppVersion] = useState('');
  const [engineReady, setEngineReady] = useState<boolean | null>(null);
  const [workspaceInfo, setWorkspaceInfo] = useState<{ name: string; file_count: number } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // V4: her açılışta anahtar yükleme durumu sıfırlanır; Save yüklenene kadar kilitli.
    keysStatusRef.current = 'loading';
    setKeysLoaded(false);
    loadedKeysRef.current = {};
    // Keys are read asynchronously from the OS vault (desktop) or localStorage
    // (browser); legacy localStorage entries in the vault are migrated automatically.
    Promise.all(API_PROVIDERS.map(async (p) => [p.id, await getStoredKey(p.id)] as const))
      .then((entries) => {
        if (cancelled) return;
        const map = Object.fromEntries(entries);
        setKeys(map);
        loadedKeysRef.current = map;
        keysStatusRef.current = 'ok';
        setKeysLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        // Anahtarlar okunamadı: inputlar BOŞ kalır ama bu "sil" demek değildir.
        keysStatusRef.current = 'error';
        setKeysLoaded(true);
        showToast('Key Load Failed', 'Stored API keys could not be read. Saving will NOT touch them. Restart the app if this repeats — the vault may be locked.', 'error', undefined, '[500] secrets vault read failed');
      });
    const loadedBases: Record<string, string> = {};
    for (const p of API_PROVIDERS) {
      loadedBases[p.id] = localStorage.getItem(baseStorageKey(p.id)) || p.defaultBaseUrl || '';
    }
    setBaseUrls(loadedBases);
    setLivePricing(localStorage.getItem('tlm_online_pricing') === 'true');
    const loadedTheme = (localStorage.getItem('tlm_theme') as 'dark' | 'nord-red') || 'dark';
    themeAtOpenRef.current = loadedTheme;
    setTheme(loadedTheme);
    setDefaultModel(localStorage.getItem('tlm_default_model') || DEFAULT_MODEL_NAME);
    setStartView(localStorage.getItem('tlm_start_view') === 'project' ? 'project' : 'chat');
    setActiveProvider(localStorage.getItem(activeProviderStorageKey) || 'openai');
    setResetArmed(false);
    setClearChatsArmed(false);
    setQuery('');
    setDisplayName(user?.name || '');
    setAvatar(user?.avatar || '');

    try {
      const cfg = JSON.parse(localStorage.getItem('thalamus_config') || '{}');
      if (cfg.appearance?.fontSize) setFontSize(cfg.appearance.fontSize.replace('px', ''));
      if (cfg.appearance?.tabSize) setTabSize(String(cfg.appearance.tabSize));
      if (cfg.appearance?.showLineNumbers !== undefined) setLineNumbers(cfg.appearance.showLineNumbers);
      if (typeof cfg.workspace_root === 'string') setWorkspaceRoot(cfg.workspace_root);
    } catch {}

    // Keep the workspace field in sync with the backend's actual root.
    invoke<{ root: string; name: string; file_count: number }>('get_workspace_info')
      .then((info) => {
        if (cancelled) return;
        if (info?.root) setWorkspaceRoot(info.root);
        if (info?.root) setWorkspaceInfo({ name: info.name, file_count: info.file_count });
      })
      .catch(() => {});

    // About: version + engine status (both honest — never assumed ready).
    getVersion().then((v) => { if (!cancelled) setAppVersion(v); }).catch(() => {});
    invoke<{ is_ready: boolean }>('thalamus_get_engine_status')
      .then((s) => { if (!cancelled) setEngineReady(!!s?.is_ready); })
      .catch(() => { if (!cancelled) setEngineReady(null); });

    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => setActiveSection(initialTab), [initialTab]);

  // D10: tema düğmesi anlık önizleme uygular; kaydetmeden kapatırken (Cancel,
  // X, overlay) modalin AÇILIŞTAKİ temasına dönülür. Cancel gerçekten iptal.
  const requestClose = useCallback(() => {
    if (theme !== themeAtOpenRef.current) {
      setTheme(themeAtOpenRef.current);
      try { localStorage.setItem('tlm_theme', themeAtOpenRef.current); } catch {}
      const el = document.documentElement;
      if (themeAtOpenRef.current === 'nord-red') el.setAttribute('data-theme', 'nord-red');
      else el.removeAttribute('data-theme');
    }
    onClose();
  }, [theme, onClose]);

  // Esc closes the dialog (same semantics as the X button).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, requestClose]);

  if (!isOpen) return null;

  const p = API_PROVIDERS.find((x) => x.id === activeProvider) || API_PROVIDERS[0];
  // Yalnız KULLANILABILIR sağlayıcılar sayılır: "coming soon" (ör. Anthropic)
  // listelenir ama anahtarı olsa bile kullanılamaz — sayıma katmak yanıltıcıydı.
  const availableProviders = API_PROVIDERS.filter((x) => x.available !== false);
  const configuredCount = availableProviders.filter((x) => !!(keys[x.id] || '').trim()).length;

  /**
   * Ayar değişikliğini ANINDA kalıcılaştırır ve uygular (Kaydet beklenmez).
   * Görünüm ayarları 'thalamus_config' + 'thalamus_config_changed' ile
   * ProjectDashboard'a, model/fiyatlandırma aynı olayla App'e iletilir.
   */
  const persistConfig = (
    patch: Partial<{ fontSize: string; tabSize: string; lineNumbers: boolean; onlinePricing: boolean }> = {}
  ) => {
    const cfg = {
      appearance: {
        fontSize: `${patch.fontSize ?? fontSize}px`,
        tabSize: Number(patch.tabSize ?? tabSize),
        showLineNumbers: patch.lineNumbers ?? lineNumbers,
      },
      onlinePricing: patch.onlinePricing ?? livePricing,
      workspace_root: getWorkspaceRoot() ?? '',
    };
    try { localStorage.setItem('thalamus_config', JSON.stringify(cfg)); } catch {}
    window.dispatchEvent(new Event('thalamus_config_changed'));
  };

  /** Applies a theme immediately (live preview) so the dialog itself restyles. */
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
      showToast('Invalid file', 'Please choose an image file (PNG, JPG, WEBP or GIF).', 'error', undefined, '[400] wrong file type');
      return;
    }
    try {
      setAvatar(await fileToAvatarDataUrl(file));
    } catch {
      showToast('Could not read image', 'The selected file could not be processed — it may be corrupt or in an unsupported format. Try another image.', 'error', undefined, '[400] image decode failed');
    }
  }

  async function handleSave() {
    // V4: anahtarlar henuz yuklenmediyse kaydetme anahtarlara DOKUNMAZ —
    // bos input yuzunden vault silinmesi (V4 yaris kosulu) artik imkansiz.
    if (keysStatusRef.current === 'loading') {
      showToast('Not Ready', 'API keys are still loading from the vault — try again in a moment.', 'info');
      return;
    }
    if (keysStatusRef.current === 'ok') {
      // Yalnizca kullaniciyi gercekten degistirdigi anahtarlari yaz.
      const changed = API_PROVIDERS.filter(
        (p) => (keys[p.id] || '').trim() !== (loadedKeysRef.current[p.id] || '').trim()
      );
      const removed = changed.filter((p) => !(keys[p.id] || '').trim());
      if (removed.length > 0) {
        const names = removed.map((p) => p.name).join(', ');
        if (!window.confirm(`Remove the stored API key(s) for ${names}? Existing keys stay unless you confirm.`)) {
          return;
        }
      }
      await Promise.all(changed.map((p) => setStoredKey(p.id, (keys[p.id] || '').trim())));
    }
    localStorage.setItem(activeProviderStorageKey, activeProvider);

    for (const provider of API_PROVIDERS) {
      if (provider.needsBaseUrl) {
        const b = (baseUrls[provider.id] || '').trim();
        if (b) localStorage.setItem(baseStorageKey(provider.id), b);
        else localStorage.removeItem(baseStorageKey(provider.id));
      }
    }

    localStorage.setItem('tlm_online_pricing', String(livePricing));
    localStorage.setItem('tlm_theme', theme);
    localStorage.setItem('tlm_default_model', defaultModel);
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
        showToast('Workspace Error', `"${workspaceRoot.trim()}" is not a valid folder — the previous workspace is kept. ${x.explanation}`, 'error', undefined, `[${x.code}] ${x.detail ?? String(e)}]`);
      }
    }

    const config = {
      appearance: {
        fontSize: `${fontSize}px`,
        showLineNumbers: lineNumbers,
        tabSize: Number(tabSize),
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

    showToast('Saved', 'Settings applied.', 'success');
    onSaved?.();
    // Editor ayağı (ProjectDashboard) fontSize/tabSize'ı anında alabilsin diye
    // config değişti bilgisini yay (remount beklemeden uygulanır).
    window.dispatchEvent(new Event('thalamus_config_changed'));
  }

  /** Clears stored keys + preferences; chats and files are kept. */
  async function handleReset() {
    await clearStoredKeys(API_PROVIDERS.map((p) => p.id));
    // Backend config dosyası da silinir; yoksa workspace_root %APPDATA'da
    // kalıp bir sonraki açılışta "sıfırlandı" denen ayarı geri getirir.
    try {
      await invoke('reset_app_config');
    } catch (e) {
      showToast('Reset Incomplete', 'Preferences were cleared but the backend config file could not be removed — it will be restored on next start.', 'error', undefined, `[500] ${String(e)}`);
    }
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('tlm_')) localStorage.removeItem(key);
    }
    localStorage.removeItem('thalamus_config');
    showToast('Settings reset', 'API keys and preferences cleared. Chats were kept.', 'info');
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
              <span className="mt-0.5 text-[11px] leading-snug text-[#87857F]">
                {q ? t('settings.searchEmpty', { query: query.trim() }) : t('settings.subtitle')}
              </span>
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label="Close settings"
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
              <>
                <Card title={t('settings.card.langTitle')} desc={t('settings.card.langDesc')}>
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
                </Card>

                <Card title={t('settings.startupScreen')} desc={t('settings.card.startupDesc')}>
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

                <Card title={t('settings.workspaceRoot')} desc={t('settings.card.workspaceDesc')}>
                  <div className="flex flex-col gap-1.5 py-3.5">
                    <label className={labelCls} htmlFor="settings-workspace">{t('settings.workspaceRoot')}</label>
                    <input
                      id="settings-workspace"
                      type="text"
                      value={workspaceRoot}
                      onChange={(e) => setWorkspaceRoot(e.target.value)}
                      placeholder="C:/projects/my-app"
                      className={inputCls}
                    />
                    <p className="text-[11px] text-[#87857F]">{t('settings.workspaceRootHint')}</p>
                  </div>
                </Card>
              </>
            )}

            {/* ── APPEARANCE ── */}
            {!q && activeSection === 'appearance' && (
              <Card title={t('settings.card.interfaceTitle')} desc={t('settings.card.interfaceDesc')}>
                <Row
                  label={t('settings.theme')}
                  control={
                    <Segmented
                      value={theme}
                      onChange={previewTheme}
                      options={[
                        { value: 'dark', label: 'Obsidian' },
                        { value: 'nord-red', label: 'Nord Red' },
                      ]}
                    />
                  }
                />
              </Card>
            )}

            {/* ── EDITOR ── */}
            {!q && activeSection === 'editor' && (
              <Card title={t('settings.card.codeTitle')} desc={t('settings.card.codeDesc')}>
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
                        <option key={s} value={s}>{s} spaces</option>
                      ))}
                    </select>
                  }
                />
                <Row
                  label={t('settings.lineNumbers')}
                  control={<Switch checked={lineNumbers} onChange={(v) => { setLineNumbers(v); persistConfig({ lineNumbers: v }); }} />}
                />
              </Card>
            )}

            {/* ── PROVIDERS ── */}
            {!q && activeSection === 'providers' && (
              <>
                <Card title={t('settings.card.connectionTitle')} desc={t('settings.card.connectionDesc')}>
                  <div className="flex flex-col gap-1.5 py-3.5">
                    <label className={labelCls}>{t('settings.provider')}</label>
                    <select
                      value={activeProvider}
                      onChange={(e) => {
                        // Unavailable providers (e.g. Anthropic until the proxy
                        // speaks /v1/messages) must not be selected — silently
                        // ignoring the change keeps the previous choice intact.
                        const target = API_PROVIDERS.find((x) => x.id === e.target.value);
                        if (target && target.available === false) return;
                        setActiveProvider(e.target.value);
                        setVisibleProvider(null);
                      }}
                      className={selectCls}
                    >
                      {API_PROVIDERS.map((x) => (
                        <option key={x.id} value={x.id} disabled={x.available === false}>
                          {x.name}
                          {x.available === false ? t('settings.comingSoon') : ` — ${FAMILY_LABEL[x.family]}`}
                        </option>
                      ))}
                    </select>
                    {p.available === false && (
                      <p className="text-[11px] text-amber-300/90">{t('settings.providerNotWired', { name: p.name })}</p>
                    )}
                    <p className="text-[11px] text-[#87857F]">
                      {t('settings.keyCount', { configured: configuredCount, total: availableProviders.length })}
                    </p>
                  </div>

                  {p.needsBaseUrl && (
                    <div className="flex flex-col gap-1.5 py-3.5">
                      <label className={labelCls}>{t('settings.baseUrl')}</label>
                      <input
                        type="text"
                        value={baseUrls[p.id] || ''}
                        onChange={(e) => setBaseUrls((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        placeholder={p.defaultBaseUrl || 'http://localhost:8000/v1'}
                        className={inputCls}
                        spellCheck={false}
                      />
                    </div>
                  )}

                  <div className="flex flex-col gap-1.5 py-3.5">
                    <label className={labelCls}>
                      {providerRequiresKey(p) ? t('settings.apiKey') : t('settings.apiKeyOptional')}
                    </label>
                    <div className="relative">
                      <input
                        type={visibleProvider === p.id ? 'text' : 'password'}
                        value={keys[p.id] || ''}
                        onChange={(e) => setKeys((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        placeholder={p.keyPlaceholder}
                        className={inputCls}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        onClick={() => setVisibleProvider(visibleProvider === p.id ? null : p.id)}
                        aria-label={visibleProvider === p.id ? t('settings.hideKey') : t('settings.showKey')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[#575654] transition-colors hover:text-[#CECDC3] cursor-pointer"
                        tabIndex={-1}
                      >
                        {visibleProvider === p.id ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    </div>
                    {p.docsUrl && (
                      <a
                        href={p.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="self-start text-[11.5px] text-[#3AA99F] hover:underline"
                      >
                        Get an API key →
                      </a>
                    )}
                  </div>
                </Card>

                <Card title={t('settings.card.modelsTitle')} desc={t('settings.card.modelsDesc')}>
                  <Row
                    label={t('settings.defaultModel')}
                    hint={t('settings.defaultModelHint')}
                    control={
                      <select
                        value={defaultModel}
                        onChange={(e) => {
                          const v = e.target.value;
                          setDefaultModel(v);
                          try { localStorage.setItem('tlm_default_model', v); } catch {}
                          window.dispatchEvent(new Event('thalamus_config_changed'));
                        }}
                        className={selectCls}
                      >
                        {MODELS.map((m) => (
                          <option key={m.id} value={m.name}>{m.name}</option>
                        ))}
                      </select>
                    }
                  />
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
              </>
            )}

            {/* ── PROFILE ── */}
            {!q && activeSection === 'profile' && (
              !user ? (
                <p className="pt-2 text-[11.5px] leading-relaxed text-[#87857F]">
                  Sign in with a local profile to edit your name and photo here.
                </p>
              ) : (
                <Card title={t('settings.card.identityTitle')} desc={t('settings.card.identityDesc')}>
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
                          {avatar ? 'Change photo' : 'Upload photo'}
                          <input type="file" accept="image/*" className="hidden" onChange={handleAvatarPick} />
                        </label>
                        {avatar && (
                          <button
                            type="button"
                            onClick={() => setAvatar('')}
                            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/[0.08] px-3 py-1.5 text-[11.5px] text-[#87857F] transition-colors hover:border-rose-600/50 hover:text-rose-300"
                          >
                            <Trash2 size={12} />
                            Remove
                          </button>
                        )}
                      </div>
                      <span className="text-[11px] text-[#87857F]">Square JPG or PNG. Stored locally on this device.</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5 py-3.5">
                    <label className={labelCls} htmlFor="profile-display-name">{t('settings.displayName')}</label>
                    <input
                      id="profile-display-name"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Anonymous User"
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

            {/* ── SHORTCUTS ── */}
            {!q && activeSection === 'shortcuts' && (
              <Card title={t('settings.card.shortcutsTitle')} desc={t('settings.card.shortcutsDesc')}>
                <Row label={t('settings.shortcut.send')} control={<Kbd>Enter</Kbd>} />
                <Row label={t('settings.shortcut.newline')} control={<Kbd>Shift</Kbd>} />
                <Row label={t('settings.shortcut.save')} control={<Kbd>Ctrl + S</Kbd>} />
                <Row label={t('settings.shortcut.run')} control={<Kbd>Ctrl + R</Kbd>} />
                <Row label={t('settings.shortcut.close')} control={<Kbd>Esc</Kbd>} />
              </Card>
            )}

            {/* ── ABOUT ── */}
            {!q && activeSection === 'about' && (
              <Card title={t('settings.card.aboutTitle')} desc={t('settings.card.aboutDesc')}>
                <Row label={t('settings.aboutVersion')} control={<span className="font-mono text-[12px] text-[#CECDC3]">{appVersion || '—'}</span>} />
                <Row
                  label={t('settings.aboutEngine')}
                  control={
                    <span className={`text-[12px] ${engineReady ? 'text-emerald-400' : 'text-[#87857F]'}`}>
                      {engineReady === null
                        ? '—'
                        : engineReady
                          ? t('settings.aboutEngineReady')
                          : t('settings.aboutEngineOffline')}
                    </span>
                  }
                />
                <Row
                  label={t('settings.aboutWorkspace')}
                  control={
                    <span className="max-w-[320px] truncate text-right text-[12px] text-[#CECDC3]">
                      {workspaceInfo
                        ? `${workspaceInfo.name} · ${t('settings.aboutFiles', { n: workspaceInfo.file_count })}`
                        : t('settings.aboutNoWorkspace')}
                    </span>
                  }
                />
              </Card>
            )}

            {/* ── DATA & RESET ── */}
            {!q && activeSection === 'data' && (
              <>
                <Card title={t('settings.resetTitle')} desc={t('settings.resetHint')}>
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
                </Card>

                <Card title={t('settings.clearChats')} desc={t('settings.clearChatsHint')}>
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

          <footer className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-white/[0.06] px-6 py-3">
            <button
              type="button"
              onClick={requestClose}
              className="rounded-md border border-white/[0.08] px-3.5 py-1.5 text-[11.5px] text-[#87857F] transition-colors hover:border-white/[0.14] hover:text-[#CECDC3] cursor-pointer"
            >
              {t('settings.cancel')}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!keysLoaded}
              title={keysLoaded ? undefined : 'API keys are still loading from the vault…'}
              className="flex items-center gap-1.5 rounded-md bg-[#3AA99F] px-4 py-1.5 text-[11.5px] font-semibold text-[#071310] transition-colors hover:bg-[#45B8AD] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Save size={12} />
              {keysLoaded ? t('settings.save') : t('settings.save') + '…'}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
