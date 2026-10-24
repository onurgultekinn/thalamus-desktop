import { useEffect, useState } from 'react';
import { Check, HelpCircle } from 'lucide-react';
import { useT } from '../lib/i18n';
import type { AskQuestion, AskQuestionOption } from '../types';

interface AskQuestionCardProps {
  question: AskQuestion;
  answered?: string;
  disabled?: boolean;
  onAnswer: (answer: string) => void;
}

export function AskQuestionCard({ question, answered, disabled = false, onAnswer }: AskQuestionCardProps) {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const [showCustom, setShowCustom] = useState(question.allowOther !== false && question.options.length === 0);

  useEffect(() => {
    setSelected([]);
    setCustom('');
    setShowCustom(question.allowOther !== false && question.options.length === 0);
  }, [question]);

  const multiple = question.multiple === true;
  const canType = question.allowOther !== false;
  const inactive = disabled && !answered;

  const choose = (option: AskQuestionOption) => {
    if (answered || disabled) return;
    if (multiple) {
      setSelected((prev) => (
        prev.includes(option.label)
          ? prev.filter((label) => label !== option.label)
          : [...prev, option.label]
      ));
      return;
    }
    onAnswer(option.label);
  };

  const submit = () => {
    const text = [...selected, custom.trim()].filter(Boolean).join(', ');
    if (!text || answered || disabled) return;
    onAnswer(text);
  };

  return (
    <div className="mt-1 border-l-2 border-[#dcb67a]/45 pl-3">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.13em] text-[#8F8B83]">
        <HelpCircle size={12} strokeWidth={1.8} className="shrink-0 text-[#dcb67a]/80" />
        <span className="truncate">{question.header || t('chat.question.label')}</span>
      </div>

      <p className="mt-1.5 text-[13px] leading-relaxed text-[#EDE9DD]">{question.question}</p>

      {answered ? (
        <div className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-snug text-[#B9B4A8]">
          <Check size={12} strokeWidth={2} className="mt-[2px] shrink-0 text-[#dcb67a]" />
          <span className="min-w-0 break-words">{answered}</span>
        </div>
      ) : (
        <>
          {multiple && (
            <p className="mt-1 text-[10.5px] text-[#7E7A73]">{t('chat.question.multipleHint')}</p>
          )}

          {question.options.length > 0 && (
            <div
              className="mt-2 flex flex-col gap-1"
              role={multiple ? 'group' : 'radiogroup'}
              aria-label={question.question}
            >
              {question.options.map((option) => {
                const active = selected.includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    role={multiple ? 'checkbox' : 'radio'}
                    aria-checked={active}
                    disabled={inactive}
                    onClick={() => choose(option)}
                    className={`group flex w-full items-start gap-2 rounded-[4px] border px-2.5 py-1.5 text-left transition-colors disabled:cursor-default ${
                      active
                        ? 'border-[#dcb67a]/55 bg-[#dcb67a]/[0.07]'
                        : 'border-white/[0.08] bg-transparent hover:border-[#dcb67a]/30 hover:bg-white/[0.025]'
                    }`}
                  >
                    <span
                      className={`mt-[3px] flex h-3 w-3 shrink-0 items-center justify-center border transition-colors ${
                        multiple ? 'rounded-[2px]' : 'rounded-full'
                      } ${active ? 'border-[#dcb67a] bg-[#dcb67a]' : 'border-white/25 group-hover:border-[#dcb67a]/55'}`}
                    >
                      {active && <Check size={8} strokeWidth={3} className="text-[#1A1917]" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12px] leading-snug text-[#E6E2D8]">{option.label}</span>
                      {option.description && (
                        <span className="mt-0.5 block text-[10.5px] leading-snug text-[#8C8880]">{option.description}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {canType && (
            <div className="mt-1.5">
              {!showCustom ? (
                <button
                  type="button"
                  disabled={inactive}
                  onClick={() => setShowCustom(true)}
                  className="cursor-pointer text-[11px] text-[#9A968D] underline decoration-white/15 underline-offset-2 transition-colors hover:text-[#dcb67a] disabled:cursor-default disabled:opacity-50"
                >
                  {t('chat.question.other')}
                </button>
              ) : (
                <input
                  value={custom}
                  disabled={inactive}
                  onChange={(event) => setCustom(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={t('chat.question.otherPlaceholder')}
                  className="w-full border-0 border-b border-white/[0.12] bg-transparent px-0 py-1.5 text-[12px] text-[#EDE9DD] outline-none transition-colors placeholder:text-[#6F6B64] focus:border-[#dcb67a]/55 disabled:opacity-50"
                />
              )}
            </div>
          )}

          {inactive && (
            <p className="mt-1.5 text-[10.5px] text-[#7E7A73]">{t('chat.question.inactive')}</p>
          )}

          {(multiple || showCustom) && !inactive && (
            <button
              type="button"
              onClick={submit}
              disabled={(!selected.length && !custom.trim()) || disabled}
              className="mt-2 cursor-pointer rounded-[4px] border border-[#dcb67a]/30 bg-[#dcb67a]/10 px-2.5 py-1 text-[11px] font-medium text-[#dcb67a] transition-colors hover:border-[#dcb67a]/50 hover:bg-[#dcb67a]/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('chat.question.submit')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
