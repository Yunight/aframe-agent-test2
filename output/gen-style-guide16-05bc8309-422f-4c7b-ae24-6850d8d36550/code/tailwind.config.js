/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        lidl: ["'Lidl Font Pro'", 'Arial', 'sans-serif'],
      },
      colors: {
        'lidl-blue': '#015AA2',
        'lidl-yellow': '#FFF200',
        'lidl-red': '#EE1C25',
        'lidl-darkblue': '#002395',
        'lidl-gold': '#FFD700',
        'lidl-green': '#4CAF50',
        'lidl-dark': '#1A1A2E',
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        lidl: {
          primary: '#015AA2',
          secondary: '#FFF200',
          accent: '#EE1C25',
          neutral: '#1A1A2E',
          'base-100': '#FFFFFF',
          info: '#1565C0',
          success: '#4CAF50',
          warning: '#FFC107',
          error: '#D32F2F',
        },
      },
    ],
  },
};