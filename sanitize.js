import { detectObjects } from "./yolo.js";
import { extractTextFromImage } from "./ocr.js";
import { detectPII } from "./pii.js";

export async function sanitizeScreenshot(screenshotSource) {
    // 1. Create a working Canvas from the input screenshot
    const img = await loadImageSource(screenshotSource);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    // -------------------------------------------------------------
    // STEP 1: Detect and Blur People (YOLOv8)
    // -------------------------------------------------------------
    try {
        const detections = await detectObjects(img, { confidence: 0.35 });
        const scaleX = canvas.width / 640;
        const scaleY = canvas.height / 640;

        // Filter out detected 'person' class items
        const people = detections.filter(d => d.label === "person");

        for (const person of people) {
            // Scale YOLO 640x640 coordinates back to original image dimensions
            const x = person.x * scaleX;
            const y = person.y * scaleY;
            const w = person.width * scaleX;
            const h = person.height * scaleY;

            applyBlur(ctx, x, y, w, h, 20);
        }
    } catch (err) {
        console.warn("YOLO person blurring skipped or failed:", err);
    }

    // -------------------------------------------------------------
    // STEP 2 & 3: Extract Text (OCR) & Detect PII
    // -------------------------------------------------------------
    try {
        // Tesseract direct recognition to retain word-level bounding boxes
        const ocrResult = await Tesseract.recognize(canvas, "eng");
        const fullText = ocrResult.data.text.trim();

        if (fullText) {
            const piiResult = await detectPII(fullText);

            if (piiResult.success && piiResult.entities.length > 0) {
                const words = ocrResult.data.words; // List of detected words with bbox coordinates

                // Match PII entities to OCR words and blur them
                for (const entity of piiResult.entities) {
                    const entityText = entity.text.replace(/##/g, "").toLowerCase();

                    for (const word of words) {
                        const cleanWordText = word.text.toLowerCase();

                        if (cleanWordText.includes(entityText) || entityText.includes(cleanWordText)) {
                            const { x0, y0, x1, y1 } = word.bbox;
                            const w = x1 - x0;
                            const h = y1 - y0;

                            applyBlur(ctx, x0, y0, w, h, 15);
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.warn("OCR / PII processing failed:", err);
    }

    return canvas;
}

function applyBlur(ctx, x, y, width, height, blurRadius = 15) {
    if (width <= 0 || height <= 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();

    ctx.filter = `blur(${blurRadius}px)`;
    // Draw the canvas onto itself to apply the blur filter over the clip region
    ctx.drawImage(ctx.canvas, 0, 0);

    ctx.restore();
}

function loadImageSource(source) {
    return new Promise((resolve, reject) => {
        if (source instanceof HTMLImageElement && source.complete) {
            return resolve(source);
        }

        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;

        if (source instanceof File || source instanceof Blob) {
            img.src = URL.createObjectURL(source);
        } else if (typeof source === "string") {
            img.src = source;
        } else {
            reject(new Error("Unsupported image source."));
        }
    });
}