import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-cpu";
import "@tensorflow/tfjs-backend-webgl";
import * as blazeface from "@tensorflow-models/blazeface";

let model = null;
let backendPromise = null;

function extensionUrl(path) {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(path);
    }

    return path;
}

async function ensureTensorFlowBackend() {
    if (!backendPromise) {
        backendPromise = (async () => {
            let lastError = null;

            for (const backendName of ["webgl", "cpu"]) {
                try {
                    await tf.setBackend(backendName);
                    await tf.ready();
                    return backendName;
                } catch (error) {
                    lastError = error;
                }
            }

            throw lastError || new Error("No TensorFlow.js backend is available.");
        })().catch((error) => {
            backendPromise = null;
            throw error;
        });
    }

    return backendPromise;
}

export async function loadFaceDetectionModel(
    modelPath = extensionUrl("models/blazeface/model.json"),
    options = {}
) {
    await ensureTensorFlowBackend();

    model = await blazeface.load({
        maxFaces: 50,
        scoreThreshold: 0.65,
        modelUrl: modelPath,
        ...options,
    });

    return true;
}

export async function detectFaces(image, options = {}) {
    if (!model) {
        throw new Error(
            "Face detection model is not loaded. Call loadFaceDetectionModel() first."
        );
    }

    const {
        returnTensors = false,
        flipHorizontal = false,
        annotateBoxes = false,
    } = options;

    return model.estimateFaces(
        image,
        returnTensors,
        flipHorizontal,
        annotateBoxes
    );
}

export function isFaceDetectionModelLoaded() {
    return model !== null;
}
