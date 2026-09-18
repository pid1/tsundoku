import { describe, expect, it } from "vitest";
import { attr, deepText, decodeEntities, findAll, findFirst, parseXml } from "../../src/books/xml.js";

describe("decodeEntities", () => {
  it("handles the five XML entities and numeric references", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(`a & b <c> "d" 'e'`);
    expect(decodeEntities("&#65;&#x42;&#x1F4DA;")).toBe("AB\u{1F4DA}");
  });

  it("leaves an undeclared entity alone rather than dropping it", () => {
    // Real EPUBs reference HTML entities that were never declared. Mangling the
    // text is worse than passing it through.
    expect(decodeEntities("Alice &mdash; Bob")).toBe("Alice &mdash; Bob");
  });
});

describe("parseXml", () => {
  it("splits namespace prefixes from local names", () => {
    const doc = parseXml("<package><dc:title>Hello</dc:title></package>");
    const title = findFirst(doc, "title");
    expect(title?.prefix).toBe("dc");
    expect(title?.name).toBe("title");
    expect(deepText(title!)).toBe("Hello");
  });

  it("keys attributes by both qualified and bare name", () => {
    const doc = parseXml(`<creator opf:file-as="Le Guin, Ursula">Ursula Le Guin</creator>`);
    const node = findFirst(doc, "creator");
    expect(attr(node, "opf:file-as")).toBe("Le Guin, Ursula");
    expect(attr(node, "file-as")).toBe("Le Guin, Ursula");
  });

  it("accepts single-quoted and unquoted attribute values", () => {
    const doc = parseXml(`<item id='a' href=b.xhtml media-type="text/html"/>`);
    const node = findFirst(doc, "item");
    expect(attr(node, "id")).toBe("a");
    expect(attr(node, "href")).toBe("b.xhtml");
    expect(attr(node, "media-type")).toBe("text/html");
  });

  it("does not end a tag on a > inside a quoted attribute", () => {
    const doc = parseXml(`<meta name="x" content="a > b"/><title>after</title>`);
    expect(attr(findFirst(doc, "meta"), "content")).toBe("a > b");
    expect(deepText(findFirst(doc, "title")!)).toBe("after");
  });

  it("treats CDATA as literal text", () => {
    const doc = parseXml("<description><![CDATA[<b>bold</b> & raw]]></description>");
    expect(deepText(findFirst(doc, "description")!)).toBe("<b>bold</b> & raw");
  });

  it("skips comments, processing instructions and a DOCTYPE with an internal subset", () => {
    const source = `<?xml version="1.0"?>
      <!DOCTYPE package [ <!ENTITY nbsp "&#160;"> ]>
      <!-- a comment with <tags> in it -->
      <package><title>Real</title></package>`;
    expect(deepText(findFirst(parseXml(source), "title")!)).toBe("Real");
  });

  it("survives a mismatched close tag instead of throwing", () => {
    const doc = parseXml("<a><b>one</c></b><d>two</d></a>");
    expect(findAll(doc, "d")).toHaveLength(1);
    expect(deepText(findFirst(doc, "d")!)).toBe("two");
  });

  it("does not let an unclosed void element swallow the document", () => {
    const doc = parseXml("<metadata><br><title>Still here</title></metadata>");
    const metadata = findFirst(doc, "metadata")!;
    expect(metadata.children.map((c) => c.name)).toContain("title");
  });

  it("keeps text inside a meta element, which EPUB3 depends on", () => {
    // <meta> is void in XHTML but not in an OPF: EPUB3 writes the collection
    // name as the element's text. Treating it as void loses every series.
    const doc = parseXml('<metadata><meta property="belongs-to-collection" id="c1">Earthsea</meta></metadata>');
    const meta = findFirst(doc, "meta")!;
    expect(deepText(meta)).toBe("Earthsea");
    expect(attr(meta, "id")).toBe("c1");
  });

  it("finds every matching element depth-first", () => {
    const doc = parseXml("<r><m><subject>a</subject></m><subject>b</subject></r>");
    expect(findAll(doc, "subject").map(deepText)).toEqual(["a", "b"]);
  });
});
