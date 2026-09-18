/**
 * A ZIP reader that never downloads the archive.
 *
 * An EPUB is a ZIP, and ZIP is readable from the tail: the End of Central
 * Directory record points at the central directory, which points at each entry.
 * So extracting a title and a cover from a 40MB book costs four or five R2
 * range reads and one small inflate, instead of pulling 40MB through a Worker
 * that has 128MB of memory and 10ms of CPU.
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface RangeReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function r2RangeReader(bucket: R2Bucket, key: string, size: number): RangeReader {
  return {
    size,
    async read(offset, length) {
      if (length <= 0 || offset >= size) return new Uint8Array(0);
      const clamped = Math.min(length, size - offset);
      const object = await bucket.get(key, { range: { offset, length: clamped } });
      if (object === null || !("body" in object)) {
        throw new Error(`r2 range read failed for ${key} at ${offset}+${clamped}`);
      }
      return new Uint8Array(await object.arrayBuffer());
    },
  };
}

/** In-memory reader, used by the tests and by cover re-upload. */
export function bytesRangeReader(bytes: Uint8Array): RangeReader {
  return {
    size: bytes.length,
    async read(offset, length) {
      return bytes.subarray(offset, Math.min(offset + length, bytes.length));
    },
  };
}

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const source = new Response(data).body;
  if (source === null) return new Uint8Array(0);
  const stream = source.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(dv: DataView, offset: number): number {
  const value = dv.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("zip: 64-bit field exceeds safe integer range");
  return Number(value);
}

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  // Bit 11 of the general purpose flags promises UTF-8. Archives lie about this
  // constantly, and UTF-8 with replacement is a better guess than CP437 either
  // way, so we decode as UTF-8 regardless and only vary the fatal-ness.
  void utf8Flag;
  return new TextDecoder("utf-8").decode(bytes);
}

interface Eocd {
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  entryCount: number;
}

async function findEocd(reader: RangeReader): Promise<Eocd> {
  // 22 byte EOCD + up to 65535 bytes of archive comment.
  const tailLength = Math.min(reader.size, 22 + 65535);
  const tailStart = reader.size - tailLength;
  const tail = await reader.read(tailStart, tailLength);
  const dv = view(tail);

  let eocdAt = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0) throw new Error("zip: no end-of-central-directory record; not a zip file");

  const entryCount = dv.getUint16(eocdAt + 10, true);
  const cdSize = dv.getUint32(eocdAt + 12, true);
  const cdOffset = dv.getUint32(eocdAt + 16, true);

  const needsZip64 = cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff;
  if (!needsZip64) {
    return { centralDirectoryOffset: cdOffset, centralDirectorySize: cdSize, entryCount };
  }

  // ZIP64: a locator sits immediately before the EOCD and points at the real record.
  const locatorAt = eocdAt - 20;
  if (locatorAt < 0 || dv.getUint32(locatorAt, true) !== SIG_EOCD64_LOCATOR) {
    throw new Error("zip: zip64 sizes without a zip64 locator");
  }
  const zip64At = u64(dv, locatorAt + 8);
  const record = await reader.read(zip64At, 56);
  const rdv = view(record);
  if (rdv.getUint32(0, true) !== SIG_EOCD64) throw new Error("zip: bad zip64 end-of-central-directory record");

  return {
    entryCount: u64(rdv, 32),
    centralDirectorySize: u64(rdv, 40),
    centralDirectoryOffset: u64(rdv, 48),
  };
}

/** Parses the central directory into a name-keyed map of entries. */
export async function readCentralDirectory(reader: RangeReader): Promise<Map<string, ZipEntry>> {
  const eocd = await findEocd(reader);
  const cd = await reader.read(eocd.centralDirectoryOffset, eocd.centralDirectorySize);
  const dv = view(cd);
  const entries = new Map<string, ZipEntry>();

  let p = 0;
  while (p + 46 <= cd.length) {
    if (dv.getUint32(p, true) !== SIG_CENTRAL) break;

    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let uncompressedSize = dv.getUint32(p + 24, true);
    const nameLength = dv.getUint16(p + 28, true);
    const extraLength = dv.getUint16(p + 30, true);
    const commentLength = dv.getUint16(p + 32, true);
    let localHeaderOffset = dv.getUint32(p + 42, true);

    const name = decodeName(cd.subarray(p + 46, p + 46 + nameLength), (flags & 0x800) !== 0);

    // ZIP64 extra field carries whichever of the above were saturated, in order.
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const extraStart = p + 46 + nameLength;
      let e = extraStart;
      while (e + 4 <= extraStart + extraLength) {
        const headerId = dv.getUint16(e, true);
        const dataSize = dv.getUint16(e + 2, true);
        if (headerId === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = u64(dv, q);
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = u64(dv, q);
            q += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = u64(dv, q);
            q += 8;
          }
          break;
        }
        e += 4 + dataSize;
      }
    }

    if (!name.endsWith("/")) {
      entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
    }
    p += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Reads and decompresses one entry. Only stored and deflate are supported. */
export async function readEntry(reader: RangeReader, entry: ZipEntry, maxBytes = 8 * 1024 * 1024): Promise<Uint8Array> {
  if (entry.uncompressedSize > maxBytes) {
    throw new Error(`zip: entry ${entry.name} is ${entry.uncompressedSize} bytes, over the ${maxBytes} limit`);
  }

  const header = await reader.read(entry.localHeaderOffset, 30);
  const hdv = view(header);
  if (hdv.getUint32(0, true) !== SIG_LOCAL) throw new Error(`zip: bad local header for ${entry.name}`);

  // The local header repeats the name and extra fields, and its lengths may
  // differ from the central directory's. Data starts after both.
  const nameLength = hdv.getUint16(26, true);
  const extraLength = hdv.getUint16(28, true);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;

  const raw = await reader.read(dataStart, entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`);
}

export async function readEntryText(reader: RangeReader, entry: ZipEntry): Promise<string> {
  const bytes = await readEntry(reader, entry);
  return new TextDecoder("utf-8").decode(bytes);
}

/** Case-insensitive lookup, because archives disagree about casing. */
export function findEntry(entries: Map<string, ZipEntry>, name: string): ZipEntry | null {
  const direct = entries.get(name);
  if (direct) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of entries) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}
