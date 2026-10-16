import React, { useState, useRef } from 'react';
import { ts } from '../lib/format';
import { 
  FileText, 
  Check, 
  Paperclip, 
  Send, 
  Sparkles, 
  MessageSquare, 
  GitPullRequest, 
  AtSign, 
  User, 
  Zap,
  Eye,
  Camera,
  ListChecks,
  ShieldCheck,
  Minimize2,
  Undo2,
  ImagePlus,
  X,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { CameraPanel } from './CameraPanel';
import { aiChat, userMessage, type AiChatResponse, type AiEditResult } from '../services/aiClient';
import { prepareImageFile, IMAGE_MODE_ORDER, imageModeLabel, imageModeHint, DEFAULT_IMAGE_MODE, type AttachedImage, type ImageMode } from '../lib/imageAttach';
import { MarkdownMessage } from './MarkdownMessage';
import { CopilotDiffModal } from './CopilotDiffModal';

export interface ActionPayload {
  type: 'RUN_TERMINAL' | 'APPLY_PATCH';
  label: string;
  command?: string;
  codeSnippet?: string;
  targetFile?: string;
  originalCodeSnippet?: string;
}

export interface Message {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: string;
  modeUsed?: 'chat' | 'agent';
  actionPayload?: ActionPayload;
  agentSteps?: { step: number; desc: string; status: 'pending' | 'running' | 'completed' }[];
}

interface ThalamusCopilotProps {
  activeFile?: string;
  activeFileCode?: string;
  workspaceFiles?: string[];
  onApplyCode?: (file: string, code: string) => void;
  onOpenTerminal?: () => void;
}

/** Slash command templates (Claude Code / ZCode style). */
const SLASH_TEMPLATES: Record<string, string> = {
  '/explain': 'Explain the relevant code below (logic, patterns used, improvement opportunities):',
  '/review': 'Review the relevant code for bugs, security and improvement suggestions:',
  '/refactor': 'Make the relevant code cleaner and more readable (apply with SEARCH/REPLACE blocks):',
  '/tests': 'Suggest unit tests for the relevant code (with SEARCH/REPLACE blocks):',
};

/** Generates a message id (against Date.now collisions). */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function ThalamusCopilot({
  activeFile = "",
  activeFileCode = "",
  workspaceFiles = [],
  onApplyCode,
  onOpenTerminal
}: ThalamusCopilotProps) {
  const [mode, setMode] = useState<'chat' | 'agent'>('chat');
  const [input, setInput] = useState("");
  const [executedActions, setExecutedActions] = useState<Record<string, boolean>>({});
  const [lastEdit, setLastEdit] = useState<{ file: string; prev: string } | null>(null);
  // ZCode/Claude Code style: plan mode, permission mode, context, summarization
  const [planMode, setPlanMode] = useState(false);
  const [permission, setPermission] = useState<'ask' | 'auto'>('ask');
  const [lastUsage, setLastUsage] = useState<AiChatResponse['usage'] | null>(null);
  const [pendingEdits, setPendingEdits] = useState<AiEditResult[] | null>(null);
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  // Images attached to the next message, sent as real image parts to the model.
  const [pendingImages, setPendingImages] = useState<AttachedImage[]>([]);
  const [imageMode, setImageMode] = useState<ImageMode>(DEFAULT_IMAGE_MODE);
  const pendingImagesRef = useRef<AttachedImage[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const addPendingImages = (imgs: AttachedImage[]) => {
    const next = [...pendingImagesRef.current, ...imgs];
    pendingImagesRef.current = next;
    setPendingImages(next);
  };

  const clearPendingImages = () => {
    pendingImagesRef.current = [];
    setPendingImages([]);
  };

  const handleImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const prepared: AttachedImage[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        prepared.push(await prepareImageFile(file, imageMode));
      } catch {
        // Unreadable image — skip it rather than failing the whole attach.
      }
    }
    if (prepared.length) addPendingImages(prepared);
  };

  /** Reverts the last applied edit (safety net). */
  const undoLastEdit = () => {
    if (!lastEdit) return;
    onApplyCode?.(lastEdit.file, lastEdit.prev);
    setLastEdit(null);
  };

  

  // Refs to reliably read values at send time
  const planModeRef = useRef(planMode);
  planModeRef.current = planMode;
  const permRef = useRef(permission);
  permRef.current = permission;

  const handleSend = () => doSend(input);

  /** Second-turn send to apply the plan generated in plan mode. */
  const applyPlan = () => {
    if (!pendingPlan) return;
    doSend(`IMPLEMENT YOUR PLAN (step by step, with SEARCH/REPLACE blocks):\n${pendingPlan}`);
    setPendingPlan(null);
  };

  /** Applies pending edits with user confirmation when permission mode is 'ask'. */
  const applyPendingEdits = () => {
    if (!pendingEdits) return;
    const e = pendingEdits.find(x => x.applied && x.new_body) ?? pendingEdits[0];
    if (e && e.new_body) {
      onApplyCode?.(activeFile, e.new_body);
      setLastEdit({ file: activeFile, prev: activeFileCode });
    }
    setPendingEdits(null);
  };

  /** Claude Code `/compact` equivalent: summarizes the chat and clears the window. */
  const compactConversation = async () => {
    const history = messages
      .map(m => `${m.sender === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
      .join('\n---\n')
      .slice(-10000);
    try {
      const data = await aiChat([{
        role: 'user',
        content: `Summarize the following chat comprehensively but with as few tokens as possible; preserve the requests made, decisions taken and edits performed. In the same language:\n\n${history}`,
      }]);
      setMessages([{ id: newId(), sender: 'ai', text: `[SUMMARY]\n${data.content}`, timestamp: ts(), modeUsed: 'chat' }]);
      setPendingEdits(null);
      setPendingPlan(null);
      setLastEdit(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages(prev => [...prev, { id: newId(), sender: 'ai', text: msg === 'API_KEY_MISSING' ? 'A key is required for summarization (Settings → Providers).' : `Summarization failed: ${msg}`, timestamp: ts(), modeUsed: 'chat' }]);
    }
  };

  /** Has the AI interpret the camera measurements (with the error-reducing protocol). */
  const runCameraInterpret = async (prompt: string) => {
    setCameraOpen(false);
    setMessages(prev => [...prev, { id: newId(), sender: 'ai', text: 'Camera interpretation requested…', timestamp: ts(), modeUsed: 'chat' }]);
    try {
      const res = await callRealAI(prompt);
      setMessages(prev => [...prev.slice(0, -1), { id: newId(), sender: 'ai', text: res.content, timestamp: ts(), modeUsed: 'chat' }]);
    } catch (err) {
      setMessages(prev => [...prev.slice(0, -1), { id: newId(), sender: 'ai', text: `Could not get interpretation: ${err instanceof Error ? err.message : String(err)}`, timestamp: ts(), modeUsed: 'chat' }]);
    }
  };

  const [activeModalMessage, setActiveModalMessage] = useState<Message | null>(null);

  const [showFileMentionMenu, setShowFileMentionMenu] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      sender: "ai",
      text: activeFile
        ? `\`${activeFile}\` is active — how can I help you?`
        : 'How can I help you?',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      modeUsed: 'chat'
    }
  ]);

  const executeAgentAction = async (msgId: string, action: ActionPayload) => {
    try {
      if (action.type === 'RUN_TERMINAL' && action.command) {
        onOpenTerminal?.();
        await invoke('write_terminal', { data: action.command + '\r' });
      } else if (action.type === 'APPLY_PATCH' && action.targetFile && action.codeSnippet) {
        onApplyCode?.(action.targetFile, action.codeSnippet);
      }
      setExecutedActions(prev => ({ ...prev, [msgId]: true }));
    } catch (err) {
      // Make the failure visible in the chat — no "Applied" lie.
      setMessages(prev => [...prev, {
        id: newId(),
        sender: 'ai',
        text: `⚠️ Action could not be applied: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: ts(),
        modeUsed: 'chat',
      }]);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);

    const lastAtIndex = val.lastIndexOf('@');
    if (lastAtIndex !== -1 && lastAtIndex === val.length - 1) {
      setShowFileMentionMenu(true);
    } else if (showFileMentionMenu && !val.includes('@')) {
      setShowFileMentionMenu(false);
    }
  };

  const handleSelectFileMention = (fileName: string) => {
    const lastAtIndex = input.lastIndexOf('@');
    const newInput = input.substring(0, lastAtIndex) + `@${fileName} `;
    setInput(newInput);
    setShowFileMentionMenu(false);
    if (!selectedFiles.includes(fileName)) {
      setSelectedFiles(prev => [...prev, fileName]);
    }
    textareaRef.current?.focus();
  };

  const callRealAI = async (
    prompt: string
  ): Promise<AiChatResponse> => {
    // Code context: a SCHEMA is sent instead of the body; the LLM requests the body via get_code_body.
    // No loss — the original code stays in the editor/locally.
    const codeBlocks = activeFileCode.trim()
      ? [{ id: activeFile, name: activeFile, body: activeFileCode }]
      : [];
    const images = pendingImagesRef.current.map((i) => ({ url: i.url, detail: i.detail }));
    clearPendingImages();
    // D3: konusma DURUMU gonderilir (son 10 gercek mesaj) — copilot artik
    // "hafizasiz" degil; "Thinking..." placeholder'i ve bos mesajlar elenir.
    const history = messages
      .filter(m => m.text.trim().length > 0 && m.text !== 'Thinking...')
      .slice(-10)
      .map(m => ({
        role: (m.sender === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.text,
      }));
    return aiChat([...history, userMessage(prompt, images)], codeBlocks);
  };

  const doSend = (raw: string) => {
    const imageCount = pendingImagesRef.current.length;
    if (!raw.trim() && imageCount === 0) return;

    const userText = raw.trim();
    const contextInfo = selectedFiles.length > 0 ? ` [Reference: ${selectedFiles.join(', ')}]` : '';
    // D4: @referansi SUS donanin otesi — modele dosya adlari verilir ve
    // read_file araciyla gercekten acabilecekleri soylenir (backend araclari
    // workspace icinde dosya okuyabiliyor).
    const referenceNote = selectedFiles.length > 0
      ? `\nReferenced files (workspace-relative paths — open their contents with the read_file tool when needed): ${selectedFiles.join(', ')}`
      : '';

    // Slash command expansion: /explain, /review, /refactor, /tests
    const firstTok = userText.split(/\s+/)[0];
    const slashTemplate = SLASH_TEMPLATES[firstTok];
    const aiText = slashTemplate
      ? slashTemplate + (userText.length > firstTok.length ? ' ' + userText.slice(firstTok.length).trim() : '')
      : (userText || 'Look at the attached image.');

    const userMsg: Message = {
      id: newId(),
      sender: 'user',
      text: (userText || `[${imageCount} image${imageCount > 1 ? 's' : ''}]`) + contextInfo,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      modeUsed: mode
    };

    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setSelectedFiles([]);
    setShowFileMentionMenu(false);

    const isAgent = mode === 'agent';
    const placeholderId = newId();

    // Add temporary "Thinking..." message
    setMessages(prev => [...prev, {
      id: placeholderId,
      sender: 'ai',
      text: 'Thinking...',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      modeUsed: mode
    }]);

    const inPlanMode = planModeRef.current && isAgent;
    let systemPrompt = "";
    if (isAgent) {
      systemPrompt = inPlanMode
        ? `Agent Mode (PLAN MODE). Active file: ${activeFile}${referenceNote}\n\nTask: ${aiText}\n\nProduce ONLY a detailed PLAN; do NOT edit code (do not write a SEARCH/REPLACE block). Steps, functions to touch, risks and a verification suggestion.`
        : `Agent Mode. Active file: ${activeFile}${referenceNote}\n\nUser request: ${aiText}\n\nApply your changes as SEARCH/REPLACE blocks (format is provided to you).`;
    } else {
      // D5: "Answer in English" kaldirildi — kullanicinin diline saygi
      // (Türkce yazana Türkce yanit) birinci kural.
      systemPrompt = `You are Thalamus Copilot, an AI assistant. Help the user analyze or understand their code. Always answer in the same language the user writes in (Turkish user → answer in Turkish).\nActive file: ${activeFile}${referenceNote}\n\nUser question: ${aiText}`;
    }

    callRealAI(systemPrompt)
      .then(res => {
        // Remove "Thinking..." message
        setMessages(prev => prev.filter(m => m.id !== placeholderId));
        if (res.usage) setLastUsage(res.usage);

        let explanation = res.content;
        let codeSnippet = "";
        const codeBlockRegex = /```[a-zA-Z]*\n([\s\S]*?)```/;
        const match = explanation.match(codeBlockRegex);
        if (match && match[1]) {
          codeSnippet = match[1].trim();
          explanation = explanation.replace(codeBlockRegex, "").trim();
        }

        const applied = (res.edits || []).filter(e => e.applied && e.new_body);

        // PLAN MODE: a plan arrived instead of an edit → waits for "Apply Plan".
        if (inPlanMode) {
          setPendingPlan(explanation);
        } else if (applied.length > 0 && permRef.current === 'ask') {
          setPendingEdits(applied);
        } else if (applied.length > 0) {
          applied.forEach(e => onApplyCode?.(activeFile, e.new_body as string));
          setLastEdit({ file: activeFile, prev: activeFileCode });
        }
        (res.edits || []).filter(e => !e.applied).forEach(e =>
          console.warn('edit could not be applied:', e.file, e.message)
        );

        let text = explanation || (isAgent ? "Patch package prepared:" : "");
        if (applied.length > 0) {
          text += permRef.current === 'ask'
            ? `\n\n✓ ${applied.length} edit(s) ready — confirm with the APPLY button (Ctrl+S to save).`
            : `\n\n✓ ${applied.length} edit(s) applied to ${activeFile} (Ctrl+S to save).`;
        }
        if (inPlanMode && !text.trim()) {
          text = "(could not generate a plan.)";
        }

        const responseMsg: Message = {
          id: newId(),
          sender: 'ai',
          text,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          modeUsed: mode,
          ...(isAgent && !applied.length && codeSnippet ? {
            actionPayload: {
              type: 'APPLY_PATCH',
              label: `Apply Patch to ${activeFile}`,
              originalCodeSnippet: activeFileCode || "",
              codeSnippet: codeSnippet,
              targetFile: activeFile
            }
          } : {})
        };

        setMessages(prev => [...prev, responseMsg]);
      })
      .catch(err => {
        // Remove "Thinking..." message
        setMessages(prev => prev.filter(m => m.id !== placeholderId));

        const isKeyMissing = err instanceof Error && err.message === 'API_KEY_MISSING';
        const errorText = isKeyMissing
          ? 'No API key is configured. Open Settings → Providers, save an OpenAI, Anthropic or DeepSeek key, then ask again. No simulated answer is shown.'
          : `⚠️ The AI request failed: ${err instanceof Error ? err.message : String(err)}`;

        setMessages(prev => [...prev, {
          id: newId(),
          sender: 'ai',
          text: errorText,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          modeUsed: mode
        }]);
      });
  };

  return (
    <div className="w-full h-full bg-[#1C1B1A] flex flex-col font-sans select-none text-xs relative overflow-hidden">
      {cameraOpen && (
        <CameraPanel onClose={() => setCameraOpen(false)} onInterpret={runCameraInterpret} />
      )}
      
      {/* CSS FOR THE SLIM HOVER-GROWING SCROLLBAR */}
      <style>{`
        .pretty-scrollbar::-webkit-scrollbar {
          width: 4px;
          height: 4px;
          transition: width 0.2s ease;
        }
        .pretty-scrollbar:hover::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        .pretty-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .pretty-scrollbar::-webkit-scrollbar-thumb {
          background: #34332F;
          border-radius: 4px;
          transition: background 0.2s ease;
        }
        .pretty-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #403E3C;
        }
      `}</style>

      {/* 🎯 CODE INSPECTION MODAL */}
      {activeModalMessage && activeModalMessage.actionPayload && (
        <CopilotDiffModal
          message={activeModalMessage}
          executed={!!executedActions[activeModalMessage.id]}
          activeFile={activeFile}
          onApply={(payload) => {
            executeAgentAction(activeModalMessage.id, payload);
            setActiveModalMessage(null);
          }}
          onClose={() => setActiveModalMessage(null)}
        />
      )}


      {/* 1. HEADER AND MODE SELECTOR */}
      <div className="h-9 px-2 bg-[#282726] border-b border-[#34332F] flex items-center gap-1.5 justify-between flex-shrink-0">
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
          <div className="flex items-center gap-0.5 bg-[#1C1B1A] p-0.5 rounded-md border border-[#34332F]">
            <button
              type="button"
              onClick={() => setMode('chat')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer ${
                mode === 'chat' ? 'bg-[#34332F] text-[#F2F0E5]' : 'text-[#87857F] hover:text-[#CECDC3]'
              }`}
            >
              <MessageSquare size={11} /> Chat
            </button>
            <button
              type="button"
              onClick={() => setMode('agent')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer ${
                mode === 'agent' ? 'bg-[#34332F] text-[#F2F0E5]' : 'text-[#87857F] hover:text-[#CECDC3]'
              }`}
            >
              <Zap size={11} /> Agent
            </button>
          </div>

          <span className="mx-0.5 h-4 w-px flex-shrink-0 bg-[#34332F]" />

          {/* Plan mode (Claude Code /plan) */}
          <button
            type="button"
            onClick={() => setPlanMode(v => !v)}
            title="Plan mode: generate a plan first, apply if you approve"
            className={`flex h-6 items-center gap-1.5 rounded-md border px-2 text-[10.5px] font-medium cursor-pointer transition-colors ${
              planMode
                ? 'bg-white/[0.06] border-white/[0.10] text-[#F2F0E5]'
                : 'border-transparent text-[#87857F] hover:bg-white/[0.04] hover:text-[#CECDC3]'
            }`}
          >
            <ListChecks size={12} className="flex-shrink-0" /> Plan
          </button>
          {/* Permission mode (Claude Code permission) */}
          <button
            type="button"
            onClick={() => setPermission(p => (p === 'ask' ? 'auto' : 'ask'))}
            title="Edit permission: Confirm — every edit is asked first / Automatic — applied directly"
            className={`flex h-6 items-center gap-1.5 rounded-md border px-2 text-[10.5px] font-medium cursor-pointer transition-colors ${
              permission === 'ask'
                ? 'bg-white/[0.06] border-white/[0.10] text-[#F2F0E5]'
                : 'border-transparent text-[#87857F] hover:bg-white/[0.04] hover:text-[#CECDC3]'
            }`}
          >
            <ShieldCheck size={12} className="flex-shrink-0" />
            {permission === 'ask' ? 'Confirm' : 'Auto'}
          </button>
          {/* Summarize (Claude Code /compact) */}
          <button
            type="button"
            onClick={compactConversation}
            title="Summarize the chat and clear the window (token savings)"
            className="flex h-6 items-center gap-1.5 rounded-md border border-transparent px-2 text-[10.5px] font-medium text-[#87857F] hover:bg-white/[0.04] hover:text-[#CECDC3] cursor-pointer transition-colors"
          >
            <Minimize2 size={12} className="flex-shrink-0" /> Summarize
          </button>
          {/* Live camera vision (model-less measurements + AI interpretation) */}
          <button
            type="button"
            onClick={() => setCameraOpen(v => !v)}
            title="Camera: live measurements, AI interpretation (prediction + confidence)"
            className={`flex h-6 items-center gap-1.5 rounded-md border px-2 text-[10.5px] font-medium cursor-pointer transition-colors ${
              cameraOpen
                ? 'bg-white/[0.06] border-white/[0.10] text-[#F2F0E5]'
                : 'border-transparent text-[#87857F] hover:bg-white/[0.04] hover:text-[#CECDC3]'
            }`}
          >
            <Camera size={12} className="flex-shrink-0" /> Camera
          </button>
        </div>

        <div className="flex items-center gap-1.5 text-[#87857F] font-mono text-[10px]">
          {/* Context indicator (Claude Code /context style) */}
          {lastUsage && (
            <div className="flex items-center gap-1" title="Total token usage in the last request (128k target)">
              <span className="text-[8.5px] text-[#87857F]">{lastUsage.total_tokens ?? '—'}</span>
              <div className="flex gap-[2px]">
                {Array.from({ length: 10 }).map((_, i) => {
                  const frac = Math.min(1, (lastUsage.total_tokens ?? 0) / 128000);
                  const on = i < Math.ceil(frac * 10);
                  return (
                    <span
                      key={i}
                      className={`w-[3px] h-3 rounded-sm ${
                        on
                          ? frac > 0.8
                            ? 'bg-rose-400'
                            : frac > 0.5
                              ? 'bg-amber-400'
                              : 'bg-emerald-400'
                          : 'bg-[#34332F]'
                      }`}
                    />
                  );
                })}
              </div>
            </div>
          )}
          <FileText size={11} className="text-[#87857F]" />
          <span className="truncate max-w-[80px] text-[#CECDC3]">{activeFile}</span>
        </div>
      </div>

      {/* 2. MESSAGE FLOW */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5 pretty-scrollbar">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex flex-col gap-0.5 ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
            <div className="flex items-center gap-1 text-[9.5px] text-[#87857F] px-1 font-mono">
              {msg.sender === 'user' && <User size={9} className="text-[#4385BE]" />}
              <span className="text-[#A8A49E] font-medium">
                {msg.sender === 'user' ? 'Anonymous User' : 'Thalamus'}
              </span>
              <span>•</span>
              <span>{msg.timestamp}</span>
              {msg.modeUsed === 'agent' && (
                <span className="bg-[#4385BE]/20 text-[#4385BE] px-1 py-0.2 rounded text-[8.5px]">Agent</span>
              )}
            </div>

            <div className={`p-2 rounded-md max-w-[98%] text-[11px] leading-normal border ${
              msg.sender === 'user' 
                ? 'bg-[#1E3A52] border-[#35639E] text-white' 
                : 'bg-[#282726] border-[#34332F] text-[#CECDC3]'
            }`}>
              <MarkdownMessage content={msg.text} />

              {msg.agentSteps && (
                <div className="mt-1 space-y-0.5 font-mono text-[9.5px]">
                  {msg.agentSteps.map(step => (
                    <div key={step.step} className="flex items-center gap-1 text-[#3AA99F]">
                      <Check size={10} className="flex-shrink-0" />
                      <span className="text-[#87857F]">{step.desc}</span>
                    </div>
                  ))}
                </div>
              )}

              {msg.actionPayload && (
                <div className="mt-2 rounded border border-[#2a2a2c] bg-[#1C1B1A] p-2 flex items-center justify-between gap-2 overflow-hidden">
                  <div className="flex items-center gap-1.5 min-w-0 font-mono text-[10px]">
                    <GitPullRequest size={12} className="text-[#3AA99F] flex-shrink-0" />
                    <span className="font-medium text-[#CECDC3] truncate max-w-[100px]">
                      {msg.actionPayload.targetFile}
                    </span>
                    <div className="flex items-center gap-1 flex-shrink-0 text-[8.5px]">
                      {(() => {
                        const aLen = (msg.actionPayload?.originalCodeSnippet ?? '').split('\n').length;
                        const bLen = (msg.actionPayload?.codeSnippet ?? '').split('\n').length;
                        const added = Math.max(0, bLen - aLen);
                        const removed = Math.max(0, aLen - bLen);
                        return (
                          <>
                            {added > 0 && <span className="text-[#3AA99F] bg-[#3AA99F]/10 px-1 py-0.2 rounded">+{added}</span>}
                            {removed > 0 && <span className="text-[#D14D41] bg-[#D14D41]/10 px-1 py-0.2 rounded">-{removed}</span>}
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => setActiveModalMessage(msg)}
                      className="px-2 py-0.5 bg-[#205EA6] hover:bg-[#4385BE] text-white font-medium rounded text-[9.5px] flex items-center gap-1 cursor-pointer transition-colors shadow-xs"
                    >
                      <Eye size={10} /> Inspect
                    </button>

                    {executedActions[msg.id] ? (
                      <span className="text-[#3AA99F] text-[9.5px] font-medium flex items-center gap-0.5 px-1.5 py-0.5 bg-[#3AA99F]/10 rounded">
                        <Check size={9} /> Applied
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => executeAgentAction(msg.id, msg.actionPayload!)}
                        className="px-2 py-0.5 bg-[#205EA6] hover:bg-[#4385BE] text-white font-medium rounded text-[9.5px] flex items-center gap-1 cursor-pointer transition-colors shadow-xs"
                      >
                        <GitPullRequest size={9} /> Apply
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 3. INPUT AREA */}
      <div className="p-2 border-t border-[#34332F] bg-[#1C1B1A] flex flex-col gap-1 flex-shrink-0 z-10 relative">
        <div className="flex items-center gap-1 px-0.5">
          <span className="text-[9px] font-mono uppercase tracking-wider text-[#87857F]">Image</span>
          {(IMAGE_MODE_ORDER).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setImageMode(m)}
              title={imageModeHint(m)}
              className={`rounded border px-1.5 py-0.5 text-[9.5px] transition-colors cursor-pointer ${
                imageMode === m
                  ? 'border-[#dcb67a]/50 bg-[#dcb67a]/10 text-[#dcb67a]'
                  : 'border-[#34332F] text-[#87857F] hover:text-[#CECDC3]'
              }`}
            >
              {imageModeLabel(m)}
            </button>
          ))}
        </div>
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-0.5">
            {pendingImages.map((img, idx) => (
              <div key={`${img.name}-${idx}`} className="relative">
                <img
                  src={img.url}
                  alt={img.name}
                  title={`${img.name} · ${img.width}×${img.height} · detail:${img.detail} · ${img.reason}${img.visionDiag ? ' · ' + img.visionDiag : ''}\n${img.options.map((o) => `${o.label}: ${Math.round(o.ratio * 100)}% · ≈${o.tokens} tok · ${o.retention}% detail`).join('\n')}`}
                  className="h-10 w-10 rounded-md object-cover border border-[#34332F]"
                />
                <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded bg-[#1C1B1A]/90 px-1 text-[8px] font-mono text-[#dcb67a] whitespace-nowrap">
                  ≈{img.estTokens} · %{img.retention}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const next = pendingImagesRef.current.filter((_, i) => i !== idx);
                    pendingImagesRef.current = next;
                    setPendingImages(next);
                  }}
                  className="absolute -top-1.5 -right-1.5 bg-[#1C1B1A] border border-[#34332F] rounded-full p-0.5 text-[#87857F] hover:text-rose-400 cursor-pointer"
                  title="Remove image"
                >
                  <X size={9} />
                </button>
              </div>
            ))}
          </div>
        )}
        {pendingPlan && (
          <div className="flex items-center justify-between px-0.5">
            <span className="flex items-center gap-1 text-[9.5px] font-mono text-[#D0A215]">
              <ListChecks size={11} /> Plan ready
            </span>
            <button
              type="button"
              onClick={applyPlan}
              className="text-[10px] font-semibold text-[#D0A215] hover:underline cursor-pointer"
            >
              Apply Plan
            </button>
          </div>
        )}
        {pendingEdits && pendingEdits.length > 0 && (
          <div className="flex items-center justify-between px-0.5">
            <span className="text-[9.5px] font-mono text-[#3AA99F]">
              {pendingEdits.length} edit(s) pending
            </span>
            <button
              type="button"
              onClick={applyPendingEdits}
              className="text-[10px] font-semibold text-[#3AA99F] hover:underline cursor-pointer"
            >
              Apply
            </button>
          </div>
        )}
        {lastEdit && (
          <div className="flex items-center justify-between px-0.5">
            <span className="text-[9.5px] font-mono text-[#D0A215]">
              Last edit ({lastEdit.file.split('/').pop()}) can be undone
            </span>
            <button
              type="button"
              onClick={undoLastEdit}
              className="flex items-center gap-1 text-[10px] font-medium text-[#3AA99F] hover:underline cursor-pointer"
            >
              <Undo2 size={11} /> Undo
            </button>
          </div>
        )}
        {showFileMentionMenu && (
          <div className="absolute bottom-full left-2 mb-1.5 w-[200px] bg-[#282726] border border-[#34332F] rounded shadow-2xl p-1 z-50">
            <div className="px-1.5 py-0.5 text-[9px] font-mono text-[#87857F] uppercase border-b border-[#34332F] mb-1">
              Attach File (@)
            </div>
            {workspaceFiles.map(file => (
              <button
                key={file}
                type="button"
                onClick={() => handleSelectFileMention(file)}
                className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-[#282726] text-[#CECDC3] hover:text-white font-mono text-[10.5px] text-left cursor-pointer transition-colors"
              >
                <FileText size={11} className="text-[#87857F]" />
                <span className="truncate">{file}</span>
              </button>
            ))}
          </div>
        )}

        <div className="relative bg-[#100F0F] border border-[#34332F] focus-within:border-[#4385BE] rounded p-1.5 transition-all">
          {selectedFiles.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mb-1 pb-1 border-b border-[#282726]">
              {selectedFiles.map(file => (
                <span key={file} className="flex items-center gap-1 bg-[#282726] border border-[#34332F] text-[#3AA99F] px-1.5 py-0.2 rounded text-[9.5px] font-mono">
                  <FileText size={9} /> @{file}
                  <button 
                    type="button" 
                    onClick={() => setSelectedFiles(selectedFiles.filter(f => f !== file))}
                    className="hover:text-red-400 ml-0.5 cursor-pointer"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !showFileMentionMenu) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={mode === 'agent' ? "Task for Agent or @ file..." : "Type a message or use @..."}
            className="w-full bg-transparent text-[#F2F0E5] placeholder-[#87857F] text-[11px] resize-none outline-none min-h-[36px] max-h-[80px] leading-relaxed pretty-scrollbar"
            rows={2}
          />

          <div className="flex items-center justify-between pt-1 border-t border-[#1C1B1A]">
            <div className="flex items-center gap-1 text-[#87857F]">
              <button 
                type="button" 
                title="Add File Reference (@)" 
                onClick={() => {
                  setInput(prev => prev + '@');
                  setShowFileMentionMenu(true);
                  textareaRef.current?.focus();
                }}
                className="p-0.5 hover:bg-[#282726] rounded text-[#CECDC3] hover:text-white transition-colors cursor-pointer"
              >
                <AtSign size={12} className="text-[#3AA99F]" />
              </button>
              <button 
                type="button" 
                title="Attach File (@)" 
                onClick={() => {
                  setInput(prev => prev + '@');
                  setShowFileMentionMenu(true);
                  textareaRef.current?.focus();
                }}
                className="p-0.5 hover:bg-[#282726] rounded text-[#CECDC3] hover:text-white transition-colors cursor-pointer"
              >
                <Paperclip size={12} className="text-[#4385BE]" />
              </button>
              <button
                type="button"
                title="Attach image (sent to a vision model)"
                onClick={() => imageInputRef.current?.click()}
                className="p-0.5 hover:bg-[#282726] rounded text-[#CECDC3] hover:text-white transition-colors cursor-pointer"
              >
                <ImagePlus size={12} className="text-[#dcb67a]" />
              </button>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleImagePick}
              />
              <span className="text-[9px] font-mono text-[#575654] px-0.5">|</span>
              <span className="text-[9.5px] font-mono text-[#87857F] flex items-center gap-0.5">
                <Sparkles size={10} className="text-[#4385BE]" /> 
                {mode === 'agent' ? 'Agent' : 'Chat'}
              </span>
            </div>

            <button 
              type="button"
              onClick={handleSend}
              disabled={!input.trim()}
              className={`p-1 rounded transition-all ${
                input.trim() 
                  ? 'bg-[#205EA6] text-white hover:bg-[#4385BE] cursor-pointer' 
                  : 'bg-[#282726] text-[#575654] cursor-not-allowed'
              }`}
            >
              <Send size={11} />
            </button>
          </div>
        </div>
      </div>

    </div>
  );
}