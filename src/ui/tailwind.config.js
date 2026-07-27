/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/ui/react/**/*.{html,js,jsx}'],
  theme: {
    extend: {
      colors: { ink: '#171719', canvas: '#f6f6f4', accent: '#6757e8' },
      boxShadow: { soft: '0 1px 2px rgba(18,18,20,.04), 0 18px 50px rgba(18,18,20,.07)' },
    },
  },
  plugins: [],
};
