/**
 * Ajan koşusu ile açık editör arasındaki köprü.
 *
 * Sorun: run ekranından dosyaya yazmak, editörün `fileContents`/`savedContents`
 * durumundan habersizse iki yanlış doğar — (1) kaydedilmemiş kullanıcı
 * düzenlemeleri sessizce ezilir, (2) yazma sonrası editör diskteki yeni hâli
 * göstermez. Bu yüzden yazma/okuma yetkisi editöre (ProjectDashboard) verilir;
 * o yoksa (panel tek başına açıldıysa) güvenli varsayılan doğrudan disktir.
 */

export interface HostWriteResult {
  ok: boolean;
  /**
   * 'dirty'     → dosyada kaydedilmemiş düzenleme var, yazılmadı.
   * 'no-desktop' → tarayıcı önizlemesi; diske yazma yok.
   * 'error'     → yazma denendi ve başarısız oldu.
   */
  reason?: 'dirty' | 'no-desktop' | 'error';
  message?: string;
}

/** Tarayıcı önizlemesinde diske erişim yok; dostça bir mesaj için ayırt edilir. */
function inDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

interface FileHost {
  read: (path: string) => Promise<string | null>;
  write: (path: string, content: string) => Promise<HostWriteResult>;
}

let host: FileHost | null = null;

/** Editör kendini kaydeder; panel kapanınca bırakır. */
export function registerFileHost(h: FileHost | null): void {
  host = h;
}

/** Arayüzde açık editör varsa ondan okur (kaydedilmemiş tampon dahil). */
export async function readFileViaHost(path: string): Promise<string | null> {
  if (host) {
    try {
      return await host.read(path);
    } catch {
      return null;
    }
  }
  return readFileDirect(path);
}

/**
 * Dosyayı yazar. Açık editör varsa editör yazar (durumu günceller ve
 * kaydedilmemiş düzenleme varsa reddeder); yoksa doğrudan diske yazar.
 */
export async function writeFileViaHost(path: string, content: string): Promise<HostWriteResult> {
  if (host) {
    try {
      return await host.write(path, content);
    } catch (e) {
      return { ok: false, reason: 'error', message: String(e) };
    }
  }
  if (!inDesktop()) return { ok: false, reason: 'no-desktop' };
  try {
    await writeFileDirect(path, content);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'error', message: String(e) };
  }
}

async function readFileDirect(path: string): Promise<string | null> {
  if (!inDesktop()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string>('thalamus_read_file', { path });
  } catch {
    return null;
  }
}

async function writeFileDirect(path: string, content: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('thalamus_write_file', { path, content });
}
