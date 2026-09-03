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
const MISSING_RECEIVER_MESSAGE = "Receiving end does not exist";

const $ = (id) => document.getElementById(id);
const qs = (selector) => document.querySelector(selector);

const elements = {
    agentTab: $("agentTab") || qs('label[for="nav-agent"]'),
    privateTab: $("privateTab") || qs('label[for="nav-vault"]'),
    agentRadio: $("nav-agent"),
    privateRadio: $("nav-vault"),
    agentView: $("agentView") || $("view-agent"),
    privateView: $("privateView") || $("view-vault"),
    chat: $("chat") || qs(".chat-history"),
    agentStatus: $("agentStatus") || qs(".agent-status-indicator strong"),
    messageInput: $("messageInput") || qs(".chat-input"),
    send: $("send") || qs(".btn-send"),
    stopAgent: $("stopAgent") || qs(".btn-stop"),
    clearChats: $("clearChats") || qs(".btn-clear"),
    attachScreenshot: $("attachScreenshot") || qs(".protection-status input[type='checkbox']"),
    secretSearch: $("secretSearch") || qs(".search-bar input"),
    addSecret: $("addSecret") || qs(".vault-controls .btn-vault.primary"),
    exportSecrets: $("exportSecrets"),
    importSecrets: $("importSecrets"),
    importSecretsFile: $("importSecretsFile"),
    secretList: $("secretList") || qs(".secrets-list"),
    secretCount: $("secretCount") || qs(".vault-badge"),
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
let chatMessages = [];
let attachScreenshot = false;
let lastSanitizerDebugLogKey = "";

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
                const message = String(error.message || "");
                const backgroundUnavailable = message.includes("Receiving end does not exist");

                reject(new Error(backgroundUnavailable
                    ? "PRISM background worker is not available. Reload the extension in chrome://extensions and make sure the loaded extension folder contains background.js."
                    : message));
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

function hasRuntimeMessaging() {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
}

function isMissingMessageReceiver(error) {
    return error?.code === "PRISM_BACKGROUND_UNAVAILABLE" ||
        String(error?.message || error || "").includes(MISSING_RECEIVER_MESSAGE);
}

function backgroundUnavailableMessage() {
    return "PRISM background worker is not responding. Reload the extension in chrome://extensions, then reopen the popup.";
}

function backgroundUnavailableError() {
    const error = new Error(backgroundUnavailableMessage());
    error.code = "PRISM_BACKGROUND_UNAVAILABLE";
    return error;
}

function sendRuntimeMessage(message) {
    if (!hasRuntimeMessaging()) {
        return Promise.reject(new Error("PRISM must be run from the Chrome extension popup."));
    }

    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            const error = chrome.runtime?.lastError;

            if (error) {
                reject(isMissingMessageReceiver(error)
                    ? backgroundUnavailableError()
                    : new Error(error.message));
                return;
            }

            if (response && response.ok === false) {
                reject(new Error(response.error || "Background agent request failed."));
                return;
            }

            resolve(response);
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

    if (elements.agentRadio) {
        elements.agentRadio.checked = !showSensitive;
    }

    if (elements.privateRadio) {
        elements.privateRadio.checked = showSensitive;
    }

    elements.agentTab.classList.toggle("active", !showSensitive);
    elements.privateTab.classList.toggle("active", showSensitive);
    elements.agentTab.setAttribute("aria-selected", String(!showSensitive));
    elements.privateTab.setAttribute("aria-selected", String(showSensitive));
    elements.agentView.classList.toggle("active", !showSensitive);
    elements.privateView.classList.toggle("active", showSensitive);
    elements.agentView.toggleAttribute("hidden", showSensitive);
    elements.privateView.toggleAttribute("hidden", !showSensitive);
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

function normalizeImageDataUrl(value) {
    const dataUrl = stringifyValue(value);

    return dataUrl.startsWith("data:image/") ? dataUrl : "";
}

function formatCount(value, singular, plural = `${singular}s`) {
    return `${value} ${value === 1 ? singular : plural}`;
}

function updateSecretCount(filteredCount = secrets.length, hasSearch = false) {
    if (!elements.secretCount) {
        return;
    }

    elements.secretCount.textContent = hasSearch
        ? `${filteredCount}/${secrets.length} shown`
        : `${formatCount(secrets.length, "secret")} saved`;
}

function maskSecretValue(value) {
    const text = stringifyValue(value);

    if (!text) {
        return "(empty value)";
    }

    return `${formatCount(text.length, "character")} hidden`;
}

function flashButtonLabel(button, temporaryText, delay = 1200) {
    const previousText = button.textContent;

    button.textContent = temporaryText;
    button.disabled = true;

    window.setTimeout(() => {
        button.textContent = previousText;
        button.disabled = false;
    }, delay);
}

function resizeMessageInput() {
    if (!elements.messageInput) {
        return;
    }

    elements.messageInput.style.height = "auto";
    elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 104)}px`;
}

function createMessageElement(chatMessage) {
    const isSent = chatMessage.type === "sent";
    const message = document.createElement("div");
    message.className = `chat-message ${isSent ? "user" : "prism"}${chatMessage.imageDataUrl ? " has-image" : ""}`;

    if (!isSent) {
        const avatar = document.createElement("div");
        avatar.className = "avatar";

        const logo = document.createElement("img");
        logo.src = "./icons/logo.jpeg";
        logo.alt = "PRISM";

        avatar.appendChild(logo);
        message.appendChild(avatar);
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble glass-card";

    if (chatMessage.text) {
        const text = document.createElement("div");
        text.className = "message-text";
        text.textContent = chatMessage.text;
        bubble.appendChild(text);
    }

    if (chatMessage.imageDataUrl) {
        const image = document.createElement("img");
        image.className = "message-image";
        image.src = chatMessage.imageDataUrl;
        image.alt = chatMessage.text || "Screenshot sent to server";
        image.loading = "lazy";
        bubble.appendChild(image);
    }

    message.appendChild(bubble);

    return message;
}

function createQuickFillElement() {
    const message = document.createElement("div");
    message.className = "chat-message user";

    const bubble = document.createElement("div");
    bubble.className = "bubble glass-card";

    const glow = document.createElement("div");
    glow.className = "spectral-underglow subtle";

    const button = document.createElement("button");
    button.className = "glass-btn primary btn-fill";
    button.type = "button";
    button.textContent = "Fill the form";
    button.addEventListener("click", () => {
        if (agentRunning) {
            return;
        }

        elements.messageInput.value = "Fill the form";
        void sendMessage();
    });

    bubble.append(glow, button);
    message.appendChild(bubble);

    return message;
}

function appendMessage(type, text, options = {}) {
    elements.chat.appendChild(createMessageElement({
        type: type === "sent" ? "sent" : "received",
        text: stringifyValue(text),
        imageDataUrl: normalizeImageDataUrl(options.imageDataUrl),
    }));
    elements.chat.scrollTop = elements.chat.scrollHeight;
}

async function appendStoredMessage(type, text) {
    const nextMessages = normalizeChatMessages(chatMessages);

    nextMessages.push({
        id: makeRequestId(),
        type: type === "sent" ? "sent" : "received",
        text: stringifyValue(text),
        createdAt: Date.now(),
    });

    chatMessages = nextMessages.slice(-200);

    await storageSet(CHAT_STORAGE_KEY, chatMessages);
    renderChat(chatMessages);
}

function renderChat(messages) {
    chatMessages = normalizeChatMessages(messages);
    elements.chat.replaceChildren();

    if (chatMessages.length === 0) {
        appendMessage("received", "Enter a prompt to run PRISM on the active tab.");
        elements.chat.scrollTop = elements.chat.scrollHeight;
        return;
    }

    chatMessages.forEach((message) => {
        elements.chat.appendChild(createMessageElement(message));
    });

    elements.chat.scrollTop = elements.chat.scrollHeight;
}

function makeRequestId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setAgentRunning(stateOrRunning) {
    const state = typeof stateOrRunning === "object"
        ? stateOrRunning
        : { running: Boolean(stateOrRunning), status: stateOrRunning ? "running" : "idle" };
    const running = Boolean(state.running);
    const status = state.status || (running ? "running" : "idle");

    agentRunning = running;
    document.body.dataset.agentState = running ? status : "idle";
    elements.send.disabled = running;
    elements.messageInput.disabled = running;
    elements.send.textContent = running ? "Running" : "Send";

    if (elements.stopAgent) {
        elements.stopAgent.disabled = !running || status === "stopping";
        elements.stopAgent.textContent = status === "stopping" ? "Stopping" : "Stop";
    }

    if (elements.agentStatus) {
        const statusText = running
            ? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ")
            : "Idle";

        elements.agentStatus.textContent = statusText;
        elements.agentStatus.classList.toggle("running", running);
        elements.agentStatus.title = state.tabTitle || state.tabUrl || statusText;
    }
}

function formatSanitizerTargetsForConsole(targets) {
    const regions = Array.isArray(targets?.regions) ? targets.regions : [];

    return {
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
    };
}

function formatSanitizerTimingForConsole(timing) {
    return {
        index: timing?.index,
        tag: timing?.tag || "",
        id: timing?.id || "",
        classes: Array.isArray(timing?.classes) ? timing.classes : [],
        source: timing?.source || "",
        cssBox: timing?.cssBox || null,
        screenshotBox: timing?.screenshotBox || null,
    };
}

function sanitizerDebugConsoleLabel(kind) {
    if (kind === "ocr") {
        return "PRISM OCR output:";
    }

    if (kind === "pii") {
        return "PRISM PII detect output:";
    }

    if (kind === "error") {
        return "PRISM OCR / PII error output:";
    }

    return "PRISM screenshot sanitizer debug output:";
}

function sanitizerDebugLogKey(debugLog) {
    try {
        return JSON.stringify({
            kind: debugLog?.kind || "",
            payload: debugLog?.payload ?? null,
        });
    } catch {
        return `${debugLog?.kind || ""}:${String(debugLog?.payload ?? "")}`;
    }
}

function logSanitizerDebugOutput(debugLog) {
    if (!debugLog || typeof debugLog !== "object") {
        return;
    }

    const key = sanitizerDebugLogKey(debugLog);

    if (key === lastSanitizerDebugLogKey) {
        return;
    }

    lastSanitizerDebugLogKey = key;
    console.log(
        sanitizerDebugConsoleLabel(debugLog.kind),
        debugLog.payload ?? null
    );
}

function bindRuntimeDebugMessages() {
    if (!hasRuntimeMessaging() || !chrome.runtime?.onMessage) {
        return;
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === "prism:screenshotSanitizerTargets") {
            console.log(
                "PRISM screenshot sanitizer elements sent to sanitize.js:",
                formatSanitizerTargetsForConsole(message.targets)
            );
            return false;
        }

        if (message?.type === "prism:screenshotSanitizerRegionTiming") {
            console.log(
                `Response Time from start to end of receiving time: ${message.timing?.seconds || 0} s`,
                formatSanitizerTimingForConsole(message.timing)
            );
            return false;
        }

        if (message?.type === "prism:screenshotSanitizerDebugLog") {
            logSanitizerDebugOutput(message.debugLog);
        }

        return false;
    });
}

async function sendMessage() {
    if (agentRunning) {
        return;
    }

    const text = elements.messageInput.value.trim();

    if (!text) {
        return;
    }

    elements.messageInput.value = "";
    resizeMessageInput();
    setAgentRunning({ running: true, status: "starting" });

    try {
        await sendRuntimeMessage({
            type: "prism:startAgent",
            query: text,
        });
    } catch (error) {
        await appendStoredMessage("sent", text);
        await appendStoredMessage("received", `Agent failed: ${error.message}`);
        setAgentRunning(false);
    } finally {
        elements.messageInput.focus();
        resizeMessageInput();

    }
}

async function stopAgent() {
    if (!agentRunning) {
        return;
    }

    setAgentRunning({ running: true, status: "stopping" });

    try {
        await sendRuntimeMessage({
            type: "prism:stopAgent",
        });
    } catch (error) {
        await appendStoredMessage("received", `Unable to stop agent: ${error.message}`);
        setAgentRunning(false);
    }
}

async function clearChats() {
    if (agentRunning && !window.confirm("Stop the running agent and clear chat history?")) {
        return;
    }

    if (!agentRunning && chatMessages.length > 0 && !window.confirm("Clear chat history?")) {
        return;
    }

    try {
        await sendRuntimeMessage({
            type: "prism:clearChat",
            stopRun: true,
        });
    } catch (error) {
        if (isMissingMessageReceiver(error)) {
            await storageSet(CHAT_STORAGE_KEY, []);
            await storageSet(AGENT_STATE_STORAGE_KEY, {
                running: false,
                status: "idle",
                requestId: "",
                tabId: null,
                updatedAt: Date.now(),
            });
            renderChat([]);
            setAgentRunning(false);
            return;
        }

        await appendStoredMessage("received", `Unable to clear chat history: ${error.message}`);
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
    chip.className = "tag";
    chip.textContent = text;
    return chip;
}

function renderSecrets() {
    const search = elements.secretSearch.value.trim();
    const filteredSecrets = secrets.filter((record) => recordMatchesSearch(record, search));

    updateSecretCount(filteredSecrets.length, Boolean(search));
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
        row.className = "secret-card glass-card";

        const header = document.createElement("div");
        header.className = "secret-header";

        const key = document.createElement("h3");
        key.textContent = record.key;

        header.append(key, createMetaChip(record.category));

        const body = document.createElement("div");
        body.className = "secret-body";

        const value = document.createElement("div");
        value.className = "hidden-value";
        value.textContent = maskSecretValue(record.value);

        const description = document.createElement("div");
        description.className = "desc";
        description.textContent = record.description || "No description";

        body.append(value, description);

        const actions = document.createElement("div");
        actions.className = "secret-actions";

        const copyButton = document.createElement("button");
        copyButton.className = "glass-btn small secondary btn-vault";
        copyButton.type = "button";
        copyButton.textContent = "Copy";
        copyButton.addEventListener("click", async () => {
            await copyValue(record.value);
            flashButtonLabel(copyButton, "Copied");
        });

        const editButton = document.createElement("button");
        editButton.className = "glass-btn small secondary btn-vault";
        editButton.type = "button";
        editButton.textContent = "Edit";
        editButton.addEventListener("click", () => showSecretForm(record));

        const deleteButton = document.createElement("button");
        deleteButton.className = "glass-btn small danger btn-delete";
        deleteButton.type = "button";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", () => deleteRecord(record.key));

        actions.append(copyButton, editButton, deleteButton);
        row.append(header, body, actions);
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
    elements.secretForm.scrollIntoView({ block: "nearest" });
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
    elements.stopAgent.addEventListener("click", stopAgent);
    elements.clearChats.addEventListener("click", clearChats);
    elements.messageInput.addEventListener("input", resizeMessageInput);
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

            await appendStoredMessage(
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
}

async function saveScreenshotSetting() {
    await storageSet(SCREENSHOT_SETTING_KEY, attachScreenshot);
}

async function loadAgentSnapshot() {
    if (hasRuntimeMessaging()) {
        try {
            const snapshot = await sendRuntimeMessage({
                type: "prism:getSnapshot",
            });

            renderChat(snapshot?.chat || []);
            setAgentRunning(snapshot?.state || false);
            logSanitizerDebugOutput(snapshot?.sanitizerDebugLog);
            return;
        } catch (error) {
            if (!isMissingMessageReceiver(error)) {
                throw error;
            }
        }
    }

    const stored = await storageGetAll();
    renderChat(stored[CHAT_STORAGE_KEY] || []);
    setAgentRunning(false);
}

function bindStorageChanges() {
    if (!hasChromeStorage() || !chrome.storage?.onChanged) {
        return;
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") {
            return;
        }

        if (changes[CHAT_STORAGE_KEY]) {
            renderChat(changes[CHAT_STORAGE_KEY].newValue || []);
        }

        if (changes[AGENT_STATE_STORAGE_KEY]) {
            setAgentRunning(changes[AGENT_STATE_STORAGE_KEY].newValue || false);
        }

        if (changes[SANITIZER_DEBUG_STORAGE_KEY]) {
            logSanitizerDebugOutput(changes[SANITIZER_DEBUG_STORAGE_KEY].newValue);
        }
    });
}

async function init() {
    populateCategorySelect();
    bindEvents();
    bindStorageChanges();
    bindRuntimeDebugMessages();
    resizeMessageInput();

    try {
        await loadAgentSnapshot();
        await loadScreenshotSetting();
        await loadSecrets();
        renderSecrets();
    } catch (error) {
        elements.secretList.textContent =
            `Unable to initialize PRISM: ${error.message}`;
    }
}

init();
