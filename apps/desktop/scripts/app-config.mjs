import { readFile } from "node:fs/promises";

export const tauriConfig = JSON.parse(
  await readFile(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ),
);

export const productName = tauriConfig.productName;
if (typeof productName !== "string" || !productName.trim())
  throw new Error("Set productName in src-tauri/tauri.conf.json.");

export const productSlug = productName
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");
if (!productSlug)
  throw new Error(
    "productName must contain at least one ASCII letter or digit.",
  );

export const executableName = `${productName}.exe`;
