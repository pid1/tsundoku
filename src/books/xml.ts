/**
 * A tolerant XML scanner.
 *
 * Workers has no DOMParser, and an OPF package document is small, namespaced
 * and well-known, so this is a scanner rather than a dependency. It is
 * deliberately forgiving: real EPUBs ship mismatched close tags, undeclared
 * entities and stray DOCTYPE subsets, and a metadata read that throws is worse
 * than one that returns what it could find. Callers treat a partial result as
 * normal -- see epub.ts, which falls back to the filename.
 */

export interface XmlNode {
  /** Local name, lowercased. `dc:title` parses to name "title", prefix "dc". */
  name: string;
  prefix: string;
  /** Lowercased; both the qualified name and the bare local name are keys. */
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text content of this element, entities decoded. */
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function splitName(qualified: string): { prefix: string; name: string } {
  const colon = qualified.indexOf(":");
  if (colon < 0) return { prefix: "", name: qualified.toLowerCase() };
  return { prefix: qualified.slice(0, colon).toLowerCase(), name: qualified.slice(colon + 1).toLowerCase() };
}

function newNode(qualified: string): XmlNode {
  const { prefix, name } = splitName(qualified);
  return { name, prefix, attrs: {}, children: [], text: "" };
}

export function parseXml(source: string): XmlNode {
  const root = newNode("#document");
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      appendText(stack[stack.length - 1], source.slice(i));
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], source.slice(i, lt));

    // Comment
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    // CDATA is literal text
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      const body = end < 0 ? source.slice(lt + 9) : source.slice(lt + 9, end);
      stack[stack.length - 1].text += body;
      i = end < 0 ? n : end + 3;
      continue;
    }
    // DOCTYPE, possibly with an internal subset in square brackets
    if (source.startsWith("<!", lt)) {
      i = skipDoctype(source, lt);
      continue;
    }
    // Processing instruction / XML declaration
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }

    // Closing tag
    if (source.startsWith("</", lt)) {
      const end = source.indexOf(">", lt + 2);
      if (end < 0) break;
      const qualified = source.slice(lt + 2, end).trim();
      const { name, prefix } = splitName(qualified);
      // Pop to the nearest matching ancestor; ignore a close with no opener.
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].name === name && stack[s].prefix === prefix) {
          stack.length = s;
          break;
        }
      }
      i = end + 1;
      continue;
    }

    // Opening tag
    const tagEnd = findTagEnd(source, lt);
    if (tagEnd < 0) break;
    const inner = source.slice(lt + 1, tagEnd);
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;

    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) {
      i = tagEnd + 1;
      continue;
    }
    const node = newNode(nameMatch[1]);
    parseAttributes(body.slice(nameMatch[1].length), node.attrs);

    stack[stack.length - 1].children.push(node);
    if (!selfClosing && !VOID_TAGS.has(node.name)) stack.push(node);
    i = tagEnd + 1;
  }

  return root;
}

// Void elements, so an unclosed tag inside content does not swallow the rest of
// the document.
//
// `meta` and `link` are deliberately NOT here. They are void in XHTML, but this
// parser only ever reads container.xml, OPF and ComicInfo.xml -- and in an EPUB3
// OPF `<meta property="belongs-to-collection">Earthsea</meta>` carries its value
// as text. Treating it as void silently drops every EPUB3 series.
const VOID_TAGS = new Set(["br", "img", "hr", "input", "area", "base", "col", "source"]);

function appendText(node: XmlNode, raw: string): void {
  if (!raw) return;
  node.text += decodeEntities(raw);
}

/** Finds the `>` that closes a tag, skipping any inside quoted attributes. */
function findTagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

function skipDoctype(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ">" && depth <= 0) return i + 1;
  }
  return source.length;
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttributes(source: string, into: Record<string, string>): void {
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(source)) !== null) {
    const qualified = m[1].toLowerCase();
    const value = decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
    into[qualified] = value;
    // Also key by bare local name, so callers need not care whether the
    // document wrote `opf:file-as` or `file-as`.
    const colon = qualified.indexOf(":");
    if (colon >= 0) {
      const local = qualified.slice(colon + 1);
      if (!(local in into)) into[local] = value;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* traversal helpers                                                           */
/* -------------------------------------------------------------------------- */

export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

export function firstChild(node: XmlNode, name: string): XmlNode | null {
  return node.children.find((c) => c.name === name) ?? null;
}

/** Depth-first search for every element with this local name. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode): void => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export function findFirst(node: XmlNode, name: string): XmlNode | null {
  if (node.name === name) return node;
  for (const c of node.children) {
    const hit = findFirst(c, name);
    if (hit) return hit;
  }
  return null;
}

export function attr(node: XmlNode | null, name: string): string | undefined {
  return node?.attrs[name.toLowerCase()];
}

/** Text of this element and everything under it, whitespace collapsed. */
export function deepText(node: XmlNode): string {
  let out = node.text;
  for (const c of node.children) out += " " + deepText(c);
  return out.replace(/\s+/g, " ").trim();
}
