let image = null;

/**
 * Load an image.
 *
 * @param {string|File|HTMLImageElement} source
 * @returns {Promise<HTMLImageElement>}
 */
export async function loadImage(source) {
    // Already an HTML Image
    if (source instanceof HTMLImageElement) {
        image = source;

        if (!image.complete) {
            await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = reject;
            });
        }

        return image;
    }

    // File object
    if (source instanceof File) {
        source = URL.createObjectURL(source);
    }

    // URL or Data URL
    image = new Image();

    await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;

        image.src = source;
    });

    return image;
}


/**
 * Draw an image with a colored text region.
 *
 * @param {Object} options
 *
 * options:
 * {
 *   image: HTMLImageElement,
 *   x: number,
 *   y: number,
 *   width: number,
 *   height: number,
 *   backgroundColor: "#ffffff",
 *   text: "Hello World",
 *   textColor: "#000000",
 *   padding: 10
 * }
 *
 * @returns {HTMLCanvasElement}
 */
export function createTextOverlay(options) {
    const {
        x,
        y,
        width,
        height,
        backgroundColor = "#ffffff",
        text = "",
        textColor = "#000000",
        padding = 10
    } = options;

    const sourceImage = options.image || image;

    if (!sourceImage) {
        throw new Error(
            "No image provided. Use loadImage() or pass image."
        );
    }

    const canvas = document.createElement("canvas");

    canvas.width = sourceImage.naturalWidth || sourceImage.width;
    canvas.height = sourceImage.naturalHeight || sourceImage.height;

    const ctx = canvas.getContext("2d");

    // Draw original image
    ctx.drawImage(
        sourceImage,
        0,
        0,
        canvas.width,
        canvas.height
    );

    // Fill the specified region
    ctx.fillStyle = backgroundColor;

    ctx.fillRect(
        x,
        y,
        width,
        height
    );

    // Available space for text
    const availableWidth =
        Math.max(0, width - padding * 2);

    const availableHeight =
        Math.max(0, height - padding * 2);

    // Find largest font that fits
    const fontSize = findBestFontSize(
        ctx,
        text,
        availableWidth,
        availableHeight
    );

    ctx.save();

    // Prevent text from overflowing outside region
    ctx.beginPath();

    ctx.rect(
        x,
        y,
        width,
        height
    );

    ctx.clip();

    ctx.font = `${fontSize}px Arial`;

    ctx.fillStyle = textColor;

    ctx.textBaseline = "top";

    const lines = getWrappedLines(
        ctx,
        text,
        availableWidth
    );

    const lineHeight =
        Math.ceil(fontSize * 1.2);

    const totalTextHeight =
        lines.length * lineHeight;

    // Vertically center the text
    const startY =
        y +
        padding +
        Math.max(
            0,
            (availableHeight - totalTextHeight) / 2
        );

    // Draw centered lines
    lines.forEach((line, index) => {
        const textWidth =
            ctx.measureText(line).width;

        const textX =
            x +
            padding +
            Math.max(
                0,
                (availableWidth - textWidth) / 2
            );

        const textY =
            startY +
            index * lineHeight;

        ctx.fillText(
            line,
            textX,
            textY
        );
    });

    ctx.restore();

    return canvas;
}


/**
 * Find the largest font size that fits
 * inside the given width and height.
 */
function findBestFontSize(
    ctx,
    text,
    maxWidth,
    maxHeight
) {
    if (!text || maxWidth <= 0 || maxHeight <= 0) {
        return 5;
    }

    let fontSize = Math.min(
        200,
        maxHeight
    );

    const minFontSize = 5;

    while (fontSize >= minFontSize) {
        ctx.font = `${fontSize}px Arial`;

        const lines = getWrappedLines(
            ctx,
            text,
            maxWidth
        );

        const lineHeight =
            fontSize * 1.2;

        const totalHeight =
            lines.length * lineHeight;

        if (totalHeight <= maxHeight) {
            return fontSize;
        }

        fontSize--;
    }

    return minFontSize;
}


/**
 * Wrap text to fit within maxWidth.
 */
function getWrappedLines(
    ctx,
    text,
    maxWidth
) {
    if (!text) {
        return [];
    }

    const paragraphs =
        text.split("\n");

    const lines = [];

    paragraphs.forEach((paragraph) => {
        const words =
            paragraph.trim().split(/\s+/);

        let line = "";

        words.forEach((word) => {
            const testLine =
                line
                    ? `${line} ${word}`
                    : word;

            const testWidth =
                ctx.measureText(testLine).width;

            if (
                testWidth > maxWidth &&
                line
            ) {
                lines.push(line);

                line = word;
            } else {
                line = testLine;
            }
        });

        if (line) {
            lines.push(line);
        }
    });

    return lines;
}


/**
 * Convert the canvas to a PNG Blob.
 */
export function canvasToBlob(
    canvas,
    type = "image/png",
    quality = 1
) {
    return new Promise((resolve) => {
        canvas.toBlob(
            resolve,
            type,
            quality
        );
    });
}


/**
 * Get image as a Data URL.
 */
export function canvasToDataURL(
    canvas,
    type = "image/png",
    quality = 1
) {
    return canvas.toDataURL(
        type,
        quality
    );
}