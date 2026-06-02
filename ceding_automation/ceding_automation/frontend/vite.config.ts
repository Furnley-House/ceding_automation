import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Local dev proxies /api/* to staging backend. Bypasses CORS because
      // the browser sees same-origin localhost:5173. Revert this target to
      // http://localhost:3001 when working against a local backend.
      "/api": {
        target: "https://ca-cedingai-backend-staging.delightfulpond-8e29b388.uksouth.azurecontainerapps.io",
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
