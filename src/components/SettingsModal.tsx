import { useState, useEffect, useRef, type ReactNode, type ChangeEvent } from 'react';
import { X, Eye, EyeOff, Save, UserRound, Upload, Trash2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
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

export type SettingsTab = 'profile' | 'providers' | 'appearance' | 'general';

const FAMILY_LABEL: Record<ProviderFamily, string> = {
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic',
  local: 'Local',
};

/** A plain settings row: label on the left, control on the right. */
function Row({
  label,
  hint,
  control,
}: {
  label: string;
  hint?: string;
  control: ReactNode;
}) {
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

const inputCls =
  'w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 font-mono text-[12.5px] text-[#F2F0E5] placeholder-white/20 transition-colors focus:border-[#3AA99F]/60 focus:outline-none';
const selectCls =
  'rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 font-mono text-[12px] text-[#F2F0E5] focus:outline-none cursor-pointer';
const labelCls = 'text-[11.5px] text-[#87857F]';

const SECTIONS: { id: SettingsTab; labelKey: TranslationKey }[] = [
  { id: 'profile',    labelKey: 'settings.tab.profile' },
  { id: 'providers',  labelKey: 'settings.tab.providers' },
  { id: 'appearance', labelKey: 'settings.tab.appearance' },
  { id: 'general',    labelKey: 'settings.tab.general' },
];

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

  // Appearance
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
    invoke<{ root: string }>('get_workspace_info')
      .then(info => {
        if (info?.root) setWorkspaceRoot(info.root);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => setActiveSection(initialTab), [initialTab]);

  if (!isOpen) return null;

  const p = API_PROVIDERS.find(x => x.id === activeProvider) || API_PROVIDERS[0];
  // Yalnız KULLANILABILIR sağlayıcılar sayılır: "coming soon" (ör. Anthropic)
  // listelenir ama anahtarı olsa bile kullanılamaz — sayıma katmak yanıltıcıydı.
  const availableProviders = API_PROVIDERS.filter(x => x.available !== false);
  const configuredCount = availableProviders.filter(x => !!(keys[x.id] || '').trim()).length;

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
        p => (keys[p.id] || '').trim() !== (loadedKeysRef.current[p.id] || '').trim()
      );
      const removed = changed.filter(p => !(keys[p.id] || '').trim());
      if (removed.length > 0) {
        const names = removed.map(p => p.name).join(', ');
        if (!window.confirm(`Remove the stored API key(s) for ${names}? Existing keys stay unless you confirm.`)) {
          return;
        }
      }
      await Promise.all(
        changed.map(p => setStoredKey(p.id, (keys[p.id] || '').trim()))
      );
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

  const section = SECTIONS.find(s => s.id === activeSection) || SECTIONS[0];

  // D10: tema dügmesi anlik onizleme uygular; kaydetmeden kapatirken (Cancel,
  // X, overlay) modalin ACILISTAKI temasina donulur. Cancel gercekten iptal.
  // (themeAtOpenRef hook kurali geregi diğer hook'larla birlikte tepede.)
  const requestClose = () => {
    if (theme !== themeAtOpenRef.current) {
      setTheme(themeAtOpenRef.current);
      try { localStorage.setItem('tlm_theme', themeAtOpenRef.current); } catch {}
      const el = document.documentElement;
      if (themeAtOpenRef.current === 'nord-red') el.setAttribute('data-theme', 'nord-red');
      else el.removeAttribute('data-theme');
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="absolute inset-0" onClick={requestClose} />

      <div className="relative flex h-[560px] w-[680px] max-w-[94vw] overflow-hidden rounded-lg border border-white/[0.08] bg-[#100F0F] shadow-2xl font-sans text-xs">

        {/* left: section list */}
        <aside className="flex w-[168px] flex-shrink-0 flex-col border-r border-white/[0.06] bg-[#100F0F] p-2">
          {SECTIONS.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveSection(s.id)}
              className={`rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors cursor-pointer ${
                activeSection === s.id
                  ? 'bg-white/[0.06] text-[#F2F0E5]'
                  : 'text-[#87857F] hover:bg-white/[0.03] hover:text-[#CECDC3]'
              }`}
            >
              {t(s.labelKey)}
            </button>
          ))}
        </aside>

        {/* right: content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex flex-shrink-0 items-center justify-between px-6 pb-3 pt-5">
            <span className="text-[14px] font-semibold tracking-tight text-[#F2F0E5]">{t(section.labelKey)}</span>
            <button
              type="button"
              onClick={requestClose}
              aria-label="Close settings"
              className="flex h-6 w-6 items-center justify-center rounded text-[#575654] transition-colors hover:bg-white/[0.06] hover:text-[#CECDC3] cursor-pointer"
            >
              <X size={14} />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-6 pb-5 pretty-scrollbar">
            {/* ── PROFILE ── */}
            {activeSection === 'profile' && (
              !user ? (
                <p className="text-[11.5px] leading-relaxed text-[#87857F]">
                  Sign in with a local profile to edit your name and photo here.
                </p>
              ) : (
                <div className="flex flex-col gap-5">
                  <div className="flex items-center gap-4">
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

                  <div className="flex flex-col gap-1.5">
                    <label className={labelCls} htmlFor="profile-display-name">Display name</label>
                    <input
                      id="profile-display-name"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Anonymous User"
                      className={inputCls}
                      spellCheck={false}
                    />
                    <span className="text-[11px] text-[#87857F]">Shown in the sidebar and on your messages.</span>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className={labelCls} htmlFor="profile-email">Email</label>
                    <input
                      id="profile-email"
                      type="text"
                      value={user.email || ''}
                      readOnly
                      className={`${inputCls} cursor-not-allowed opacity-60`}
                    />
                    <span className="text-[11px] text-[#87857F]">Part of your local profile; it cannot be changed here.</span>
                  </div>
                </div>
              )
            )}

            {/* ── PROVIDERS ── */}
            {activeSection === 'providers' && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className={labelCls}>Provider</label>
                  <select
                    value={activeProvider}
                    onChange={e => {
                      // Unavailable providers (e.g. Anthropic until the proxy
                      // speaks /v1/messages) must not be selected — silently
                      // ignoring the change keeps the previous choice intact.
                      const target = API_PROVIDERS.find(x => x.id === e.target.value);
                      if (target && target.available === false) return;
                      setActiveProvider(e.target.value);
                      setVisibleProvider(null);
                    }}
                    className={selectCls}
                  >
                    {API_PROVIDERS.map(x => (
                      <option key={x.id} value={x.id} disabled={x.available === false}>
                        {x.name}
                        {x.available === false ? ' — coming soon' : ` — ${FAMILY_LABEL[x.family]}`}
                      </option>
                    ))}
                  </select>
                  {p.available === false && (
                    <p className="text-[11px] text-amber-300/90">
                      {p.name} is listed but not wired yet: the local proxy only speaks the OpenAI chat/completions format. Choose an OpenAI-compatible provider until then.
                    </p>
                  )}
                  <p className="text-[11px] text-[#87857F]">
                    {configuredCount} of {availableProviders.length} providers have a key saved. Keys are stored in the OS credential vault — never in plain text.
                  </p>
                </div>

                {p.needsBaseUrl && (
                  <div className="flex flex-col gap-1.5">
                    <label className={labelCls}>Base URL</label>
                    <input
                      type="text"
                      value={baseUrls[p.id] || ''}
                      onChange={e => setBaseUrls(prev => ({ ...prev, [p.id]: e.target.value }))}
                      placeholder={p.defaultBaseUrl || 'http://localhost:8000/v1'}
                      className={inputCls}
                      spellCheck={false}
                    />
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <label className={labelCls}>
                    API key{providerRequiresKey(p) ? '' : ' — optional for local'}
                  </label>
                  <div className="relative">
                    <input
                      type={visibleProvider === p.id ? 'text' : 'password'}
                      value={keys[p.id] || ''}
                      onChange={e => setKeys(prev => ({ ...prev, [p.id]: e.target.value }))}
                      placeholder={p.keyPlaceholder}
                      className={inputCls}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      onClick={() => setVisibleProvider(visibleProvider === p.id ? null : p.id)}
                      aria-label={visibleProvider === p.id ? 'Hide API key' : 'Show API key'}
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
              </div>
            )}

            {/* ── APPEARANCE ── */}
            {activeSection === 'appearance' && (
              <div className="divide-y divide-white/[0.05]">
                <Row label="Theme" control={
                  <div className="flex gap-1">
                    {(['dark', 'nord-red'] as const).map(t => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => {
                          setTheme(t);
                          localStorage.setItem('tlm_theme', t);
                          const el = document.documentElement;
                          if (t === 'nord-red') el.setAttribute('data-theme', 'nord-red');
                          else el.removeAttribute('data-theme');
                        }}
                        className={`rounded-md border px-3 py-1.5 text-[11.5px] transition-colors cursor-pointer ${
                          theme === t
                            ? 'border-white/[0.12] bg-white/[0.07] text-[#F2F0E5]'
                            : 'border-white/[0.07] bg-transparent text-[#87857F] hover:text-[#CECDC3]'
                        }`}
                      >
                        {t === 'dark' ? 'Obsidian' : 'Nord Red'}
                      </button>
                    ))}
                  </div>
                } />
                <Row label="Editor font size" control={
                  <select value={fontSize} onChange={e => setFontSize(e.target.value)} className={selectCls}>
                    {['11','12','13','14','15','16'].map(s => (
                      <option key={s} value={s}>{s}px</option>
                    ))}
                  </select>
                } />
                <Row label="Editor tab size" control={
                  <select value={tabSize} onChange={e => setTabSize(e.target.value)} className={selectCls}>
                    {['2','4','8'].map(s => (
                      <option key={s} value={s}>{s} spaces</option>
                    ))}
                  </select>
                } />
                <Row label="Line numbers" control={
                  <Switch checked={lineNumbers} onChange={setLineNumbers} />
                } />
              </div>
            )}

            {/* ── GENERAL ── */}
            {activeSection === 'general' && (
              <div className="flex flex-col gap-5">
                <Row
                  label={t('settings.language')}
                  hint={t('settings.languageHint')}
                  control={
                    <select
                      value={getLang()}
                      onChange={e => setLang(e.target.value === 'tr' ? 'tr' : 'en')}
                      className={selectCls}
                    >
                      {LANGUAGES.map(l => (
                        <option key={l.id} value={l.id}>{l.label}</option>
                      ))}
                    </select>
                  }
                />

                <div className="flex flex-col gap-1.5">
                  <label className={labelCls}>{t('settings.workspaceRoot')}</label>
                  <input
                    type="text"
                    value={workspaceRoot}
                    onChange={e => setWorkspaceRoot(e.target.value)}
                    placeholder="C:/projects/my-app"
                    className={inputCls}
                  />
                  <p className="text-[11px] text-[#87857F]">{t('settings.workspaceRootHint')}</p>
                </div>

                <div className="divide-y divide-white/[0.05]">
                  <Row
                    label={t('settings.defaultModel')}
                    hint={t('settings.defaultModelHint')}
                    control={
                      <select
                        value={defaultModel}
                        onChange={e => setDefaultModel(e.target.value)}
                        className={selectCls}
                      >
                        {MODELS.map(m => (
                          <option key={m.id} value={m.name}>{m.name}</option>
                        ))}
                      </select>
                    }
                  />
                  <Row
                    label="Startup screen"
                    hint="What opens when you launch the app."
                    control={
                      <div className="flex gap-1">
                        {(['chat', 'project'] as const).map(v => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => setStartView(v)}
                            className={`rounded-md border px-3 py-1.5 text-[11.5px] transition-colors cursor-pointer ${
                              startView === v
                                ? 'border-white/[0.12] bg-white/[0.07] text-[#F2F0E5]'
                                : 'border-white/[0.07] bg-transparent text-[#87857F] hover:text-[#CECDC3]'
                            }`}
                          >
                            {v === 'chat' ? 'Chat' : 'Project'}
                          </button>
                        ))}
                      </div>
                    }
                  />
                  <Row
                    label="Live prices"
                    hint="Show up-to-date per-token costs from the public registry."
                    control={<Switch checked={livePricing} onChange={setLivePricing} />}
                  />
                </div>

                <div className="flex items-center justify-between border-t border-white/[0.05] pt-4">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[12.5px] text-[#CECDC3]">Reset settings</span>
                    <span className="text-[11px] leading-snug text-[#87857F]">
                      Clears saved keys and preferences. Chats and files are kept.
                    </span>
                  </div>
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
                    {resetArmed ? 'Confirm reset' : 'Reset'}
                  </button>
                </div>
              </div>
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
