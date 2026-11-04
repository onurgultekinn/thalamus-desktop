import { getLang } from './i18n';

/**
 * Sohbetin ne zaman açıldığını kompakt gösterir: bugün açıldıysa saat
 * ("14:32"), daha önceyse gün+ay ("3 Kas" / "Nov 3"). Zaman damgası
 * 'chat_<ms>' kimliğine gömülüdür — eski sohbetler göç gerektirmeden
 * tarih kazanır. Okunamıyorsa null: satırda yalnız ad çizilir.
 */
export function chatWhen(id: string): string | null {
  const ms = Number(id.startsWith('chat_') ? id.slice(5) : NaN);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const locale = getLang() === 'tr' ? 'tr-TR' : 'en-US';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d)
    : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(d);
}
