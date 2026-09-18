import { CT } from "../http/responses.js";
import { escapeXml } from "../util.js";

/**
 * Authentication for OPDS 1.0.
 *
 * Returned as the body of every 401, alongside a `WWW-Authenticate: Basic`
 * challenge. Dumb clients see the challenge and prompt; clients that understand
 * the document render a proper login form with our labels. The document itself
 * must be reachable without authentication, which is why it is also served at
 * its own URL.
 */
export function authDocument(origin: string, catalogTitle: string): Record<string, unknown> {
  return {
    id: `${origin}/opds/auth`,
    title: catalogTitle,
    description: "Sign in with the account you were given. Accounts are created by the library administrator.",
    links: [
      { rel: "logo", href: `${origin}/logo.svg`, type: "image/svg+xml", width: 512, height: 512 },
      { rel: "help", href: `${origin}/help.html`, type: "text/html" },
    ],
    authentication: [
      {
        type: "http://opds-spec.org/auth/basic",
        labels: { login: "Username", password: "Password" },
      },
    ],
  };
}

export function unauthorized(origin: string, catalogTitle: string, realm = "tsundoku"): Response {
  return new Response(JSON.stringify(authDocument(origin, catalogTitle)), {
    status: 401,
    headers: {
      "content-type": CT.opdsAuth,
      "www-authenticate": `Basic realm="${escapeXml(realm)}", charset="UTF-8"`,
      link: `<${origin}/opds/auth>; rel="http://opds-spec.org/auth/document"`,
      "cache-control": "no-store",
    },
  });
}
