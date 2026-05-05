/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'af-navy': '#002157',
        'af-red': '#F71D25',
        'af-dark-red': '#931116',
        'af-blue': '#1A3A6B',
        'af-light-blue': '#CCE5FF',
        'af-gray': '#F5F5F5',
        'af-gray-dark': '#E0E0E0',
      },
      fontFamily: {
        'neo-sans': ['"Neo Sans"', 'Montserrat', 'system-ui', 'sans-serif'],
        'frutiger': ['Frutiger', '"Source Sans 3"', 'system-ui', 'sans-serif'],
        'brand': ['"Excellence In Motion"', '"Neo Sans"', 'Montserrat', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'badge-pop': {
          '0%': { opacity: '0', transform: 'scale(0.4)' },
          '60%': { transform: 'scale(1.18)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'subtle-float': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-3px)' },
        },
      },
      animation: {
        'slide-up': 'slide-up 0.45s ease-out forwards',
        'badge-pop': 'badge-pop 0.4s ease-out forwards',
        'subtle-float': 'subtle-float 3s ease-in-out infinite',
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        airfrance: {
          'primary': '#002157',
          'secondary': '#F71D25',
          'accent': '#1A3A6B',
          'neutral': '#000000',
          'base-100': '#FFFFFF',
          'base-200': '#F5F5F5',
          'base-300': '#E0E0E0',
          'info': '#D1ECF1',
          'success': '#D4EDDA',
          'warning': '#FFF3CD',
          'error': '#F8D7DA',
        },
      },
    ],
  },
};