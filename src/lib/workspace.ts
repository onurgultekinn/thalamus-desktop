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

export function forgetProject(root: string): RecentProject[] {
  const next = listRecentProjects().filter((p) => p.root !== root);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
  return next;
}

/**
 * Opens a project by switching the active workspace root. The root is saved
 * locally first so the UI switches even without the native backend, then the
 * backend is asked to adopt it (its canonical path wins when available).
 */
export async function openProject(root: string): Promise<void> {
  if (!root) return;
  saveWorkspaceRoot(root);
  rememberProject(root);
  try {
    const info = await invoke<WorkspaceInfo>('set_workspace_root', { path: root });
    if (info?.root) {
      saveWorkspaceRoot(info.root);
      rememberProject(info.root, info.name);
    }
  } catch {
    // Backend unavailable (e.g. browser preview) — the local switch stands.
  }
}
