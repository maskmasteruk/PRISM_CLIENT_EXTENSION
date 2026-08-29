import {
    pipeline,
    env
} from "@huggingface/transformers";

function extensionUrl(path) {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(path);
    }

    return path;
}

// Use locally stored models only
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;

if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = extensionUrl("libs/ort/");
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
}

// Local model directory
env.localModelPath = new URL(
    "./",
    window.location.href
).href;

let detector = null;


/**
 * Load the PII detection model.
 *
 * @param {string} modelId
 * @param {object} options
 */
export async function loadPIIModel(
    modelId = "models/bert-small-pii-web",
    options = {}
) {
    const {
        device = "wasm",
        dtype = "q8",
        onProgress = null
    } = options;

    if (typeof onProgress === "function") {
        onProgress({
            status: "loading",
            message: "Loading PII model..."
        });
    }

    const pipelineOptions = {
        device,
        dtype,
    };

    if (typeof onProgress === "function") {
        pipelineOptions.progress_callback = (progress) => {
            onProgress(progress);
        };
    }

    try {
        detector = await pipeline(
            "token-classification",
            modelId,
            pipelineOptions
        );

        if (typeof onProgress === "function") {
            onProgress({
                status: "ready",
                message: "PII model loaded successfully."
            });
        }

        return {
            success: true
        };

    } catch (error) {

        console.error("PII model loading error:", error);

        return {
            success: false,
            error: error.message
        };
    }
}


/**
 * Detect personally identifiable information in text.
 *
 * @param {string} text
 * @param {object} options
 */
export async function detectPII(
    text,
    options = {}
) {
    if (!detector) {
        throw new Error(
            "PII model is not loaded. Call loadPIIModel() first."
        );
    }

    if (!text || !text.trim()) {
        return {
            success: true,
            entities: []
        };
    }

    const {
        aggregationStrategy = "simple"
    } = options;

    try {
        const startTime = performance.now();

        const output = await detector(
            text,
            {
                aggregation_strategy: aggregationStrategy
            }
        );

        const endTime = performance.now();

        // Convert the model output into a cleaner format
        const entities = output.map((entity) => ({
            label:
                entity.entity_group ||
                entity.entity,

            text: entity.word,

            confidence: entity.score,

            start: entity.start,
            end: entity.end
        }));

        return {
            success: true,
            entities,
            processingTime: endTime - startTime
        };

    } catch (error) {

        console.error("PII detection error:", error);

        return {
            success: false,
            entities: [],
            error: error.message
        };
    }
}


/**
 * Check whether the PII model is loaded.
 */
export function isPIIModelLoaded() {
    return detector !== null;
}
