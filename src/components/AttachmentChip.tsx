import {
  FileText, FileImage, FileAudio, FileVideo, FileArchive, FileSpreadsheet,
  FileCode2, File as FileIcon, X, AlertTriangle, Loader2,
} from 'lucide-react';
import { useT } from '../lib/i18n';
import { formatBytes, type Attachment } from '../lib/attachments';

function KindIcon({ kind }: { kind: Attachment['kind'] }) {
  switch (kind) {
    case 'image': return <FileImage size={12} className="flex-shrink-0" />;
    case 'audio': return <FileAudio size={12} className="flex-shrink-0" />;
    case 'video': return <FileVideo size={12} className="flex-shrink-0" />;
    case 'archive': return <FileArchive size={12} className="flex-shrink-0" />;
    case 'spreadsheet': return <FileSpreadsheet size={12} className="flex-shrink-0" />;
    case 'text': return <FileCode2 size={12} className="flex-shrink-0" />;
    case 'pdf':
    case 'office': return <FileText size={12} className="flex-shrink-0" />;
    default: return <FileIcon size={12} className="flex-shrink-0" />;
  }
}

/**
 * The single attachment chip used everywhere: shows type, name, size, read
 * state and whether the content actually goes to the model.
 */
export function AttachmentChip({
  attachment: a,
  onPreview,
  onRemove,
  className = '',
}: {
  attachment: Attachment;
  onPreview?: (a: Attachment) => void;
  onRemove?: (a: Attachment) => void;
  className?: string;
}) {
  const t = useT();
  const failed = a.status === 'error' || (a.kind === 'pdf' && !a.modelReadable && !!a.error);
  const reading = a.status === 'reading';
  const status = reading
    ? t('attach.reading')
    : failed
      ? t('attach.readError')
      : formatBytes(a.size);
  const title = [
    a.name,
    a.path ?? '',
    a.error ?? '',
    a.modelReadable ? t('attach.sentToModel') : t('attach.previewOnly'),
  ].filter(Boolean).join('\n');

  return (
    <div
      role={onPreview ? 'button' : undefined}
      tabIndex={onPreview ? 0 : undefined}
      onClick={onPreview ? () => onPreview(a) : undefined}
      onKeyDown={onPreview ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPreview(a);
        }
      } : undefined}
      title={title}
      className={`group flex max-w-[250px] items-center gap-1 rounded border px-1.5 py-1 font-mono text-[10.5px] transition-colors ${
        failed
          ? 'border-[#D14D41]/60 bg-[#D14D41]/10 text-[#F0A8A2]'
          : 'border-obsidian-raise bg-obsidian-surface text-obsidian-soft hover:border-[#dcb67a]/50'
      } ${onPreview ? 'cursor-pointer' : ''} ${className}`}
    >
      {reading ? <Loader2 size={12} className="flex-shrink-0 animate-spin" /> : <KindIcon kind={a.kind} />}
      <span className="truncate">{a.name}</span>
      <span className={`flex-shrink-0 ${failed ? 'text-[#F0A8A2]/80' : 'text-obsidian-muted'}`}>
        {status}
      </span>
      {!reading && !failed && (
        <span
          className={`flex-shrink-0 rounded px-1 text-[8.5px] uppercase tracking-wide ${
            a.modelReadable
              ? 'bg-[#3AA99F]/15 text-[#3AA99F]'
              : 'bg-white/5 text-obsidian-muted'
          }`}
        >
          {a.modelReadable ? t('attach.badgeModel') : t('attach.badgePreview')}
        </span>
      )}
      {failed && <AlertTriangle size={10} className="flex-shrink-0" />}
      {onRemove && (
        <button
          type="button"
          aria-label={t('common.remove')}
          onClick={(e) => { e.stopPropagation(); onRemove(a); }}
          className="ml-0.5 flex-shrink-0 cursor-pointer text-obsidian-muted hover:text-rose-400"
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}
