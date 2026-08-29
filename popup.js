import { sanitizeScreenshot } from "./sanitize.js";

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

const AGENT_URL = "http://127.0.0.1:8000/agent";
const MAX_AGENT_STEPS = 20;
const AGENT_ACTION_SETTLE_MS = 500;
const AGENT_REQUEST_TIMEOUT_MS = 120000;

const $ = (id) => document.getElementById(id);

const elements = {
    agentTab: $("agentTab"),
    privateTab: $("privateTab"),
    agentView: $("agentView"),
    privateView: $("privateView"),
    chat: $("chat"),
    messageInput: $("messageInput"),
    send: $("send"),
    attachScreenshot: $("attachScreenshot"),
    screenshotStatus: $("screenshotStatus"),
    secretSearch: $("secretSearch"),
    addSecret: $("addSecret"),
    exportSecrets: $("exportSecrets"),
    importSecrets: $("importSecrets"),
    importSecretsFile: $("importSecretsFile"),
    secretList: $("secretList"),
    secretForm: $("secretForm"),
    secretId: $("secretId"),
    secretKey: $("secretKey"),
    secretValue: $("secretValue"),
    toggleReveal: $("toggleReveal"),
    secretCategory: $("secretCategory"),
    secretDescription: $("secretDescription"),
    cancelSecret: $("cancelSecret"),
    deleteSecret: $("deleteSecret"),
    clearSecrets: $("clearSecrets"),
};

let secrets = [];
let editingKey = "";
let agentRunning = false;
const userInputs = {};

let previousMessages = [];

const SCREENSHOT_SETTING_KEY = "prism.attachScreenshot";
let attachScreenshot = false;

function hasChromeStorage() {
    return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

function storageGetAll() {
    if (!hasChromeStorage()) {
        const entries = {};

        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);

            if (key) {
                entries[key] = decodeStoredValue(localStorage.getItem(key));
            }
        }

        return Promise.resolve(entries);
    }

    return new Promise((resolve, reject) => {
        chrome.storage.local.get(null, (items) => {
            const error = chrome.runtime?.lastError;

            if (error) {
                reject(new Error(error.message));
                return;
            }

            resolve(items || {});
        });
    });
}

function storageSet(key, value) {
    if (!hasChromeStorage()) {
        localStorage.setItem(key, JSON.stringify(value));
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        chrome.storage.local.set({ [key]: value }, () => {
            const error = chrome.runtime?.lastError;

            if (error) {
                reject(new Error(error.message));
                return;
            }

            resolve();
        });
    });
}

function storageRemove(keys) {
    const keyList = Array.isArray(keys) ? keys : [keys];

    if (!hasChromeStorage()) {
        keyList.forEach((key) => localStorage.removeItem(key));
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        chrome.storage.local.remove(keyList, () => {
            const error = chrome.runtime?.lastError;

            if (error) {
                reject(new Error(error.message));
                return;
            }

            resolve();
        });
    });
}

function decodeStoredValue(rawValue) {
    if (typeof rawValue !== "string") {
        return rawValue;
    }

    try {
        return JSON.parse(rawValue);
    } catch {
        return rawValue;
    }
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
    if (!key || LEGACY_COLLECTION_KEYS.has(key)) {
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

    if (!safeKey || LEGACY_COLLECTION_KEYS.has(safeKey)) {
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

function storageValueFor(record) {
    return {
        value: record.value,
        category: normalizeCategory(record.category, record.key, record.value),
        description: record.description || "",
    };
}

function sortRecords(records) {
    return [...records].sort((left, right) => left.key.localeCompare(right.key));
}

async function loadSecrets() {
    const storedItems = await storageGetAll();
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

    secrets = sortRecords([...byKey.values()]);
}

function setActiveView(viewName) {
    const showSensitive = viewName === "private";

    elements.agentTab.classList.toggle("active", !showSensitive);
    elements.privateTab.classList.toggle("active", showSensitive);
    elements.agentView.classList.toggle("active", !showSensitive);
    elements.privateView.classList.toggle("active", showSensitive);
}

function appendMessage(type, text) {
    const message = document.createElement("div");
    message.className = `message ${type}`;
    message.textContent = text;
    elements.chat.appendChild(message);
    elements.chat.scrollTop = elements.chat.scrollHeight;
}

function makeRequestId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function hasBrowserAgentApis() {
    return typeof chrome !== "undefined" &&
        Boolean(chrome.tabs?.query) &&
        Boolean(chrome.tabs?.get) &&
        Boolean(chrome.tabs?.captureVisibleTab) &&
        Boolean(chrome.scripting?.executeScript);
}

function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function setAgentRunning(running) {
    agentRunning = running;
    elements.send.disabled = running;
    elements.messageInput.disabled = running;
    elements.send.textContent = running ? "Running" : "Send";
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

async function waitForTabReady(tabId, timeoutMs = 8000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const tab = await getTab(tabId);

        if (tab.status !== "loading") {
            return tab;
        }

        await sleep(250);
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

function captureScreenshotBase64(windowId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(windowId, { format: "png" }, async (dataUrl) => {
            const error = chrome.runtime?.lastError;

            if (error) {
                reject(new Error(error.message));
                return;
            }

            try {
                const sanitizedCanvas = await sanitizeScreenshot(dataUrl);

                const sanitizedDataUrl = sanitizedCanvas.toDataURL("image/png");

                const commaIndex = sanitizedDataUrl.indexOf(",");
                const base64Data = commaIndex === -1 ? sanitizedDataUrl : sanitizedDataUrl.slice(commaIndex + 1);

                resolve(base64Data);
            } catch (err) {
                reject(new Error(`Failed to sanitize screenshot: ${err.message}`));
            }
        });
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

function executeAgentActionInPage(action, secretValue) {
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

    function setElementValue(element, value) {
        const textValue = String(value ?? "");

        bringIntoView(element);

        if (element.isContentEditable) {
            element.focus();
            document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, textValue);
            element.dispatchEvent(new InputEvent("input", { bubbles: true, data: textValue }));
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

        element.dispatchEvent(new InputEvent("input", { bubbles: true, data: textValue }));
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

    if (actionType === "click") {
        const element = getElement(action.element_id);
        bringIntoView(element);
        element.focus?.({ preventScroll: true });
        element.click();
        return { ok: true };
    }

    if (actionType === "move") {
        dispatchHover(getElement(action.element_id));
        return { ok: true };
    }

    if (actionType === "type_text") {
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

async function buildBrowserContext(tab) {
    return executeScript(tab.id, extractDomInPage);
}

async function takeScreenshotBase64(tab) {
    return captureScreenshotBase64(tab.windowId);
}

function buildAvailableSecrets() {
    return secrets.map((record) => ({
        key: record.key,
        category: record.category,
        description: record.description || "",
    }));
}

function buildUserInputs() {
    return Object.entries(userInputs).map(([key, value]) => ({ key, value }));
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

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
            throw new Error(`Agent request timed out after ${Math.round(timeoutMs / 1000)}s.`);
        }

        throw error;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

async function callAgent({ requestId, query, browser, screenshotBase64 }) {
    const payload = {
        request_id: requestId,
        query,
        browser,
        available_secrets: buildAvailableSecrets(),
        user_inputs: buildUserInputs(),
        previous_messages: previousMessages,
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
        AGENT_REQUEST_TIMEOUT_MS
    );
}

function getSecretValue(secretKey) {
    const record = secrets.find((secret) => secret.key === secretKey);

    if (!record) {
        throw new Error(`Local secret not found: ${secretKey}`);
    }

    return record.value;
}

function isExecutableAction(action) {
    return action?.type && !["request_screenshot", "request_user_input"].includes(action.type);
}

async function executeAction(tab, action) {
    if (!isExecutableAction(action)) {
        return;
    }

    if (action.type === "wait") {
        await sleep(Number(action.milliseconds ?? 1000));
        return;
    }

    const secretValue = action.type === "type_secret"
        ? getSecretValue(action.secret_key)
        : null;

    await executeScript(tab.id, executeAgentActionInPage, [action, secretValue]);
}

async function executeActions(tab, actions) {
    for (const action of actions) {
        await executeAction(tab, action);
    }
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
    return response.message ||
        response.answer ||
        response.result ||
        response.final ||
        "Agent finished.";
}

function trackPreviousMessage(messageText) {
    if (messageText) {
        previousMessages.push({
            role: "assistant",
            message: messageText,
        });
    }
}

async function runBrowserAgent(query) {
    if (!hasBrowserAgentApis()) {
        throw new Error("PRISM must be run from the Chrome extension popup on an active web page.");
    }

    await loadSecrets();

    let tab = await getActiveTab();

    if (!isScriptableTab(tab)) {
        throw new Error(`PRISM can run on http, https, or file tabs. Current tab: ${tab.url || "unknown"}`);
    }

    const requestId = makeRequestId();
    let screenshotBase64 = null;

    appendMessage("received", `Running agent on: ${tab.title || tab.url || "active tab"}`);

    for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
        tab = await waitForTabReady(tab.id);

        const browser = await buildBrowserContext(tab);

        // When enabled, capture a fresh screenshot before every
        // request to the agent server.
        if (attachScreenshot) {
            try {
                screenshotBase64 = await takeScreenshotBase64(tab);
            } catch (error) {
                appendMessage(
                    "received",
                    `Screenshot capture failed: ${error.message}`
                );

                screenshotBase64 = null;
            }
        }

        const response = await callAgent({
            requestId,
            query,
            browser,
            screenshotBase64,
        });

        const status = response?.status;
        const actions = Array.isArray(response?.actions)
            ? response.actions
            : [];

        screenshotBase64 = null;

        if (response?.message) {
            trackPreviousMessage(response.message);
        }

        if (status === "error") {
            appendMessage("received", `Agent returned an error:\n${response.error || "Unknown error"}`);
            return;
        }

        if (status === "screenshot_required") {
            appendMessage("received", `Step ${step + 1}: agent requested a screenshot.`);
            screenshotBase64 = await takeScreenshotBase64(tab);
            continue;
        }

        if (status === "user_input_required") {
            appendMessage("received", formatUserInputRequest(actions));
            return;
        }

        if (status === "actions_ready") {
            const executableActions = actions.filter(isExecutableAction);

            if (executableActions.length === 0) {
                appendMessage("received", "Agent returned no executable actions.");
                return;
            }

            // appendMessage("received", `Step ${step + 1}: executing ${executableActions.length} action(s).`);
            appendMessage("received", `${response.message}`);
            await executeActions(tab, executableActions);
            await sleep(AGENT_ACTION_SETTLE_MS);
            continue;
        }

        if (["done", "complete", "completed", "success"].includes(status)) {
            appendMessage("received", agentCompletionText(response));
            return;
        }

        throw new Error(`Unsupported agent status: ${status || "missing"}`);
    }

    appendMessage("received", "Maximum agent steps reached.");
}

async function sendMessage() {
    if (agentRunning) {
        return;
    }

    const text = elements.messageInput.value.trim();

    if (!text) {
        return;
    }

    appendMessage("sent", text);
    elements.messageInput.value = "";
    setAgentRunning(true);

    try {
        await runBrowserAgent(text);
    } catch (error) {
        appendMessage("received", `Agent failed: ${error.message}`);
    } finally {
        setAgentRunning(false);
        elements.messageInput.focus();
    }
}

function populateCategorySelect() {
    elements.secretCategory.replaceChildren();

    CATEGORIES.forEach((category) => {
        const option = document.createElement("option");
        option.value = category;
        option.textContent = category;
        elements.secretCategory.appendChild(option);
    });
}

function recordMatchesSearch(record, search) {
    if (!search) {
        return true;
    }

    const haystack = [
        record.key,
        record.value,
        record.category,
        record.description,
    ].join(" ").toLowerCase();

    return haystack.includes(search.toLowerCase());
}

function createMetaChip(text) {
    const chip = document.createElement("span");
    chip.className = "meta-chip";
    chip.textContent = text;
    return chip;
}

function renderSecrets() {
    const search = elements.secretSearch.value.trim();
    const filteredSecrets = secrets.filter((record) => recordMatchesSearch(record, search));

    elements.secretList.replaceChildren();

    if (filteredSecrets.length === 0) {
        const emptyState = document.createElement("div");
        emptyState.className = "empty-state";
        emptyState.textContent = secrets.length === 0
            ? "No local sensitive records yet."
            : "No records match the current search.";
        elements.secretList.appendChild(emptyState);
        return;
    }

    filteredSecrets.forEach((record) => {
        const row = document.createElement("article");
        row.className = "secret-row";

        const content = document.createElement("div");

        const key = document.createElement("div");
        key.className = "secret-key";
        key.textContent = record.key;

        const value = document.createElement("div");
        value.className = "secret-value";
        value.textContent = record.value || "(empty value)";

        const description = document.createElement("div");
        description.className = "secret-description";
        description.textContent = record.description || "No description";

        const meta = document.createElement("div");
        meta.className = "secret-meta";
        meta.appendChild(createMetaChip(record.category));

        content.append(key, value, description, meta);

        const actions = document.createElement("div");

        const copyButton = document.createElement("button");
        copyButton.className = "secondary";
        copyButton.type = "button";
        copyButton.textContent = "Copy";
        copyButton.addEventListener("click", () => copyValue(record.value));

        const editButton = document.createElement("button");
        editButton.className = "secondary";
        editButton.type = "button";
        editButton.textContent = "Edit";
        editButton.addEventListener("click", () => showSecretForm(record));

        const deleteButton = document.createElement("button");
        deleteButton.className = "danger";
        deleteButton.type = "button";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", () => deleteRecord(record.key));

        actions.append(copyButton, editButton, deleteButton);
        row.append(content, actions);
        elements.secretList.appendChild(row);
    });
}

async function copyValue(value) {
    try {
        await navigator.clipboard.writeText(value);
    } catch {
        const textArea = document.createElement("textarea");
        textArea.value = value;
        textArea.className = "copy-buffer";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        textArea.remove();
    }
}

function resetSecretForm() {
    editingKey = "";
    elements.secretId.value = "";
    elements.secretKey.value = "";
    elements.secretValue.value = "";
    elements.secretValue.type = "password";
    elements.toggleReveal.textContent = "Reveal";
    elements.secretCategory.value = "other";
    elements.secretDescription.value = "";
    elements.deleteSecret.classList.add("hidden");
}

function showSecretForm(record = null) {
    resetSecretForm();

    if (record) {
        editingKey = record.key;
        elements.secretId.value = record.key;
        elements.secretKey.value = record.key;
        elements.secretValue.value = record.value;
        elements.secretCategory.value = normalizeCategory(record.category, record.key, record.value);
        elements.secretDescription.value = record.description;
        elements.deleteSecret.classList.remove("hidden");
    }

    elements.secretForm.classList.remove("hidden");
    elements.secretKey.focus();
}

function hideSecretForm() {
    resetSecretForm();
    elements.secretForm.classList.add("hidden");
}

async function saveRecord(event) {
    event.preventDefault();

    const key = elements.secretKey.value.trim();
    const value = elements.secretValue.value;
    const category = normalizeCategory(elements.secretCategory.value, key, value);
    const description = elements.secretDescription.value.trim();

    if (!key) {
        elements.secretKey.focus();
        return;
    }

    const duplicateRecord = secrets.find((record) => record.key === key && record.key !== editingKey);

    if (duplicateRecord) {
        window.alert(`A record named "${key}" already exists.`);
        return;
    }

    const record = { key, value, category, description };

    if (editingKey && editingKey !== key) {
        await storageRemove(editingKey);
    }

    await storageSet(key, storageValueFor(record));
    await loadSecrets();
    renderSecrets();
    hideSecretForm();
}

async function deleteRecord(key) {
    if (!key || !window.confirm(`Delete "${key}" from local storage?`)) {
        return;
    }

    await storageRemove(key);
    await loadSecrets();
    renderSecrets();

    if (editingKey === key) {
        hideSecretForm();
    }
}

async function clearSecrets() {
    if (secrets.length === 0) {
        return;
    }

    if (!window.confirm("Clear every listed sensitive record from local storage?")) {
        return;
    }

    await storageRemove(secrets.map((record) => record.key));
    await loadSecrets();
    renderSecrets();
    hideSecretForm();
}

function exportSecrets() {
    const payload = secrets.reduce((accumulator, record) => {
        accumulator[record.key] = storageValueFor(record);
        return accumulator;
    }, {});
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);

    link.href = url;
    link.download = `prism-sensitive-data-${date}.json`;
    link.click();
    URL.revokeObjectURL(url);
}

async function importSecrets(event) {
    const file = event.target.files?.[0];

    if (!file) {
        return;
    }

    try {
        const text = await file.text();
        const importedRecords = recordsFromJson(JSON.parse(text));

        if (importedRecords.length === 0) {
            window.alert("The JSON file does not contain any importable records.");
            return;
        }

        const uniqueRecords = new Map();
        importedRecords.forEach((record) => uniqueRecords.set(record.key, record));

        for (const record of uniqueRecords.values()) {
            await storageSet(record.key, storageValueFor(record));
        }

        await loadSecrets();
        renderSecrets();
        window.alert(`Imported ${uniqueRecords.size} record(s).`);
    } catch (error) {
        window.alert(`Import failed: ${error.message}`);
    } finally {
        elements.importSecretsFile.value = "";
    }
}

function bindEvents() {
    elements.agentTab.addEventListener("click", () => setActiveView("agent"));
    elements.privateTab.addEventListener("click", () => setActiveView("private"));
    elements.send.addEventListener("click", sendMessage);
    elements.messageInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });
    elements.addSecret.addEventListener("click", () => showSecretForm());
    elements.secretSearch.addEventListener("input", renderSecrets);
    elements.secretForm.addEventListener("submit", saveRecord);
    elements.cancelSecret.addEventListener("click", hideSecretForm);
    elements.deleteSecret.addEventListener("click", () => deleteRecord(editingKey));
    elements.clearSecrets.addEventListener("click", clearSecrets);
    elements.exportSecrets.addEventListener("click", exportSecrets);
    elements.importSecrets.addEventListener("click", () => elements.importSecretsFile.click());
    elements.importSecretsFile.addEventListener("change", importSecrets);
    elements.toggleReveal.addEventListener("click", () => {
        const isHidden = elements.secretValue.type === "password";

        elements.secretValue.type = isHidden ? "text" : "password";
        elements.toggleReveal.textContent = isHidden ? "Hide" : "Reveal";
    });
    elements.attachScreenshot.addEventListener("change", async () => {
        attachScreenshot = elements.attachScreenshot.checked;

        try {
            await saveScreenshotSetting();
        } catch (error) {
            // Revert the checkbox if local storage fails.
            attachScreenshot = !attachScreenshot;
            elements.attachScreenshot.checked = attachScreenshot;
            updateScreenshotStatus();

            appendMessage(
                "received",
                `Unable to save screenshot setting: ${error.message}`
            );
        }
    });
}

async function loadScreenshotSetting() {
    const stored = await storageGetAll();
    const value = stored[SCREENSHOT_SETTING_KEY];

    attachScreenshot = value === true || value === "true";

    if (elements.attachScreenshot) {
        elements.attachScreenshot.checked = attachScreenshot;
    }

    updateScreenshotStatus();
}

async function saveScreenshotSetting() {
    await storageSet(SCREENSHOT_SETTING_KEY, attachScreenshot);
    updateScreenshotStatus();
}

function updateScreenshotStatus() {
    if (!elements.screenshotStatus) {
        return;
    }

    elements.screenshotStatus.textContent = attachScreenshot
        ? "Attached every request"
        : "On request only";
}

async function init() {
    populateCategorySelect();
    bindEvents();

    try {
        await loadScreenshotSetting();
        await loadSecrets();
        renderSecrets();
    } catch (error) {
        elements.secretList.textContent =
            `Unable to initialize PRISM: ${error.message}`;
    }

    appendMessage(
        "received",
        "Enter a prompt to run PRISM on the active tab."
    );
}

init();