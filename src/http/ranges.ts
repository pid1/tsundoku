export type ParsedRange = { offset: number; length: number } | "unsatisfiable" | null;

/**
 * Single-range `bytes=` parsing. Multi-range requests are answered with the
 * whole object, which is legal and is what every OPDS reader tolerates.
 */
export function parseRange(header: string | null, size: number): ParsedRange {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, startRaw, endRaw] = m;
  if (startRaw === "" && endRaw === "") return null;

  if (startRaw === "") {
    const suffix = parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const start = parseInt(startRaw, 10);
  if (!Number.isFinite(start) || start >= size) return "unsatisfiable";
  const end = endRaw === "" ? size - 1 : Math.min(parseInt(endRaw, 10), size - 1);
  if (end < start) return "unsatisfiable";
  return { offset: start, length: end - start + 1 };
}

export interface StreamOptions {
  contentType: string;
  filename?: string;
  cacheControl: string;
  etag: string;
  /** Content-Disposition: attachment. OPDS downloads want this; covers do not. */
  attachment?: boolean;
}

/** Streams an R2 object, honouring Range so large downloads stay resumable. */
export async function streamObject(
  bucket: R2Bucket,
  key: string,
  size: number,
  request: Request,
  opts: StreamOptions,
): Promise<Response> {
  const range = parseRange(request.headers.get("range"), size);

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" },
    });
  }

  const headers = new Headers({
    "content-type": opts.contentType,
    "accept-ranges": "bytes",
    "cache-control": opts.cacheControl,
    etag: opts.etag,
  });
  if (opts.filename) {
    const safe = opts.filename.replace(/["\\]/g, "_");
    const disp = opts.attachment ? "attachment" : "inline";
    headers.set(
      "content-disposition",
      `${disp}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(opts.filename)}`,
    );
  }

  if (request.method === "HEAD") {
    headers.set("content-length", String(size));
    return new Response(null, { status: 200, headers });
  }

  const object = await bucket.get(key, range ? { range } : undefined);
  if (object === null) return new Response("Not found", { status: 404 });
  if (!("body" in object) || object.body === null) return new Response(null, { status: 204, headers });

  if (range) {
    headers.set("content-length", String(range.length));
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("content-length", String(size));
  return new Response(object.body, { status: 200, headers });
}
