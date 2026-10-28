import { useState, type FormEvent } from 'react';
import { User as UserIcon } from 'lucide-react';
import type { User } from '../../types';
import { DEFAULT_PLAN, PLAN_FEATURE_ENABLED } from '../../lib/plan';
import { useT } from '../../lib/i18n';

interface AuthScreenProps {
  onLogin: (user: User) => void;
}

/**
 * Local profile screen — this is NOT account authentication: the app runs
 * entirely on-device, never connects to a server, and the details entered here
 * are only kept in localStorage to personalize the interface.
 */
export function AuthScreen({ onLogin }: AuthScreenProps) {
  const t = useT();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();

    const userData: User = {
      name: name.trim() || email.split('@')[0] || t('sidebar.anonymous'),
      email: email.trim(),
      role: 'user',
      // While the plan feature is off no plan is written to the profile; once
      // enabled, a local profile starts on the default plan.
      ...(PLAN_FEATURE_ENABLED ? { plan: DEFAULT_PLAN } : {})
    };

    localStorage.setItem('thalamus_user', JSON.stringify(userData));
    onLogin(userData);
  };

  return (
    <div className="fixed inset-0 z-50 bg-obsidian-bg flex items-center justify-center p-4 font-sans text-obsidian-text">
      {/* Technological background grid */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#100F0F_1px,transparent_1px),linear-gradient(to_bottom,#100F0F_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_70%,transparent_100%)] opacity-30 pointer-events-none" />

      {/* Card */}
      <div className="w-full max-w-[360px] bg-obsidian-panel border border-obsidian-raise rounded-xl shadow-2xl overflow-hidden p-6 flex flex-col gap-6 relative z-10">

        {/* Header */}
        <div className="flex flex-col gap-1 text-center">
          <h1 className="hand text-[26px] leading-tight" style={{ color: 'rgb(var(--tlm-gold))' }}>Thalamus Studio</h1>
          <svg viewBox="0 0 180 8" fill="none" aria-hidden="true" className="w-[180px] h-2 mx-auto opacity-60">
            <path d="M2 5 C 26 2, 48 7, 74 4 S 128 2, 152 5 S 172 3, 178 4" stroke="#dcb67a" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <p className="text-xs text-[#A8A49E] leading-relaxed mt-2">
            {t('auth.subtitle')}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">

          <div className="flex flex-col gap-1.5">
            <label className="text-[#A8A49E] font-mono text-[11px] tracking-wider uppercase">{t('auth.nameLabel')}</label>
            <div className="relative">
              <UserIcon size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-obsidian-muted" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('sidebar.anonymous')}
                className="w-full bg-obsidian-bg border border-obsidian-raise focus:border-[#403E3C] rounded-md pl-9 pr-3 py-2 text-obsidian-text text-xs focus:outline-none transition-all"
                autoFocus
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[#A8A49E] font-mono text-[11px] tracking-wider uppercase">{t('auth.emailLabel')}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@local"
              className="w-full bg-obsidian-bg border border-obsidian-raise focus:border-[#403E3C] rounded-md px-3 py-2 text-obsidian-text text-xs focus:outline-none transition-all"
            />
          </div>

          <button
            type="submit"
            className="w-full bg-[#F2F0E5] hover:bg-[#FFFCF0] text-[#100F0F] font-semibold text-xs py-2 rounded-md transition-colors cursor-pointer mt-2"
          >
            {t('auth.continue')}
          </button>
        </form>

      </div>
    </div>
  );
}
