import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/osrm": {
        target: "https://router.project-osrm.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/osrm/, ""),
      },
      "/owm": {
        target: "https://api.openweathermap.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/owm/, ""),
      },
    },
  },
});
