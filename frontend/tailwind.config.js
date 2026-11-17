/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        page: token('page'),
        surface: token('surface'),
        raised: token('raised'),
        wash: token('wash'),
        fg: {
          DEFAULT: token('fg'),
          secondary: token('fg-secondary'),
          muted: token('fg-muted'),
        },
        line: {
          DEFAULT: token('line'),
          strong: token('line-strong'),
        },
        primary: {
          DEFAULT: token('primary'),
          fg: token('primary-fg'),
          wash: token('primary-wash'),
        },
        danger: {
          DEFAULT: token('danger'),
          fg: token('danger-fg'),
          wash: token('danger-wash'),
        },
        success: {
          DEFAULT: token('success'),
          wash: token('success-wash'),
        },
        warning: {
          DEFAULT: token('warning'),
          wash: token('warning-wash'),
        },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'pop-in': {
          from: { opacity: '0', transform: 'translate(-50%, -48%) scale(0.97)' },
          to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'pop-in': 'pop-in 150ms ease-out',
      },
    },
  },
  plugins: [],
};
