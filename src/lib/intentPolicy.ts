/**
 * İstek politikası — SÖZCÜK LİSTESİ YOK.
 *
 * Neden: "aynen", "açıkla", "tam" gibi kelimeler farklı bağlamlarda farklı
 * anlam taşır ("aynen" bir onaylama olabilir). Kelime eşleştirmesi bu yüzden
 * risklidir: yanlış bağlamda kısalığı/ayrıntıyı veya sıkıştırmayı değiştirir.
 *
 * Politika artık yalnız İKİ güvenilir kaynaktan gelir:
 *   1) Kullanıcının açık ayarı (Ayarlar → yanıt tarzı / ham bağlam)
 *   2) Sabit sistem istemindeki model kuralı: kullanıcı nasıl ifade ederse
 *      etsin, açık bir tercih belirtirse model onu uygular.
 *
 * `preserve` yalnız "Ham bağlam gönder" ayarıyla açılır; tahmin edilmez.
 */

export type AnswerMode = 'auto' | 'terse' | 'detailed';

export interface RequestPolicy {
  detailed: boolean;
  fullFile: boolean;
  preserve: boolean;
  terse: boolean;
}

/** Ayarlardan deterministik politika. Varsayılan: maliyet dostu. */
export function policyFromSettings(answerMode: AnswerMode, rawContext: boolean): RequestPolicy {
  return {
    detailed: answerMode === 'detailed',
    fullFile: false,
    preserve: rawContext,
    terse: answerMode === 'terse',
  };
}

/**
 * İsteğin kuyruğuna eklenecek kısa sistem yönergesi.
 * `null` → varsayılan politika (maliyet dostu, model kuralı geçerli).
 */
export function policyDirective(p: RequestPolicy): string | null {
  const parts: string[] = [];
  if (p.detailed) {
    parts.push(
      'The user selected the DETAILED answer style: do not apply the two-sentence limit; give the full explanation.'
    );
  }
  if (p.fullFile) {
    parts.push('The user selected full-file output: output the entire file, not a diff.');
  }
  if (p.preserve) {
    parts.push(
      'The user selected RAW context: compression is disabled. Use the original text exactly and preserve its formatting.'
    );
  }
  if (p.terse) {
    parts.push('The user selected the CONCISE answer style: keep it brief.');
  }
  return parts.length ? parts.join(' ') : null;
}
