// The upload dialog, opened from Home and the Library. Dropping files anywhere
// on those pages opens it too, so there is no separate upload page.
import { api, el, formatBytes, icon } from "/app.js";

// Anything over this goes through R2 multipart: the Workers request body limit
// is 100MB, so a single-shot PUT of a large comic would be rejected outright.
const SINGLE_SHOT_LIMIT = 95 * 1024 * 1024;
const PART_SIZE = 50 * 1024 * 1024;

const ACCEPT = ".epub,.cbz,.pdf,.mobi,.azw3,.fb2,.txt,application/epub+zip";

/**
 * An Upload button for a page heading. `secondary` where something else is
 * the page's primary action (Home's resume).
 */
export function uploadButton({ secondary = false } = {}) {
  return el("button", { type: "button", id: "upload", class: secondary ? "secondary" : null }, icon("upload", 18), el("span", { text: "Upload" }));
}

/**
 * Wires `button` to the upload dialog. `onAdded` runs once a batch has
 * finished with at least one new book, so the page can refresh.
 */
export function mountUpload(button, { onAdded } = {}) {
  const picker = el("input", { type: "file", multiple: true, accept: ACCEPT, class: "visually-hidden", tabindex: "-1", "aria-hidden": "true" });
  const choose = el(
    "button",
    { type: "button", class: "dropzone", "aria-describedby": "upload-hint" },
    el("strong", { text: "Choose files" }),
    el("span", { class: "muted", id: "upload-hint", text: "or drop them here. EPUB and CBZ get metadata and a cover read out of the file itself." }),
  );
  const queue = el("ul", { class: "queue", "aria-live": "polite" });
  const close = el("button", { type: "button", class: "secondary", text: "Done" });
  const dialog = el(
    "dialog",
    { class: "upload-dialog", "aria-labelledby": "upload-title" },
    el("h2", { id: "upload-title", text: "Upload books" }),
    choose,
    picker,
    queue,
    el("div", { class: "dialog-actions" }, close),
  );
  document.body.append(dialog);

  let added = 0;
  const open = () => { if (!dialog.open) dialog.showModal(); };
  button.addEventListener("click", open);
  choose.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => { enqueue([...picker.files]); picker.value = ""; });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (added > 0) onAdded?.();
    added = 0;
  });

  // Files dragged over any part of the page open the dialog and land there.
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
  document.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    open();
    choose.classList.add("hot");
  });
  document.addEventListener("dragleave", (event) => {
    if (event.relatedTarget === null) choose.classList.remove("hot");
  });
  document.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    choose.classList.remove("hot");
    enqueue([...event.dataTransfer.files]);
  });

  async function enqueue(files) {
    for (const file of files) {
      const row = makeRow(file);
      queue.prepend(row.li);
      try {
        const result = file.size > SINGLE_SHOT_LIMIT ? await multipart(file, row) : await singleShot(file, row);
        const note = result.index && result.index.error ? ` (${result.index.error})` : "";
        row.done(`Added as "${(result.index && result.index.title) || file.name}"${note}`, !note);
        added += 1;
      } catch (error) {
        if (error.status === 409) row.done(`Already in the library: "${error.body.title}"`, true);
        else row.done(error.message, false);
      }
    }
  }
}

function makeRow(file) {
  const state = el("div", { class: "state", text: "Waiting" });
  const fill = el("i");
  const li = el(
    "li",
    {},
    el("div", {}, el("strong", { text: file.name }), " ", el("span", { class: "muted", text: formatBytes(file.size) })),
    el("div", { class: "bar", "aria-hidden": "true" }, fill),
    state,
  );
  return {
    li,
    progress(fraction, label) {
      fill.style.width = `${Math.round(fraction * 100)}%`;
      state.textContent = label;
    },
    done(label, ok) {
      fill.style.width = "100%";
      state.textContent = label;
      state.className = `state ${ok ? "ok" : "error"}`;
    },
  };
}

function singleShot(file, row) {
  // XMLHttpRequest rather than fetch, purely for upload progress events.
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/books");
    request.setRequestHeader("x-filename", encodeURIComponent(file.name));
    request.setRequestHeader("content-type", file.type || "application/octet-stream");
    request.withCredentials = true;

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) row.progress(event.loaded / event.total, `Uploading ${formatBytes(event.loaded)}`);
    });
    request.addEventListener("load", () => {
      let body = null;
      try { body = JSON.parse(request.responseText); } catch { body = {}; }
      if (request.status >= 200 && request.status < 300) {
        row.progress(1, "Reading metadata");
        resolve(body);
      } else {
        const error = new Error(body.error || `${request.status}`);
        error.status = request.status;
        error.body = body;
        reject(error);
      }
    });
    request.addEventListener("error", () => reject(new Error("Network error")));
    request.send(file);
  });
}

async function multipart(file, row) {
  row.progress(0, "Starting multipart upload");
  const { uploadId } = await api("/api/uploads", {
    method: "POST",
    body: JSON.stringify({ filename: file.name }),
  });

  try {
    const total = Math.ceil(file.size / PART_SIZE);
    for (let part = 1; part <= total; part++) {
      const slice = file.slice((part - 1) * PART_SIZE, Math.min(part * PART_SIZE, file.size));
      const response = await fetch(`/api/uploads/${uploadId}/${part}`, {
        method: "PUT",
        credentials: "same-origin",
        body: slice,
      });
      if (!response.ok) throw new Error(`Part ${part} failed: ${response.status}`);
      row.progress(part / total, `Uploaded part ${part} of ${total}`);
    }
    row.progress(1, "Finishing");
    return await api(`/api/uploads/${uploadId}/complete`, { method: "POST" });
  } catch (error) {
    // Leave no half-finished multipart behind; the nightly sweep is a backstop.
    await api(`/api/uploads/${uploadId}`, { method: "DELETE" }).catch(() => {});
    throw error;
  }
}
