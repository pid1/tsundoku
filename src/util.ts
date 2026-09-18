const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: lexicographically sortable, collision-free without coordination. */
export function ulid(now = Date.now()): string {
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  let r = "";
  for (let i = 0; i < 16; i++) r += CROCKFORD[rand[i] % 32];
  return ts + r;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Sort key for titles: lowercase, leading article stripped, punctuation folded.
 * "The Left Hand of Darkness" -> "left hand of darkness".
 */
export function sortTitle(title: string): string {
  const t = title.trim().toLowerCase().replace(/^(the|a|an)\s+/, "");
  return t.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim() || title.toLowerCase();
}

/**
 * "Ursula K. Le Guin" -> "le guin, ursula k." Used for author sort order when
 * the EPUB does not supply an opf:file-as.
 */
export function sortAuthor(name: string): string {
  const n = name.trim();
  if (n.includes(",")) return n.toLowerCase();
  const parts = n.split(/\s+/);
  if (parts.length < 2) return n.toLowerCase();
  const last = parts.pop() as string;
  return `${last}, ${parts.join(" ")}`.toLowerCase();
}

export function slugify(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[^\w\s.-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 80) || "book"
  );
}

const FORMATS: Record<string, { format: string; mime: string }> = {
  epub: { format: "epub", mime: "application/epub+zip" },
  cbz: { format: "cbz", mime: "application/vnd.comicbook+zip" },
  cbr: { format: "cbr", mime: "application/vnd.comicbook-rar" },
  pdf: { format: "pdf", mime: "application/pdf" },
  mobi: { format: "mobi", mime: "application/x-mobipocket-ebook" },
  azw3: { format: "azw3", mime: "application/vnd.amazon.ebook" },
  fb2: { format: "fb2", mime: "application/x-fictionbook+xml" },
  txt: { format: "txt", mime: "text/plain" },
  djvu: { format: "djvu", mime: "image/vnd.djvu" },
};

export function detectFormat(filename: string): { format: string; mime: string } {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return FORMATS[ext] ?? { format: ext || "bin", mime: "application/octet-stream" };
}

/** Title guessed from a filename, for formats we cannot open. */
export function titleFromFilename(filename: string): string {
  return (
    filename
      .replace(/\.[^.]+$/, "")
      .replace(/[_.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || filename
  );
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Strip characters that are not legal in XML 1.0 content. A title carrying a
 * stray 0x0C will otherwise produce a feed that readers reject outright.
 */
export function xmlSafe(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    const legal =
      c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || c >= 0x10000;
    if (legal) out += ch;
  }
  return out;
}

export function clampInt(v: string | null, min: number, max: number, dflt: number): number {
  const n = v === null ? NaN : parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * Human-readable, high-entropy generated password. The admin UI hands these out
 * rather than accepting typed passwords, because the credential verifier is a
 * fast keyed hash rather than a slow KDF (PLAN.md section 5) and entropy is
 * what carries the security argument.
 */
export function generatePassword(groups = 4, len = 5): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(groups * len);
  crypto.getRandomValues(bytes);
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[bytes[g * len + i] % alphabet.length];
    out.push(s);
  }
  return out.join("-");
}
