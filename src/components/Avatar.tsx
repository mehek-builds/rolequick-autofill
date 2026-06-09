import React from 'react';

interface AvatarProps {
  name: string;
  /** Pixel diameter. 40 on list cards, 48 on detail views per the research. */
  size?: number;
  /** Highlight ring, e.g. for an alum the user shares a school with. */
  ring?: boolean;
}

// Soft, desaturated tints only - the student-native palette. No harsh primaries.
const PALETTE = [
  { bg: '#EEF2FF', fg: '#4338CA' }, // indigo
  { bg: '#ECFDF5', fg: '#047857' }, // emerald
  { bg: '#FFF1F2', fg: '#BE123C' }, // rose
  { bg: '#FEF3C7', fg: '#B45309' }, // amber
  { bg: '#F0F9FF', fg: '#0369A1' }, // sky
  { bg: '#F5F3FF', fg: '#6D28D9' }, // violet
  { bg: '#FDF2F8', fg: '#A21CAF' }, // fuchsia
  { bg: '#F0FDFA', fg: '#0F766E' }, // teal
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function pick(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export default function Avatar({ name, size = 40, ring = false }: AvatarProps) {
  const { bg, fg } = pick(name);
  return (
    <div
      className={`flex flex-shrink-0 items-center justify-center rounded-full font-semibold select-none ${
        ring ? 'ring-2 ring-brand-300 ring-offset-1' : ''
      }`}
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        color: fg,
        fontSize: Math.round(size * 0.36),
        letterSpacing: '0.01em',
      }}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}
