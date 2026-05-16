import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

function copyExtensionFiles(): Plugin {
  return {
    name: "copy-extension-files",
    async closeBundle() {
      const copies = [
        ["manifest.json", "dist/manifest.json"],
        ["src/popup/popup.html", "dist/popup.html"],
        ["src/popup/popup.css", "dist/popup.css"],
        ["src/preview/preview.html", "dist/preview.html"],
        ["src/preview/preview.css", "dist/preview.css"]
      ] as const;

      await Promise.all(
        copies.map(async ([from, to]) => {
          const target = resolve(to);
          await mkdir(dirname(target), { recursive: true });
          await copyFile(resolve(from), target);
        })
      );
    }
  };
}

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist",
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        content: resolve(__dirname, "src/content.ts"),
        popup: resolve(__dirname, "src/popup/popup.ts"),
        preview: resolve(__dirname, "src/preview/preview.ts")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  },
  plugins: [copyExtensionFiles()]
});
