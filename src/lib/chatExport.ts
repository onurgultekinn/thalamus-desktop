/**
 * Sohbet dışa aktarma: Markdown (insan-okur) ve JSON (yedek/taşınabilir).
 * Tarayıcıda ve Tauri webview'inde blob indirmesi tek yol; dosya sistemi
 * eklentisi gerekmez.
 */
import type { Message } from '../types';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function exportedAt(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function messageBody(msg: Message): string {
  const notes: string[] = [];
  if (msg.images?.length) notes.push(`_[${msg.images.length} image attachment(s)]_`);
  const body = (msg.content || '').trim();
  return [notes.join('\n'), body].filter(Boolean).join('\n\n');
}

export function chatToMarkdown(title: string, messages: Message[]): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    `_Exported from Thalamus · ${messages.length} messages · ${exportedAt()}_`,
  ];

  for (const msg of messages) {
    lines.push('', '---', '');
    const who = msg.role === 'user' ? 'User' : 'Thalamus';
    const model = msg.role === 'assistant' && msg.modelName ? ` · ${msg.modelName}` : '';
    const when = msg.timestamp ? ` · ${msg.timestamp}` : '';
    lines.push(`## ${who}${model}${when}`, '', messageBody(msg));
    if (msg.reasoning?.trim()) {
      lines.push('', '### Reasoning', '', msg.reasoning.trim());
    }
    if (msg.usage && (msg.usage.prompt_tokens || msg.usage.completion_tokens)) {
      lines.push('', `_tokens: ${msg.usage.prompt_tokens ?? 0} in / ${msg.usage.completion_tokens ?? 0} out_`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function chatToJson(title: string, messages: Message[]): string {
  return JSON.stringify(
    {
      app: 'thalamus_desktop',
      exportedAt: new Date().toISOString(),
      title,
      messages,
    },
    null,
    2
  );
}

export function safeFilename(title: string): string {
  const base = (title || 'chat')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return base || 'chat';
}

/** Blob indirme; webview'de çalışmayan ortamda sessizce false döner. */
export function downloadText(filename: string, text: string, mime: string): boolean {
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Bazı webview'ler indirmeyi eşzamanlı başlatır; URL'i hemen iptal etme.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch {
    return false;
  }
}
