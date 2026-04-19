/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{svelte,js,ts}'],
  theme: {
    extend: {
      colors: {
        // Base
        bg:           '#0a0a0f',
        surface:      '#111118',
        surface2:     '#16161f',
        surface3:     '#1c1c28',
        surface4:     '#22223a',
        // Borders
        border:       '#1e1e2e',
        'border-soft':'#252535',
        'border-hi':  '#2e2e4a',
        // Accent (Violet — Spotify-ish energy, Vercel precision)
        accent:       '#7c6af5',
        'accent-dim': '#5a4fc4',
        'accent-hi':  '#9d8eff',
        'accent-glow':'rgba(124,106,245,0.18)',
        // Text
        muted:        '#5a5a78',
        dim:          '#8888a8',
        soft:         '#b0b0cc',
        // Semantic
        positive:     '#1db954',   // Spotify green
        warn:         '#f59e0b',
        danger:       '#ef4444',
        info:         '#38bdf8',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', '14px'],
      },
      boxShadow: {
        glow:      '0 0 32px rgba(124,106,245,0.22)',
        'glow-sm': '0 0 14px rgba(124,106,245,0.14)',
        'glow-lg': '0 0 48px rgba(124,106,245,0.30)',
        card:      '0 8px 32px rgba(0,0,0,0.55)',
        'card-sm': '0 2px 12px rgba(0,0,0,0.40)',
        'inner-accent': 'inset 0 0 0 1px rgba(124,106,245,0.25)',
      },
      backgroundImage: {
        'gradient-accent': 'linear-gradient(135deg, #7c6af5 0%, #9d8eff 100%)',
        'gradient-surface': 'linear-gradient(180deg, #111118 0%, #0a0a0f 100%)',
        'gradient-card': 'linear-gradient(135deg, rgba(124,106,245,0.08) 0%, rgba(124,106,245,0.02) 100%)',
        'gradient-hero': 'radial-gradient(ellipse at 50% 0%, rgba(124,106,245,0.15) 0%, transparent 60%)',
      },
      keyframes: {
        'slide-up':  { from: { transform: 'translateY(8px)', opacity: 0 }, to: { transform: 'none', opacity: 1 } },
        'slide-in':  { from: { transform: 'translateX(40px)', opacity: 0 }, to: { transform: 'none', opacity: 1 } },
        'fade-in':   { from: { opacity: 0 }, to: { opacity: 1 } },
        'pulse-glow':{ '0%,100%': { boxShadow: '0 0 8px rgba(124,106,245,0.2)' }, '50%': { boxShadow: '0 0 24px rgba(124,106,245,0.5)' } },
        'bar-fill':  { from: { width: '0%' }, to: {} },
      },
      animation: {
        'slide-up':   'slide-up 0.22s ease-out',
        'slide-in':   'slide-in 0.18s ease-out',
        'fade-in':    'fade-in 0.2s ease-out',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'bar-fill':   'bar-fill 0.8s ease-out',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
      spacing: {
        '18': '4.5rem',
        '22': '5.5rem',
      },
    },
  },
  plugins: [],
};
