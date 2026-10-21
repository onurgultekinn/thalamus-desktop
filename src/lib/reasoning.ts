/**
 * "Modelin düşünmesini göster" tercihi.
 *
 * Varsayılan KAPALI: düşünme, isteğe bağlı bir ayrıntıdır. Kapalıyken
 * sağlayıcının "kapat" değeri (ör. EVREN/vLLM'de `none`) gönderilir; yanıt
 * daha hızlı ve kısa gelir, düşünme token'ı üretilmez. Açıkken
 * `reasoning_effort` gönderilmez ve modelin düşünme metni katlanabilir blokta
 * gösterilir.
 *
 * Tek kaynak: tercih hem istek katmanında (aiClient) hem Ayarlar'da okunur.
 */
export const SHOW_REASONING_KEY = 'tlm_show_reasoning';

export function readShowReasoning(): boolean {
  try {
    return localStorage.getItem(SHOW_REASONING_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeShowReasoning(value: boolean): void {
  try {
    localStorage.setItem(SHOW_REASONING_KEY, String(value));
  } catch {
    /* localStorage yoksa (SSR/test) sessiz geç */
  }
}
