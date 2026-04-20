/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "#1E3A5F",
          50:  "#EBF0F7",
          100: "#C8D7EA",
          200: "#94AFCE",
          300: "#6088B2",
          400: "#3D6496",
          500: "#1E3A5F",
          600: "#18304F",
          700: "#12253F",
          800: "#0C1A2F",
          900: "#060F1F",
        },
        secondary: {
          DEFAULT: "#2E75B6",
          50:  "#EBF3FB",
          100: "#C7DEF4",
          200: "#94BEE8",
          300: "#619FDC",
          400: "#3D8ACF",
          500: "#2E75B6",
          600: "#255F96",
          700: "#1C4976",
          800: "#133356",
          900: "#0A1D36",
        },
      },
    },
  },
  plugins: [],
};
