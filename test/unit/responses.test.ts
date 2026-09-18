import { describe, expect, it } from "vitest";
import { redirect, securityHeaders } from "../../src/http/responses.js";

describe("redirect", () => {
  it("sets the status and Location", () => {
    const res = redirect("https://books.example.com/opds/1.2", 302);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://books.example.com/opds/1.2");
  });

  // The regression: /opds built its redirect with Response.redirect(), whose
  // headers are immutable, and securityHeaders() writes to every response
  // leaving the router. The catalog root answered 500 instead of redirecting.
  it("survives securityHeaders, unlike Response.redirect()", () => {
    const res = securityHeaders(redirect("https://books.example.com/opds/1.2"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://books.example.com/opds/1.2");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("securityHeaders", () => {
  it("applies the headers to an ordinary response", () => {
    const res = securityHeaders(new Response("hi"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
  });

  it("copies rather than throwing when the headers are immutable", async () => {
    const immutable = Response.redirect("https://books.example.com/opds/1.2", 302);
    const res = securityHeaders(immutable);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://books.example.com/opds/1.2");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
  });

  it("preserves the body and status of an immutable response", async () => {
    const upstream = new Response("payload", { status: 203, headers: { "content-type": "text/plain" } });
    Object.defineProperty(upstream, "headers", {
      value: new Proxy(upstream.headers, {
        get(target, prop) {
          if (prop === "set") {
            return () => {
              throw new TypeError("Can't modify immutable headers.");
            };
          }
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }),
    });
    const res = securityHeaders(upstream);
    expect(res.status).toBe(203);
    expect(await res.text()).toBe("payload");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
