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

/* ------------------------------------------------------------------------ */
/* Page chrome: header, account menu and phone tab bar                       */
/* ------------------------------------------------------------------------ */

// The one place navigation is written down. Pages used to carry their own
// copy, and they drifted: Help's lacked Admin and Sign out. AGENTS.md "Design
// system" describes the layout.
const MAIN_NAV = [
  { href: "/home.html", label: "Home", icon: "home" },
  { href: "/library.html", label: "Library", icon: "library" },
];
const ACCOUNT_NAV = [
  { href: "/preferences.html", label: "Preferences" },
  { href: "/admin.html", label: "Admin and sync", adminOnly: true },
  { href: "/help.html", label: "Help" },
];

const ICONS = {
  home: "M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  library: "M4 4h4v16H4zM10 4h4v16h-4zM16 5l3.5-1 2.5 15.5-3.5 1z",
  account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6",
  chevron: "m6 9 6 6 6-6",
  upload: "M12 16V4M6 10l6-6 6 6M4 20h16",
  play: "M7 4v16l13-8z",
};
const FILLED = new Set(["play"]);

/** An inline icon. Decorative: the control beside it carries the label. */
export function icon(name, size = 20) {
  const filled = FILLED.has(name);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    width: size, height: size, viewBox: "0 0 24 24", fill: filled ? "currentColor" : "none", stroke: filled ? "none" : "currentColor",
    "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(key, String(value));
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

// The asset router serves these pages extensionless: a request for
// /library.html is redirected to /library. So `location.pathname` never
// equals the ".html" href, and comparing them raw meant the current page was
// never marked. Strip the extension from both sides.
const stripHtml = (path) => path.replace(/\.html$/, "");
const isHere = (href) => stripHtml(href) === stripHtml(location.pathname);

function navLink(item, className) {
  return el(
    "a",
    { href: item.href, class: className, "aria-current": isHere(item.href) ? "page" : null },
    item.icon && className === "tab" ? icon(item.icon, 24) : null,
    el("span", { text: item.label }),
  );
}

/**
 * Draws the header and the phone tab bar, then checks the session. With
 * `{ optional: true }` (Help, which the sign-in page links to) a signed-out
 * visitor gets a Sign in link instead of being sent away; the result is then
 * the user or null.
 */
export async function mountChrome({ optional = false } = {}) {
  const main = document.querySelector("main");
  if (main && !main.id) main.id = "main";
  if (main) main.tabIndex = -1;

  const header = el(
    "header",
    { class: "site" },
    el("a", { class: "brand", href: "/home.html", text: "tsundoku" }),
    el("nav", { class: "primary", "aria-label": "Main" }, MAIN_NAV.map((item) => navLink(item, "primary-link"))),
    el("div", { class: "account", id: "account" }),
  );
  document.body.prepend(el("a", { class: "skip", href: "#main", text: "Skip to content" }), header);

  let user;
  if (optional) {
    user = await api("/api/me", { redirectOn401: false }).then((r) => r.user).catch(() => null);
  } else {
    user = await requireUser();
  }

  if (!user) {
    header.querySelector("nav.primary").remove();
    document.getElementById("account").append(
      el("a", { class: "button secondary", href: `/?next=${encodeURIComponent(location.pathname)}`, text: "Sign in" }),
    );
    return null;
  }

  mountAccountMenu(user);
  return user;
}

function mountAccountMenu(user) {
  const name = user.display_name || user.username;
  const menu = el(
    "div",
    { class: "account-menu", id: "account-menu", hidden: true },
    el("p", { class: "account-who" }, "Signed in as ", el("strong", { text: name })),
    el(
      "ul",
      {},
      ACCOUNT_NAV.filter((item) => !item.adminOnly || user.role === "admin").map((item) =>
        el("li", {}, navLink(item, "menu-link")),
      ),
    ),
    el("button", { type: "button", class: "menu-link danger-link", text: "Sign out", onclick: signOut }),
  );

  // Two buttons open the one menu: the header's on a wide screen, the tab
  // bar's on a phone. CSS shows exactly one of them.
  const headerButton = el(
    "button",
    { type: "button", class: "account-button", "aria-expanded": "false", "aria-controls": "account-menu" },
    el("span", { class: "avatar", "aria-hidden": "true", text: name.slice(0, 1).toUpperCase() }),
    el("span", { class: "account-name", text: name }),
    icon("chevron", 16),
  );
  const accountHere = ACCOUNT_NAV.some((item) => isHere(item.href));
  const tabButton = el(
    "button",
    { type: "button", class: "tab", "aria-expanded": "false", "aria-controls": "account-menu", "data-current": accountHere ? "" : null },
    icon("account", 24),
    el("span", { text: "Account" }),
  );
  const tabbar = el(
    "nav",
    { class: "tabbar", "aria-label": "Main" },
    MAIN_NAV.map((item) => navLink(item, "tab")),
    tabButton,
  );

  document.getElementById("account").append(headerButton, menu);
  document.body.append(tabbar);
  document.body.classList.add("has-tabbar");

  let opener = null;
  const setOpen = (open, from) => {
    menu.hidden = !open;
    for (const button of [headerButton, tabButton]) button.setAttribute("aria-expanded", String(open && button === from));
    if (open) {
      opener = from;
      menu.querySelector("a, button")?.focus();
    } else if (opener) {
      opener.focus();
      opener = null;
    }
  };
  for (const button of [headerButton, tabButton]) {
    button.addEventListener("click", () => setOpen(menu.hidden, button));
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) setOpen(false);
  });
  document.addEventListener("click", (event) => {
    if (menu.hidden || menu.contains(event.target)) return;
    if (headerButton.contains(event.target) || tabButton.contains(event.target)) return;
    menu.hidden = true;
    for (const button of [headerButton, tabButton]) button.setAttribute("aria-expanded", "false");
    opener = null;
  });
  // Tabbing out of the menu closes it, so it never sits open behind the page.
  menu.addEventListener("focusout", (event) => {
    if (event.relatedTarget && !menu.contains(event.relatedTarget) && event.relatedTarget !== opener) {
      menu.hidden = true;
      for (const button of [headerButton, tabButton]) button.setAttribute("aria-expanded", "false");
      opener = null;
    }
  });
}

async function signOut() {
  await api("/api/session", { method: "DELETE" });
  location.href = "/";
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
  // Each column is capped at the line length, and whatever width is left over
  // becomes margin. "Full width" (0) lifts the cap, so the side margin is the
  // whole margin.
  lineLength: [[55, "Narrow"], [65, "Medium"], [75, "Wide"], [0, "Full width"]],
  // Two columns need a landscape-shaped page: foliate-js shows one on a page
  // taller than it is wide, whatever this says.
  columns: [[1, "One"], [2, "Two"]],
  // Space between the text and the edge of the screen, in CSS pixels.
  // Horizontal has a floor so two-column layouts keep a gutter.
  marginV: { min: 0, max: 96, step: 4 },
  marginH: { min: 4, max: 96, step: 4 },
};

/**
 * 18px, 1.6 and 65 characters: comfortable on a 13-15" laptop, and the usual
 * guidance. Margins default small, because on a phone foliate-js's own 48px
 * top and bottom take a tenth of the screen from the text.
 */
export const DEFAULT_DEVICE_SETTINGS = {
  theme: "system",
  fontSize: 18,
  lineHeight: 1.6,
  lineLength: 65,
  columns: 2,
  marginV: 16,
  marginH: 20,
  statusBar: true,
};

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
  const range = (value, { min, max }, fallback) => {
    const n = Number(value);
    return value !== undefined && value !== null && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  return {
    theme: pick(raw.theme, o.theme, d.theme),
    fontSize: range(raw.fontSize, o.fontSize, d.fontSize),
    lineHeight: pick(Number(raw.lineHeight), o.lineHeight, d.lineHeight),
    lineLength: pick(Number(raw.lineLength), o.lineLength, d.lineLength),
    columns: pick(Number(raw.columns), o.columns, d.columns),
    marginV: range(raw.marginV, o.marginV, d.marginV),
    marginH: range(raw.marginH, o.marginH, d.marginH),
    statusBar: typeof raw.statusBar === "boolean" ? raw.statusBar : d.statusBar,
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
 * foliate-js's paginator attributes for these settings in a view `width`
 * pixels wide. Its `margin` is the space above and below the text, in pixels.
 * Its `gap` is a percentage of the width, and each side's margin works out to
 * one gap (half outside the column, half inside it), so the horizontal margin
 * is converted against the current width. Call it again when the width changes.
 */
export function paginatorLayout(settings, width) {
  const gap = width > 0 ? Math.min(40, (settings.marginH / width) * 100) : 5;
  return {
    margin: `${settings.marginV}px`,
    gap: `${gap.toFixed(3)}%`,
    // foliate shows min(columns, ceil(width / cap)) columns. Full width has no
    // cap of its own, so the cap is the width split by the column count: wide
    // enough to fill the page, narrow enough that the count still comes out right.
    "max-inline-size": `${settings.lineLength ? lineLengthPx(settings) : Math.max(1, Math.floor(width / settings.columns))}px`,
    "max-column-count": String(settings.columns),
  };
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
 * The display controls, shared by the reader's Aa panel and the Preferences
 * page so the two always offer the same things. Each change is saved to this
 * device and handed to `onChange`.
 */
export function deviceSettingsForm(settings, onChange) {
  const o = DEVICE_SETTING_OPTIONS;
  const update = (patch) => {
    Object.assign(settings, patch);
    saveDeviceSettings(settings);
    onChange({ ...settings });
  };

  // A row of mutually exclusive buttons over one setting.
  const segmented = (key, label) =>
    el(
      "div",
      { class: "segmented", role: "radiogroup", "aria-label": label },
      ...o[key].map(([value, text]) =>
        el(
          "label",
          {},
          el("input", {
            type: "radio",
            name: `reader-${key}`,
            value: String(value),
            checked: settings[key] === value,
            onchange: () => update({ [key]: value }),
          }),
          el("span", { text }),
        ),
      ),
    );

  // A − value + control over a numeric setting.
  const stepper = (key, unit, less, more, labels) => {
    const { min, max, step } = o[key];
    const value = el("output", { class: "size-value", text: `${settings[key]}${unit}` });
    const by = (delta) => () => {
      const next = Math.min(max, Math.max(min, settings[key] + delta));
      value.textContent = `${next}${unit}`;
      update({ [key]: next });
    };
    return el(
      "div",
      { class: "stepper" },
      el("button", { type: "button", class: "secondary", "aria-label": labels[0], text: less, onclick: by(-step) }),
      value,
      el("button", { type: "button", class: "secondary", "aria-label": labels[1], text: more, onclick: by(step) }),
    );
  };

  const select = (id, options, value, key) =>
    el(
      "select",
      { id, onchange: (event) => update({ [key]: Number(event.target.value) }) },
      ...options.map(([v, label]) => el("option", { value: String(v), selected: v === value, text: label })),
    );

  const field = (label, control, id) =>
    el("div", { class: "field" }, el(id ? "label" : "span", { class: "label", for: id, text: label }), control);

  const statusBar = el(
    "label",
    { class: "check" },
    el("input", {
      type: "checkbox",
      checked: settings.statusBar,
      onchange: (event) => update({ statusBar: event.target.checked }),
    }),
    el("span", { text: "Show the status bar (chapter and progress) below the page" }),
  );

  return el(
    "div",
    { class: "device-settings" },
    field("Theme", segmented("theme", "Theme")),
    field("Text size", stepper("fontSize", "px", "A−", "A+", ["Smaller text", "Larger text"])),
    el(
      "div",
      { class: "row" },
      field("Line spacing", select("ds-line-height", o.lineHeight, settings.lineHeight, "lineHeight"), "ds-line-height"),
      field("Line length", select("ds-line-length", o.lineLength, settings.lineLength, "lineLength"), "ds-line-length"),
    ),
    field("Columns", segmented("columns", "Columns")),
    el(
      "div",
      { class: "row" },
      field("Top and bottom margin", stepper("marginV", "px", "−", "+", ["Less top and bottom margin", "More top and bottom margin"])),
      field("Side margin", stepper("marginH", "px", "−", "+", ["Less side margin", "More side margin"])),
    ),
    field("Status bar", statusBar),
  );
}

/** A CSS font-family for a reader font; a book serif stands in for the publisher's own. */
export function fontStack(key) {
  const font = READER_FONTS[key];
  return font?.family ? `"${font.family}", system-ui, sans-serif` : `Georgia, "Iowan Old Style", "Palatino Linotype", serif`;
}

/**
 * The font choice, shared by the reader's Aa panel and the Preferences page.
 * Unlike the display settings this is saved to the account, so each change is
 * sent to the server; `onChange` gets the new key once it is saved, and
 * `onError` the message if it is not.
 */
export function readerFontForm(current, onChange, onError) {
  const fieldset = el(
    "fieldset",
    { class: "choices" },
    ...Object.entries(READER_FONTS).map(([key, font]) =>
      el(
        "label",
        { class: "choice" },
        el("input", { type: "radio", name: "reader_font", value: key, checked: current === key }),
        el("span", { text: font.label }),
        el("span", {
          class: "sample",
          // The book's own fonts are usually a serif, and the UI is not, so
          // that option's sample is drawn in one rather than in the UI face.
          style: `font-family: ${fontStack(key)}`,
          text: font.family ? "Il1 O0 rn m — the quick brown fox jumps over the lazy dog." : "Whatever the publisher chose, or your browser's default.",
        }),
      ),
    ),
  );
  fieldset.addEventListener("change", async (event) => {
    const previous = current;
    fieldset.disabled = true;
    try {
      await api("/api/preferences", { method: "PATCH", body: JSON.stringify({ reader_font: event.target.value }) });
      current = event.target.value;
      onChange(current);
    } catch (error) {
      for (const input of fieldset.querySelectorAll("input")) input.checked = input.value === previous;
      onError?.(error.message);
    } finally {
      fieldset.disabled = false;
    }
  });
  return fieldset;
}
