import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const tauriConfig = JSON.parse(
  readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const productName = tauriConfig.productName;
if (typeof productName !== "string" || !productName.trim())
  throw new Error("Set productName in src-tauri/tauri.conf.json.");

const htmlProductName = productName.replace(
  /[&<>"']/g,
  (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character] ?? character,
);

export default defineConfig({
  plugins: [
    react(),
    {
      name: "tauri-product-name",
      transformIndexHtml(html) {
        return html.replaceAll("%APP_NAME%", htmlProductName);
      },
    },
  ],
  define: { __APP_NAME__: JSON.stringify(productName) },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
});
