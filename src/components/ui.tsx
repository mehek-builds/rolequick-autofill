import React from 'react';
import BrandMark from './BrandMark';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';

export const fieldClass =
  'min-h-11 w-full rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-950 placeholder:text-gray-500 transition-[border-color,box-shadow] focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100';

export const textAreaClass =
  `${fieldClass} resize-none py-2.5 leading-6`;

export const primaryButtonClass =
  'inline-flex min-h-11 items-center justify-center rounded-md bg-brand-600 px-4 text-sm font-semibold text-white transition-[background-color,transform] hover:bg-brand-700 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

export const secondaryButtonClass =
  'inline-flex min-h-11 items-center justify-center rounded-md border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 transition-[background-color,border-color] hover:border-gray-400 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

export const textButtonClass =
  'inline-flex min-h-10 items-center justify-center rounded-md px-2 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-50 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

export const iconButtonClass =
  'inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

interface PopupHeaderProps {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  children?: React.ReactNode;
}

export function PopupHeader({ title = 'Litos', subtitle, onBack, children }: PopupHeaderProps) {
  return (
    <header className="sticky top-0 z-20 flex min-h-14 items-center gap-2 border-b border-gray-200 bg-white px-3">
      {onBack ? (
        <button type="button" onClick={onBack} className={iconButtonClass} aria-label="Go back">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      ) : (
        // The mark has no ground of its own, so it merges into the header: no
        // tile, no border, no rounding.
        <span className="flex h-7 w-7 items-center justify-center" aria-hidden="true">
          <BrandMark className="h-6 w-6" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold text-gray-950">{title}</h1>
        {subtitle && <p className="truncate text-xs text-gray-600">{subtitle}</p>}
      </div>

      {children && <div className="flex items-center gap-0.5">{children}</div>}
    </header>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-gray-600">
      {children}
    </h2>
  );
}

/** Inline pending label: a small orb next to button/status text, never wraps.
   `onColor` is for white-text buttons on a solid brand background, where the
   orb must render light dots regardless of the popup's own light/dark mode. */
export function PendingLabel({
  children,
  state = 'working',
  onColor = false,
}: {
  children: React.ReactNode;
  state?: OrbState;
  onColor?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      <ThinkingOrb state={state} size={20} theme={onColor ? 'dark' : 'auto'} />
      <span className="whitespace-nowrap">{children}</span>
    </span>
  );
}

export function StatusDot({ tone = 'neutral' }: { tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'brand' }) {
  const color = {
    neutral: 'bg-gray-400',
    success: 'bg-success-600',
    warning: 'bg-warning-500',
    danger: 'bg-danger-600',
    brand: 'bg-brand-600',
  }[tone];

  return <span className={`h-2 w-2 flex-shrink-0 rounded-full ${color}`} aria-hidden="true" />;
}
