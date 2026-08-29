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
        console.error("OCR Error:", error);

        return {
            success: false,
            text: "",
            error: error.message
        };
    }
}

function extensionUrl(path) {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(path);
    }

    return path;
}
