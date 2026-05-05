/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        noto: ['"Noto Sans"', 'sans-serif'],
      },
      colors: {
        'ikea-blue': '#0051BA',
        'ikea-yellow': '#FFDA1A',
        'ikea-dark': '#111111',
        'ikea-gray': '#E0E0E0',
        'ikea-light': '#F5F5F5',
        'ikea-green': '#046A38',
        'ikea-cobalt': '#0047AB',
        'ikea-bordeaux': '#722F37',
        'ikea-gold': '#E8D44D',
        'ikea-wood': '#C8A97E',
        'ikea-charcoal': '#333333',
        'ikea-navy': '#1A1A2E',
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        ikea: {
          'primary': '#0051BA',
          'secondary': '#FFDA1A',
          'accent': '#046A38',
          'neutral': '#111111',
          'base-100': '#FFFFFF',
          'base-200': '#F5F5F5',
          'base-300': '#E0E0E0',
          'info': '#0047AB',
          'success': '#046A38',
          'warning': '#E8D44D',
          'error': '#722F37',
        },
      },
    ],
  },
};
