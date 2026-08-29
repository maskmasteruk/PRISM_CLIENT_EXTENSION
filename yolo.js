let session = null;

function extensionUrl(path) {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(path);
    }

    return path;
}

function getOrtRuntime() {
    if (!globalThis.ort) {
        throw new Error("ONNX Runtime is not loaded.");
    }

    globalThis.ort.env.wasm.wasmPaths = extensionUrl("libs/ort/");
    globalThis.ort.env.wasm.numThreads = 1;
    globalThis.ort.env.wasm.proxy = false;

    return globalThis.ort;
}

// COCO dataset classes
const labels = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus",
    "train", "truck", "boat", "traffic light", "fire hydrant",
    "stop sign", "parking meter", "bench", "bird", "cat", "dog",
    "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe",
    "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat",
    "baseball glove", "skateboard", "surfboard", "tennis racket",
    "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl",
    "banana", "apple", "sandwich", "orange", "broccoli", "carrot",
    "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop",
    "mouse", "remote", "keyboard", "cell phone", "microwave", "oven",
    "toaster", "sink", "refrigerator", "book", "clock", "vase",
    "scissors", "teddy bear", "hair drier", "toothbrush"
];


/**
 * Load YOLO ONNX model
 *
 * @param {string} modelPath
 */
export async function loadYOLOModel(
    modelPath = extensionUrl("models/yolov8n.onnx")
) {
    const runtime = getOrtRuntime();

    session = await runtime.InferenceSession.create(modelPath, {
        executionProviders: ["wasm"],
    });

    return true;
}


/**
 * Convert an image into YOLO input tensor
 *
 * @param {HTMLImageElement} image
 * @param {number} size
 */
function preprocess(image, size = 640) {
    const canvas = document.createElement("canvas");

    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d");

    ctx.drawImage(image, 0, 0, size, size);

    const imageData =
        ctx.getImageData(0, 0, size, size).data;

    const red = [];
    const green = [];
    const blue = [];

    for (let i = 0; i < imageData.length; i += 4) {
        red.push(imageData[i] / 255);
        green.push(imageData[i + 1] / 255);
        blue.push(imageData[i + 2] / 255);
    }

    const input = new Float32Array([
        ...red,
        ...green,
        ...blue
    ]);

    const runtime = getOrtRuntime();

    return new runtime.Tensor(
        "float32",
        input,
        [1, 3, size, size]
    );
}


/**
 * Run object detection
 *
 * @param {HTMLImageElement} image
 * @param {object} options
 *
 * @returns {Array}
 */
export async function detectObjects(
    image,
    options = {}
) {
    if (!session) {
        throw new Error(
            "YOLO model is not loaded. Call loadYOLOModel() first."
        );
    }

    const {
        confidence = 0.45,
        inputSize = 640
    } = options;

    const tensor = preprocess(image, inputSize);

    // Get actual input name from model
    const inputName = session.inputNames[0];

    const outputs = await session.run({
        [inputName]: tensor
    });

    const outputName = session.outputNames[0];

    const output =
        outputs[outputName].data;

    const detections = [];

    // YOLOv8 output:
    // [1, 84, 8400]
    const numberOfBoxes = 8400;
    const numberOfClasses = 80;

    for (let i = 0; i < numberOfBoxes; i++) {
        let maxScore = 0;
        let classId = -1;

        for (let c = 0; c < numberOfClasses; c++) {
            const score =
                output[numberOfBoxes * (c + 4) + i];

            if (score > maxScore) {
                maxScore = score;
                classId = c;
            }
        }

        if (maxScore >= confidence) {
            const cx = output[i];
            const cy = output[numberOfBoxes + i];
            const width = output[numberOfBoxes * 2 + i];
            const height = output[numberOfBoxes * 3 + i];

            const x = cx - width / 2;
            const y = cy - height / 2;

            detections.push({
                classId,
                label: labels[classId],
                confidence: maxScore,

                // YOLO 640x640 coordinates
                x,
                y,
                width,
                height,

                centerX: cx,
                centerY: cy
            });
        }
    }

    return detections;
}


export { labels };
