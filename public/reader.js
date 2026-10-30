// The web reader. foliate-js does the rendering; this file fetches the book,
// applies the reader's font preference, and keeps the reading position in step
// with KOReader through the same kosync tables an e-reader writes.
//
// Kept out of reader.html, unlike the other pages' scripts, because the reader
// runs under a Content-Security-Policy that refuses inline script: a book's
// chapters are rendered in blob: iframes that inherit this page's policy, and
// that policy is what stops a script inside an EPUB from running as you.

import "/vendor/foliate-js/view.js";
import {
  api,
  deviceSettingsForm,
  fontFaceCss,
  formatBytes,
  loadDeviceSettings,
  paginatorLayout,
  READABLE_FORMATS,
  READER_FONTS,
  readerDisplayCss,
  readerFontCss,
  readerFontForm,
  resolveTheme,
} from "/app.js";
import { fromXPointer, isXPointer, toXPointer } from "/xpointer.js";

/** Formats whose position KOReader can read back: an XPointer, or a page number. */
const SYNCED_FORMATS = new Set(["epub", "cbz"]);

/** Seconds of stillness before a page turn is pushed. Turning pages quickly sends one push, not ten. */
const PUSH_DELAY_MS = 3000;

// Adapted from foliate-js's own reader.js: readable defaults that leave the
// publisher's layout alone. Colours, size and spacing come from the device
// settings (readerDisplayCss in app.js) and are appended after this.
const BASE_CSS = `
@namespace epub "http://www.idpf.org/2007/ops";
p, li, blockquote, dd {
  text-align: start;
  hyphens: auto;
  widows: 2;
}
[align="left"] { text-align: left; }
[align="right"] { text-align: right; }
[align="center"] { text-align: center; }
[align="justify"] { text-align: justify; }
pre { white-space: pre-wrap !important; }
aside[epub|type~="endnote"], aside[epub|type~="footnote"],
aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
`;

const $ = (id) => document.getElementById(id);
const percent = new Intl.NumberFormat(undefined, { style: "percent" });

// localStorage can throw (private windows, blocked storage); the reader still
// works without it, it just cannot remember an exact position or a device id.
const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Not fatal.
    }
  },
};

/** A stable id for this browser, so the Sync page lists it as one device. */
function deviceId() {
  let id = store.get("tsundoku.deviceId");
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    store.set("tsundoku.deviceId", id);
  }
  return id;
}

/** What the Sync page calls this device. */
function deviceName() {
  const ua = navigator.userAgent;
  const platform =
    /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return platform ? `Web reader (${platform})` : "Web reader";
}

function showStatus(...content) {
  const node = $("status");
  node.replaceChildren(...content);
  node.hidden = content.length === 0;
}

/** The position string KOReader would write here: an XPointer, or a 1-based page. */
function progressFor(format, index, range) {
  if (format === "cbz") return String(index + 1);
  if (format === "epub" && range) return toXPointer(index, range);
  return null;
}

/** Turns a stored kosync position into something the renderer can go to. */
function targetFor(format, row) {
  if (format === "epub" && isXPointer(row.progress)) return fromXPointer(row.progress);
  if (format === "cbz" && /^\d+$/.test(row.progress)) return { index: Number(row.progress) - 1 };
  return { fraction: row.percentage };
}

async function goToStart(view, target, fallbackFraction) {
  const sections = view.book.sections.length;
  try {
    if (target && typeof target === "object" && "index" in target) {
      if (target.index >= 0 && target.index < sections) {
        await view.renderer.goTo(target);
        return;
      }
    } else if (target) {
      await view.init({ lastLocation: target });
      if (view.lastLocation) return;
    }
  } catch (error) {
    console.warn("Could not restore the position; falling back", error);
  }
  if (typeof fallbackFraction === "number" && fallbackFraction > 0) await view.goToFraction(fallbackFraction);
  else await view.init({ showTextStart: true });
}

function buildToc(view, items, onMove, depth = 0) {
  const list = document.createElement("ol");
  for (const item of items ?? []) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = item.label?.trim() || "Untitled";
    a.dataset.href = item.href ?? "";
    a.addEventListener("click", (event) => {
      event.preventDefault();
      $("toc").close();
      if (item.href) {
        onMove();
        view.goTo(item.href);
      }
    });
    li.append(a);
    if (item.subitems?.length && depth < 3) li.append(buildToc(view, item.subitems, onMove, depth + 1));
    list.append(li);
  }
  return list;
}

/**
 * Left and right thirds of the page turn it; the middle third is left for
 * selecting text. `onMove` is told whenever you might have moved: a key, a tap,
 * a swipe or a scroll. foliate-js turns pages on swipes itself, so those are
 * noticed from the touch events rather than from a handler of ours.
 */
function wireNavigation(view, onMove) {
  const onKey = (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    // onMove() goes first: a page turn inside a chapter reports its new
    // position synchronously, before goLeft()/goRight() even return.
    const left = event.key === "ArrowLeft" || event.key === "PageUp";
    const right = event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ";
    if (!left && !right) return;
    event.preventDefault();
    onMove();
    if (left) view.goLeft();
    else view.goRight();
  };
  document.addEventListener("keydown", onKey);
  for (const type of ["touchend", "wheel"]) view.addEventListener(type, onMove, { passive: true });

  view.addEventListener("load", ({ detail: { doc } }) => {
    doc.addEventListener("keydown", onKey);
    for (const type of ["touchend", "wheel"]) doc.addEventListener(type, onMove, { passive: true });
    doc.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.target.closest?.("a[href]")) return;
      if (doc.getSelection()?.toString()) return;
      // Clicks arrive in the chapter iframe's coordinates. Map them back to
      // the page, so "left third" means the left third of what you see.
      const frame = event.view?.frameElement;
      const x = (frame?.getBoundingClientRect().left ?? 0) + event.clientX;
      const stage = $("stage").getBoundingClientRect();
      const at = (x - stage.left) / stage.width;
      if (at >= 1 / 3 && at <= 2 / 3) return;
      onMove();
      if (at < 1 / 3) view.goLeft();
      else view.goRight();
    });
  });
}

// Theme the bars before anything downloads, so a dark-mode reader does not
// flash light while a large book loads.
document.documentElement.dataset.theme = resolveTheme(loadDeviceSettings().theme);

async function main() {
  const bookId = new URLSearchParams(location.search).get("book");
  if (!bookId) {
    showStatus("No book was given. Open one from the library.");
    return;
  }
  const base = `/api/books/${encodeURIComponent(bookId)}`;

  const [book, prefs, remote] = await Promise.all([
    api(base),
    api("/api/preferences").catch(() => ({ reader_font: "publisher" })),
    api(`${base}/progress`).catch(() => null),
  ]);

  document.title = `${book.title} - tsundoku`;
  $("title").textContent = book.title;
  const href = `/content/${book.id}/${encodeURIComponent(book.filename)}`;

  if (!READABLE_FORMATS.has(book.format)) {
    const link = document.createElement("a");
    link.href = href;
    link.download = book.filename;
    link.textContent = `Download the ${book.format.toUpperCase()}`;
    showStatus(`The reader cannot open ${book.format.toUpperCase()} files. `, link);
    return;
  }

  showStatus(`Downloading ${formatBytes(book.byte_size)}…`);
  const response = await fetch(href, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Could not download the book (${response.status})`);
  const file = new File([await response.blob()], book.filename, { type: book.mime });
  showStatus("Laying out pages…");

  const view = document.createElement("foliate-view");
  $("stage").append(view);
  await view.open(file);

  // Everything in the Aa panel applies live. Display settings are per device;
  // the font is the account's, saved by the form and then applied here too.
  // A "Match system" theme follows the OS, and the side margin, which foliate
  // takes as a percentage, is recomputed whenever the page changes width.
  let display = loadDeviceSettings();
  let font = prefs.reader_font;
  const layout = () => {
    const attrs = paginatorLayout(display, $("stage").clientWidth);
    let changed = false;
    for (const [name, value] of Object.entries(attrs)) {
      if (view.renderer.getAttribute(name) === value) continue;
      view.renderer.setAttribute(name, value);
      changed = true;
    }
    // foliate re-renders on its own for a new line length but not for a new
    // margin, gap or column count, which only change its CSS variables.
    if (changed) view.renderer.render?.();
  };
  const applyDisplay = (settings) => {
    display = settings;
    document.documentElement.dataset.theme = resolveTheme(settings.theme);
    $("footer").hidden = !settings.statusBar;
    view.renderer.setStyles?.(BASE_CSS + readerDisplayCss(settings) + readerFontCss(font));
    layout();
  };
  applyDisplay(display);
  new ResizeObserver(layout).observe($("stage"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (display.theme === "system") applyDisplay(display);
  });

  // The font samples in the panel need the faces loaded on this page too.
  const faces = document.createElement("style");
  faces.textContent = Object.keys(READER_FONTS).map(fontFaceCss).join("\n");
  document.head.append(faces);
  $("settings-font").replaceChildren(
    readerFontForm(
      font,
      (next) => {
        font = next;
        applyDisplay(display);
      },
      (message) => {
        $("settings-msg").textContent = message;
        $("settings-msg").hidden = false;
      },
    ),
  );
  $("settings-form").replaceChildren(deviceSettingsForm({ ...display }, applyDisplay));
  $("display").addEventListener("click", () => $("settings").showModal());
  $("settings-close").addEventListener("click", () => $("settings").close());
  $("settings").addEventListener("click", (event) => {
    if (event.target === $("settings")) $("settings").close();
  });

  // Only a move you made is pushed. Opening a book lands on a position, and the
  // layout settling afterwards reports it again a little differently; pushing
  // either would make this browser the latest device and overwrite KOReader's
  // exact position with an approximation of itself.
  let moved = false;
  const onMove = () => { moved = true; };
  wireNavigation(view, onMove);

  if (view.book.toc?.length) {
    $("toc-list").replaceChildren(buildToc(view, view.book.toc, onMove));
    $("contents").disabled = false;
    $("contents").addEventListener("click", () => $("toc").showModal());
    $("toc").addEventListener("click", (event) => {
      if (event.target === $("toc")) $("toc").close();
    });
  }

  // Where to start. The server's position is the latest from any device. When
  // it is the one this browser pushed, the CFI saved beside it locally is exact
  // where the XPointer is approximate, so prefer it.
  const syncing = SYNCED_FORMATS.has(book.format) && !!remote?.document;
  const localKey = `tsundoku.position.${book.id}`;
  const local = store.get(localKey);
  const theirs = syncing ? remote.progress : null;
  let target = null;
  if (theirs && local?.cfi && local.progress === theirs.progress) target = local.cfi;
  else if (theirs) target = targetFor(book.format, theirs);
  else if (local?.cfi) target = local.cfi;

  $("sync").textContent = syncing ? "" : "Not synced";
  $("sync").title = syncing
    ? ""
    : "This position is saved in this browser only. EPUB and CBZ positions sync with KOReader.";

  let lastPushed = theirs?.progress ?? null;
  let pending = null;
  let timer = 0;

  const push = (keepalive = false) => {
    clearTimeout(timer);
    if (!pending) return;
    const body = JSON.stringify(pending);
    const sent = pending.progress;
    pending = null;
    fetch(`${base}/progress`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body,
      keepalive,
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        lastPushed = sent;
        $("sync").textContent = "";
        $("sync").title = "";
      })
      .catch(() => {
        $("sync").textContent = "Not saved";
        $("sync").title = "Could not save this position to the server. It is kept in this browser.";
      });
  };

  view.addEventListener("relocate", ({ detail }) => {
    const index = detail.section?.current ?? 0;
    const total = view.book.sections.length;
    // Comic pages carry no text size, so foliate's size-weighted fraction is
    // empty for them; a page count is the honest measure there.
    const fraction = book.format === "cbz" || !Number.isFinite(detail.fraction)
      ? (index + 1) / Math.max(1, total)
      : detail.fraction;

    $("pct").textContent = percent.format(fraction);
    $("chapter").textContent = detail.tocItem?.label?.trim() ?? "";

    const progress = progressFor(book.format, index, detail.range);
    if (!moved) return;
    store.set(localKey, { cfi: detail.cfi, progress });
    if (!syncing || !progress || progress === lastPushed) return;
    pending = { percentage: fraction, progress, device: deviceName(), device_id: deviceId() };
    clearTimeout(timer);
    timer = setTimeout(push, PUSH_DELAY_MS);
  });

  // Leaving the page, or the phone locking, must not lose the last page turn.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") push(true);
  });
  window.addEventListener("pagehide", () => push(true));

  await goToStart(view, target, theirs?.percentage);
  showStatus();
}

main().catch((error) => {
  console.error(error);
  showStatus(error.message || "Could not open this book.");
});
