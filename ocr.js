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