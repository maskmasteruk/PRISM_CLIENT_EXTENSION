let keepAliveTimer = null;
let sanitizerModulePromise = null;
let sanitizerGlobalsPromise = null;

const SANITIZER_GLOBAL_SCRIPTS = [
    "libs/tesseract.min.js",
];

function stripBase64FromDataUrl(dataUrl) {
    const commaIndex = dataUrl.indexOf(",");

    return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

function sendKeepAlive() {
    try {
        chrome.runtime.sendMessage(
            { type: "prism:keepAlive" },
            (response) => {
                if (chrome.runtime.lastError) {
                    return;
                }

                if (response?.running === false) {
                    setKeepAlive(false);
                }
            }
        );
    } catch {
        // The service worker can be restarting; the next interval will retry.
    }
}

function setKeepAlive(active) {
    if (!active) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
        return;
    }

    if (keepAliveTimer) {
        return;
    }

    sendKeepAlive();
    keepAliveTimer = setInterval(sendKeepAlive, 20000);
}

function loadClassicScript(path) {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");

        script.src = chrome.runtime.getURL(path);
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${path}.`));

        document.head.appendChild(script);
    });
}

async function ensureSanitizerGlobals() {
    sanitizerGlobalsPromise ||= (async () => {
        for (const path of SANITIZER_GLOBAL_SCRIPTS) {
            await loadClassicScript(path);
        }

        if (!globalThis.Tesseract) {
            throw new Error("Tesseract library did not initialize.");
        }
    })();

    return sanitizerGlobalsPromise;
}

async function sanitizeScreenshotDataUrl(dataUrl) {
    await ensureSanitizerGlobals();
    sanitizerModulePromise ||= import("./sanitize.js");
    const { sanitizeScreenshot } = await sanitizerModulePromise;
    const canvas = await sanitizeScreenshot(dataUrl);

    return stripBase64FromDataUrl(canvas.toDataURL("image/png"));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "prism:setKeepAlive") {
        setKeepAlive(Boolean(message.active));
        sendResponse({ ok: true });
        return false;
    }

    if (message?.type !== "prism:sanitizeScreenshot") {
        return false;
    }

    sanitizeScreenshotDataUrl(message.dataUrl)
        .then((base64) => {
            sendResponse({
                ok: true,
                base64,
            });
        })
        .catch((error) => {
            sendResponse({
                ok: false,
                error: error.message,
            });
        });

    return true;
});
