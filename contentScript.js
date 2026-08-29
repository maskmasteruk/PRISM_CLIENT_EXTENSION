(function prismContentScript() {
  const ELEMENT_ATTR = "data-prism-element-id";
  const SELECTOR = [
    "input",
    "textarea",
    "select",
    "button",
    "a",
    "[role]",
    "[contenteditable='true']",
    "summary",
    "label"
  ].join(",");

  function rectFor(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity || 1) > 0;
  }

  function isInteractive(element) {
    const tag = element.tagName.toLowerCase();
    return ["input", "textarea", "select", "button", "a"].includes(tag) ||
      element.isContentEditable ||
      element.getAttribute("role") ||
      element.tabIndex >= 0;
  }

  function textFromIds(ids) {
    return String(ids || "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "")
      .filter(Boolean)
      .join(" ");
  }

  function labelFor(element) {
    const parts = [
      element.getAttribute("aria-label"),
      textFromIds(element.getAttribute("aria-labelledby")),
      textFromIds(element.getAttribute("aria-describedby")),
      element.getAttribute("title"),
      element.placeholder,
      element.name,
      element.id
    ];

    if (element.labels) {
      parts.push(...Array.from(element.labels).map((label) => label.textContent));
    }

    return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function semanticTypeFor(element) {
    const haystack = labelFor(element).toLowerCase();
    const type = (element.type || "").toLowerCase();
    if (type === "password" || haystack.includes("password") || haystack.includes("passcode")) return "password";
    if (type === "email" || haystack.includes("email") || haystack.includes("e-mail")) return "email";
    if (type === "tel" || haystack.includes("phone") || haystack.includes("mobile")) return "phone";
    if (haystack.includes("credit") || haystack.includes("card")) return "credit_card";
    if (haystack.includes("account") || haystack.includes("iban")) return "bank_account";
    if (haystack.includes("aadhaar") || haystack.includes("ssn") || haystack.includes("passport") || haystack.includes("government")) return "government_id";
    if (haystack.includes("api") || haystack.includes("token") || haystack.includes("secret key")) return "api_key";
    if (haystack.includes("address") || haystack.includes("postal") || haystack.includes("zip")) return "address";
    if (haystack.includes("birth") || haystack.includes("dob")) return "date_of_birth";
    if (haystack.includes("username") || haystack.includes("user id") || haystack.includes("login")) return "username";
    if (haystack.includes("name")) return "name";
    return "";
  }

  function ensureElementId(element, index) {
    const existing = element.getAttribute(ELEMENT_ATTR);
    if (existing) return existing;
    const id = element.id || `prism_element_${index}_${Math.random().toString(16).slice(2, 8)}`;
    element.setAttribute(ELEMENT_ATTR, id);
    return id;
  }

  function valueMetadataFor(element, semanticType) {
    if (!("value" in element)) return { present: false };
    const value = String(element.value || "");
    return {
      present: value.length > 0,
      length: value.length,
      masked: Boolean(semanticType),
      kind: semanticType || element.type || "text"
    };
  }

  function perceiveDom(options = {}) {
    const maxElements = options.maxElements || 500;
    const nodes = Array.from(document.querySelectorAll(SELECTOR)).filter(isVisible);
    const elements = nodes.slice(0, maxElements).map((element, index) => {
      const semanticType = semanticTypeFor(element);
      const elementId = ensureElementId(element, index);
      const parent = element.parentElement?.getAttribute(ELEMENT_ATTR) || "";
      const childElementIds = Array.from(element.children)
        .map((child) => child.getAttribute(ELEMENT_ATTR))
        .filter(Boolean);
      const role = element.getAttribute("role") || "";
      const type = (element.type || role || "").toLowerCase();
      const sensitive = ["password", "government_id", "api_key", "credit_card", "bank_account"].includes(semanticType);

      return {
        element_id: elementId,
        tag: element.tagName.toLowerCase(),
        tagName: element.tagName.toLowerCase(),
        id: element.id || "",
        classes: Array.from(element.classList || []).slice(0, 8),
        role,
        "aria-label": element.getAttribute("aria-label") || "",
        "aria-labelledby": element.getAttribute("aria-labelledby") || "",
        "aria-describedby": element.getAttribute("aria-describedby") || "",
        name: element.name || "",
        type,
        placeholder: element.placeholder || "",
        title: element.getAttribute("title") || "",
        label: labelFor(element),
        text: String(element.innerText || element.textContent || "").trim().slice(0, 500),
        value: "",
        value_metadata: valueMetadataFor(element, semanticType),
        bbox: rectFor(element),
        rect: rectFor(element),
        visibility: { visible: true },
        enabled: !element.disabled,
        selected: Boolean(element.selected),
        checked: Boolean(element.checked),
        interactive: isInteractive(element),
        parent,
        children: childElementIds,
        sensitive,
        semantic_type: semanticType,
        reason: sensitive ? "sensitive_field_type" : ""
      };
    });

    return {
      title: document.title,
      url: window.location.href,
      origin: window.location.origin,
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      elements,
      signals: {
        elementCount: elements.length,
        iframeCount: document.querySelectorAll("iframe").length,
        canvasCount: document.querySelectorAll("canvas").length,
        hasShadowDom: Array.from(document.querySelectorAll("*")).some((element) => element.shadowRoot),
        customControlCount: elements.filter((element) => element.role && !["button", "textbox", "link", "checkbox", "radio", "combobox"].includes(element.role)).length,
        mutationTime: performance.now()
      }
    };
  }

  function resolveElement(elementId) {
    return document.querySelector(`[${ELEMENT_ATTR}="${CSS.escape(elementId)}"]`) ||
      document.getElementById(elementId);
  }

  function describeElement(elementId) {
    const element = resolveElement(elementId);
    if (!element) return null;
    return {
      element_id: elementId,
      tagName: element.tagName.toLowerCase(),
      type: (element.type || element.getAttribute("role") || "").toLowerCase(),
      name: element.name || "",
      id: element.id || "",
      placeholder: element.placeholder || "",
      label: labelFor(element),
      rect: rectFor(element),
      visible: isVisible(element),
      enabled: !element.disabled
    };
  }

  function executeResolvedAction(action, resolvedValue) {
    const element = action.target?.element_id ? resolveElement(action.target.element_id) : null;
    if (["click", "focus", "fill", "select", "submit"].includes(action.action) && !element) {
      return { result: "blocked", code: "TARGET_NOT_FOUND" };
    }
    if (action.action === "click") element.click();
    if (action.action === "focus") element.focus();
    if (action.action === "submit") element.closest("form")?.requestSubmit?.();
    if (action.action === "fill") {
      element.focus();
      element.value = resolvedValue;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (action.action === "select") {
      element.value = resolvedValue;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (action.action === "scroll") window.scrollBy(action.x || 0, action.y || 0);
    return { result: "success", action: action.action };
  }

  window.PRISM_CONTENT_V1 = {
    perceiveDom,
    describeElement,
    executeResolvedAction
  };
})();
