import { describe, expect, it } from "vitest";
import { md5Hex } from "../../src/auth/password.js";
import { TAIL_OFFSETS, partialMd5 } from "../../src/books/partialmd5.js";
import { bytesRangeReader } from "../../src/books/zip.js";

function pattern(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  return bytes;
}

describe("md5Hex", () => {
  it("matches the RFC 1321 test vectors, proving the Cloudflare MD5 extension works", async () => {
    expect(await md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(await md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(await md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
  });
});

describe("partialMd5", () => {
  it("uses exponentially spaced offsets of 1024 * 4^i", () => {
    expect(TAIL_OFFSETS.slice(0, 5)).toEqual([1024, 4096, 16384, 65536, 262144]);
    expect(TAIL_OFFSETS).toHaveLength(11);
    expect(TAIL_OFFSETS[10]).toBe(1024 * 1024 * 1024);
  });

  it("hashes the whole file when the file is smaller than the first tail offset", async () => {
    const bytes = pattern(500);
    const { primary } = await partialMd5(bytesRangeReader(bytes));
    expect(primary).toBe(await md5Hex(bytes));
  });

  it("concatenates the samples it took, in offset order", async () => {
    // 3000 bytes: samples at 0 (1024 bytes) and 1024 (1024 bytes); 4096 is past EOF.
    const bytes = pattern(3000);
    const expected = await md5Hex(bytes.subarray(0, 2048));
    const { primary } = await partialMd5(bytesRangeReader(bytes));
    expect(primary).toBe(expected);
  });

  it("truncates the last sample at end of file rather than padding", async () => {
    // 1500 bytes: samples at 0 (1024) and 1024 (only 476 remain).
    const bytes = pattern(1500);
    const { primary } = await partialMd5(bytesRangeReader(bytes));
    expect(primary).toBe(await md5Hex(bytes));
  });

  it("produces two different candidates, which is the whole point of storing both", async () => {
    // primary starts at offset 0, alt at 256. See the comment in partialmd5.ts:
    // LuaJIT's bit.lshift masks the shift count, and which reading KOReader
    // actually produces is unconfirmed until checked against a device.
    const bytes = pattern(9000);
    const { primary, alt } = await partialMd5(bytesRangeReader(bytes));
    expect(primary).not.toBe(alt);
    expect(alt).toBe(
      await md5Hex(
        new Uint8Array([
          ...bytes.subarray(256, 1280),
          ...bytes.subarray(1024, 2048),
          ...bytes.subarray(4096, 5120),
        ]),
      ),
    );
  });

  it("is deterministic", async () => {
    const reader = bytesRangeReader(pattern(70000));
    expect(await partialMd5(reader)).toEqual(await partialMd5(reader));
  });

  it("weights the head, so appending to a file does not change the hash", async () => {
    // KOReader appends to PDFs when highlighting; that is the documented reason
    // for the non-even sampling. A 2KB file's samples all sit in the first 2KB.
    const base = pattern(2000);
    const appended = new Uint8Array(2400);
    appended.set(base);
    appended.set(pattern(400), 2000);

    const a = await partialMd5(bytesRangeReader(base));
    const b = await partialMd5(bytesRangeReader(appended));
    // Both read [0,1024) and [1024, min(2048,size)); the second file has more
    // bytes in the second window, so they differ -- but only because the sample
    // window was short, not because the tail moved.
    expect(a.primary).not.toBe(b.primary);

    const big = pattern(200000);
    const bigAppended = new Uint8Array(200500);
    bigAppended.set(big);
    const c = await partialMd5(bytesRangeReader(big));
    const d = await partialMd5(bytesRangeReader(bigAppended));
    expect(c.primary).toBe(d.primary);
  });
});
