import { detectFaces, loadFaceDetectionModel } from "./face.js";
import { detectPII, loadPIIModel } from "./pii.js";

let faceModelPromise = null;
let piiModelPromise = null;
const PII_BADGE_LABEL = "PII";
const PII_DETECTION_CHUNK_SIZE = 1200;
const PII_DETECTION_CHUNK_OVERLAP = 120;

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

export async function sanitizeScreenshot(screenshotSource, options = {}) {
    // 1. Create a working Canvas from the input screenshot
    const img = await loadImageSource(screenshotSource);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const regions = resolveSanitizationRegions(options, canvas.width, canvas.height);
    logSanitizationRegions(options, regions, canvas.width, canvas.height);

    for (let index = 0; index < regions.length; index += 1) {
        const region = regions[index];
        const startTime = performance.now();

        await sanitizeFacesInCanvasRegion(ctx, region);

        const endTime = performance.now();
        const processingTimeSeconds = (endTime - startTime) / 1000;
        const timing = createRegionTiming(region, index, processingTimeSeconds);

        console.log(
            `Response Time from start to end of receiving time: ${processingTimeSeconds} s`,
            timing
        );
        notifyRegionProcessed(options, timing);
    }

    await sanitizePiiInCanvas(canvas, ctx, options);

    return canvas;
}

async function sanitizeFacesInCanvasRegion(targetCtx, region) {
    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = Math.max(1, Math.round(region.width));
    cropCanvas.height = Math.max(1, Math.round(region.height));

    const cropCtx = cropCanvas.getContext("2d");
    cropCtx.drawImage(
        targetCtx.canvas,
        region.x,
        region.y,
        region.width,
        region.height,
        0,
        0,
        cropCanvas.width,
        cropCanvas.height
    );

    await sanitizeFacesInCanvas(cropCanvas, cropCtx);
    targetCtx.drawImage(cropCanvas, region.x, region.y, region.width, region.height);
}

async function sanitizeFacesInCanvas(canvas, ctx = canvas.getContext("2d")) {
    // -------------------------------------------------------------
    // STEP 1: Detect and Blur Faces (BlazeFace)
    // -------------------------------------------------------------
    try {
        await ensureFaceDetectionModel();
        const faces = await detectFaces(canvas);

        for (const face of faces) {
            const box = getExpandedFaceBox(face, canvas.width, canvas.height);

            if (box) {
                applyBlur(ctx, box.x, box.y, box.width, box.height, 24);
            }
        }
    } catch (err) {
        console.warn("Face blurring skipped or failed:", err);
    }
}

async function sanitizePiiInCanvas(canvas, ctx = canvas.getContext("2d"), options = {}) {
    // -------------------------------------------------------------
    // STEP 2 & 3: Extract Text (OCR) & Detect PII on the full screenshot
    // -------------------------------------------------------------
    try {
        // Tesseract direct recognition to retain word-level bounding boxes
        const ocrResult = await Tesseract.recognize(canvas, "eng", createTesseractOptions());
        const ocrItems = getBestOcrTextItems(ocrResult.data || {});
        const indexedOcr = buildOcrWordIndex(ocrItems.items);
        const ocrDebugPayload = createOcrDebugPayload(
            ocrResult.data || {},
            indexedOcr,
            ocrItems,
            canvas
        );

        console.log("PRISM OCR output:", ocrDebugPayload);
        notifySanitizerDebug(options, "ocr", ocrDebugPayload);

        console.log("PRISM full screenshot OCR result:", {
            textLength: indexedOcr.text.length,
            itemCount: indexedOcr.words.length,
            granularity: ocrItems.granularity,
            screenshot: {
                width: canvas.width,
                height: canvas.height,
            },
        });

        if (!indexedOcr.text) {
            return;
        }

        const modelEntities = await detectModelPiiEntities(indexedOcr.text);
        const regexEntities = detectRegexPiiEntities(indexedOcr.text);
        const heuristicEntities = detectHeuristicPiiEntities(indexedOcr.text);
        const piiEntities = mergePiiEntities([
            ...modelEntities,
            ...regexEntities,
            ...heuristicEntities,
        ], indexedOcr.text);
        const piiDebugPayload = {
            fullText: indexedOcr.text,
            modelEntities,
            regexEntities,
            heuristicEntities,
            mergedEntities: piiEntities,
        };

        console.log("PRISM PII detect output:", piiDebugPayload);
        notifySanitizerDebug(options, "pii", piiDebugPayload);

        console.log("PRISM full screenshot PII result:", {
            modelEntityCount: modelEntities.length,
            regexEntityCount: regexEntities.length,
            heuristicEntityCount: heuristicEntities.length,
            entityCount: piiEntities.length,
        });

        blurPiiEntities(ctx, piiEntities, indexedOcr.words);
    } catch (err) {
        const normalizedError = normalizeError(err, "OCR / PII processing failed without an error message.");

        console.warn("OCR / PII processing failed:", normalizedError);
        notifySanitizerDebug(options, "error", {
            message: normalizedError.message,
            source: "ocr-pii",
        });
    }
}

function resolveSanitizationRegions(options, canvasWidth, canvasHeight) {
    const regionInput = Array.isArray(options?.mediaRegions)
        ? options.mediaRegions
        : Array.isArray(options?.regions)
            ? options.regions
            : null;

    if (!regionInput) {
        return [{
            x: 0,
            y: 0,
            width: canvasWidth,
            height: canvasHeight,
        }];
    }

    const viewportWidth = Number(options?.viewport?.width);
    const viewportHeight = Number(options?.viewport?.height);
    const scaleX = viewportWidth > 0 ? canvasWidth / viewportWidth : 1;
    const scaleY = viewportHeight > 0 ? canvasHeight / viewportHeight : scaleX;
    const regions = [];
    const seen = new Set();

    for (const region of regionInput) {
        const cssX = Number(region?.x);
        const cssY = Number(region?.y);
        const cssWidth = Number(region?.width);
        const cssHeight = Number(region?.height);

        if (![cssX, cssY, cssWidth, cssHeight].every(Number.isFinite) ||
            cssWidth <= 0 ||
            cssHeight <= 0) {
            continue;
        }

        const left = Math.floor(cssX * scaleX);
        const top = Math.floor(cssY * scaleY);
        const right = Math.ceil((cssX + cssWidth) * scaleX);
        const bottom = Math.ceil((cssY + cssHeight) * scaleY);
        const box = clampBoxToBounds(
            left,
            top,
            right - left,
            bottom - top,
            canvasWidth,
            canvasHeight
        );

        if (!box) {
            continue;
        }

        const key = `${box.x}:${box.y}:${box.width}:${box.height}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        regions.push({
            ...box,
            tag: String(region?.tag || region?.element?.tag || ""),
            element: region?.element || null,
            cssBox: {
                x: cssX,
                y: cssY,
                width: cssWidth,
                height: cssHeight,
            },
        });
    }

    return regions;
}

function logSanitizationRegions(options, regions, canvasWidth, canvasHeight) {
    const hasExplicitRegions = Array.isArray(options?.mediaRegions) || Array.isArray(options?.regions);

    if (!hasExplicitRegions) {
        return;
    }

    console.log("PRISM screenshot sanitizer crop regions:", {
        screenshot: {
            width: canvasWidth,
            height: canvasHeight,
        },
        count: regions.length,
        regions: regions.map((region, index) => ({
            index,
            tag: region.tag,
            id: region.element?.id || "",
            classes: region.element?.classes || [],
            source: region.element?.source || "",
            cssBox: region.cssBox || null,
            screenshotBox: {
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
            },
        })),
    });
}

function createRegionTiming(region, index, processingTimeSeconds) {
    return {
        index,
        tag: region.tag || "",
        id: region.element?.id || "",
        classes: region.element?.classes || [],
        source: region.element?.source || "",
        seconds: processingTimeSeconds,
        cssBox: region.cssBox || null,
        screenshotBox: {
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
        },
    };
}

function notifyRegionProcessed(options, timing) {
    if (typeof options?.onRegionProcessed !== "function") {
        return;
    }

    try {
        options.onRegionProcessed(timing);
    } catch (error) {
        console.warn("Screenshot sanitizer timing callback failed:", error);
    }
}

function notifySanitizerDebug(options, kind, payload) {
    if (typeof options?.onDebugLog !== "function") {
        return;
    }

    try {
        options.onDebugLog({ kind, payload });
    } catch (error) {
        console.warn("Screenshot sanitizer debug callback failed:", error);
    }
}

function createOcrDebugPayload(ocrData, indexedOcr, ocrItems, canvas) {
    return {
        rawText: String(ocrData.text || ""),
        indexedText: indexedOcr.text,
        confidence: Number.isFinite(Number(ocrData.confidence))
            ? Number(ocrData.confidence)
            : null,
        granularity: ocrItems.granularity,
        screenshot: {
            width: canvas.width,
            height: canvas.height,
        },
        items: indexedOcr.words.map((word, index) => ({
            index,
            text: word.text,
            start: word.start,
            end: word.end,
            bbox: word.box,
        })),
    };
}

function getBestOcrTextItems(ocrData) {
    const candidates = [
        { granularity: "word", items: getNestedOcrWords(ocrData) },
        { granularity: "line", items: getNestedOcrLines(ocrData) },
        { granularity: "paragraph", items: getNestedOcrParagraphs(ocrData) },
        { granularity: "block", items: getNestedOcrBlocks(ocrData) },
    ];

    for (const candidate of candidates) {
        const items = Array.isArray(candidate.items)
            ? candidate.items.filter((item) => String(item?.text || "").trim() && getWordBox(item))
            : [];

        if (items.length > 0) {
            return {
                granularity: candidate.granularity,
                items,
            };
        }
    }

    return {
        granularity: "none",
        items: [],
    };
}

function getNestedOcrWords(ocrData) {
    const directWords = Array.isArray(ocrData?.words) ? ocrData.words : [];

    if (directWords.length > 0) {
        return directWords;
    }

    return getNestedOcrLines(ocrData)
        .flatMap((line) => Array.isArray(line?.words) ? line.words : []);
}

function getNestedOcrLines(ocrData) {
    const directLines = Array.isArray(ocrData?.lines) ? ocrData.lines : [];

    if (directLines.length > 0) {
        return directLines;
    }

    return getNestedOcrParagraphs(ocrData)
        .flatMap((paragraph) => Array.isArray(paragraph?.lines) ? paragraph.lines : []);
}

function getNestedOcrParagraphs(ocrData) {
    const directParagraphs = Array.isArray(ocrData?.paragraphs) ? ocrData.paragraphs : [];

    if (directParagraphs.length > 0) {
        return directParagraphs;
    }

    return getNestedOcrBlocks(ocrData)
        .flatMap((block) => Array.isArray(block?.paragraphs) ? block.paragraphs : []);
}

function getNestedOcrBlocks(ocrData) {
    return Array.isArray(ocrData?.blocks) ? ocrData.blocks : [];
}

function buildOcrWordIndex(words) {
    const indexedWords = [];
    let text = "";

    for (const word of words) {
        const wordText = String(word?.text || "")
            .replace(/\s+/g, " ")
            .trim();
        const box = getWordBox(word);

        if (!wordText || !box) {
            continue;
        }

        if (text) {
            text += " ";
        }

        const start = text.length;
        text += wordText;

        indexedWords.push({
            text: wordText,
            start,
            end: text.length,
            box,
        });
    }

    return {
        text,
        words: indexedWords,
    };
}

async function detectModelPiiEntities(text) {
    try {
        await ensurePIIModel();

        const entities = [];

        for (const chunk of chunkTextForPiiDetection(text)) {
            const piiResult = await detectPII(chunk.text);

            if (!piiResult.success) {
                console.warn("PII model detection failed:", piiResult.error || "Unknown error");
                continue;
            }

            for (const entity of piiResult.entities || []) {
                const normalized = normalizePiiEntity(entity, chunk.offset, text, "model");

                if (normalized) {
                    entities.push(normalized);
                }
            }
        }

        return entities;
    } catch (error) {
        const normalizedError = normalizeError(error, "PII model detection failed without an error message.");

        console.warn("PII model detection skipped or failed:", normalizedError);
        return [];
    }
}

function chunkTextForPiiDetection(text) {
    if (text.length <= PII_DETECTION_CHUNK_SIZE) {
        return [{ text, offset: 0 }];
    }

    const chunks = [];
    let offset = 0;

    while (offset < text.length) {
        const hardEnd = Math.min(text.length, offset + PII_DETECTION_CHUNK_SIZE);
        const softEnd = hardEnd < text.length
            ? Math.max(offset + 1, text.lastIndexOf(" ", hardEnd))
            : hardEnd;
        const end = softEnd > offset ? softEnd : hardEnd;

        chunks.push({
            text: text.slice(offset, end),
            offset,
        });

        if (end >= text.length) {
            break;
        }

        offset = Math.max(end - PII_DETECTION_CHUNK_OVERLAP, offset + 1);

        while (offset < text.length && text[offset] !== " ") {
            offset += 1;
        }

        if (text[offset] === " ") {
            offset += 1;
        }
    }

    return chunks;
}

function normalizePiiEntity(entity, offset, fullText, source) {
    const startValue = Number(entity?.start);
    const endValue = Number(entity?.end);
    const hasSpan = Number.isFinite(startValue) &&
        Number.isFinite(endValue) &&
        endValue > startValue;
    const start = hasSpan
        ? clamp(Math.floor(startValue + offset), 0, fullText.length)
        : null;
    const end = hasSpan
        ? clamp(Math.ceil(endValue + offset), start, fullText.length)
        : null;
    const text = hasSpan
        ? fullText.slice(start, end)
        : String(entity?.text || "");

    if (!normalizePiiText(text)) {
        return null;
    }

    return {
        label: entity?.label || PII_BADGE_LABEL,
        text,
        start,
        end,
        source,
        confidence: Number(entity?.confidence || 0),
    };
}

function detectRegexPiiEntities(text) {
    const patterns = [
        {
            label: "EMAIL",
            regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        },
        {
            label: "SSN",
            regex: /\b\d{3}-\d{2}-\d{4}\b/g,
        },
        {
            label: "AADHAAR",
            regex: /\b\d{4}\s+\d{4}\s+\d{4}\b/g,
        },
        {
            label: "PHONE",
            regex: /(?:\+?\d[\d\s().-]{7,}\d)/g,
            validate: (value) => value.replace(/\D/g, "").length >= 8,
        },
        {
            label: "CARD",
            regex: /\b(?:\d[ -]*?){13,19}\b/g,
            validate: (value) => {
                const digits = value.replace(/\D/g, "");
                return digits.length >= 13 && digits.length <= 19;
            },
        },
    ];
    const entities = [];

    for (const pattern of patterns) {
        pattern.regex.lastIndex = 0;
        let match = pattern.regex.exec(text);

        while (match) {
            const value = match[0];

            if (!pattern.validate || pattern.validate(value)) {
                entities.push({
                    label: pattern.label,
                    text: value,
                    start: match.index,
                    end: match.index + value.length,
                    source: "regex",
                    confidence: 1,
                });
            }

            match = pattern.regex.exec(text);
        }
    }

    return entities;
}

function detectHeuristicPiiEntities(text) {
    return [
        ...detectContextNameEntities(text),
        ...detectUppercaseNameEntities(text),
    ];
}

function detectContextNameEntities(text) {
    const entities = [];
    const regex = /\b(?:let'?s\s+jump\s+in|welcome\s+back|welcome|hello|hi|hey|signed\s+in\s+as|account(?:\s+name)?|profile)\s*,?\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){1,5})/gi;
    let match = regex.exec(text);

    while (match) {
        const value = match[1];
        const offset = match[0].lastIndexOf(value);
        const start = offset >= 0 ? match.index + offset : match.index;

        if (looksLikePersonNameCandidate(value)) {
            entities.push({
                label: "PERSON",
                text: value,
                start,
                end: start + value.length,
                source: "heuristic",
                confidence: 0.85,
            });
        }

        match = regex.exec(text);
    }

    return entities;
}

function detectUppercaseNameEntities(text) {
    const entities = [];
    const regex = /\b[A-Z][A-Z.'-]{1,}(?:\s+[A-Z][A-Z.'-]{1,}){1,5}\b/g;
    let match = regex.exec(text);

    while (match) {
        const value = match[0];

        if (looksLikePersonNameCandidate(value)) {
            entities.push({
                label: "PERSON",
                text: value,
                start: match.index,
                end: match.index + value.length,
                source: "heuristic",
                confidence: 0.7,
            });
        }

        match = regex.exec(text);
    }

    return entities;
}

function looksLikePersonNameCandidate(value) {
    const normalized = normalizePiiText(value)
        .replace(/[^a-z\s.'-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (!normalized) {
        return false;
    }

    const tokens = normalized.split(/\s+/)
        .map((token) => token.replace(/^[.'-]+|[.'-]+$/g, ""))
        .filter(Boolean);

    if (tokens.length < 2 || tokens.length > 6) {
        return false;
    }

    const stopWords = new Set([
        "active",
        "agent",
        "api",
        "ask",
        "chat",
        "chats",
        "clear",
        "client",
        "console",
        "data",
        "detect",
        "edu",
        "email",
        "error",
        "file",
        "flash",
        "gemini",
        "image",
        "images",
        "input",
        "library",
        "login",
        "model",
        "new",
        "ocr",
        "output",
        "pii",
        "popup",
        "prism",
        "profile",
        "sanitize",
        "screenshot",
        "search",
        "secret",
        "server",
        "settings",
        "tab",
        "text",
        "user",
    ]);

    if (tokens.every((token) => stopWords.has(token))) {
        return false;
    }

    return tokens.every((token) => token.length >= 2 && !stopWords.has(token));
}

function mergePiiEntities(entities, text) {
    const seen = new Set();
    const merged = [];

    for (const entity of entities) {
        const normalized = normalizePiiEntity(entity, 0, text, entity.source || "model");

        if (!normalized) {
            continue;
        }

        const key = normalized.start !== null && normalized.end !== null
            ? `${normalized.start}:${normalized.end}:${formatPiiTag(normalized.label)}`
            : `${normalizePiiText(normalized.text)}:${formatPiiTag(normalized.label)}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        merged.push(normalized);
    }

    return merged.sort((left, right) => {
        if (left.start === null && right.start === null) {
            return normalizePiiText(left.text).localeCompare(normalizePiiText(right.text));
        }

        if (left.start === null) return 1;
        if (right.start === null) return -1;

        return left.start - right.start || right.end - left.end;
    });
}

function blurPiiEntities(ctx, entities, indexedWords) {
    const piiAnnotations = [];
    const seenPiiRegions = new Set();

    for (const entity of entities) {
        const boxes = getEntityWordBoxes(entity, indexedWords, ctx.canvas.width, ctx.canvas.height);

        for (const box of boxes) {
            const tag = PII_BADGE_LABEL;
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

    console.log("PRISM full screenshot PII blur result:", {
        blurredRegionCount: piiAnnotations.length,
    });

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

function getEntityWordBoxes(entity, indexedWords, canvasWidth, canvasHeight) {
    const boxes = entity.start !== null && entity.end !== null
        ? indexedWords
            .filter((word) => rangesOverlap(word.start, word.end, entity.start, entity.end))
            .map((word) => word.box)
        : [];

    if (boxes.length === 0) {
        boxes.push(...getFallbackEntityWordBoxes(entity, indexedWords));
    }

    return boxes
        .map((box) => expandWordBox(box, canvasWidth, canvasHeight))
        .filter(Boolean);
}

function getFallbackEntityWordBoxes(entity, indexedWords) {
    const entityText = normalizePiiText(entity.text);

    if (!entityText || entityText.length < 3) {
        return [];
    }

    return indexedWords
        .filter((word) => {
            const wordText = normalizePiiText(word.text);

            return wordText.length >= 3 &&
                (entityText.includes(wordText) || wordText.includes(entityText));
        })
        .map((word) => word.box);
}

function rangesOverlap(startA, endA, startB, endB) {
    return startA < endB && endA > startB;
}

function expandWordBox(box, canvasWidth, canvasHeight) {
    if (!box) {
        return null;
    }

    const padX = Math.max(2, box.width * 0.08);
    const padY = Math.max(2, box.height * 0.18);

    return clampBoxToBounds(
        box.x - padX,
        box.y - padY,
        box.width + padX * 2,
        box.height + padY * 2,
        canvasWidth,
        canvasHeight
    );
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
    const bbox = word?.bbox || word || {};
    let left = Number(bbox.x0);
    let top = Number(bbox.y0);
    let right = Number(bbox.x1);
    let bottom = Number(bbox.y1);

    if (![left, top, right, bottom].every(Number.isFinite)) {
        left = Number(bbox.left ?? bbox.x);
        top = Number(bbox.top ?? bbox.y);
        const width = Number(bbox.width);
        const height = Number(bbox.height);

        if ([left, top, width, height].every(Number.isFinite)) {
            right = left + width;
            bottom = top + height;
        }
    }

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
    const tag = String(label || PII_BADGE_LABEL)
        .replace(/^[BI]-/i, "")
        .trim();

    return (tag || PII_BADGE_LABEL).toUpperCase();
}

function drawPiiTag(ctx, label, x, y, width, height) {
    const tag = formatPiiTag(label);
    const box = clampBox(ctx, x, y, width, height);

    if (!box) {
        return;
    }

    ctx.save();

    const fontSize = Math.round(clamp(box.height * 0.55, 11, 18));
    ctx.font = `700 ${fontSize}px Arial, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";

    const paddingX = 6;
    const paddingY = 3;
    const gap = 2;
    const margin = 2;
    const canvasWidth = ctx.canvas.width;
    const canvasHeight = ctx.canvas.height;
    const measuredTextWidth = ctx.measureText(tag).width;
    const maxTagWidth = Math.max(0, canvasWidth - margin * 2);
    const tagWidth = Math.min(
        Math.max(box.width, measuredTextWidth + paddingX * 2),
        maxTagWidth
    );
    const tagHeight = fontSize + paddingY * 2;
    const tagX = clamp(
        box.x + (box.width - tagWidth) / 2,
        margin,
        Math.max(margin, canvasWidth - tagWidth - margin)
    );
    const aboveY = box.y - tagHeight - gap;
    const belowY = box.y + box.height + gap;
    const tagY = aboveY >= margin
        ? aboveY
        : belowY + tagHeight <= canvasHeight - margin
            ? belowY
            : clamp(box.y, margin, Math.max(margin, canvasHeight - tagHeight - margin));
    const fittedText = fitCanvasText(ctx, tag, tagWidth - paddingX * 2);

    ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
    const radius = Math.min(4, tagHeight / 2);
    ctx.beginPath();
    ctx.roundRect(tagX, tagY, tagWidth, tagHeight, radius);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.fillText(fittedText, tagX + tagWidth / 2, tagY + tagHeight / 2);

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
    return clampBoxToBounds(x, y, width, height, ctx.canvas.width, ctx.canvas.height);
}

function clampBoxToBounds(x, y, width, height, maxWidth, maxHeight) {
    if (width <= 0 || height <= 0) return null;

    const left = clamp(x, 0, maxWidth);
    const top = clamp(y, 0, maxHeight);
    const right = clamp(x + width, 0, maxWidth);
    const bottom = clamp(y + height, 0, maxHeight);

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

    const sourcePadding = Math.ceil(blurRadius * 2);
    const sourceBox = clampBox(
        ctx,
        box.x - sourcePadding,
        box.y - sourcePadding,
        box.width + sourcePadding * 2,
        box.height + sourcePadding * 2
    );

    if (!sourceBox) return;

    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = Math.max(1, Math.ceil(sourceBox.width));
    sourceCanvas.height = Math.max(1, Math.ceil(sourceBox.height));

    const sourceCtx = sourceCanvas.getContext("2d");
    sourceCtx.drawImage(
        ctx.canvas,
        sourceBox.x,
        sourceBox.y,
        sourceBox.width,
        sourceBox.height,
        0,
        0,
        sourceCanvas.width,
        sourceCanvas.height
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.clip();

    ctx.filter = `blur(${blurRadius}px)`;
    ctx.drawImage(
        sourceCanvas,
        sourceBox.x,
        sourceBox.y,
        sourceBox.width,
        sourceBox.height
    );

    ctx.restore();
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeError(error, fallbackMessage) {
    if (error instanceof Error && error.message) {
        return error;
    }

    if (typeof error === "string" && error.trim()) {
        return new Error(error);
    }

    if (error && typeof error.message === "string" && error.message.trim()) {
        return new Error(error.message);
    }

    try {
        const serialized = JSON.stringify(error);

        if (serialized && serialized !== "null" && serialized !== "undefined") {
            return new Error(serialized);
        }
    } catch {
        // Ignore serialization failures and use the fallback below.
    }

    return new Error(fallbackMessage);
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
