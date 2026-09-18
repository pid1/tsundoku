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
    location.href = `/?next=${encodeURIComponent(location.pathname)}`;
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
    location.href = `/?next=${encodeURIComponent(location.pathname)}`;
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
