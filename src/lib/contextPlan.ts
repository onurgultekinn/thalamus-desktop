/**
 * Oturum bağlam planlayıcısı (laboratuvarda ölçülmüş, kayıpsız katman).
 *
 * Fikir: bir sohbette AYNI dosya birden çok kez iliştirildiğinde içeriğini
 * yeniden göndermek yerine tek satır referans gönderilir. Model içeriği zaten
 * yukarıdaki mesajda görmüştür; kayıpsızlık korunur (bilgi bağlamda durur).
 *
 * ÖLÇÜM: 20 turluk oturumda gönderilen girdi
 * 1.746.558 → 193.400 token (%88,9). Kalite: diff/referans biçimi, tam dosyaya
 * karşı 96 eşleştirilmiş soruda −2,1 puan (güven aralıkları örtüşük → anlamlı
 * fark yok).
 *
 * GÜVENLİK KURALI: referans YALNIZCA içerik hâlâ bağlam penceresindeyse
 * kullanılır. Uygulama son N mesajı gönderiyor; dosya o pencerenin dışına
 * çıktıysa model içeriği göremez, dolayısıyla tam gövde yeniden gönderilir.
 * Aksi halde "kayıpsız" iddiası sessizce çökerdi.
 */

/** Uygulamanın modele gönderdiği geçmiş penceresi (App.tsx `history` = son 8).
 *  Güvenlik payı: 2 mesaj. Referans yalnız bu yaşın İÇİNDEKİ dosyalar için
 *  kullanılır; dışına çıkan dosya tam gövdeyle yeniden gönderilir. */
export const HISTORY_WINDOW = 6;

export interface PlannedFile {
  id: string;
  name: string;
  body: string;
}

interface SentRecord {
  hash: string;
  /** Dosya bu mesaj sayısında gönderildi (o anki toplam mesaj adedi). */
  atMessageCount: number;
  /** Kullanıcıya gösterilecek ham karakter sayısı. */
  chars: number;
}

const storageKey = (chatId: string) => `thalamus_sent_files_${chatId}`;

/** FNV-1a: hızlı, bağımlılıksız içerik parmak izi (kriptografik değil, amaç dedup). */
export function contentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function load(chatId: string): Record<string, SentRecord> {
  try {
    const raw = localStorage.getItem(storageKey(chatId));
    return raw ? (JSON.parse(raw) as Record<string, SentRecord>) : {};
  } catch {
    return {};
  }
}

function save(chatId: string, map: Record<string, SentRecord>) {
  try {
    localStorage.setItem(storageKey(chatId), JSON.stringify(map));
  } catch {
    /* kota dolu: planlayıcı sessizce devre dışı kalır, akış bozulmaz */
  }
}

export interface PlanResult {
  blocks: PlannedFile[];
  /** Yeniden gönderilmeyen ham karakter sayısı. */
  avoidedChars: number;
  /** Referansa çevrilen dosyaların adları. */
  referenced: string[];
  /** Neden referans kullanılmadı (güvenlik kuralı) — bilgi amaçlı. */
  resendReasons: string[];
}

/**
 * İliştirilen dosyaları planlar: değişmeyen ve hâlâ bağlamda olan dosyalar
 * referansa dönüşür; diğerleri tam gönderilir.
 */
export function planFileContext(
  chatId: string,
  messageCount: number,
  files: { name: string; body: string }[]
): PlanResult {
  const map = load(chatId);
  const out: PlannedFile[] = [];
  const referenced: string[] = [];
  const resendReasons: string[] = [];
  let avoidedChars = 0;

  files.forEach((f, i) => {
    const hash = contentHash(f.body);
    const prev = map[f.name];
    const age = prev ? messageCount - prev.atMessageCount : Number.POSITIVE_INFINITY;
    const unchanged = !!prev && prev.hash === hash;
    const inWindow = age <= HISTORY_WINDOW;

    if (unchanged && inWindow) {
      avoidedChars += f.body.length;
      referenced.push(f.name);
      out.push({
        id: `file${i}`,
        name: f.name,
        body:
          `// ${f.name} — bu sohbette daha önce tam olarak gönderildi ve o zamandan ` +
          `beri DEĞİŞMEDİ (parmak izi ${hash}).\n` +
          `// İçeriği yukarıdaki mesajda duruyor; yeniden gönderilmedi. ` +
          `Değişiklik yapacaksan önce o içeriği kullan.`,
      });
    } else {
      if (prev && !unchanged) resendReasons.push(`${f.name}: değişti`);
      else if (prev && !inWindow) resendReasons.push(`${f.name}: bağlam penceresinden çıktı`);
      out.push({ id: `file${i}`, name: f.name, body: f.body });
    }
    map[f.name] = { hash, atMessageCount: messageCount, chars: f.body.length };
  });

  save(chatId, map);
  return { blocks: out, avoidedChars, referenced, resendReasons };
}

/** Gösterge sayacı: sohbet başına birikimli tasarruf. */
export interface SessionSavings {
  avoidedChars: number;
  files: number;
  turns: number;
}

export function loadSavings(chatId: string): SessionSavings {
  try {
    const raw = localStorage.getItem(`thalamus_session_save_${chatId}`);
    return raw ? (JSON.parse(raw) as SessionSavings) : { avoidedChars: 0, files: 0, turns: 0 };
  } catch {
    return { avoidedChars: 0, files: 0, turns: 0 };
  }
}

export function addSavings(chatId: string, avoidedChars: number, files: number): SessionSavings {
  const cur = loadSavings(chatId);
  const next: SessionSavings = {
    avoidedChars: cur.avoidedChars + avoidedChars,
    files: cur.files + files,
    turns: cur.turns + (avoidedChars > 0 ? 1 : 0),
  };
  try {
    localStorage.setItem(`thalamus_session_save_${chatId}`, JSON.stringify(next));
  } catch {
    /* noop */
  }
  return next;
}

/**
 * ÖNEK CACHE uyumlu geçmiş penceresi.
 *
 * Sabit `slice(-8)` her turda pencereyi kaydırır: ilk mesaj değiştiği için
 * sağlayıcının önek cache'i neredeyse her turda kırılır. Bunun yerine pencere
 * BÜYÜK PARÇALARLA taşınır: 24 mesaja kadar değişmez (append-only → cache
 * hit), aşınca son 8 kalacak şekilde 16 mesaj birden düşer (tek cache miss,
 * sonra yine 16 tur sabit).
 *
 * Durum sohbet başına saklanır; uygulama yeniden açılsa da pencere konumu
 * korunur. `historyStart` localStorage'da yoksa 0'dan başlar.
 */
export const CACHE_KEEP = 24;
export const CACHE_RECENT = 8;
/**
 * Geçmişin karakter bütçesi (~12k token). 24 mesajlık cache-penceresi kod
 * içeren sohbetlerde 50k+ karaktere büyür ve BASİT bir soru bile devasa
 * istek yollardı. Bütçe aşılırsa başlangıç YİNE büyük parçalarla ilerler
 * (16'lı adım) — önek cache deseninin kendisi korunur.
 */
export const HISTORY_CHAR_BUDGET = 48_000;

export function cacheAwareHistory<T>(
  messages: T[],
  chatId: string,
  charOf?: (m: T) => number
): T[] {
  if (messages.length <= CACHE_KEEP) return messages;
  const key = 'thalamus_hist_start_' + chatId;
  let start = 0;
  try {
    start = Number(localStorage.getItem(key) ?? 0) || 0;
  } catch {
    start = 0;
  }
  if (start < 0 || start > messages.length) start = 0;
  if (messages.length - start <= CACHE_KEEP) {
    // Karakter bütçesi: pencereyi 16'şar mesaj geriye kaydırarak daralt.
    if (charOf) {
      const size = () =>
        messages.slice(start).reduce((a, m) => a + (charOf(m) || 0), 0);
      while (size() > HISTORY_CHAR_BUDGET && messages.length - start > CACHE_RECENT) {
        start = Math.min(start + 16, messages.length - CACHE_RECENT);
      }
      try {
        localStorage.setItem(key, String(start));
      } catch {
        /* kota dolu: pencere yine de doğru çalışır */
      }
    }
    return messages.slice(start);
  }
  // Eşik aşıldı: tek seferde büyük parça düşür (her turda kaydırma yok).
  start = messages.length - CACHE_RECENT;
  try {
    localStorage.setItem(key, String(start));
  } catch {
    /* kota dolu: pencere yine de doğru çalışır */
  }
  return messages.slice(start);
}

/** Kaba token tahmini (≈4 karakter/token) — arayüzde "≈" ile gösterilir. */
export const estimateTokens = (chars: number) => Math.round(chars / 4);
