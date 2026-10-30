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
