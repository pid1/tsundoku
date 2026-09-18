/**
 * Minimal ZIP writer, for tests only.
 *
 * The reader in src/books/zip.ts is the thing under test, so the fixtures it
 * reads are built here rather than checked in as binaries: a byte-level parser
 * is only meaningfully tested against archives whose layout you control.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const body = new Response(bytes).body;
  if (!body) return new Uint8Array(0);
  const stream = body.pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ZipInput {
  name: string;
  data: Uint8Array | string;
  /** 8 = deflate (default), 0 = stored. */
  method?: 0 | 8;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function buildZip(inputs: ZipInput[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const input of inputs) {
    const raw = typeof input.data === "string" ? encoder.encode(input.data) : input.data;
    const method = input.method ?? 8;
    const compressed = method === 8 ? await deflateRaw(raw) : raw;
    const name = encoder.encode(input.name);
    const crc = crc32(raw);

    const header = new Uint8Array(30 + name.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true);
    hv.setUint16(4, 20, true); // version needed
    hv.setUint16(6, 0x800, true); // UTF-8 names
    hv.setUint16(8, method, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, compressed.length, true);
    hv.setUint32(22, raw.length, true);
    hv.setUint16(26, name.length, true);
    hv.setUint16(28, 0, true);
    header.set(name, 30);

    local.push(header, compressed);

    const entry = new Uint8Array(46 + name.length);
    const ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true);
    ev.setUint16(4, 20, true);
    ev.setUint16(6, 20, true);
    ev.setUint16(8, 0x800, true);
    ev.setUint16(10, method, true);
    ev.setUint32(16, crc, true);
    ev.setUint32(20, compressed.length, true);
    ev.setUint32(24, raw.length, true);
    ev.setUint16(28, name.length, true);
    ev.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);

    offset += header.length + compressed.length;
  }

  const centralBytes = concat(central);
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, inputs.length, true);
  dv.setUint16(10, inputs.length, true);
  dv.setUint32(12, centralBytes.length, true);
  dv.setUint32(16, offset, true);

  return concat([...local, centralBytes, eocd]);
}

export interface EpubOptions {
  title?: string;
  authors?: Array<{ name: string; fileAs?: string; role?: string }>;
  language?: string;
  publisher?: string;
  date?: string;
  description?: string;
  subjects?: string[];
  isbn?: string;
  /** Calibre-style EPUB2 series. */
  series?: { name: string; index?: number };
  /** EPUB3 belongs-to-collection instead. */
  collection?: { name: string; position?: number };
  cover?: { bytes: Uint8Array; mime: string; href: string; epub3?: boolean };
  /** Where the OPF lives, to exercise relative href resolution. */
  opfPath?: string;
}

export async function buildEpub(options: EpubOptions = {}): Promise<Uint8Array> {
  const opfPath = options.opfPath ?? "OEBPS/content.opf";
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";

  const meta: string[] = [];
  meta.push(`<dc:title>${options.title ?? "Untitled"}</dc:title>`);
  for (const author of options.authors ?? []) {
    const attrs = [
      author.fileAs ? ` opf:file-as="${author.fileAs}"` : "",
      author.role ? ` opf:role="${author.role}"` : "",
    ].join("");
    meta.push(`<dc:creator${attrs}>${author.name}</dc:creator>`);
  }
  if (options.language) meta.push(`<dc:language>${options.language}</dc:language>`);
  if (options.publisher) meta.push(`<dc:publisher>${options.publisher}</dc:publisher>`);
  if (options.date) meta.push(`<dc:date>${options.date}</dc:date>`);
  if (options.description) meta.push(`<dc:description>${options.description}</dc:description>`);
  for (const subject of options.subjects ?? []) meta.push(`<dc:subject>${subject}</dc:subject>`);
  if (options.isbn) meta.push(`<dc:identifier opf:scheme="ISBN">${options.isbn}</dc:identifier>`);
  if (options.series) {
    meta.push(`<meta name="calibre:series" content="${options.series.name}"/>`);
    if (options.series.index !== undefined) {
      meta.push(`<meta name="calibre:series_index" content="${options.series.index}"/>`);
    }
  }
  if (options.collection) {
    meta.push(`<meta property="belongs-to-collection" id="coll1">${options.collection.name}</meta>`);
    meta.push(`<meta refines="#coll1" property="collection-type">series</meta>`);
    if (options.collection.position !== undefined) {
      meta.push(`<meta refines="#coll1" property="group-position">${options.collection.position}</meta>`);
    }
  }

  const manifest: string[] = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>'];
  if (options.cover) {
    if (options.cover.epub3) {
      manifest.push(
        `<item id="cover-img" href="${options.cover.href}" media-type="${options.cover.mime}" properties="cover-image"/>`,
      );
    } else {
      manifest.push(`<item id="cover-img" href="${options.cover.href}" media-type="${options.cover.mime}"/>`);
      meta.push('<meta name="cover" content="cover-img"/>');
    }
  }

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    ${meta.join("\n    ")}
  </metadata>
  <manifest>
    ${manifest.join("\n    ")}
  </manifest>
  <spine><itemref idref="nav"/></spine>
</package>`;

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const entries: ZipInput[] = [
    { name: "mimetype", data: "application/epub+zip", method: 0 },
    { name: "META-INF/container.xml", data: container },
    { name: opfPath, data: opf },
    { name: `${opfDir ? `${opfDir}/` : ""}nav.xhtml`, data: "<html><body><nav/></body></html>" },
  ];
  if (options.cover) {
    entries.push({
      name: `${opfDir ? `${opfDir}/` : ""}${options.cover.href}`,
      data: options.cover.bytes,
      method: 0,
    });
  }

  return buildZip(entries);
}
