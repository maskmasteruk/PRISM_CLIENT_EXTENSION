import { detectFaces, loadFaceDetectionModel } from "./face.js";
import { detectPII, loadPIIModel } from "./pii.js";

let faceModelPromise = null;
let piiModelPromise = null;

function extensionUrl(path) {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(path);
    }

    return path;
}

function createTesseractOptions(options = {}) {
    return {
        workerPath: extensionUrl("libs/tesseract/worker.min.js"),
        corePath: extensionUrl("libs/tesseract/core/"),
        langPath: extensionUrl("libs/tesseract/lang/"),
        cacheMethod: "none",
        workerBlobURL: false,
        gzip: true,
        ...options,
    };
}

function ensureFaceDetectionModel() {
    if (!faceModelPromise) {
        faceModelPromise = loadFaceDetectionModel().catch((error) => {
            faceModelPromise = null;
            throw error;
        });
    }

    return faceModelPromise;
}

function ensurePIIModel() {
    if (!piiModelPromise) {
        piiModelPromise = loadPIIModel().then((result) => {
            if (!result?.success) {
                throw new Error(result?.error || "PII model failed to load.");
            }

            return result;
        }).catch((error) => {
            piiModelPromise = null;
            throw error;
        });
    }

    return piiModelPromise;
}

export async function sanitizeScreenshot(screenshotSource) {
    // 1. Create a working Canvas from the input screenshot
    const img = await loadImageSource(screenshotSource);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    // -------------------------------------------------------------
    // STEP 1: Detect and Blur Faces (BlazeFace)
    // -------------------------------------------------------------
    try {
        await ensureFaceDetectionModel();
        const faces = await detectFaces(img);

        for (const face of faces) {
            const box = getExpandedFaceBox(face, canvas.width, canvas.height);

            if (box) {
                applyBlur(ctx, box.x, box.y, box.width, box.height, 24);
            }
        }
    } catch (err) {
        console.warn("Face blurring skipped or failed:", err);
    }

    // -------------------------------------------------------------
    // STEP 2 & 3: Extract Text (OCR) & Detect PII
    // -------------------------------------------------------------
    try {
        // Tesseract direct recognition to retain word-level bounding boxes
        const ocrResult = await Tesseract.recognize(canvas, "eng", createTesseractOptions());
        const fullText = ocrResult.data.text.trim();

        if (fullText) {
            await ensurePIIModel();
            const piiResult = await detectPII(fullText);

            if (piiResult.success && piiResult.entities.length > 0) {
                const words = ocrResult.data.words; // List of detected words with bbox coordinates
                const piiAnnotations = [];
                const seenPiiRegions = new Set();

                // Match PII entities to OCR words and blur them
                for (const entity of piiResult.entities) {
                    const entityText = normalizePiiText(entity.text);

                    if (!entityText) {
                        continue;
                    }

                    for (const word of words) {
                        const cleanWordText = normalizePiiText(word.text);

                        if (!cleanWordText) {
                            continue;
                        }

                        if (cleanWordText.includes(entityText) || entityText.includes(cleanWordText)) {
                            const box = getWordBox(word);

                            if (!box) {
                                continue;
                            }

                            const tag = formatPiiTag(entity.label);
                            const regionKey = `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}:${tag}`;

                            applyPiiBlur(ctx, box);

                            if (!seenPiiRegions.has(regionKey)) {
                                seenPiiRegions.add(regionKey);
                                piiAnnotations.push({
                                    ...box,
                                    label: tag,
                                });
                            }
                        }
                    }
                }

                for (const annotation of piiAnnotations) {
                    drawPiiTag(
                        ctx,
                        annotation.label,
                        annotation.x,
                        annotation.y,
                        annotation.width,
                        annotation.height
                    );
                }
            }
        }
    } catch (err) {
        console.warn("OCR / PII processing failed:", err);
    }

    return canvas;
}

function getExpandedFaceBox(face, canvasWidth, canvasHeight) {
    const topLeft = pointToArray(face.topLeft);
    const bottomRight = pointToArray(face.bottomRight);

    if (topLeft.length < 2 || bottomRight.length < 2) {
        return null;
    }

    const left = Number(topLeft[0]);
    const top = Number(topLeft[1]);
    const right = Number(bottomRight[0]);
    const bottom = Number(bottomRight[1]);

    if (![left, top, right, bottom].every(Number.isFinite)) {
        return null;
    }

    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) {
        return null;
    }

    const padX = Math.max(8, width * 0.12);
    const padY = Math.max(8, height * 0.18);
    const x0 = clamp(left - padX, 0, canvasWidth);
    const y0 = clamp(top - padY, 0, canvasHeight);
    const x1 = clamp(right + padX, 0, canvasWidth);
    const y1 = clamp(bottom + padY, 0, canvasHeight);

    return {
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
    };
}

function pointToArray(point) {
    if (Array.isArray(point)) {
        return point;
    }

    if (point?.dataSync) {
        return Array.from(point.dataSync());
    }

    return [];
}

function normalizePiiText(value) {
    return String(value || "")
        .replace(/##/g, "")
        .toLowerCase()
        .trim();
}

function getWordBox(word) {
    const { x0, y0, x1, y1 } = word?.bbox || {};
    const left = Number(x0);
    const top = Number(y0);
    const right = Number(x1);
    const bottom = Number(y1);

    if (![left, top, right, bottom].every(Number.isFinite)) {
        return null;
    }

    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) {
        return null;
    }

    return {
        x: left,
        y: top,
        width,
        height,
    };
}

function formatPiiTag(label) {
    const tag = String(label || "PII")
        .replace(/^[BI]-/i, "")
        .trim();

    return (tag || "PII").toUpperCase();
}

function drawPiiTag(ctx, label, x, y, width, height) {
    const tag = formatPiiTag(label);
    const box = clampBox(ctx, x, y, width, height);

    if (!box) {
        return;
    }

    const fontSize = Math.round(clamp(height * 0.55, 11, 18));
    const paddingX = 6;
    const tagHeight = fontSize + 7;
    const gap = 2;
    const margin = 2;

    ctx.save();
    ctx.font = `700 ${fontSize}px Arial, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";

    const canvasWidth = ctx.canvas.width;
    const canvasHeight = ctx.canvas.height;
    const measuredTextWidth = ctx.measureText(tag).width;
    const tagWidth = Math.min(
        Math.max(box.width, measuredTextWidth + paddingX * 2),
        canvasWidth - margin * 2
    );
    const left = clamp(box.x, margin, canvasWidth - tagWidth - margin);
    const hasRoomAbove = box.y - tagHeight - gap >= margin;
    const top = hasRoomAbove
        ? box.y - tagHeight - gap
        : clamp(box.y, margin, canvasHeight - tagHeight - margin);
    const fittedText = fitCanvasText(ctx, tag, tagWidth - paddingX * 2);

    ctx.fillStyle = "#1d4ed8";
    ctx.fillRect(left, top, tagWidth, tagHeight);

    ctx.strokeStyle = "rgba(29, 78, 216, 0.85)";
    ctx.lineWidth = 1;
    ctx.strokeRect(box.x, box.y, box.width, box.height);

    ctx.fillStyle = "#ffffff";
    ctx.fillText(fittedText, left + tagWidth / 2, top + tagHeight / 2);
    ctx.restore();
}

function fitCanvasText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) {
        return text;
    }

    const suffix = "...";
    let fitted = text;

    while (fitted.length > 0 && ctx.measureText(`${fitted}${suffix}`).width > maxWidth) {
        fitted = fitted.slice(0, -1);
    }

    return fitted ? `${fitted}${suffix}` : suffix;
}

function clampBox(ctx, x, y, width, height) {
    if (width <= 0 || height <= 0) return null;

    const left = clamp(x, 0, ctx.canvas.width);
    const top = clamp(y, 0, ctx.canvas.height);
    const right = clamp(x + width, 0, ctx.canvas.width);
    const bottom = clamp(y + height, 0, ctx.canvas.height);

    if (right <= left || bottom <= top) return null;

    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };
}

function applyPiiBlur(ctx, box) {
    applyBlur(ctx, box.x, box.y, box.width, box.height, 15);
}

function applyBlur(ctx, x, y, width, height, blurRadius = 15) {
    const box = clampBox(ctx, x, y, width, height);

    if (!box) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.clip();

    ctx.filter = `blur(${blurRadius}px)`;
    // Draw the canvas onto itself to apply the blur filter over the clip region
    ctx.drawImage(ctx.canvas, 0, 0);

    ctx.restore();
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
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
