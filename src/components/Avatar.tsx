import React from 'react';

interface AvatarProps {
  name: string;
  size?: number;
  ring?: boolean;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function Avatar({ name, size = 40, ring = false }: AvatarProps) {
  return (
    <div
      className={`flex flex-shrink-0 select-none items-center justify-center rounded-full bg-gray-100 font-semibold text-gray-700 ${
        ring ? 'ring-2 ring-brand-300 ring-offset-1' : ''
      }`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}
