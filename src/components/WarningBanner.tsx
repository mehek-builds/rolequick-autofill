import React from 'react';

interface WarningBannerProps {
  message: string;
  variant?: 'warning' | 'error' | 'info';
}

export default function WarningBanner({
  message,
  variant = 'warning',
}: WarningBannerProps) {
  const colors =
    variant === 'error'
      ? 'bg-danger-50 border-danger-200 text-danger-700'
      : variant === 'info'
        ? 'bg-brand-50 border-brand-200 text-brand-800'
        : 'bg-warning-50 border-warning-200 text-warning-700';

  const icon =
    variant === 'error' ? (
      <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
          clipRule="evenodd"
        />
      </svg>
    ) : (
      <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
          clipRule="evenodd"
        />
      </svg>
    );

  return (
    <div
      className={`flex min-h-11 animate-slide-down items-start gap-2 rounded-md border px-3 py-2.5 text-sm leading-5 ${colors}`}
      role={variant === 'error' ? 'alert' : 'status'}
      aria-live={variant === 'error' ? 'assertive' : 'polite'}
    >
      {icon}
      <span>{message}</span>
    </div>
  );
}
