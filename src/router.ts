import type { Env } from "./types.js";

export interface RouteContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  params: Record<string, string>;
}

export type Handler = (c: RouteContext) => Response | Promise<Response>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

/**
 * A router small enough to read in one sitting. Patterns use `:name` for a
 * single segment and a trailing `*` for the rest of the path.
 */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method,
      segments: pattern.split("/").filter((s) => s.length > 0),
      handler,
    });
    return this;
  }

  get(p: string, h: Handler): this {
    return this.add("GET", p, h);
  }
  post(p: string, h: Handler): this {
    return this.add("POST", p, h);
  }
  put(p: string, h: Handler): this {
    return this.add("PUT", p, h);
  }
  patch(p: string, h: Handler): this {
    return this.add("PATCH", p, h);
  }
  delete(p: string, h: Handler): this {
    return this.add("DELETE", p, h);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter((s) => s.length > 0);
    // HEAD is served by the GET handler; streamObject() short-circuits the body.
    const wanted = method === "HEAD" ? "GET" : method;

    for (const route of this.routes) {
      if (route.method !== wanted) continue;
      const params: Record<string, string> = {};
      let ok = true;

      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg === "*") {
          params["*"] = parts.slice(i).join("/");
          return { handler: route.handler, params };
        }
        if (i >= parts.length) {
          ok = false;
          break;
        }
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }

      if (ok && route.segments.length === parts.length) {
        return { handler: route.handler, params };
      }
    }
    return null;
  }
}
