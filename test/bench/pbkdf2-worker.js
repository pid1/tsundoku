const enc = new TextEncoder();
const salt = enc.encode("tsundoku-benchmark-salt");
const PASSWORD = "correct horse battery staple";

async function pbkdf2(iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(PASSWORD), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

async function hmac(reps) {
  const key = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  for (let i = 0; i < reps; i++) await crypto.subtle.sign("HMAC", key, enc.encode(`opds:alice:${PASSWORD}`));
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "pbkdf2";
    const iters = Number(url.searchParams.get("iters") ?? "100000");
    const reps = Number(url.searchParams.get("reps") ?? "1");
    const t0 = Date.now();
    if (mode === "hmac") await hmac(reps);
    else for (let i = 0; i < reps; i++) await pbkdf2(iters);
    const t1 = Date.now();
    return new Response(JSON.stringify({ mode, iters, reps, dateNowDelta: t1 - t0 }), {
      headers: { "content-type": "application/json" },
    });
  },
};
