const CATEGORIES = [
    "email",
    "username",
    "password",
    "api_key",
    "phone",
    "address",
    "otp",
    "name",
    "other",
];

const LEGACY_COLLECTION_KEYS = new Set([
    "prism.sensitiveData",
    "prismSensitiveData",
]);

const SCREENSHOT_SETTING_KEY = "prism.attachScreenshot";
const CHAT_STORAGE_KEY = "prism.chatMessages";
const AGENT_STATE_STORAGE_KEY = "prism.agentState";
const SANITIZER_DEBUG_STORAGE_KEY = "prism.screenshotSanitizerDebugLog";
const APP_STORAGE_KEYS = new Set([
    ...LEGACY_COLLECTION_KEYS,
    SCREENSHOT_SETTING_KEY,
    CHAT_STORAGE_KEY,
    AGENT_STATE_STORAGE_KEY,
    SANITIZER_DEBUG_STORAGE_KEY,
]);

const AGENT_URL = "http://127.0.0.1:8000/agent";
const MAX_AGENT_STEPS = 20;
const AGENT_ACTION_SETTLE_MS = 500;
const AGENT_REQUEST_TIMEOUT_MS = 120000;
const MAX_CHAT_MESSAGES = 200;
const MAX_CHAT_SCREENSHOT_PREVIEWS = 1;

const HANDLED_MESSAGE_TYPES = new Set([
    "prism:startAgent",
    "prism:stopAgent",
    "prism:clearChat",
    "prism:getSnapshot",
    "prism:pageUserAction",
    "prism:keepAlive",
    "prism:screenshotSanitizerDebugLog",
]);

const userInputs = {};

let activeRun = null;
let creatingOffscreenDocument = null;

class AgentStoppedError extends Error {
    constructor(reason) {
        super(stopMessageFor(reason));
        this.name = "AgentStoppedError";
        this.reason = reason;
    }
}

function makeRequestId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function storageGet(keys = null) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, (items) => {
            const error = chrome.runtime?.lastError;

            if (error) {
                reject(new Error(error.message));
                return;
            }

            resolve(items || {});
        });
    });
}

function storageSet(items) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(items, () => {
            const error = chrome.runtime?.lastError;

            if (error) {
                reject(new Error(error.message));
                return;
            }

            resolve();
        });
    });
}

async function storageGetValue(key, fallbackValue) {
    const items = await storageGet(key);

    return Object.prototype.hasOwnProperty.call(items, key)
        ? items[key]
        : fallbackValue;
}

async function storageSetValue(key, value) {
    await storageSet({ [key]: value });
}

function stringifyValue(value) {
    if (value === null || value === undefined) {
        return "";
    }

    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }

    return JSON.stringify(value);
}

function normalizeCategory(category, key = "", value = "") {
    if (CATEGORIES.includes(category)) {
        return category;
    }

    const label = `${key} ${value}`.toLowerCase();

    if (label.includes("email")) return "email";
    if (label.includes("user") || label.includes("login")) return "username";
    if (label.includes("pass") || label.includes("secret")) return "password";
    if (label.includes("api") || label.includes("token") || label.includes("key")) return "api_key";
    if (label.includes("phone") || label.includes("mobile")) return "phone";
    if (label.includes("address")) return "address";
    if (label.includes("otp") || label.includes("code")) return "otp";
    if (label.includes("name")) return "name";

    return "other";
}

function normalizeRecord(key, storedValue) {
    if (!key || APP_STORAGE_KEYS.has(key)) {
        return null;
    }

    if (storedValue && typeof storedValue === "object" && !Array.isArray(storedValue)) {
        const value = stringifyValue(storedValue.value ?? storedValue.secret ?? "");
        const category = normalizeCategory(storedValue.category, key, value);
        const description = stringifyValue(storedValue.description ?? "").trim();

        return { key, value, category, description };
    }

    const value = stringifyValue(storedValue);

    return {
        key,
        value,
        category: normalizeCategory("", key, value),
        description: "",
    };
}

function normalizeImportedRecord(key, storedValue) {
    const safeKey = stringifyValue(key).trim();

    if (!safeKey || APP_STORAGE_KEYS.has(safeKey)) {
        return null;
    }

    if (storedValue && typeof storedValue === "object" && !Array.isArray(storedValue)) {
        const explicitKey = stringifyValue(storedValue.key ?? safeKey).trim() || safeKey;
        const value = stringifyValue(storedValue.value ?? storedValue.secret ?? "");
        const category = normalizeCategory(storedValue.category, explicitKey, value);
        const description = stringifyValue(storedValue.description ?? "").trim();

        return { key: explicitKey, value, category, description };
    }

    const value = stringifyValue(storedValue);

    return {
        key: safeKey,
        value,
        category: normalizeCategory("", safeKey, value),
        description: "",
    };
}

function recordsFromJson(data) {
    if (Array.isArray(data)) {
        return data
            .map((item, index) => normalizeImportedRecord(item?.key ?? `imported_${index + 1}`, item))
            .filter(Boolean);
    }

    if (data && typeof data === "object") {
        const collection = Array.isArray(data.items)
            ? data.items
            : Array.isArray(data.secrets)
                ? data.secrets
                : null;

        if (collection) {
            return collection
                .map((item, index) => normalizeImportedRecord(item?.key ?? `imported_${index + 1}`, item))
                .filter(Boolean);
        }

        return Object.entries(data)
            .map(([key, value]) => normalizeImportedRecord(key, value))
            .filter(Boolean);
    }

    return [];
}

function sortRecords(records) {
    return [...records].sort((left, right) => left.key.localeCompare(right.key));
}

async function loadSecrets() {
    const storedItems = await storageGet(null);
    const byKey = new Map();

    Object.entries(storedItems).forEach(([key, storedValue]) => {
        if (LEGACY_COLLECTION_KEYS.has(key)) {
            recordsFromJson(storedValue).forEach((record) => byKey.set(record.key, record));
            return;
        }

        const record = normalizeRecord(key, storedValue);

        if (record) {
            byKey.set(record.key, record);
        }
    });

    return sortRecords([...byKey.values()]);
}

function normalizeChatMessages(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter((message) => message && typeof message === "object")
        .map((message) => {
            const normalized = {
                id: stringifyValue(message.id || makeRequestId()),
                type: message.type === "sent" ? "sent" : "received",
                text: stringifyValue(message.text ?? message.message ?? ""),
                createdAt: Number(message.createdAt || Date.now()),
                includeInAgentHistory: message.includeInAgentHistory !== false,
            };
            const imageDataUrl = normalizeImageDataUrl(message.imageDataUrl);

            if (imageDataUrl) {
                normalized.imageDataUrl = imageDataUrl;
            }

            return normalized;
        })
        .filter((message) => message.text || message.imageDataUrl);
}

async function getChatMessages() {
    return normalizeChatMessages(await storageGetValue(CHAT_STORAGE_KEY, []));
}

function normalizeImageDataUrl(value) {
    const dataUrl = stringifyValue(value);

    return dataUrl.startsWith("data:image/") ? dataUrl : "";
}

function trimStoredChatMessages(messages) {
    let previewsKept = 0;

    return messages
        .slice(-MAX_CHAT_MESSAGES)
        .reverse()
        .map((message) => {
            if (!message.imageDataUrl) {
                return message;
            }

            previewsKept += 1;

            if (previewsKept <= MAX_CHAT_SCREENSHOT_PREVIEWS) {
                return message;
            }

            const { imageDataUrl, ...withoutPreview } = message;
            return withoutPreview;
        })
        .reverse();
}

async function appendChat(type, text, options = {}) {
    const messages = await getChatMessages();
    const nextMessage = {
        id: stringifyValue(options.id || makeRequestId()),
        type: type === "sent" ? "sent" : "received",
        text: stringifyValue(text),
        createdAt: Date.now(),
        includeInAgentHistory: options.includeInAgentHistory !== false,
    };
    const imageDataUrl = normalizeImageDataUrl(options.imageDataUrl);

    if (imageDataUrl) {
        nextMessage.imageDataUrl = imageDataUrl;
    }

    messages.push(nextMessage);

    const nextMessages = trimStoredChatMessages(messages);
    await storageSetValue(CHAT_STORAGE_KEY, nextMessages);

    return nextMessages;
}

async function updateChatMessage(messageId, updates = {}) {
    const normalizedId = stringifyValue(messageId);

    if (!normalizedId) {
        return appendChat("received", updates.text || "", updates);
    }

    const messages = await getChatMessages();
    let updated = false;
    const nextMessages = messages.map((message) => {
        if (message.id !== normalizedId) {
            return message;
        }

        updated = true;
        const nextMessage = { ...message };

        if (Object.prototype.hasOwnProperty.call(updates, "text")) {
            nextMessage.text = stringifyValue(updates.text);
        }

        if (Object.prototype.hasOwnProperty.call(updates, "includeInAgentHistory")) {
            nextMessage.includeInAgentHistory = updates.includeInAgentHistory !== false;
        }

        if (Object.prototype.hasOwnProperty.call(updates, "imageDataUrl")) {
            const imageDataUrl = normalizeImageDataUrl(updates.imageDataUrl);

            if (imageDataUrl) {
                nextMessage.imageDataUrl = imageDataUrl;
            } else {
                delete nextMessage.imageDataUrl;
            }
        }

        return nextMessage;
    });

    if (!updated) {
        return appendChat("received", updates.text || "", updates);
    }

    const trimmedMessages = trimStoredChatMessages(normalizeChatMessages(nextMessages));
    await storageSetValue(CHAT_STORAGE_KEY, trimmedMessages);

    return trimmedMessages;
}

function normalizeAgentState(value) {
    if (!value || typeof value !== "object") {
        return {
            running: false,
            status: "idle",
            requestId: "",
            tabId: null,
            updatedAt: Date.now(),
        };
    }

    const tabId = value.tabId === null || value.tabId === undefined || value.tabId === ""
        ? null
        : Number(value.tabId);

    return {
        running: Boolean(value.running),
        status: stringifyValue(value.status || (value.running ? "running" : "idle")),
        requestId: stringifyValue(value.requestId || ""),
        tabId: Number.isFinite(tabId) ? tabId : null,
        tabTitle: stringifyValue(value.tabTitle || ""),
        tabUrl: stringifyValue(value.tabUrl || ""),
        stopReason: stringifyValue(value.stopReason || ""),
        updatedAt: Number(value.updatedAt || Date.now()),
    };
}

async function getAgentState() {
    const state = normalizeAgentState(await storageGetValue(AGENT_STATE_STORAGE_KEY, null));

    if (state.running && !activeRun) {
        const idleState = {
            ...state,
            running: false,
            status: "idle",
            requestId: "",
            updatedAt: Date.now(),
        };

        await storageSetValue(AGENT_STATE_STORAGE_KEY, idleState);
        return idleState;
    }

    return state;
}

async function setAgentState(state) {
    const normalized = normalizeAgentState({
        ...state,
        updatedAt: Date.now(),
    });

    await storageSetValue(AGENT_STATE_STORAGE_KEY, normalized);
    return normalized;
}

async function setRunState(run, status, fields = {}) {
    run.status = status;

    return setAgentState({
        running: true,
        status,
        requestId: run.requestId,
        tabId: run.tabId,
        tabTitle: run.tabTitle,
        tabUrl: run.tabUrl,
        stopReason: run.stopReason || "",
        ...fields,
    });
}

function stopMessageFor(reason) {
    if (reason === "page_action") {
        return "Stopped because you interacted with the webpage. Server communication was cancelled.";
    }

    if (reason === "clear_chat") {
        return "Agent stopped.";
    }

    return "Agent stopped.";
}

function ensureRunActive(run) {
    if (run.stopped || run.cancelController.signal.aborted) {
        throw new AgentStoppedError(run.stopReason);
    }
}

function abortableSleep(milliseconds, run) {
    ensureRunActive(run);

    return new Promise((resolve, reject) => {
        let timeoutId = null;

        const cleanup = () => {
            clearTimeout(timeoutId);
            run.cancelController.signal.removeEventListener("abort", abortHandler);
        };

        const abortHandler = () => {
            cleanup();
            reject(new AgentStoppedError(run.stopReason));
        };

        timeoutId = setTimeout(() => {
            cleanup();
            resolve();
        }, milliseconds);

        run.cancelController.signal.addEventListener("abort", abortHandler, { once: true });
    });
}

function getActiveTab() {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const error = chrome.runtime?.lastError;

            if (error) {
                reject(new Error(error.message));
                return;
            }

            const tab = tabs?.[0];

            if (!tab?.id) {
                reject(new Error("No active tab is available."));
                return;
            }

            resolve(tab);
        });
    });
}

function getTab(tabId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.get(tabId, (tab) => {
            const error = chrome.runtime?.lastError;

            if (error) {
                reject(new Error(error.message));
                return;
            }

            resolve(tab);
        });
    });
}

async function waitForTabReady(tabId, timeoutMs = 8000, run = null) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        if (run) {
            ensureRunActive(run);
        }

        const tab = await getTab(tabId);

        if (tab.status !== "loading") {
            return tab;
        }

        if (run) {
            await abortableSleep(250, run);
        } else {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }

    return getTab(tabId);
}

function isScriptableTab(tab) {
    return Boolean(tab?.id) && /^(https?:|file:)/.test(tab.url || "");
}

function executeScript(tabId, func, args = []) {
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript(
            {
                target: { tabId },
                func,
                args,
            },
            (results) => {
                const error = chrome.runtime?.lastError;

                if (error) {
                    reject(new Error(error.message));
                    return;
                }

                resolve(results?.[0]?.result);
            }
        );
    });
}

function extractDomInPage() {
    const elements = [];
    let counter = 0;
    const interactiveSelectors = [
        "a",
        "button",
        "input",
        "textarea",
        "select",
        "[role]",
        "[contenteditable='true']",
        "[onclick]",
    ];
    const nodes = document.querySelectorAll(interactiveSelectors.join(","));
    const usedIds = new Set(
        Array.from(document.querySelectorAll("[data-agent-id]"))
            .map((element) => element.getAttribute("data-agent-id"))
            .filter(Boolean)
    );

    function rectIntersectsViewport(rect) {
        return rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth;
    }

    function isRendered(element) {
        for (let current = element; current; current = current.parentElement) {
            const style = window.getComputedStyle(current);

            if (style.display === "none" ||
                style.visibility === "hidden" ||
                style.visibility === "collapse" ||
                Number(style.opacity || 1) <= 0) {
                return false;
            }
        }

        return true;
    }

    function isElementVisibleInViewport(element, rect = element.getBoundingClientRect()) {
        return rectIntersectsViewport(rect) && isRendered(element);
    }

    function isTextNodeVisibleInViewport(node) {
        if (!node.parentElement || !isRendered(node.parentElement)) {
            return false;
        }

        const range = document.createRange();
        range.selectNodeContents(node);

        const visible = Array.from(range.getClientRects()).some(rectIntersectsViewport);
        range.detach?.();

        return visible;
    }

    function visibleTextFor(element, maxLength) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const parts = [];
        let length = 0;
        let node = walker.nextNode();

        while (node && length < maxLength) {
            const text = String(node.textContent || "").replace(/\s+/g, " ").trim();

            if (text && isTextNodeVisibleInViewport(node)) {
                parts.push(text);
                length += text.length + 1;
            }

            node = walker.nextNode();
        }

        return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, maxLength);
    }

    function visiblePlaceholderFor(element) {
        const placeholder = element.getAttribute("placeholder");

        if (!placeholder) {
            return null;
        }

        return "value" in element && String(element.value || "").length > 0
            ? null
            : placeholder;
    }

    function visibleLabelFor(element) {
        if (!element.labels?.length) {
            return null;
        }

        return Array.from(element.labels)
            .filter((labelElement) => isElementVisibleInViewport(labelElement))
            .map((labelElement) => visibleTextFor(labelElement, 200))
            .filter(Boolean)
            .join(" ");
    }

    function nextAgentId() {
        let agentId = "";

        do {
            agentId = `agent-${counter}`;
            counter += 1;
        } while (usedIds.has(agentId));

        usedIds.add(agentId);
        return agentId;
    }

    for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        const visible = isElementVisibleInViewport(el, rect);

        if (!visible) {
            continue;
        }

        let agentId = el.getAttribute("data-agent-id");

        if (!agentId) {
            agentId = nextAgentId();
            el.setAttribute("data-agent-id", agentId);
        }

        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute("type");
        const label = visibleLabelFor(el);
        const ariaLabel = el.getAttribute("aria-label");
        const placeholder = visiblePlaceholderFor(el);
        const name = el.getAttribute("name");
        const role = el.getAttribute("role");
        const text = visibleTextFor(el, 1000);
        const href = el.getAttribute("href");
        let maskedValue = null;

        if (tag === "input" || tag === "textarea" || tag === "select") {
            const value = el.value || "";
            maskedValue = value.length > 0 ? (label || name || "[MASKED]") : "";
        }

        const item = {
            id: agentId,
            tag,
            disabled: Boolean(el.disabled),
            visible: true,
        };
        const optionalValues = {
            type,
            label,
            aria_label: ariaLabel,
            placeholder,
            name,
            role,
            text,
            masked_value: maskedValue,
            href,
            checked: typeof el.checked === "boolean" ? el.checked : null,
            selected: typeof el.selected === "boolean" ? el.selected : null,
        };

        for (const [key, value] of Object.entries(optionalValues)) {
            if (value !== null && value !== undefined && value !== "") {
                item[key] = value;
            }
        }

        elements.push(item);
    }

    return {
        url: window.location.href,
        title: document.title,
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
        elements,
    };
}

function executeAgentActionInPage(action, secretValue, screenshotSize = null) {
    const actionType = action.type;

    function findElement(elementId) {
        if (!elementId) {
            return null;
        }

        if (window.CSS?.escape) {
            return document.querySelector(`[data-agent-id="${CSS.escape(elementId)}"]`);
        }

        return Array.from(document.querySelectorAll("[data-agent-id]"))
            .find((element) => element.getAttribute("data-agent-id") === elementId) || null;
    }

    function getElement(elementId) {
        const element = findElement(elementId);

        if (!element) {
            throw new Error(`Element not found: ${elementId}`);
        }

        return element;
    }

    function centerOf(element) {
        const rect = element.getBoundingClientRect();
        return {
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
        };
    }

    function bringIntoView(element) {
        element.scrollIntoView({ block: "center", inline: "center" });
    }

    function dispatchInputEvent(element, data, inputType = "") {
        const eventOptions = {
            bubbles: true,
            data,
        };

        if (inputType) {
            eventOptions.inputType = inputType;
        }

        try {
            element.dispatchEvent(new InputEvent("input", eventOptions));
        } catch {
            element.dispatchEvent(new Event("input", { bubbles: true }));
        }
    }

    function setElementValue(element, value) {
        const textValue = String(value ?? "");

        bringIntoView(element);

        if (element.isContentEditable) {
            element.focus();
            document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, textValue);
            dispatchInputEvent(element, textValue);
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return;
        }

        if (!("value" in element)) {
            throw new Error("Target element does not accept text input.");
        }

        element.focus();

        const prototype = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

        if (descriptor?.set) {
            descriptor.set.call(element, textValue);
        } else {
            element.value = textValue;
        }

        dispatchInputEvent(element, textValue);
        element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function dispatchHover(element) {
        bringIntoView(element);
        const center = centerOf(element);
        element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, ...center }));
        element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...center }));
    }

    function focusNextElement(backward = false) {
        const focusable = Array.from(document.querySelectorAll([
            "a[href]",
            "button",
            "input",
            "textarea",
            "select",
            "[tabindex]:not([tabindex='-1'])",
            "[contenteditable='true']",
        ].join(","))).filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 &&
                rect.height > 0 &&
                !element.disabled &&
                style.display !== "none" &&
                style.visibility !== "hidden";
        });

        if (focusable.length === 0) {
            return;
        }

        const currentIndex = focusable.indexOf(document.activeElement);
        const offset = backward ? -1 : 1;
        const nextIndex = currentIndex === -1
            ? 0
            : (currentIndex + offset + focusable.length) % focusable.length;
        focusable[nextIndex].focus();
    }

    function dispatchKey(key) {
        const target = document.activeElement || document.body;
        const normalizedKey = String(key || "");

        if (normalizedKey === "Tab" || normalizedKey === "Shift+Tab") {
            focusNextElement(normalizedKey === "Shift+Tab");
            return;
        }

        const eventOptions = {
            key: normalizedKey,
            code: normalizedKey,
            bubbles: true,
            cancelable: true,
        };
        const shouldContinue = target.dispatchEvent(new KeyboardEvent("keydown", eventOptions));

        if (shouldContinue && normalizedKey === "Enter") {
            const form = target.closest?.("form");

            if (form?.requestSubmit) {
                form.requestSubmit();
            } else if (target.click && ["button", "a"].includes(target.tagName?.toLowerCase())) {
                target.click();
            }
        }

        target.dispatchEvent(new KeyboardEvent("keyup", eventOptions));
    }

    function resolveActionPoint() {
        const rawX = Number(action.x);
        const rawY = Number(action.y);

        if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
            throw new Error(`Coordinate action requires finite x/y: ${actionType}`);
        }

        const coordinateSystem = action.coordinate_system || "viewport";

        if (coordinateSystem === "viewport") {
            return {
                clientX: rawX,
                clientY: rawY,
            };
        }

        if (coordinateSystem !== "screenshot") {
            throw new Error(`Unsupported coordinate system: ${coordinateSystem}`);
        }

        const screenshotWidth = Number(
            action.screenshot_width ??
            action.screenshotWidth ??
            screenshotSize?.width
        );
        const screenshotHeight = Number(
            action.screenshot_height ??
            action.screenshotHeight ??
            screenshotSize?.height
        );

        if (!Number.isFinite(screenshotWidth) ||
            !Number.isFinite(screenshotHeight) ||
            screenshotWidth <= 0 ||
            screenshotHeight <= 0) {
            throw new Error("Screenshot coordinate action requires screenshot dimensions.");
        }

        return {
            clientX: rawX * window.innerWidth / screenshotWidth,
            clientY: rawY * window.innerHeight / screenshotHeight,
        };
    }

    function targetAtPoint(point) {
        const target = document.elementFromPoint(point.clientX, point.clientY);

        if (!target) {
            throw new Error(
                `Coordinate target is outside the current viewport: ${point.clientX}, ${point.clientY}`
            );
        }

        return target;
    }

    function dispatchPointerEvent(target, type, point, buttons) {
        if (typeof PointerEvent !== "function") {
            return;
        }

        target.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
            buttons,
            clientX: point.clientX,
            clientY: point.clientY,
        }));
    }

    function dispatchMouseEvent(target, type, point, buttons) {
        target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            button: 0,
            buttons,
            clientX: point.clientX,
            clientY: point.clientY,
        }));
    }

    function focusTarget(target) {
        const focusable = target.closest?.([
            "input",
            "textarea",
            "select",
            "button",
            "a[href]",
            "[tabindex]:not([tabindex='-1'])",
            "[contenteditable='true']",
        ].join(",")) || target;

        focusable.focus?.({ preventScroll: true });
        return focusable;
    }

    function moveToPoint(point) {
        const target = targetAtPoint(point);

        dispatchPointerEvent(target, "pointerover", point, 0);
        dispatchMouseEvent(target, "mouseover", point, 0);
        dispatchPointerEvent(target, "pointermove", point, 0);
        dispatchMouseEvent(target, "mousemove", point, 0);

        return target;
    }

    function clickPoint(point) {
        const target = moveToPoint(point);

        focusTarget(target);
        dispatchPointerEvent(target, "pointerdown", point, 1);
        dispatchMouseEvent(target, "mousedown", point, 1);
        dispatchPointerEvent(target, "pointerup", point, 0);
        dispatchMouseEvent(target, "mouseup", point, 0);
        dispatchMouseEvent(target, "click", point, 0);

        return target;
    }

    function isTextInputElement(element) {
        const tagName = element?.tagName?.toLowerCase();

        if (tagName === "textarea") {
            return true;
        }

        if (tagName !== "input") {
            return false;
        }

        const inputType = String(element.type || "text").toLowerCase();
        return ![
            "button",
            "checkbox",
            "color",
            "file",
            "hidden",
            "image",
            "radio",
            "range",
            "reset",
            "submit",
        ].includes(inputType);
    }

    function textTargetFor(clickedTarget) {
        const active = document.activeElement;

        if (active?.isContentEditable || isTextInputElement(active)) {
            return active;
        }

        const closestEditable = clickedTarget.closest?.("input, textarea, [contenteditable='true']");

        if (closestEditable) {
            closestEditable.focus?.({ preventScroll: true });
            return closestEditable;
        }

        return active || clickedTarget;
    }

    function insertTextIntoInput(element, textValue) {
        const value = String(element.value || "");
        let selectionStart = value.length;
        let selectionEnd = value.length;

        try {
            if (typeof element.selectionStart === "number") {
                selectionStart = element.selectionStart;
            }

            if (typeof element.selectionEnd === "number") {
                selectionEnd = element.selectionEnd;
            }
        } catch {
            selectionStart = value.length;
            selectionEnd = value.length;
        }

        if (typeof element.setRangeText === "function") {
            try {
                element.setRangeText(textValue, selectionStart, selectionEnd, "end");
                dispatchInputEvent(element, textValue, "insertText");
                element.dispatchEvent(new Event("change", { bubbles: true }));
                return;
            } catch {
                // Some input types expose setRangeText but do not support text selection.
            }
        }

        const nextValue = value.slice(0, selectionStart) + textValue + value.slice(selectionEnd);
        const prototype = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

        if (descriptor?.set) {
            descriptor.set.call(element, nextValue);
        } else {
            element.value = nextValue;
        }

        dispatchInputEvent(element, textValue, "insertText");
        element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function dispatchKeyboardTyping(target, textValue) {
        for (const character of Array.from(textValue)) {
            const key = character === "\n" ? "Enter" : character;
            const eventOptions = {
                key,
                bubbles: true,
                cancelable: true,
            };

            target.dispatchEvent(new KeyboardEvent("keydown", eventOptions));
            target.dispatchEvent(new KeyboardEvent("keypress", eventOptions));
            target.dispatchEvent(new KeyboardEvent("keyup", eventOptions));
        }
    }

    function typeTextAtPoint(point, text) {
        const clickedTarget = clickPoint(point);
        const textValue = String(text ?? "");
        const target = textTargetFor(clickedTarget);

        if (target?.isContentEditable) {
            target.focus?.({ preventScroll: true });
            document.execCommand("insertText", false, textValue);
            dispatchInputEvent(target, textValue, "insertText");
            target.dispatchEvent(new Event("change", { bubbles: true }));
            return;
        }

        if (isTextInputElement(target)) {
            target.focus?.({ preventScroll: true });
            insertTextIntoInput(target, textValue);
            return;
        }

        dispatchKeyboardTyping(target || document.body, textValue);
    }

    if (actionType === "click") {
        if (!action.element_id) {
            const point = resolveActionPoint();
            clickPoint(point);
            return { ok: true, coordinateTargeted: true };
        }

        const element = getElement(action.element_id);
        bringIntoView(element);
        element.focus?.({ preventScroll: true });
        element.click();
        return { ok: true };
    }

    if (actionType === "move") {
        if (!action.element_id) {
            const point = resolveActionPoint();
            moveToPoint(point);
            return { ok: true, coordinateTargeted: true };
        }

        dispatchHover(getElement(action.element_id));
        return { ok: true };
    }

    if (actionType === "type_text") {
        if (!action.element_id) {
            const point = resolveActionPoint();
            typeTextAtPoint(point, action.text);
            return { ok: true, coordinateTargeted: true };
        }

        setElementValue(getElement(action.element_id), action.text);
        return { ok: true };
    }

    if (actionType === "type_secret") {
        setElementValue(getElement(action.element_id), secretValue);
        return { ok: true };
    }

    if (actionType === "key") {
        dispatchKey(action.key);
        return { ok: true };
    }

    if (actionType === "scroll") {
        const direction = action.direction;
        const amount = Number(action.amount ?? 500);
        let x = 0;
        let y = 0;

        if (direction === "down") y = amount;
        if (direction === "up") y = -amount;
        if (direction === "right") x = amount;
        if (direction === "left") x = -amount;

        window.scrollBy(x, y);
        return { ok: true };
    }

    throw new Error(`Unsupported executable action: ${actionType}`);
}

function installManualActionStopperInPage(runId) {
    const eventTypes = [
        "pointerdown",
        "mousedown",
        "keydown",
        "input",
        "change",
        "wheel",
        "touchstart",
    ];

    if (window.__PRISM_MANUAL_ACTION_STOPPER__?.cleanup) {
        window.__PRISM_MANUAL_ACTION_STOPPER__.cleanup();
    }

    let lastSentAt = 0;

    const sendStop = (event) => {
        if (!event.isTrusted) {
            return;
        }

        const now = Date.now();

        if (now - lastSentAt < 500) {
            return;
        }

        lastSentAt = now;

        try {
            chrome.runtime.sendMessage(
                {
                    type: "prism:pageUserAction",
                    runId,
                    eventType: event.type,
                    url: window.location.href,
                },
                () => {
                    void chrome.runtime.lastError;
                }
            );
        } catch {
            // The extension context can disappear during page navigations.
        }
    };

    eventTypes.forEach((eventType) => {
        window.addEventListener(eventType, sendStop, {
            capture: true,
            passive: true,
        });
    });

    window.__PRISM_MANUAL_ACTION_STOPPER__ = {
        runId,
        cleanup() {
            eventTypes.forEach((eventType) => {
                window.removeEventListener(eventType, sendStop, {
                    capture: true,
                });
            });
        },
    };

    return { ok: true };
}

function uninstallManualActionStopperInPage(runId) {
    const stopper = window.__PRISM_MANUAL_ACTION_STOPPER__;

    if (!stopper || stopper.runId !== runId) {
        return { ok: false };
    }

    stopper.cleanup();
    delete window.__PRISM_MANUAL_ACTION_STOPPER__;

    return { ok: true };
}

async function registerManualActionStopper(tab, run) {
    try {
        await executeScript(tab.id, installManualActionStopperInPage, [run.requestId]);
    } catch {
        // Some pages reject extension script injection. The content script still
        // covers normal web pages where it is already loaded.
    }
}

async function unregisterManualActionStopper(run) {
    if (!run.tabId) {
        return;
    }

    try {
        await executeScript(run.tabId, uninstallManualActionStopperInPage, [run.requestId]);
    } catch {
        // The tab may have navigated, closed, or moved to a restricted URL.
    }
}

async function buildBrowserContext(tab, run) {
    ensureRunActive(run);
    const context = await executeScript(tab.id, extractDomInPage);
    ensureRunActive(run);

    return maskBrowserContextForServer(context);
}

const DOM_PII_STRING_FIELDS = new Set([
    "url",
    "title",
    "label",
    "aria_label",
    "placeholder",
    "name",
    "text",
    "masked_value",
    "href",
]);

function maskBrowserContextForServer(context) {
    if (!context || typeof context !== "object") {
        return context;
    }

    const maskedContext = { ...context };

    for (const key of DOM_PII_STRING_FIELDS) {
        if (typeof maskedContext[key] === "string") {
            maskedContext[key] = maskPIIText(maskedContext[key]);
        }
    }

    if (Array.isArray(context.elements)) {
        maskedContext.elements = context.elements.map(maskDomElementForServer);
    }

    return maskedContext;
}

function maskDomElementForServer(element) {
    if (!element || typeof element !== "object") {
        return element;
    }

    const maskedElement = { ...element };

    for (const key of DOM_PII_STRING_FIELDS) {
        if (typeof maskedElement[key] === "string") {
            maskedElement[key] = maskPIIText(maskedElement[key]);
        }
    }

    return maskedElement;
}

function maskPIIText(value) {
    if (!value || typeof value !== "string") {
        return value;
    }

    return maskContextualNames(
        maskNumbers(
            maskTokens(
                maskSensitiveUrlValues(
                    value.replace(
                        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
                        "[EMAIL]"
                    )
                )
            )
        )
    );
}

function maskSensitiveUrlValues(value) {
    return value.replace(
        /([?&](?:access[_-]?token|auth|code|email|key|login|password|secret|session|token|user|username)[^=\s&#)]*=)[^&#\s)]*/gi,
        "$1[REDACTED]"
    );
}

function maskTokens(value) {
    return value
        .replace(
            /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,
            "[TOKEN]"
        )
        .replace(
            /\b(?:sk|pk|ghp|gho|ghu|ghs|xox[baprs])[-_A-Za-z0-9]{16,}\b/gi,
            "[TOKEN]"
        );
}

function maskNumbers(value) {
    return value
        .replace(
            /\b((?:account|code|id|otp|passcode|pin|roll|student|verification)[^\d\n]{0,20})\d{4,}\b/gi,
            "$1[ID]"
        )
        .replace(/\+?\d[\d\s().-]{7,}\d/g, (match) => {
            const digitCount = match.replace(/\D/g, "").length;
            const phoneShaped = /^\+/.test(match) || /[\s().-]/.test(match);

            return digitCount >= 8 && phoneShaped ? "[PHONE]" : match;
        })
        .replace(/\b\d{6,}\b/g, "[ID]");
}

function maskContextualNames(value) {
    return value
        .replace(
            /\b([A-Z][A-Z.'-]{1,}(?:\s+[A-Z][A-Z.'-]{1,}){1,5})(?=\s+(?:\[ID\]|\[EMAIL\]|Edu\b))/g,
            "[NAME]"
        )
        .replace(
            /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,5})(?=\s+(?:\[ID\]|\[EMAIL\]))/g,
            "[NAME]"
        )
        .replace(
            /(\b(?:account|google account|profile|signed in as|user):\s*)(?!\[)([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){1,5})(?=\s*(?:\[ID\]|\(|\[EMAIL\]|$))/gi,
            "$1[NAME]"
        );
}

function stripBase64FromDataUrl(dataUrl) {
    const commaIndex = dataUrl.indexOf(",");

    return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

function pngDimensionsFromBase64(base64Data) {
    const cleanBase64 = String(base64Data || "").replace(/\s+/g, "");

    if (!cleanBase64) {
        return null;
    }

    try {
        const header = atob(cleanBase64.slice(0, 64));
        const bytes = Array.from(header.slice(0, 24), (character) => character.charCodeAt(0));
        const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
        const isPng = pngSignature.every((byte, index) => bytes[index] === byte);

        if (!isPng || bytes.length < 24) {
            return null;
        }

        const width = (
            (bytes[16] * 16777216) +
            (bytes[17] << 16) +
            (bytes[18] << 8) +
            bytes[19]
        );
        const height = (
            (bytes[20] * 16777216) +
            (bytes[21] << 16) +
            (bytes[22] << 8) +
            bytes[23]
        );

        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return null;
        }

        return { width, height };
    } catch {
        return null;
    }
}

function captureVisibleTabDataUrl(windowId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
            const error = chrome.runtime?.lastError;

            if (error) {
                reject(new Error(error.message));
                return;
            }

            resolve(dataUrl);
        });
    });
}

function collectScreenshotSanitizerRegionsInPage() {
    function summarizeUrl(value) {
        if (!value) {
            return "";
        }

        try {
            const url = new URL(value, window.location.href);
            return `${url.origin}${url.pathname}`;
        } catch {
            return "";
        }
    }

    function elementSummary(element) {
        return {
            tag: element.tagName.toLowerCase(),
            id: element.id || "",
            classes: Array.from(element.classList || []).slice(0, 6),
            source: summarizeUrl(
                element.currentSrc ||
                element.src ||
                element.getAttribute("src") ||
                ""
            ),
        };
    }

    function normalizeRect(rect) {
        const left = Number(rect.left);
        const top = Number(rect.top);
        const right = Number(rect.right);
        const bottom = Number(rect.bottom);

        if (![left, top, right, bottom].every(Number.isFinite) ||
            right <= left ||
            bottom <= top) {
            return null;
        }

        return {
            left,
            top,
            right,
            bottom,
            width: right - left,
            height: bottom - top,
        };
    }

    function intersectRects(first, second) {
        const left = Math.max(first.left, second.left);
        const top = Math.max(first.top, second.top);
        const right = Math.min(first.right, second.right);
        const bottom = Math.min(first.bottom, second.bottom);

        return normalizeRect({ left, top, right, bottom });
    }

    function clipsOverflow(style) {
        return [style.overflow, style.overflowX, style.overflowY]
            .some((value) => ["auto", "clip", "hidden", "scroll"].includes(value));
    }

    function isRendered(element) {
        for (let current = element; current; current = current.parentElement) {
            const style = window.getComputedStyle(current);

            if (style.display === "none" ||
                style.visibility === "hidden" ||
                style.visibility === "collapse" ||
                Number(style.opacity || 1) <= 0) {
                return false;
            }
        }

        return true;
    }

    function collectMediaElements(root = document, elements = [], seenElements = new Set(), seenRoots = new Set()) {
        if (!root || seenRoots.has(root)) {
            return elements;
        }

        seenRoots.add(root);

        for (const element of root.querySelectorAll("img, iframe")) {
            if (!seenElements.has(element)) {
                seenElements.add(element);
                elements.push(element);
            }
        }

        for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot) {
                collectMediaElements(element.shadowRoot, elements, seenElements, seenRoots);
            }
        }

        return elements;
    }

    function clippedViewportRectFor(element) {
        const elementRect = normalizeRect(element.getBoundingClientRect());

        if (!elementRect) {
            return null;
        }

        let visibleRect = intersectRects(elementRect, {
            left: 0,
            top: 0,
            right: window.innerWidth,
            bottom: window.innerHeight,
        });

        if (!visibleRect) {
            return null;
        }

        for (let current = element.parentElement; current; current = current.parentElement) {
            if (current === document.body || current === document.documentElement) {
                continue;
            }

            const style = window.getComputedStyle(current);

            if (!clipsOverflow(style)) {
                continue;
            }

            const clipRect = normalizeRect(current.getBoundingClientRect());

            if (!clipRect) {
                return null;
            }

            visibleRect = intersectRects(visibleRect, clipRect);

            if (!visibleRect) {
                return null;
            }
        }

        return visibleRect;
    }

    const mediaElements = collectMediaElements();
    const regions = mediaElements
        .map((element) => {
            if (!isRendered(element)) {
                return null;
            }

            const visibleRect = clippedViewportRectFor(element);

            if (!visibleRect) {
                return null;
            }

            const elementInfo = elementSummary(element);

            return {
                tag: elementInfo.tag,
                element: elementInfo,
                x: visibleRect.left,
                y: visibleRect.top,
                width: visibleRect.width,
                height: visibleRect.height,
            };
        })
        .filter(Boolean);
    const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
    };

    console.log("PRISM screenshot sanitizer visible media:", {
        viewport,
        candidateCount: mediaElements.length,
        count: regions.length,
        elements: regions.map((region, index) => ({
            index,
            tag: region.tag || region.element?.tag || "",
            id: region.element?.id || "",
            classes: region.element?.classes || [],
            source: region.element?.source || "",
            bbox: {
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
            },
        })),
    });

    return {
        viewport,
        regions,
    };
}

function logScreenshotSanitizerTargets(targets) {
    const regions = Array.isArray(targets?.regions) ? targets.regions : [];

    console.log("PRISM screenshot sanitizer targets:", {
        viewport: targets?.viewport || null,
        count: regions.length,
        elements: regions.map((region, index) => ({
            index,
            tag: region.tag || region.element?.tag || "",
            id: region.element?.id || "",
            classes: region.element?.classes || [],
            source: region.element?.source || "",
            bbox: {
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
            },
        })),
    });
}

function broadcastScreenshotSanitizerTargets(targets) {
    try {
        chrome.runtime.sendMessage({
            type: "prism:screenshotSanitizerTargets",
            targets,
        }, () => {
            void chrome.runtime.lastError;
        });
    } catch {
        // The popup may be closed; background logging above still records the target list.
    }
}

async function ensureOffscreenDocument() {
    if (!chrome.offscreen?.createDocument) {
        throw new Error("Offscreen documents are unavailable in this browser.");
    }

    const offscreenUrl = chrome.runtime.getURL("offscreen.html");

    if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT"],
            documentUrls: [offscreenUrl],
        });

        if (contexts.length > 0) {
            return;
        }
    }

    if (!creatingOffscreenDocument) {
        creatingOffscreenDocument = chrome.offscreen.createDocument({
            url: "offscreen.html",
            reasons: ["BLOBS"],
            justification: "Sanitize screenshots before sending them to the local PRISM agent server.",
        });
    }

    try {
        await creatingOffscreenDocument;
    } catch (error) {
        if (!String(error.message || "").includes("Only a single offscreen document")) {
            throw error;
        }
    } finally {
        creatingOffscreenDocument = null;
    }
}

function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            const error = chrome.runtime?.lastError;

            if (error) {
                reject(new Error(error.message));
                return;
            }

            resolve(response);
        });
    });
}

async function getScreenshotSanitizerTargets(tab) {
    if (!isScriptableTab(tab)) {
        return { viewport: null, regions: [] };
    }

    try {
        const targets = await executeScript(tab.id, collectScreenshotSanitizerRegionsInPage);
        logScreenshotSanitizerTargets(targets);
        broadcastScreenshotSanitizerTargets(targets);
        return targets;
    } catch (error) {
        console.warn("Failed to collect screenshot sanitizer regions:", error);
        return { viewport: null, regions: [] };
    }
}

async function sanitizeScreenshotDataUrl(dataUrl, sanitizerTargets = { viewport: null, regions: [] }) {
    await ensureOffscreenDocument();

    const response = await sendRuntimeMessage({
        type: "prism:sanitizeScreenshot",
        dataUrl,
        mediaRegions: Array.isArray(sanitizerTargets?.regions) ? sanitizerTargets.regions : [],
        viewport: sanitizerTargets?.viewport || null,
    });

    if (!response?.ok) {
        throw new Error(response?.error || "Screenshot sanitizer did not respond.");
    }

    return response.base64 || stripBase64FromDataUrl(dataUrl);
}

async function setOffscreenKeepAlive(active) {
    try {
        await ensureOffscreenDocument();

        const response = await sendRuntimeMessage({
            type: "prism:setKeepAlive",
            active,
        });

        if (!response?.ok) {
            throw new Error(response?.error || "Offscreen keepalive did not respond.");
        }
    } catch (error) {
        console.warn("PRISM offscreen keepalive unavailable:", error);
    }
}

async function takeScreenshotBase64(tab, run) {
    const capture = await takeScreenshotCapture(tab, run);

    return capture.base64;
}

async function takeScreenshotCapture(tab, run) {
    ensureRunActive(run);
    const dataUrl = await captureVisibleTabDataUrl(tab.windowId);
    ensureRunActive(run);
    const sanitizerTargets = await getScreenshotSanitizerTargets(tab);
    ensureRunActive(run);
    const base64Data = await sanitizeScreenshotDataUrl(dataUrl, sanitizerTargets);
    ensureRunActive(run);

    return {
        base64: base64Data,
        dimensions: pngDimensionsFromBase64(base64Data) ||
            pngDimensionsFromBase64(stripBase64FromDataUrl(dataUrl)),
    };
}

function screenshotDataUrlFromBase64(base64Data) {
    return `data:image/png;base64,${base64Data}`;
}

async function appendScreenshotPreview(step, base64Data, messageId = "", message = "") {
    const previewMessage = message ||
        `Step ${step + 1}: agent requested a screenshot.\nScreenshot sent to server.`;
    const updates = {
        text: previewMessage,
        imageDataUrl: screenshotDataUrlFromBase64(base64Data),
        includeInAgentHistory: false,
    };

    try {
        await updateChatMessage(messageId, updates);
    } catch (error) {
        console.warn("Failed to store screenshot preview:", error);
        await updateChatMessage(messageId, {
            text: previewMessage,
            includeInAgentHistory: false,
        });
    }
}

function buildAvailableSecrets(secrets) {
    return secrets.map((record) => ({
        key: record.key,
        category: record.category,
        description: record.description || "",
    }));
}

function buildUserInputs() {
    return Object.entries(userInputs).map(([key, value]) => ({ key, value }));
}

function buildScreenshotOnlyBrowserContext() {
    return { elements: [] };
}

async function fetchJsonWithTimeout(url, options, timeoutMs, run) {
    ensureRunActive(run);

    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const abortFetch = () => controller.abort();

    run.fetchController = controller;
    run.cancelController.signal.addEventListener("abort", abortFetch, { once: true });

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });
        const text = await response.text();
        let data = null;

        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = text;
            }
        }

        if (!response.ok) {
            const detail = typeof data === "string" ? data : JSON.stringify(data, null, 2);
            throw new Error(`Agent HTTP ${response.status}: ${detail}`);
        }

        return data;
    } catch (error) {
        if (error.name === "AbortError") {
            if (run.stopped) {
                throw new AgentStoppedError(run.stopReason);
            }

            if (timedOut) {
                throw new Error(`Agent request timed out after ${Math.round(timeoutMs / 1000)}s.`);
            }

            throw new Error("Agent request was cancelled.");
        }

        throw error;
    } finally {
        clearTimeout(timeoutId);
        run.cancelController.signal.removeEventListener("abort", abortFetch);

        if (run.fetchController === controller) {
            run.fetchController = null;
        }
    }
}

async function callAgent({ run, query, browser, screenshotBase64, secrets, screenshotOnly = false }) {
    const payload = {
        request_id: run.requestId,
        query,
        browser: screenshotOnly ? buildScreenshotOnlyBrowserContext() : browser,
        available_secrets: buildAvailableSecrets(secrets),
        user_inputs: buildUserInputs(),
        previous_messages: screenshotOnly ? [] : normalizeAgentPreviousMessages(run.previousMessages),
        screenshot_base64: screenshotBase64,
    };

    return fetchJsonWithTimeout(
        AGENT_URL,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        },
        AGENT_REQUEST_TIMEOUT_MS,
        run
    );
}

function agentErrorText(value) {
    if (value instanceof Error) {
        return value.message;
    }

    if (typeof value === "string") {
        return value;
    }

    if (!value || typeof value !== "object") {
        return "";
    }

    return [
        value.error,
        value.message,
        value.detail,
        value.type,
        value.code,
    ].map(stringifyValue).filter(Boolean).join("\n");
}

function isPayloadTooLargeAgentError(value) {
    const text = agentErrorText(value).toLowerCase();

    return /\b413\b/.test(text) ||
        text.includes("request too large") ||
        (text.includes("tokens per minute") && text.includes("requested")) ||
        (text.includes("tpm") && text.includes("requested"));
}

function isPayloadTooLargeAgentResponse(response) {
    return response?.status === "error" &&
        isPayloadTooLargeAgentError(response.error || response.message || response);
}

async function retryAgentWithScreenshotOnly({ run, query, tab, step, screenshotBase64, screenshotSize, secrets }) {
    const retryMessageId = makeRequestId();
    const retryMessage = `Step ${step + 1}: request was too large. Retrying with screenshot only.`;

    await appendChat("received", retryMessage, {
        id: retryMessageId,
        includeInAgentHistory: false,
    });

    let retryScreenshotBase64 = screenshotBase64;
    let retryScreenshotSize = screenshotSize || (
        retryScreenshotBase64
            ? pngDimensionsFromBase64(retryScreenshotBase64)
            : null
    );

    if (!retryScreenshotBase64) {
        try {
            const retryScreenshot = await takeScreenshotCapture(tab, run);

            retryScreenshotBase64 = retryScreenshot.base64;
            retryScreenshotSize = retryScreenshot.dimensions;
        } catch (error) {
            await updateChatMessage(retryMessageId, {
                text: `${retryMessage}\nScreenshot capture failed: ${error.message}`,
                includeInAgentHistory: false,
            });
            throw error;
        }
    }

    await appendScreenshotPreview(
        step,
        retryScreenshotBase64,
        retryMessageId,
        `${retryMessage}\nScreenshot sent to server.`
    );

    const response = await callAgent({
        run,
        query,
        browser: buildScreenshotOnlyBrowserContext(),
        screenshotBase64: retryScreenshotBase64,
        secrets,
        screenshotOnly: true,
    });

    return {
        response,
        screenshotSize: retryScreenshotSize,
    };
}

function getSecretValue(secrets, secretKey) {
    const record = secrets.find((secret) => secret.key === secretKey);

    if (!record) {
        throw new Error(`Local secret not found: ${secretKey}`);
    }

    return record.value;
}

function isExecutableAction(action) {
    return action?.type && !["request_screenshot", "request_user_input"].includes(action.type);
}

function isCoordinateTargetedAction(action) {
    return ["click", "move", "type_text"].includes(action?.type) &&
        !action.element_id &&
        Number.isFinite(Number(action.x)) &&
        Number.isFinite(Number(action.y));
}

async function executeAction(run, tab, action, secrets, screenshotSize) {
    ensureRunActive(run);

    if (!isExecutableAction(action)) {
        return false;
    }

    if (action.type === "wait") {
        await abortableSleep(Number(action.milliseconds ?? 1000), run);
        return false;
    }

    const secretValue = action.type === "type_secret"
        ? getSecretValue(secrets, action.secret_key)
        : null;

    const result = await executeScript(tab.id, executeAgentActionInPage, [action, secretValue, screenshotSize]);
    ensureRunActive(run);

    return Boolean(result?.coordinateTargeted) || isCoordinateTargetedAction(action);
}

async function executeActions(run, tab, actions, secrets, screenshotSize) {
    let usedCoordinateTarget = false;

    for (const action of actions) {
        usedCoordinateTarget = await executeAction(run, tab, action, secrets, screenshotSize) ||
            usedCoordinateTarget;
    }

    return usedCoordinateTarget;
}

function formatUserInputRequest(actions) {
    const requests = actions.filter((action) => action.type === "request_user_input");

    if (requests.length === 0) {
        return "Agent requires more user input.";
    }

    const lines = requests.map((action) => {
        const key = action.key || action.name || action.field || "";
        const prompt = action.prompt || action.message || action.description || "Additional input required";
        return key ? `${key}: ${prompt}` : prompt;
    });

    return `Agent requires user input:\n${lines.join("\n")}`;
}

function agentCompletionText(response) {
    const message = agentMessageText(response);

    return message ||
        response.answer ||
        response.result ||
        response.final ||
        "Agent finished.";
}

function agentMessageText(response) {
    const message = stringifyValue(response?.message).trim();

    if (!message || ["none", "null"].includes(message.toLowerCase())) {
        return "";
    }

    return message;
}

function trackPreviousMessage(run, messageText) {
    if (messageText) {
        run.previousMessages.push({
            role: "assistant",
            message: messageText,
        });
    }
}

function normalizeAgentPreviousMessages(messages) {
    if (!Array.isArray(messages)) {
        return [];
    }

    return messages
        .filter((message) => message && typeof message === "object")
        .map((message) => ({
            role: message.role === "system" ? "system" : message.role === "assistant" ? "assistant" : "",
            message: stringifyValue(message.message ?? message.text ?? ""),
        }))
        .filter((message) => message.role && message.message);
}

async function getAttachScreenshotSetting() {
    const value = await storageGetValue(SCREENSHOT_SETTING_KEY, false);

    return value === true || value === "true";
}

async function buildPreviousMessages() {
    const messages = await getChatMessages();

    return messages
        .filter((message) => message.type === "received"
            && message.includeInAgentHistory !== false
            && message.text)
        .slice(-40)
        .map((message) => ({
            role: "assistant",
            message: message.text,
        }));
}

async function runBrowserAgent(run, query) {
    ensureRunActive(run);
    const secrets = await loadSecrets();
    ensureRunActive(run);

    let tab = await getActiveTab();
    ensureRunActive(run);

    if (!isScriptableTab(tab)) {
        throw new Error(`PRISM can run on http, https, or file tabs. Current tab: ${tab.url || "unknown"}`);
    }

    run.tabId = tab.id;
    run.tabTitle = tab.title || "";
    run.tabUrl = tab.url || "";

    await setRunState(run, "running");
    ensureRunActive(run);
    await appendChat("received", `Running agent on: ${tab.title || tab.url || "active tab"}`);
    await registerManualActionStopper(tab, run);

    let screenshotBase64 = null;
    let screenshotSize = null;
    let screenshotOnlyMode = false;
    let forceScreenshotNextStep = false;

    for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
        ensureRunActive(run);

        tab = await waitForTabReady(tab.id, 8000, run);
        run.tabId = tab.id;
        run.tabTitle = tab.title || run.tabTitle || "";
        run.tabUrl = tab.url || run.tabUrl || "";
        await setRunState(run, "running");
        ensureRunActive(run);
        await registerManualActionStopper(tab, run);

        const browser = screenshotOnlyMode
            ? buildScreenshotOnlyBrowserContext()
            : await buildBrowserContext(tab, run);

        const mustCaptureScreenshot = screenshotOnlyMode || forceScreenshotNextStep;
        const shouldCaptureScreenshot = mustCaptureScreenshot || await getAttachScreenshotSetting();

        if (shouldCaptureScreenshot) {
            try {
                const screenshot = await takeScreenshotCapture(tab, run);

                screenshotBase64 = screenshot.base64;
                screenshotSize = screenshot.dimensions;
                forceScreenshotNextStep = false;
            } catch (error) {
                await appendChat(
                    "received",
                    `Screenshot capture failed: ${error.message}`
                );

                screenshotBase64 = null;
                screenshotSize = null;

                if (mustCaptureScreenshot) {
                    run.finalStatus = "screenshot_failed";
                    return;
                }
            }
        }

        let response;
        let agentScreenshotSize = screenshotBase64 ? screenshotSize : null;

        try {
            response = await callAgent({
                run,
                query,
                browser,
                screenshotBase64,
                secrets,
                screenshotOnly: screenshotOnlyMode,
            });
        } catch (error) {
            if (screenshotOnlyMode || !isPayloadTooLargeAgentError(error)) {
                throw error;
            }

            screenshotOnlyMode = true;
            const retryResult = await retryAgentWithScreenshotOnly({
                run,
                query,
                tab,
                step,
                screenshotBase64,
                screenshotSize,
                secrets,
            });

            response = retryResult.response;
            agentScreenshotSize = retryResult.screenshotSize;
        }

        ensureRunActive(run);

        if (!screenshotOnlyMode && isPayloadTooLargeAgentResponse(response)) {
            screenshotOnlyMode = true;
            const retryResult = await retryAgentWithScreenshotOnly({
                run,
                query,
                tab,
                step,
                screenshotBase64,
                screenshotSize,
                secrets,
            });

            response = retryResult.response;
            agentScreenshotSize = retryResult.screenshotSize;
            ensureRunActive(run);
        }

        const status = response?.status;
        const actions = Array.isArray(response?.actions)
            ? response.actions
            : [];

        screenshotBase64 = null;
        screenshotSize = null;

        const responseMessage = agentMessageText(response);

        if (responseMessage) {
            trackPreviousMessage(run, responseMessage);
        }

        if (status === "error") {
            await appendChat("received", `Agent returned an error:\n${response.error || "Unknown error"}`);
            run.finalStatus = "error";
            return;
        }

        if (status === "screenshot_required") {
            const screenshotMessageId = makeRequestId();
            await appendChat("received", `Step ${step + 1}: agent requested a screenshot.`, {
                id: screenshotMessageId,
                includeInAgentHistory: false,
            });

            try {
                const screenshot = await takeScreenshotCapture(tab, run);

                screenshotBase64 = screenshot.base64;
                screenshotSize = screenshot.dimensions;
                await appendScreenshotPreview(step, screenshotBase64, screenshotMessageId);
            } catch (error) {
                await updateChatMessage(screenshotMessageId, {
                    text: `Step ${step + 1}: agent requested a screenshot.\nScreenshot capture failed: ${error.message}`,
                    includeInAgentHistory: false,
                });
                run.finalStatus = "screenshot_failed";
                return;
            }
            continue;
        }

        if (status === "user_input_required") {
            await appendChat("received", formatUserInputRequest(actions));
            run.finalStatus = "needs_user_input";
            return;
        }

        if (status === "actions_ready") {
            const executableActions = actions.filter(isExecutableAction);

            if (executableActions.length === 0) {
                await appendChat("received", responseMessage || "Agent returned no executable actions.");
                run.finalStatus = "no_actions";
                return;
            }

            await appendChat(
                "received",
                responseMessage || `Step ${step + 1}: executing ${executableActions.length} action(s).`
            );
            const usedCoordinateTarget = await executeActions(
                run,
                tab,
                executableActions,
                secrets,
                agentScreenshotSize
            );
            await abortableSleep(AGENT_ACTION_SETTLE_MS, run);

            if (usedCoordinateTarget) {
                forceScreenshotNextStep = true;
            }

            continue;
        }

        if (["done", "complete", "completed", "success"].includes(status)) {
            await appendChat("received", agentCompletionText(response));
            run.finalStatus = "complete";
            return;
        }

        throw new Error(`Unsupported agent status: ${status || "missing"}`);
    }

    await appendChat("received", "Maximum agent steps reached.");
    run.finalStatus = "max_steps";
}

async function finishRun(run, error = null) {
    try {
        if (error) {
            if (error instanceof AgentStoppedError || run.stopped) {
                run.finalStatus = "stopped";

                if (!run.stopNoticeWritten && !run.suppressStopNotice) {
                    run.stopNoticeWritten = true;
                    await appendChat("received", stopMessageFor(run.stopReason));
                }
            } else {
                run.finalStatus = "error";
                await appendChat("received", `Agent failed: ${error.message}`);
            }
        } else if (run.stopped) {
            run.finalStatus = "stopped";
        }
    } catch (finishError) {
        console.error("Failed to write PRISM agent completion message:", finishError);
    } finally {
        if (activeRun === run) {
            activeRun = null;
        }

        await unregisterManualActionStopper(run);
        await setOffscreenKeepAlive(false);

        try {
            await setAgentState({
                running: false,
                status: run.finalStatus || "idle",
                requestId: "",
                tabId: run.tabId,
                tabTitle: run.tabTitle,
                tabUrl: run.tabUrl,
                stopReason: run.stopReason || "",
                updatedAt: Date.now(),
            });
        } catch (stateError) {
            console.error("Failed to write PRISM agent state:", stateError);
        }
    }
}

async function startBackgroundAgent(query) {
    const trimmedQuery = stringifyValue(query).trim();

    if (!trimmedQuery) {
        return { ok: false, error: "Enter a prompt first." };
    }

    if (activeRun) {
        return { ok: false, error: "Agent is already running." };
    }

    const run = {
        requestId: makeRequestId(),
        tabId: null,
        tabTitle: "",
        tabUrl: "",
        status: "starting",
        previousMessages: await buildPreviousMessages(),
        stopped: false,
        stopReason: "",
        stopNoticeWritten: false,
        suppressStopNotice: false,
        finalStatus: "",
        cancelController: new AbortController(),
        fetchController: null,
    };

    activeRun = run;

    try {
        await appendChat("sent", trimmedQuery);
        await setRunState(run, "starting");
        await setOffscreenKeepAlive(true);
    } catch (error) {
        if (activeRun === run) {
            activeRun = null;
        }

        throw error;
    }

    runBrowserAgent(run, trimmedQuery)
        .then(() => finishRun(run))
        .catch((error) => finishRun(run, error))
        .catch((error) => {
            console.error("Failed to finish PRISM agent run:", error);
        });

    return {
        ok: true,
        state: await getAgentState(),
    };
}

async function stopActiveRun(reason = "manual_stop", options = {}) {
    if (!activeRun) {
        return false;
    }

    const run = activeRun;
    const writeNotice = options.writeNotice !== false;

    if (!run.stopped) {
        run.stopped = true;
        run.stopReason = reason;
        run.suppressStopNotice = Boolean(options.suppressStopNotice);
        run.cancelController.abort();
        run.fetchController?.abort();
    }

    await setRunState(run, "stopping", {
        stopReason: reason,
    });

    if (writeNotice && !run.stopNoticeWritten) {
        run.stopNoticeWritten = true;
        await appendChat("received", stopMessageFor(reason));
    }

    return true;
}

async function clearChat(stopRun = true) {
    if (activeRun && stopRun) {
        await stopActiveRun("clear_chat", {
            writeNotice: false,
            suppressStopNotice: true,
        });
    }

    await storageSetValue(CHAT_STORAGE_KEY, []);

    return { ok: true };
}

async function getSnapshot() {
    return {
        ok: true,
        chat: await getChatMessages(),
        state: await getAgentState(),
        sanitizerDebugLog: await storageGetValue(SANITIZER_DEBUG_STORAGE_KEY, null),
    };
}

async function storeScreenshotSanitizerDebugLog(debugLog) {
    const entry = {
        kind: stringifyValue(debugLog?.kind || "debug"),
        payload: debugLog?.payload ?? null,
        createdAt: Date.now(),
    };

    await storageSetValue(SANITIZER_DEBUG_STORAGE_KEY, entry);

    return { ok: true };
}

async function handlePageUserAction(message, sender) {
    if (!activeRun) {
        return { ok: true, stopped: false };
    }

    const senderTabId = sender?.tab?.id;

    if (senderTabId && activeRun.tabId && senderTabId !== activeRun.tabId) {
        return { ok: true, stopped: false };
    }

    if (message.runId && message.runId !== activeRun.requestId) {
        return { ok: true, stopped: false };
    }

    const stopped = await stopActiveRun("page_action");

    return { ok: true, stopped };
}

async function handleMessage(message, sender) {
    if (message.type === "prism:startAgent") {
        return startBackgroundAgent(message.query);
    }

    if (message.type === "prism:stopAgent") {
        const stopped = await stopActiveRun("manual_stop");

        return { ok: true, stopped };
    }

    if (message.type === "prism:clearChat") {
        return clearChat(message.stopRun !== false);
    }

    if (message.type === "prism:getSnapshot") {
        return getSnapshot();
    }

    if (message.type === "prism:pageUserAction") {
        return handlePageUserAction(message, sender);
    }

    if (message.type === "prism:keepAlive") {
        return { ok: true, running: Boolean(activeRun) };
    }

    if (message.type === "prism:screenshotSanitizerDebugLog") {
        return storeScreenshotSanitizerDebugLog(message.debugLog);
    }

    return { ok: false, error: "Unsupported PRISM message." };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!HANDLED_MESSAGE_TYPES.has(message?.type)) {
        return false;
    }

    handleMessage(message, sender)
        .then(sendResponse)
        .catch((error) => {
            sendResponse({
                ok: false,
                error: error.message,
            });
        });

    return true;
});
