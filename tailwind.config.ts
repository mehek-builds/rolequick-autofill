import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Geist Variable',
          'Geist',
          'sans-serif',
        ],
      },
      colors: {
        gray: {
          50: '#faf9f7',
          100: '#f1efec',
          200: '#e2dfda',
          300: '#d0ccc5',
          400: '#a7a29a',
          500: '#79746d',
          600: '#625f5b',
          700: '#494641',
          800: '#302e2b',
          900: '#201f1d',
          950: '#151412',
        },
        brand: {
          50: '#f1f4ff',
          100: '#e3e9ff',
          200: '#c9d4ff',
          300: '#a5b5fa',
          400: '#7891ee',
          500: '#4e6fe0',
          600: '#3157d5',
          700: '#2948b5',
          800: '#263f92',
        },
        success: {
          50: '#eef8f1',
          200: '#b9dfc4',
          600: '#237a43',
          700: '#1d6338',
        },
        warning: {
          50: '#fff8e8',
          200: '#efd79d',
          500: '#b97a12',
          700: '#80510a',
        },
        danger: {
          50: '#fff1ef',
          200: '#f2c1ba',
          600: '#b63a2b',
          700: '#922e23',
        },
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-down': {
          '0%': { opacity: '0', transform: 'translateY(-6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-450px 0' },
          '100%': { backgroundPosition: '450px 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'fade-in-up': 'fade-in-up 0.34s cubic-bezier(0.16,1,0.3,1) both',
        'slide-down': 'slide-down 0.24s cubic-bezier(0.16,1,0.3,1) both',
        'slide-in-right': 'slide-in-right 0.26s cubic-bezier(0.16,1,0.3,1) both',
        shimmer: 'shimmer 1.4s linear infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
