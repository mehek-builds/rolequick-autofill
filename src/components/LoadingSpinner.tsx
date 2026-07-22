import React from 'react';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';

interface LoadingSpinnerProps {
  message?: string;
  size?: 'sm' | 'md' | 'lg';
  state?: OrbState;
}

export default function LoadingSpinner({
  message,
  size = 'md',
  state = 'working',
}: LoadingSpinnerProps) {
  const orbSize = size === 'sm' ? 20 : 64;

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-6" role="status" aria-live="polite">
      <ThinkingOrb state={state} size={orbSize} />
      {message && (
        <p className="px-4 text-center text-sm text-gray-600">{message}</p>
      )}
      {!message && <span className="sr-only">Loading</span>}
    </div>
  );
}
