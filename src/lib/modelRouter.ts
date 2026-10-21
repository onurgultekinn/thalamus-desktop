/**
 * Model yönlendirici — SÖZCÜK LİSTESİ YOK, model adı GÖMÜLÜ DEĞİL.
 *
 * İlkeler:
 * 1. Yönlendirme kapalıysa davranış bugünküyle birebir aynıdır.
 * 2. "Hızlı" ve "derin" model kimlikleri KULLANICI tarafından Ayarlar'da
 *    girilir; router gömülü model adı bilmez.
 * 3. `auto` yalnız yapısal sinyallerle karar verir (eklerin türü). Metin
 *    analizi yapmaz; belirsizse aktif modelde kalır.
 * 4. ÖNEK CACHE: model değişimi cache'i geçersiz kılar. Bu yüzden `auto`
 *    yalnız sohbetin İLK turunda yönlendirir; sohbet ortasında seçim sabit
 *    kalır (sticky). Açık mod seçimi (fast/deep) kullanıcı kararıdır ve
 *    anında uygulanır.
 */

export type RoutingMode = 'auto' | 'fast' | 'deep';
export type TaskClass = 'data_analysis' | 'code_edit' | 'general';

export interface RouterInput {
  enabled: boolean;
  mode: RoutingMode;
  /** Kullanıcının bu sağlayıcı için seçtiği varsayılan (hızlı) model. */
  fastModel: string;
  /** Şu anda etkin model (yönlendirme yoksa bu kullanılır). */
  activeModel: string;
  /** Kullanıcının girdiği derin model; boşsa yönlendirme yapılmaz. */
  deepModel: string | null;
  hasStructuredData: boolean;
  hasCodeFiles: boolean;
  /** Sohbetin ilk isteği mi? Cache koruması için yalnız ilk turda auto. */
  isFirstTurn: boolean;
  /** Sohbetin önceki yönlendirmesi (sticky). */
  previous?: { model: string; task: TaskClass };
}

export interface RouterDecision {
  /** null → aktif model kullanılır (yönlendirme yok). */
  model: string | null;
  task: TaskClass;
  reason: string;
  switched: boolean;
}

const ACTIVE = (task: TaskClass, reason: string): RouterDecision => ({
  model: null,
  task,
  reason,
  switched: false,
});

/** Yapısal sinyallerden görev sınıfı. Metin içeriği okunmaz. */
export function classifyTask(hasStructuredData: boolean, hasCodeFiles: boolean): TaskClass {
  if (hasStructuredData) return 'data_analysis';
  if (hasCodeFiles) return 'code_edit';
  return 'general';
}

export function routeModel(i: RouterInput): RouterDecision {
  const task = classifyTask(i.hasStructuredData, i.hasCodeFiles);

  if (!i.enabled) return ACTIVE(task, 'routing disabled');
  if (!i.deepModel || !i.deepModel.trim()) return ACTIVE(task, 'no deep model configured');
  if (!i.fastModel.trim()) return ACTIVE(task, 'no fast model configured');

  if (i.mode === 'fast') {
    return {
      model: i.fastModel,
      task,
      reason: 'user selected fast mode',
      switched: i.fastModel !== i.activeModel,
    };
  }
  if (i.mode === 'deep') {
    return {
      model: i.deepModel,
      task,
      reason: 'user selected deep mode',
      switched: i.deepModel !== i.activeModel,
    };
  }

  // AUTO — yalnız ilk turda; sonrasında cache'i korumak için sticky.
  if (!i.isFirstTurn) {
    if (i.previous) {
      return {
        model: i.previous.model,
        task: i.previous.task,
        reason: 'auto: sticky (cache guard)',
        switched: i.previous.model !== i.activeModel,
      };
    }
    return ACTIVE(task, 'auto: mid-conversation, keeping active model');
  }

  // Muhafazakâr auto: yalnız yapısal VERİ işini derin modele gönder.
  // Kod/genel sohbet aktif modelde kalır (üretim kalitesi ölçülmeden risk yok).
  if (task === 'data_analysis') {
    return {
      model: i.deepModel,
      task,
      reason: 'auto: structured data on first turn',
      switched: i.deepModel !== i.activeModel,
    };
  }
  return ACTIVE(task, 'auto: no strong signal');
}
