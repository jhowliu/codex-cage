import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web/control-room",
  plugins: [react(), tailwindcss()],
  build: {
    emptyOutDir: true,
    outDir: "../../dist/control-room",
  },
});
