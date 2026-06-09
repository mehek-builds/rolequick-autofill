import React from 'react';

interface LoadingSpinnerProps {
  message?: string;
  size?: 'sm' | 'md' | 'lg';
}

export default function LoadingSpinner({
  message,
  size = 'md',
}: LoadingSpinnerProps) {
  const sizeClass =
    size === 'sm' ? 'h-4 w-4' : size === 'lg' ? 'h-10 w-10' : 'h-7 w-7';

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-6">
      <svg
        className={`animate-spin text-brand-600 ${sizeClass}`}
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
      {message && (
        <p className="text-sm text-gray-500 text-center px-4">{message}</p>
      )}
    </div>
  );
}
