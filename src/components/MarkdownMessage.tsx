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

  // Kopyalama başlıklı, dil rozetli blok çerçevesi — hem Prism dilinciği hem
  // dilsiz ``` blokları aynı çerçeveye oturur.
  const renderCodeBlock = (lang: string, codeString: string) => (
    <div className="my-2 rounded-md overflow-hidden border border-zinc-800 bg-[#100F0F] relative text-left">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1C1B1A] border-b border-zinc-800 font-mono text-[11px]">
        <span className="text-cyan-400 font-semibold">{lang || 'text'}</span>
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

      {lang ? (
        <SyntaxHighlighter
          style={vscDarkPlus as unknown as Record<string, React.CSSProperties>}
          language={lang}
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
            background: '#100F0F',
            fontFamily: "'Cascadia Code', 'Ubuntu Sans Mono', Consolas, monospace",
            fontSize: '0.8rem',
            lineHeight: '1.6'
          }}
        >
          {codeString}
        </SyntaxHighlighter>
      ) : (
        /* Dil etiketsiz ``` blokları inline pikap stiline düşmemeli; düz
           monospace blok olarak kalır (satır sonu korunur). */
        <div className="whitespace-pre-wrap px-3 py-2.5 font-mono text-[0.8rem] leading-[1.6] text-zinc-200">
          {codeString}
        </div>
      )}
    </div>
  );

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
          h3({ children }) {
            return <h3 className="text-[0.95rem] font-semibold text-zinc-100 mt-2.5 mb-1">{children}</h3>;
          },
          h4({ children }) {
            return <h4 className="text-[0.9rem] font-semibold text-zinc-100 mt-2 mb-0.5">{children}</h4>;
          },
          h5({ children }) {
            return <h5 className="text-[0.85rem] font-semibold text-zinc-200 mt-2 mb-0.5">{children}</h5>;
          },
          h6({ children }) {
            return <h6 className="text-[0.8rem] font-semibold text-zinc-300 mt-2 mb-0.5 uppercase tracking-wide">{children}</h6>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-2 border-cyan-500/60 bg-zinc-900/40 pl-3 pr-2 py-1 my-2 text-zinc-400 italic">
                {children}
              </blockquote>
            );
          },
          table({ children }) {
            return (
              <div className="my-2 overflow-x-auto rounded-md border border-zinc-800">
                <table className="w-full border-collapse text-[12px]">{children}</table>
              </div>
            );
          },
          thead({ children }) {
            return <thead className="bg-[#1C1B1A]">{children}</thead>;
          },
          th({ children }) {
            return <th className="border-b border-zinc-800 px-2.5 py-1.5 text-left font-semibold text-zinc-100">{children}</th>;
          },
          td({ children }) {
            return <td className="border-b border-zinc-800/60 px-2.5 py-1.5 align-top text-zinc-300">{children}</td>;
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline break-all">
                {children}
              </a>
            );
          },
          hr() {
            return <hr className="my-3 border-zinc-800" />;
          },
          // react-markdown v10+ artık 'inline' prop'u göndermiyor; blok/satır-içi
          // ayrımı şu mantıkla yapılır: tüm ``` blokları <pre> içinde gelir →
          // 'pre' onları yakalar ve çerçeveler; <pre> dışındaki 'code' satır
          // içidir.
          pre({ children }) {
            const child = Array.isArray(children) ? children[0] : children;
            if (React.isValidElement(child)) {
              const childProps = child.props as { className?: string; children?: unknown };
              const m = /language-(\w+)/.exec(childProps.className || '');
              const codeString = String(childProps.children ?? '').replace(/\n$/, '');
              return renderCodeBlock(m ? m[1] : '', codeString);
            }
            return <>{children}</>;
          },
          code({ children, className }) {
            // <pre> dışında kalan her code etiketi satır içidir; dil sınıflı
            // pre-dışı code (nadir) yine de çerçeveli blok olarak basılır.
            const m = /language-(\w+)/.exec(className || '');
            if (m) {
              const codeString = String(children).replace(/\n$/, '');
              return renderCodeBlock(m[1], codeString);
            }
            return (
              <code className="bg-zinc-800 text-cyan-300 px-1.5 py-0.5 rounded font-mono text-[0.775rem]">
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
