/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Noto Sans"', 'sans-serif'],
        mono: ['"Noto Sans Mono"', 'monospace'],
        display: ['"Outfit"', 'system-ui', 'sans-serif'],
      },
      colors: {
        spire: {
          dark: '#0D1117',
          teal: '#3CE8D4',
          gold: '#D9A84E',
          red: '#C2263A',
          purple: '#7B52AB',
          green: '#2A6B45',
          cream: '#E8E4DC',
          navy: '#1A2838',
          gray: '#6B7B8D',
        },
      },
      keyframes: {
        float: {
          '0%': { transform: 'translateY(0) scale(1)', opacity: '0' },
          '10%': { opacity: '0.6' },
          '90%': { opacity: '0.15' },
          '100%': { transform: 'translateY(-500px) scale(0.4)', opacity: '0' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        ctaGlow: {
          '0%, 100%': { boxShadow: '0 0 6px #D9A84E50' },
          '50%': { boxShadow: '0 0 22px #D9A84E90, 0 0 44px #D9A84E30' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        energyPulse: {
          '0%': { transform: 'scale(0)', opacity: '0.9' },
          '100%': { transform: 'scale(4)', opacity: '0' },
        },
        titleGlow: {
          '0%, 100%': { textShadow: '0 0 8px #3CE8D430' },
          '50%': { textShadow: '0 0 20px #3CE8D460, 0 2px 12px #0D1117' },
        },
      },
      animation: {
        float: 'float linear infinite',
        shimmer: 'shimmer 3s ease-in-out infinite',
        'cta-glow': 'ctaGlow 2s ease-in-out infinite',
        'fade-in-up': 'fadeInUp 0.5s ease-out forwards',
        'energy-pulse': 'energyPulse 0.6s ease-out forwards',
        'title-glow': 'titleGlow 3s ease-in-out infinite',
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        spire: {
          'primary': '#3CE8D4',
          'secondary': '#D9A84E',
          'accent': '#C2263A',
          'neutral': '#1A2838',
          'base-100': '#0D1117',
          'base-200': '#1A2838',
          'base-300': '#1A2838',
          'info': '#3CE8D4',
          'success': '#2A6B45',
          'warning': '#D9A84E',
          'error': '#C2263A',
        },
      },
    ],
  },
};