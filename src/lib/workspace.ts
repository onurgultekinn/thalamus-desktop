import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { t } from './i18n';

export interface WorkspaceInfo {
  root: string;
  name: string;
  file_count: number;
}

const CONFIG_KEY = 'thalamus_config';

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
  } catch {
    return {};
  }
}

export function getWorkspaceRoot(): string | null {
  const cfg = readConfig();
  return typeof cfg.workspace_root === 'string' && cfg.workspace_root ? cfg.workspace_root : null;
}

export function getWorkspaceName(): string {
  const root = getWorkspaceRoot();
  if (root) {
    const parts = root.split(/[\\/]/).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return 'workspace';
}

export function saveWorkspaceRoot(root: string): void {
  const cfg = readConfig();
  cfg.workspace_root = root;
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

export async function fetchWorkspaceInfo(): Promise<WorkspaceInfo | null> {
  try {
    const info = await invoke<WorkspaceInfo>('get_workspace_info');
    return info;
  } catch {
    return null;
  }
}

export async function applyWorkspaceRoot(path: string): Promise<WorkspaceInfo | null> {
  try {
    const info = await invoke<WorkspaceInfo>('set_workspace_root', { path });
    saveWorkspaceRoot(info.root);
    return info;
  } catch {
    return null;
  }
}

// --- Recent projects -------------------------------------------------------
// The desktop backend keeps a single active workspace root, so "projects" are
// the folders the user has opened before. The list is kept locally and sorted
// by most recently opened.

const RECENT_KEY = 'tlm_recent_projects';
const RECENT_MAX = 8;

export interface RecentProject {
  root: string;
  name: string;
  openedAt: number;
}

export function projectNameFromRoot(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : root;
}

export function listRecentProjects(): RecentProject[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p): p is RecentProject => !!p && typeof p.root === 'string')
      .map((p) => ({
        root: p.root,
        name: p.name || projectNameFromRoot(p.root),
        openedAt: typeof p.openedAt === 'number' ? p.openedAt : 0,
      }))
      .sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

/** Moves a project to the top of the recent list (creating it if needed). */
export function rememberProject(root: string, name?: string): RecentProject[] {
  if (!root) return listRecentProjects();
  const next: RecentProject[] = [
    { root, name: name || projectNameFromRoot(root), openedAt: Date.now() },
    ...listRecentProjects().filter((p) => p.root !== root),
  ].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
  return next;
}

/**
 * C9: son kullanilanlardan artik diskte olmayan klasorleri duser.
 * Denetim yapilamiyorsa (tarayici, komut hatasi) YANLISLIKLA hicbir sey
 * silinmez — liste aynen doner.
 */
export async function pruneRecentProjects(): Promise<RecentProject[]> {
  const list = listRecentProjects();
  if (!inTauriDesktop() || list.length === 0) return list;
  const alive = await Promise.all(
    list.map(async (p) => {
      try {
        return (await invoke<boolean>('path_is_dir', { path: p.root })) ? p : null;
      } catch {
        return p; // denetlenemedi -> silme
      }
    })
  );
  const kept = alive.filter((p): p is RecentProject => p !== null);
  if (kept.length !== list.length) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(kept)); } catch {}
  }
  return kept;
}

export function forgetProject(root: string): RecentProject[] {
  const next = listRecentProjects().filter((p) => p.root !== root);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
  return next;
}

export interface OpenProjectResult {
  ok: boolean;
  /** Hata mesajı (yalnızca masaüstünde backend reddettiyse gerçek hatadır). */
  error?: string;
  /** Gerçekten uygulanmış kök (başarıda). */
  root?: string;
}

function inTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Opens the OS-native folder picker (desktop only) so the user selects a
 * project folder instead of typing a path. Returns the chosen absolute path,
 * or null when cancelled or when no native picker is available (browser preview).
 */
export async function pickFolder(title?: string): Promise<string | null> {
  if (!inTauriDesktop()) return null;
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === 'string' ? selected : null;
}

/**
 * Opens the OS-native file picker (desktop only) so the user can attach one or
 * more files by path. Returns absolute paths ([] on cancel / browser preview).
 */
export async function pickFiles(title?: string): Promise<string[]> {
  if (!inTauriDesktop()) return [];
  const selected = await open({ directory: false, multiple: true, title });
  if (Array.isArray(selected)) return selected;
  if (typeof selected === 'string') return [selected];
  return [];
}

/**
 * Seçilen dosyaların İÇERİĞİNİ okur (yol listesi modele yetmiyordu).
 * Backend `thalamus_read_file` workspace köküne sınırlıdır ve 200 KB üstünü
 * reddeder; burada dosya başına en fazla `perFileChars` alınır, toplam
 * `totalChars` ile sınırlanır (token bütçesi). Okunamayan dosya sessizce
 * atlanmaz — sonuçta `error` alanıyla döner ki arayüz dürüstçe göstersin.
 */
export interface AttachedFileContent {
  name: string;
  body: string;
  truncated: boolean;
  error?: string;
}

export async function readAttachedFiles(
  paths: string[],
  opts: { perFileChars?: number; totalChars?: number } = {}
): Promise<AttachedFileContent[]> {
  const perFile = opts.perFileChars ?? 60_000;
  const total = opts.totalChars ?? 180_000;
  const out: AttachedFileContent[] = [];
  let used = 0;
  for (const path of paths) {
    const name = path.replace(/\\/g, '/').split('/').pop() || path;
    try {
      if (!inTauriDesktop()) {
        out.push({ name, body: '', truncated: false, error: 'file reading needs the desktop app' });
        continue;
      }
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<string>('thalamus_read_file', { path });
      const budget = Math.max(0, Math.min(perFile, total - used));
      if (budget <= 0) {
        out.push({ name, body: '', truncated: true, error: 'attachment budget exhausted' });
        continue;
      }
      let text = raw;
      let truncated = false;
      if (text.length > budget) {
        // Sondan da pay bırak (dosya sonundaki export/main kaybolmasın).
        const head = Math.floor(budget * 0.7);
        const tail = budget - head;
        text =
          text.slice(0, head) +
          `\n\n[... ${(raw.length - budget).toLocaleString()} chars omitted ...]\n\n` +
          text.slice(raw.length - tail);
        truncated = true;
      }
      used += text.length;
      out.push({ name, body: text, truncated });
    } catch (err) {
      out.push({ name, body: '', truncated: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * Opens a project by switching the active workspace root.
 *
 * V6: masaüstünde backend'in BAŞARISI dogrulanir. Silinmis/tasinmis bir
 * klasör için backend reddederse: yerel secim geri alinir, hayalet girdi
 * son kullanilanlardan düsürülür ve cagiran DURUST sekilde bilgilendirilir.
 * (Eskiden hata yutuluyor, UI ölü proje etiketiyle baska bir kökün agacını
 * göstermeye devam ediyordu — denetim M3/V6.)
 * Tarayici önizlemesinde native backend yoktur; yerel gecersiz kalir.
 */
export async function openProject(root: string): Promise<OpenProjectResult> {
  if (!root) return { ok: false, error: t('ide.projectPathEmpty') };
  const previous = getWorkspaceRoot();
  saveWorkspaceRoot(root);
  rememberProject(root);
  if (!inTauriDesktop()) {
    // Browser preview: no native backend — the local switch stands, but the
    // caller is told honestly that the backend did not verify it.
    return { ok: true, root };
  }
  try {
    const info = await invoke<WorkspaceInfo>('set_workspace_root', { path: root });
    if (info?.root) {
      saveWorkspaceRoot(info.root);
      rememberProject(info.root, info.name);
      return { ok: true, root: info.root };
    }
    throw new Error('Backend did not confirm the workspace root.');
  } catch (e) {
    // Masaüstü ve backend reddetti: yolu geri al + hayalet girdiyi düsür.
    if (previous) {
      saveWorkspaceRoot(previous);
    } else {
      const cfg = readConfig();
      delete cfg.workspace_root;
      localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    }
    forgetProject(root);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
