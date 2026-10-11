import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
export default defineConfig({
  plugins: [react()],
  resolve: {
    // The browser decoder uses innerHTML; select the DOM-free lookup table.
    alias: [
      {
        find: /^decode-named-character-reference$/,
        replacement: require.resolve("decode-named-character-reference"),
      },
    ],
  },
});
