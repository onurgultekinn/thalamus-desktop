export type NucleusView = 'chat' | 'project';

export type NucleusAction =
  | { type: 'navigate'; view: NucleusView }
  | { type: 'new_chat' }
  | { type: 'open_settings' }
  | { type: 'toggle_sidebar' }
  | { type: 'stop_generation' };

export interface NucleusContext {
  view: NucleusView;
  projectName: string;
  chatTitle: string;
  modelLabel: string;
  hasProvider: boolean;
  messageCount: number;
  activeFile?: string;
  activeFileCode?: string;
  activeFileLine?: number;
  activeFileSelection?: string;
  sidebarOpen: boolean;
  transcript: string;
}

const VIEWS: NucleusView[] = ['chat', 'project'];

function actionFromUnknown(value: unknown): NucleusAction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type === 'navigate') {
    const view = record.view;
    if (typeof view === 'string' && VIEWS.includes(view as NucleusView)) {
      return { type: 'navigate', view: view as NucleusView };
    }
    return undefined;
  }
  if (type === 'new_chat') return { type: 'new_chat' };
  if (type === 'open_settings') return { type: 'open_settings' };
  if (type === 'toggle_sidebar') return { type: 'toggle_sidebar' };
  if (type === 'stop_generation') return { type: 'stop_generation' };
  return undefined;
}

const ACTION_FENCE = /```(?:action|nucleus)\s*([\s\S]*?)```/i;

export function stripNucleusAction(raw: string): string {
  return raw.replace(/```(?:action|nucleus)[\s\S]*?(?:```|$)/gi, '').trim();
}

export function parseNucleusReply(raw: string): { text: string; action?: NucleusAction } {
  const match = raw.match(ACTION_FENCE);
  if (!match) return { text: raw.trim() };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return { text: raw.replace(match[0], '').trim() };
  }

  return {
    text: raw.replace(match[0], '').trim(),
    action: actionFromUnknown(parsed),
  };
}

export function buildNucleusSystemPrompt(context: NucleusContext): string {
  const lines = [
    'You are Nucleus, the app-wide assistant inside Thalamus Studio, a local-first AI coding workspace.',
    'You can see the app context below and can control a small set of safe UI actions.',
    '',
    'CURRENT APP CONTEXT',
    `- View: ${context.view}`,
    `- Project: ${context.projectName || 'none'}`,
    `- Chat: ${context.chatTitle || 'none'}`,
    `- Active file: ${context.activeFile || 'none'}`,
    `- Cursor line: ${context.activeFileLine ?? 'none'}`,
    `- Model: ${context.modelLabel || 'not configured'}`,
    `- Provider available: ${context.hasProvider ? 'yes' : 'no'}`,
    `- Messages in chat: ${context.messageCount}`,
    `- Sidebar open: ${context.sidebarOpen ? 'yes' : 'no'}`,
    '',
    'CURRENT CHAT TRANSCRIPT (most recent, may be truncated):',
    context.transcript || '(empty)',
    ...(context.activeFileCode?.trim()
      ? ['', `ACTIVE FILE EXCERPT (${context.activeFile || 'file'}, may be truncated):`, context.activeFileCode.trim()]
      : []),
    ...(context.activeFileSelection?.trim()
      ? ['', 'SELECTED CODE (the user selected this; "here", "this", or "this code" refers to it):', context.activeFileSelection.trim()]
      : []),
    '',
    'ACTION PROTOCOL',
    'When the user explicitly asks you to navigate or control the app, append exactly one fenced action block at the very end:',
    '```action',
    '{"type":"navigate","view":"project"}',
    '```',
    'Allowed actions: navigate (view: chat | project), new_chat, open_settings, toggle_sidebar, stop_generation.',
    'Do not emit an action block for questions, explanations, or summaries. Do not invent actions.',
    'When you emit an action, keep the prose to one short sentence.',
    'Never claim an action already happened; the app runs it and shows confirmation.',
    '',
    'STYLE',
    'Answer in the same language as the user. Be concise: at most 120 words unless the user asks for detail.',
    'Use the current context instead of asking the user to repeat it. For summaries, include decisions, open tasks, and the next step.',
    'When the user asks about "here", "this", or "this code", explain the selected code if present; otherwise explain the cursor line and nearby code.',
    'If the user asks for something outside the allowed actions, explain the shortest path in the app.',
  ];
  return lines.join('\n');
}
