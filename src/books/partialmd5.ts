import { md5Hex } from "../auth/password.js";
import type { RangeReader } from "./zip.js";

/**
 * KOReader's document hash, reimplemented.
 *
 * From koreader/frontend/util.lua:
 *
 *     local step, size = 1024, 1024
 *     local update = md5()
 *     for i = -1, 10 do
 *         file:seek("set", lshift(step, 2*i))
 *         local sample = file:read(size)
 *         if sample then update(sample) else break end
 *     end
 *
 * Samples are weighted towards the head of the file, because KOReader appends
 * to PDFs when highlighting and a tail-weighted hash would change under it.
 *
 * THE AMBIGUITY. For i = -1 the shift count is -2. Read arithmetically that is
 * offset 256. But LuaJIT's bit.lshift masks the shift count to five bits, so
 * -2 becomes 30, and 1024 << 30 overflows 32 bits to 0. The two readings give
 * different hashes and which one runs has not been confirmed against a device.
 *
 * Rather than guess, compute both and store both: `primary` takes offset 0,
 * `alt` takes 256. Lookups match on either column. This makes the ambiguity
 * cost one extra TEXT column instead of a broken feature, and sync itself never
 * depends on it -- kosync only needs the hash to agree between a user's own
 * devices, and the server stores whatever string it is handed.
 *
 * Resolving it properly: open a known file in KOReader and read
 * partial_md5_checksum out of <book>.sdr/metadata.<ext>.lua, then compare.
 * test/conformance/partial-md5.md has the procedure.
 */

const SAMPLE_SIZE = 1024;

/** Offsets for i = 0..10, i.e. 1024 * 4^i. */
export const TAIL_OFFSETS: number[] = Array.from({ length: 11 }, (_, i) => 1024 * Math.pow(4, i));

export interface PartialMd5 {
  /** i = -1 read as a 32-bit masked shift, giving offset 0. */
  primary: string;
  /** i = -1 read arithmetically, giving offset 256. */
  alt: string;
}

export async function partialMd5(reader: RangeReader): Promise<PartialMd5> {
  const size = reader.size;

  // One read covers both candidate first samples: [0,1024) and [256,1280).
  const head = await reader.read(0, Math.min(1280, size));

  const primaryChunks: Uint8Array[] = [head.subarray(0, Math.min(SAMPLE_SIZE, head.length))];
  const altChunks: Uint8Array[] = [];
  if (size > 256) {
    altChunks.push(head.subarray(256, Math.min(256 + SAMPLE_SIZE, head.length)));
  }

  for (const offset of TAIL_OFFSETS) {
    if (offset >= size) break;
    const chunk = await reader.read(offset, Math.min(SAMPLE_SIZE, size - offset));
    if (chunk.length === 0) break;
    primaryChunks.push(chunk);
    altChunks.push(chunk);
  }

  const [primary, alt] = await Promise.all([md5Hex(concat(primaryChunks)), md5Hex(concat(altChunks))]);
  return { primary, alt };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** KOReader's other matching mode: md5 of the bare filename. */
export function filenameHash(filename: string): Promise<string> {
  return md5Hex(filename);
}
