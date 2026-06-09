import React from 'react';

// A tiny, dependency-free confetti burst. Cute, not loud - fired only on
// genuine milestones (an outreach marked sent), per the research note that
// celebration should be reserved for meaningful moments, never every action.
const PIECES = [
  { left: '12%', color: '#4F46E5', delay: 0 },
  { left: '24%', color: '#22C55E', delay: 60 },
  { left: '38%', color: '#F59E0B', delay: 20 },
  { left: '50%', color: '#EC4899', delay: 90 },
  { left: '62%', color: '#0EA5E9', delay: 40 },
  { left: '76%', color: '#8B5CF6', delay: 110 },
  { left: '88%', color: '#10B981', delay: 30 },
];

export default function Confetti() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 overflow-hidden">
      {PIECES.map((p, i) => (
        <span
          key={i}
          className="animate-confetti-fall absolute top-0 block h-1.5 w-1.5 rounded-[1px]"
          style={{
            left: p.left,
            backgroundColor: p.color,
            animationDelay: `${p.delay}ms`,
          }}
        />
      ))}
    </div>
  );
}
