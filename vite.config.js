import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
    build: {
        outDir: "dist",
        emptyOutDir: true,

        rollupOptions: {
            input: {
                background: "background.js",
                offscreen: "offscreen.html",
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
                    src: "models/bert-small-pii-web/**/*",
                    dest: "models",
                    rename: {
                        stripBase: 1
                    }
                },
                {
                    src: "models/blazeface/**/*",
                    dest: "models",
                    rename: {
                        stripBase: 1
                    }
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
                    src: "face.js",
                    dest: "."
                }
            ]
        })
    ]
});
