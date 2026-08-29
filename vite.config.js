import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
    build: {
        outDir: "dist",
        emptyOutDir: true,

        rollupOptions: {
            input: {
                popup: "popup.html"
            },

            output: {
                entryFileNames: "[name].js",
                chunkFileNames: "assets/[name]-[hash].js",
                assetFileNames: "assets/[name]-[hash][extname]"
            }
        }
    },

    plugins: [
        viteStaticCopy({
            targets: [
                {
                    src: "manifest.json",
                    dest: "."
                },
                {
                    src: "icons",
                    dest: "."
                },
                {
                    src: "libs",
                    dest: "."
                },
                {
                    src: "models",
                    dest: "."
                },
                {
                    src: "contentScript.js",
                    dest: "."
                },
                {
                    src: "ocr.js",
                    dest: "."
                },
                {
                    src: "pii.js",
                    dest: "."
                },
                {
                    src: "sanitize.js",
                    dest: "."
                },
                {
                    src: "styles.css",
                    dest: "."
                },
                {
                    src: "textOverlay.js",
                    dest: "."
                },
                {
                    src: "yolo.js",
                    dest: "."
                }
            ]
        })
    ]
});