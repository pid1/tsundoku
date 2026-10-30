// Shared helpers. No framework, no bundler: these files are served as static
// assets, which on the Workers free plan are free and unmetered.

export async function api(path, options = {}) {
  // `redirectOn401` is ours, not fetch's -- keep it out of the request init.
  const { redirectOn401 = true, ...init } = options;
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof Blob) && typeof init.body === "string"
        ? { "content-type": "application/json" }
        : {}),
      ...(init.headers || {}),
    },
  });

  // A 401 sends you to the sign-in page -- but only from a page that is not
  // already it. On "/" a 401 is the expected answer for a signed-out visitor,
  // and redirecting there navigates to the page we are already on, forever.
  // Callers on "/" also pass redirectOn401: false to say so explicitly.
  if (
    response.status === 401 &&
    redirectOn401 &&
    !path.startsWith("/api/session") &&
    location.pathname !== "/"
  ) {
    location.href = `/?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error("Sign in required");
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }

  if (!response.ok) {
    const error = new Error((body && body.error) || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export async function requireUser() {
  try {
    const { user } = await api("/api/me");
    return user;
  } catch {
    location.href = `/?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error("redirecting");
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatDate(seconds) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function showMessage(id, text, kind = "error") {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = text;
  node.className = `msg ${kind}`;
  node.hidden = !text;
}

export function markCurrentNav() {
  // The asset router serves these pages extensionless: a request for
  // /library.html is redirected to /library. So `location.pathname` never
  // equals the ".html" href in the markup, and comparing them raw meant the
  // current page was never marked. Strip the extension from both sides.
  const strip = (path) => path.replace(/\.html$/, "");
  const here = strip(location.pathname);
  for (const link of document.querySelectorAll("header.top nav a")) {
    const href = link.getAttribute("href");
    if (href && href.startsWith("/") && strip(href) === here) link.setAttribute("aria-current", "page");
  }
}

export async function mountChrome() {
  markCurrentNav();
  const user = await requireUser();
  const slot = document.getElementById("who");
  if (slot) {
    slot.textContent = user.display_name || user.username;
  }
  for (const node of document.querySelectorAll("[data-admin-only]")) {
    if (user.role !== "admin") node.remove();
  }
  const signOut = document.getElementById("signout");
  if (signOut) {
    signOut.addEventListener("click", async (event) => {
      event.preventDefault();
      await api("/api/session", { method: "DELETE" });
      location.href = "/";
    });
  }
  return user;
}

/**
 * The fonts the reader can substitute for a book's own, keyed by the value
 * stored in user_preferences.reader_font. `publisher` has no CSS: it leaves the
 * book alone. Each file is served from /fonts and subset the way Fontsource
 * ships it, so a Latin book downloads only the Latin file.
 */
export const READER_FONTS = {
  publisher: { label: "The book's own fonts" },
  "atkinson-hyperlegible-next": {
    label: "Atkinson Hyperlegible Next",
    family: "Atkinson Hyperlegible Next",
    faces: [
      ["latin", "normal", "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"],
      ["latin", "italic", "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"],
      ["latin-ext", "normal", "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"],
      ["latin-ext", "italic", "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"],
    ],
    file: (subset, style) => `/fonts/atkinson-hyperlegible-next-${subset}-wght-${style}.woff2`,
  },
};

/**
 * @font-face rules for a reader font. URLs are absolute because the reader
 * injects this into each chapter's document, which is loaded from a blob: URL
 * that a relative path would resolve against.
 */
export function fontFaceCss(key) {
  const font = READER_FONTS[key];
  if (!font || !font.family) return "";
  return font.faces
    .map(([subset, style, range]) => `@font-face {
  font-family: "${font.family}";
  font-style: ${style};
  font-weight: 200 800;
  font-display: swap;
  src: url("${location.origin}${font.file(subset, style)}") format("woff2");
  unicode-range: ${range};
}`)
    .join("\n");
}

/**
 * CSS that sets a book in the chosen font. `!important` and the universal
 * selector are needed because publishers set fonts on every class they have;
 * code keeps a monospace face, since that is meaning, not style.
 */
export function readerFontCss(key) {
  const font = READER_FONTS[key];
  if (!font || !font.family) return "";
  return `${fontFaceCss(key)}
html, body, body *:not(code):not(pre):not(kbd):not(samp):not(tt) {
  font-family: "${font.family}", system-ui, sans-serif !important;
}`;
}

/** Formats the web reader can open. PDF, CBR, TXT and DjVu are download-only. */
export const READABLE_FORMATS = new Set(["epub", "cbz", "mobi", "azw3", "fb2"]);

export function readerHref(book) {
  return `/reader.html?book=${encodeURIComponent(book.id)}`;
}

/* ------------------------------------------------------------------------ */
/* Reader display settings, kept per device                                  */
/* ------------------------------------------------------------------------ */

// These live in localStorage, not on the account: the right text size for a
// phone held at arm's length is wrong for a laptop. The font family is the
// exception and stays on the account (see READER_FONTS above).
//
// Colours follow WCAG 2.2 AAA with room to spare, but stop short of black on
// white: 21:1 causes halation for some readers (dyslexia, astigmatism, Irlen
// syndrome), and a warm off-white cuts glare. Measured ratios:
//   light  #222222 on #FAFAF7  15.2:1   muted #545454  7.2:1   link #1A4A8F  8.3:1
//   dark   #E6E6E6 on #121212  15.0:1   muted #A0A0A0  7.2:1   link #8AB4F8  8.9:1
// Dark mode uses a near-black, not #000, so bright letters do not appear to bleed.

export const READER_THEMES = {
  light: { label: "Light", bg: "#FAFAF7", fg: "#222222", muted: "#545454", line: "#E2E0D8", link: "#1A4A8F", scheme: "light" },
  dark: { label: "Dark", bg: "#121212", fg: "#E6E6E6", muted: "#A0A0A0", line: "#2E2E2E", link: "#8AB4F8", scheme: "dark" },
};

export const DEVICE_SETTING_OPTIONS = {
  theme: [["system", "Match system"], ["light", "Light"], ["dark", "Dark"]],
  fontSize: { min: 14, max: 28, step: 1 },
  lineHeight: [[1.4, "Tight"], [1.5, "Snug"], [1.6, "Normal"], [1.8, "Relaxed"], [2, "Loose"]],
  lineLength: [[55, "Narrow"], [65, "Medium"], [75, "Wide"]],
};

/** 18px, 1.6 and 65 characters: comfortable on a 13-15" laptop, and the usual guidance. */
export const DEFAULT_DEVICE_SETTINGS = { theme: "system", fontSize: 18, lineHeight: 1.6, lineLength: 65 };

const DEVICE_SETTINGS_KEY = "tsundoku.readerSettings";

const pick = (value, options, fallback) => (options.some(([v]) => v === value) ? value : fallback);

/** This device's settings, with anything missing or malformed replaced by the default. */
export function loadDeviceSettings() {
  let raw = {};
  try {
    raw = JSON.parse(localStorage.getItem(DEVICE_SETTINGS_KEY)) ?? {};
  } catch {
    // Private windows and blocked storage: fall through to the defaults.
  }
  const d = DEFAULT_DEVICE_SETTINGS;
  const o = DEVICE_SETTING_OPTIONS;
  const size = Number(raw.fontSize);
  return {
    theme: pick(raw.theme, o.theme, d.theme),
    fontSize: Number.isFinite(size) ? Math.min(o.fontSize.max, Math.max(o.fontSize.min, Math.round(size))) : d.fontSize,
    lineHeight: pick(Number(raw.lineHeight), o.lineHeight, d.lineHeight),
    lineLength: pick(Number(raw.lineLength), o.lineLength, d.lineLength),
  };
}

export function saveDeviceSettings(settings) {
  try {
    localStorage.setItem(DEVICE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not fatal: the settings apply for this visit and are forgotten after.
  }
}

/** "light" or "dark": the theme to draw, with "system" resolved. */
export function resolveTheme(theme) {
  if (theme === "light" || theme === "dark") return theme;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * The column width for a line length in characters. foliate-js wants pixels;
 * an average character is about half an em in book faces, which is what the
 * usual 50-75 character guidance assumes.
 */
export function lineLengthPx(settings) {
  return Math.round(settings.lineLength * settings.fontSize * 0.5);
}

/**
 * CSS that applies the device settings to a book. Size and spacing override
 * the publisher with !important, as any reading app must for the settings to
 * do anything. In dark mode every element's colour and background is reset as
 * well, since a book that sets black text on its paragraphs would otherwise be
 * black on near-black. Light mode leaves a publisher's colours alone: dark text
 * on the off-white page reads fine. Images are never touched.
 */
export function readerDisplayCss(settings) {
  const t = READER_THEMES[resolveTheme(settings.theme)];
  const dark = t.scheme === "dark";
  return `
html { color-scheme: ${t.scheme}; font-size: ${settings.fontSize}px !important; }
html, body { background: ${t.bg} !important; color: ${t.fg} !important; }
body { font-weight: 400; }
p, li, blockquote, dd, dt, div, td, th { line-height: ${settings.lineHeight} !important; }
a:link, a:visited { color: ${t.link} !important; }
${dark ? `body *:not(img):not(svg):not(svg *):not(video):not(a) {
  color: inherit !important;
  background-color: transparent !important;
  border-color: ${t.line} !important;
}` : ""}`;
}

/**
 * The settings controls, shared by the reader's panel and the Preferences
 * page. Each change is saved to this device and handed to `onChange`.
 */
export function deviceSettingsForm(settings, onChange) {
  const o = DEVICE_SETTING_OPTIONS;
  const update = (patch) => {
    Object.assign(settings, patch);
    saveDeviceSettings(settings);
    onChange({ ...settings });
  };

  const theme = el(
    "div",
    { class: "segmented", role: "radiogroup", "aria-label": "Theme" },
    ...o.theme.map(([value, label]) =>
      el(
        "label",
        {},
        el("input", {
          type: "radio",
          name: "reader-theme",
          value,
          checked: settings.theme === value,
          onchange: () => update({ theme: value }),
        }),
        el("span", { text: label }),
      ),
    ),
  );

  const sizeValue = el("output", { class: "size-value", text: `${settings.fontSize}px` });
  const step = (delta) => () => {
    const next = Math.min(o.fontSize.max, Math.max(o.fontSize.min, settings.fontSize + delta));
    sizeValue.textContent = `${next}px`;
    update({ fontSize: next });
  };
  const size = el(
    "div",
    { class: "stepper" },
    el("button", { type: "button", class: "secondary", "aria-label": "Smaller text", text: "A−", onclick: step(-1) }),
    sizeValue,
    el("button", { type: "button", class: "secondary", "aria-label": "Larger text", text: "A+", onclick: step(1) }),
  );

  const select = (id, options, value, key) =>
    el(
      "select",
      { id, onchange: (event) => update({ [key]: Number(event.target.value) }) },
      ...options.map(([v, label]) => el("option", { value: String(v), selected: v === value, text: label })),
    );

  const field = (label, control, id) =>
    el("div", { class: "field" }, el(id ? "label" : "span", { class: "label", for: id, text: label }), control);

  return el(
    "div",
    { class: "device-settings" },
    field("Theme", theme),
    field("Text size", size),
    el(
      "div",
      { class: "row" },
      field("Line spacing", select("ds-line-height", o.lineHeight, settings.lineHeight, "lineHeight"), "ds-line-height"),
      field("Line length", select("ds-line-length", o.lineLength, settings.lineLength, "lineLength"), "ds-line-length"),
    ),
  );
}
