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
      // Layered dev setup:
      //   frontend (5173)  →  local backend (3001)  →  staging AI BFF (Azure)
      // The frontend talks only to the local backend so new backend code
      // (e.g. the /raw document streaming endpoint) is exercised end-to-end.
      // The local backend's BFF_BASE_URL in backend/.env still points at the
      // staging AI service so we don't have to run the AI layer locally.
      //
      // To switch back to the all-staging setup, set the target to:
      //   https://ca-cedingai-backend-staging.delightfulpond-8e29b388.uksouth.azurecontainerapps.io
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
