export async function extractTextFromImage(imageSrc, options = {}) {
    const {
        language = "eng",
        onProgress = () => {}
    } = options;

    try {
        const result = await Tesseract.recognize(
            imageSrc,
            language,
            {
                workerPath: extensionUrl("libs/tesseract/worker.min.js"),
                corePath: extensionUrl("libs/tesseract/core/"),
                langPath: extensionUrl("libs/tesseract/lang/"),
                cacheMethod: "none",
                workerBlobURL: false,
                gzip: true,
                logger: (message) => {
                    onProgress(message);
                }
            }
        );

        return {
            success: true,
            text: result.data.text.trim()
        };
    } catch (error) {
        const normalizedError = normalizeError(error, "OCR failed without an error message.");

        console.error("OCR Error:", normalizedError);

        return {
            success: false,
            text: "",
            error: normalizedError.message
        };
    }
}

function extensionUrl(path) {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(path);
    }

    return path;
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
