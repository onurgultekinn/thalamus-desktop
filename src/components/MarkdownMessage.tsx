import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { SyntaxHighlighter, vscDarkPlus } from '../lib/codeHighlight';

interface MarkdownMessageProps {
  content: string;
}

/**
 * Markdown message body. `memo`: when a new message is added to the chat, old
 * messages (and their Prism highlight passes) don't re-run — a big difference
 * per keystroke in long chats.
 */
export const MarkdownMessage: React.FC<MarkdownMessageProps> = React.memo(({ content }) => {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  return (
    <div className="relative text-zinc-300 text-[13px] leading-relaxed word-break-words">
      <ReactMarkdown
        components={{
          h1({ children }) {
            return (
              <h1 className="text-[1.1rem] font-bold text-zinc-100 mt-3 mb-1.5 border-b border-zinc-800 pb-1">
                {children}
              </h1>
            );
          },
          h2({ children }) {
            return (
              <h2 className="text-[1rem] font-semibold text-zinc-200 mt-2.5 mb-1">
                {children}
              </h2>
            );
          },
          p({ children }) {
            return <p className="mt-0.5 mb-1 leading-normal text-zinc-300">{children}</p>;
          },
          ol({ children }) {
            return <ol className="pl-4 mb-1.5 mt-0.5 list-decimal">{children}</ol>;
          },
          ul({ children }) {
            return <ul className="pl-4 mb-1.5 mt-0.5 list-disc">{children}</ul>;
          },
          li({ children }) {
            return <li className="mb-0.5">{children}</li>;
          },
          code({ inline, className, children, style: _codeStyle, ...props }: React.ComponentPropsWithoutRef<'code'> & { inline?: boolean }) {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');
            const currentLang = match ? match[1] : 'text';

            if (!inline && match) {
              return (
                /* Uses the palette's code background #100F0F instead of bg-[#100F0F] */
                <div className="my-2 rounded-md overflow-hidden border border-zinc-800 bg-[#100F0F] relative text-left">
                  
                  {/* Uses the top-menu color #1C1B1A instead of bg-[#0c0c0d] */}
                  <div className="flex items-center justify-between px-3 py-1.5 bg-[#1C1B1A] border-b border-zinc-800 font-mono text-[11px]">
                    <span className="text-cyan-400 font-semibold">{currentLang}</span>
                    
                    <button 
                      type="button"
                      onClick={() => handleCopy(codeString)} 
                      className="inner-code-copy-btn flex items-center gap-1 text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                      {copiedCode === codeString ? (
                        <span className="text-emerald-400">✓ Copied!</span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                          </svg>
                          Copy code
                        </span>
                      )}
                    </button>
                  </div>
                  
                  <SyntaxHighlighter
                    style={vscDarkPlus as unknown as Record<string, React.CSSProperties>}
                    language={currentLang}
                    PreTag="div"
                    showLineNumbers={true}
                    wrapLines={true}
                    lineProps={{ className: 'vscode-line-row' }} 
                    lineNumberStyle={{
                      minWidth: '28px',
                      paddingRight: '12px',
                      color: '#575654',
                      textAlign: 'right',
                      userSelect: 'none',
                      display: 'inline-block',
                    }}
                    customStyle={{
                      margin: 0,
                      padding: '0.75rem 0.85rem 0.75rem 0.5rem',
                      /* #100F0F integrated as background instead of '#100F0F' */
                      background: '#100F0F',
                      fontFamily: "'Cascadia Code', 'Ubuntu Sans Mono', Consolas, monospace",
                      fontSize: '0.8rem',
                      lineHeight: '1.6'
                    }}
                    {...props}
                  >
                    {codeString}
                  </SyntaxHighlighter>

                </div>
              );
            }

            return (
              <code className="bg-zinc-800 text-cyan-300 px-1.5 py-0.5 rounded font-mono text-[0.775rem]" {...props}>
                {children}
              </code>
            );
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
