// KOReader's EPUB positions, translated to and from the browser's DOM.
//
// KOReader (crengine, really) records where you are in an EPUB as an XPointer
// into its own rendering of the book:
//
//     /body/DocFragment[12]/body/div/p[3]/text().45
//
// DocFragment[n] is the n-th spine item, 1-based. Below it is an ordinary path
// through that chapter's XHTML: an element's index among same-named siblings,
// written only when there is more than one, then the text node and a character
// offset into it. kosync stores that string verbatim, so the web reader has to
// both read it (to resume where KOReader stopped) and write it (so KOReader can
// resume where the browser stopped).
//
// crengine's DOM is not the browser's: it drops whitespace-only text nodes and
// may normalise whitespace inside the ones it keeps. So this is a best-effort
// translation, accurate to the paragraph and usually to the word. Resolution
// never fails outright: when a step does not exist here, it stops at the
// deepest element it did find, which is still the right neighbourhood.

const XPOINTER = /^\/body\/DocFragment\[(\d+)\]((?:\/[^/]+)*)$/;
const TEXT_STEP = /^text\(\)(?:\[(\d+)\])?(?:\.(\d+))?$/;
const ELEMENT_STEP = /^([^[.]+)(?:\[(\d+)\])?(?:\.(\d+))?$/;

const isCountedText = (node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim() !== "";

/** True when `progress` looks like an EPUB XPointer KOReader would write. */
export function isXPointer(progress) {
  return typeof progress === "string" && XPOINTER.test(progress);
}

/**
 * Parses an XPointer into a navigation target for foliate's renderer:
 * `{ index, anchor }`, where `anchor(doc)` returns a Range or an Element once
 * the chapter is loaded. Null when the string is not an EPUB XPointer.
 */
export function fromXPointer(xpointer) {
  const match = XPOINTER.exec(xpointer);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  const steps = match[2].split("/").filter(Boolean);
  return { index, anchor: (doc) => resolve(doc, steps) };
}

function resolve(doc, steps) {
  // The first step is the chapter's own <body>, a child of <html>.
  let element = doc.documentElement;
  for (const step of steps) {
    const text = TEXT_STEP.exec(step);
    if (text) {
      const nodes = [...element.childNodes].filter(isCountedText);
      const node = nodes[Number(text[1] ?? 1) - 1];
      if (!node) break;
      const offset = Math.min(Number(text[2] ?? 0), Math.max(0, node.length - 1));
      const range = doc.createRange();
      range.setStart(node, offset);
      range.setEnd(node, Math.min(node.length, offset + 1));
      return range;
    }
    const tag = ELEMENT_STEP.exec(step);
    if (!tag) break;
    const name = tag[1].toLowerCase();
    const next = [...element.children].filter((c) => c.localName === name)[Number(tag[2] ?? 1) - 1];
    if (!next) break;
    element = next;
  }
  return element === doc.documentElement ? doc.body : element;
}

/**
 * Builds KOReader's XPointer for the start of `range` in spine item `index`
 * (0-based). The point is moved forward onto the first counted text node, since
 * that is the only kind of position crengine writes with an offset.
 */
export function toXPointer(index, range) {
  const prefix = `/body/DocFragment[${index + 1}]`;
  const doc = range.startContainer.ownerDocument ?? range.startContainer;
  const body = doc.body;
  if (!body) return `${prefix}/body`;

  let node = range.startContainer;
  let offset = range.startOffset;
  if (node.nodeType !== Node.TEXT_NODE) {
    node = node.childNodes[offset] ?? node;
    offset = 0;
  }
  if (!isCountedText(node) || !body.contains(node)) {
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (isCountedText(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    walker.currentNode = body.contains(node) ? node : body;
    node = walker.nextNode();
    offset = 0;
    if (!node) return `${prefix}/body`;
  }

  const textSiblings = [...node.parentNode.childNodes].filter(isCountedText);
  const textStep = textSiblings.length > 1 ? `text()[${textSiblings.indexOf(node) + 1}]` : "text()";

  const steps = [];
  for (let el = node.parentNode; el && el !== body; el = el.parentNode) {
    if (el.nodeType !== Node.ELEMENT_NODE) return `${prefix}/body`;
    const same = [...el.parentNode.children].filter((c) => c.localName === el.localName);
    steps.unshift(same.length > 1 ? `${el.localName}[${same.indexOf(el) + 1}]` : el.localName);
  }
  return `${prefix}/body${steps.map((s) => `/${s}`).join("")}/${textStep}.${offset}`;
}
