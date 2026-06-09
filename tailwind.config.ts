import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter Variable',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
      },
      colors: {
        // Brand = soft indigo (#4F46E5), the student-native palette from the research.
        // Applied to ONE thing only per the findings: primary CTAs + key accents.
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        },
      },
      boxShadow: {
        // Outer popup container lift (only the container gets a shadow, never list items)
        popup: '0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06)',
        card: '0 1px 2px rgba(16,24,40,0.04)',
        'card-hover': '0 6px 16px rgba(79,70,229,0.12), 0 2px 6px rgba(16,24,40,0.06)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        // Cards entering: gentle rise + fade, staggered for a soft cascade
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // Data revealing inside a card (email/name appearing): "found it" feel
        reveal: {
          '0%': { opacity: '0', transform: 'scale(0.97)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        // Banners + detected-job pills dropping in
        'slide-down': {
          '0%': { opacity: '0', transform: 'translateY(-6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // Screen transitions sliding in from the right
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        // Skeleton loading shimmer sweep
        shimmer: {
          '0%': { backgroundPosition: '-450px 0' },
          '100%': { backgroundPosition: '450px 0' },
        },
        // Success checkmark popping into place
        'check-pop': {
          '0%': { transform: 'scale(0)', opacity: '0' },
          '55%': { transform: 'scale(1.25)', opacity: '1' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        // Milestone celebration: a little springy pop
        'pop-in': {
          '0%': { opacity: '0', transform: 'scale(0.6)' },
          '60%': { transform: 'scale(1.08)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        // Confetti pieces falling for the "sent!" moment
        'confetti-fall': {
          '0%': { opacity: '1', transform: 'translateY(-8px) rotate(0deg)' },
          '100%': { opacity: '0', transform: 'translateY(30px) rotate(220deg)' },
        },
        // Soft attention pulse on the credits badge / detected job
        'soft-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
        // Gentle vertical float for the onboarding logo mark
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-5px)' },
        },
        // Slow ambient drift for the decorative header orbs
        'blob-drift': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '50%': { transform: 'translate(10px, -12px) scale(1.1)' },
        },
        // Very slow animated gradient pan across the header
        'gradient-pan': {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        // Breathing glow ring behind the logo
        glow: {
          '0%, 100%': { opacity: '0.45', transform: 'scale(1)' },
          '50%': { opacity: '0.8', transform: 'scale(1.08)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'fade-in-up': 'fade-in-up 0.34s cubic-bezier(0.16,1,0.3,1) both',
        reveal: 'reveal 0.22s ease-out both',
        'slide-down': 'slide-down 0.24s cubic-bezier(0.16,1,0.3,1) both',
        'slide-in-right': 'slide-in-right 0.26s cubic-bezier(0.16,1,0.3,1) both',
        shimmer: 'shimmer 1.4s linear infinite',
        'check-pop': 'check-pop 0.34s cubic-bezier(0.16,1,0.3,1) both',
        'pop-in': 'pop-in 0.4s cubic-bezier(0.18,1.25,0.4,1) both',
        'confetti-fall': 'confetti-fall 0.9s ease-out forwards',
        'soft-pulse': 'soft-pulse 2s ease-in-out infinite',
        float: 'float 4s ease-in-out infinite',
        'blob-drift': 'blob-drift 11s ease-in-out infinite',
        'blob-drift-slow': 'blob-drift 16s ease-in-out infinite',
        'gradient-pan': 'gradient-pan 9s ease-in-out infinite',
        glow: 'glow 3.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
