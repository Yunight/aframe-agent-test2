import daisyui from 'daisyui';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'hotd-dark': '#0C0C14',
        'hotd-red': '#7C1009',
        'hotd-gold': '#C5A55A',
        'hotd-crimson': '#480800',
        'hotd-earth': '#28251F',
        'hotd-brown': '#624226',
        'hotd-bronze': '#927556',
        'hotd-cream': '#E5DCA9',
        'hotd-silver': '#D4D4D4'
      },
      fontFamily: {
        display: ['"Trajan Pro"', 'serif'],
        body: ['"Gotham"', 'sans-serif'],
        accent: ['"Garamond Premier Pro"', 'serif']
      },
      keyframes: {
        spark: {
          '0%': { transform: 'scale(0)', opacity: '1' },
          '100%': { transform: 'scale(3)', opacity: '0' }
        },
        breath: {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.8' },
          '50%': { transform: 'scale(1.18)', opacity: '1' }
        },
        glowPulse: {
          '0%, 100%': { opacity: '0.04' },
          '50%': { opacity: '0.1' }
        },
        ctaGlow: {
          '0%, 100%': { boxShadow: '0 0 16px rgba(124,16,9,0.25), inset 0 1px 0 rgba(197,165,90,0.1)' },
          '50%': { boxShadow: '0 0 28px rgba(124,16,9,0.5), inset 0 1px 0 rgba(197,165,90,0.2)' }
        }
      },
      animation: {
        spark: 'spark 0.7s ease-out forwards',
        breath: 'breath 2.5s ease-in-out infinite',
        'glow-pulse': 'glowPulse 3s ease-in-out infinite',
        'cta-glow': 'ctaGlow 2s ease-in-out infinite'
      }
    }
  },
  plugins: [daisyui],
  daisyui: {
    themes: [
      {
        hotd: {
          primary: '#C5A55A',
          secondary: '#7C1009',
          accent: '#927556',
          neutral: '#28251F',
          'base-100': '#0C0C14',
          'base-200': '#28251F',
          'base-300': '#624226',
          info: '#C5A55A',
          success: '#927556',
          warning: '#E5DCA9',
          error: '#7C1009'
        }
      }
    ]
  }
};