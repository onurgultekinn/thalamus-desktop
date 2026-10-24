import type { AskQuestion, AskQuestionOption, Message } from '../types';

const QUESTION_FENCE = /```(?:question|ask|soru)\s*\n([\s\S]*?)```/i;
const JSON_FENCE = /```json\s*\n([\s\S]*?)```/i;

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

function normalizeOptions(value: unknown): AskQuestionOption[] {
  if (!Array.isArray(value)) return [];
  const options: AskQuestionOption[] = [];
  for (const raw of value) {
    if (typeof raw === 'string') {
      const label = cleanText(raw);
      if (label) options.push({ label });
    } else if (raw && typeof raw === 'object') {
      const item = raw as Record<string, unknown>;
      const label = cleanText(item.label) ?? cleanText(item.title) ?? cleanText(item.value);
      if (!label) continue;
      const description = cleanText(item.description) ?? cleanText(item.detail);
      options.push(description ? { label, description } : { label });
    }
    if (options.length === 6) break;
  }
  return options;
}

function normalizeQuestion(value: unknown): AskQuestion | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const question = cleanText(raw.question) ?? cleanText(raw.prompt) ?? cleanText(raw.text);
  if (!question) return undefined;
  const header = cleanText(raw.header) ?? cleanText(raw.title);
  const options = normalizeOptions(raw.options);
  const multiple = raw.multiple === true || raw.type === 'multiple';
  return {
    question,
    ...(header ? { header } : {}),
    options,
    ...(multiple ? { multiple: true } : {}),
    allowOther: options.length === 0 || (raw.allowOther !== false && raw.allow_other !== false),
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw.trim());
  } catch {
    return undefined;
  }
}

function stripBlock(raw: string, match: RegExpMatchArray): string {
  const start = match.index ?? 0;
  return `${raw.slice(0, start)}${raw.slice(start + match[0].length)}`
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseAskQuestion(raw: string): { content: string; question?: AskQuestion } {
  const questionFence = raw.match(QUESTION_FENCE);
  if (questionFence) {
    const question = normalizeQuestion(parseJson(questionFence[1]));
    if (question) return { content: stripBlock(raw, questionFence), question };
  }

  const jsonFence = raw.match(JSON_FENCE);
  if (jsonFence) {
    const parsed = parseJson(jsonFence[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const envelope = parsed as Record<string, unknown>;
      const marked = envelope.type === 'question' || envelope.kind === 'question';
      const shaped = typeof envelope.question === 'string' && Array.isArray(envelope.options);
      if (marked || shaped) {
        const question = normalizeQuestion(envelope);
        if (question) return { content: stripBlock(raw, jsonFence), question };
      }
    }
  }

  return { content: raw };
}

export function askQuestionAsText(question: AskQuestion): string {
  const options = question.options
    .map((option) => `- ${option.label}${option.description ? `: ${option.description}` : ''}`)
    .join('\n');
  return [question.question, options].filter(Boolean).join('\n\n');
}

export function askQuestionHistoryText(message: Pick<Message, 'role' | 'content' | 'question'>): string {
  if (message.role === 'assistant' && message.question) {
    return [message.content.trim(), `[Clarifying question]\n${askQuestionAsText(message.question)}`]
      .filter(Boolean)
      .join('\n\n');
  }
  return message.content;
}
