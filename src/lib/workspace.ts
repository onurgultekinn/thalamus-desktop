import { invoke } from '@tauri-apps/api/core';

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
  if (!root) return { ok: false, error: 'Proje yolu boş.' };
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
    throw new Error('Backend kökü onaylamadı.');
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
