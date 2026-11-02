# AGENTS.md

## Homepage

The README is tsundoku's homepage and its documentation. The repository's GitHub "website" field points at it (https://github.com/pid1/tsundoku#readme). There is no GitHub Pages site or separate landing page, and none should be added. Detail goes in USAGE.md, PLAN.md and docs/security.md, which the README links to.

- When a change adds, removes or renames a feature, a reader, an address, a requirement or a setting, update the README and USAGE.md in the same PR. public/help.html repeats the reader setup, so update it too when the catalog address, the sync settings or the reader instructions change.
- Screenshots in docs/screenshots/ are used by the README and USAGE.md. When the UI changes visibly, retake them or say in the PR that they need it. Never edit an image to fake a UI it doesn't show, and never show a copyrighted book. Take them from a fresh local instance (`wrangler dev --persist-to` a new folder) holding only public-domain books from Standard Ebooks, with demo sync positions pushed through kosync. Capture with Playwright at 2x: desktop at 1440x900, downscaled to 2000px wide, and phone at 390x844. Shots full of cover art are JPEG and the rest PNG. Keep the file names.

## Sadr

### Build and test
- Install with `npm ci`, then run `npm run typecheck` (tsc --noEmit) and `npm test` (vitest inside workerd through @cloudflare/vitest-plugin). Passing is a clean typecheck and every test passing. Neither needs a Cloudflare account.
- Run the app with `npm run db:migrate:local`, then `npx wrangler dev --port 8787 --ip 127.0.0.1 --var PEPPER:ci-pepper --var SESSION_KEY:ci-session --var ADMIN_USERNAME:ciuser --var ADMIN_PASSWORD:cipassword`. `GET /healthcheck` answers `{"state":"OK"}`. The first authenticated request seeds the admin account.
- The kosync protocol check clones https://github.com/pid1/kosync-conformance and runs its `verify.mjs` against the local Worker, as .github/workflows/kosync-conformance.yml does. Passing is "conformant (every MUST satisfied)".
- Never run `npm run deploy`, `npm run db:migrate`, `npm run setup` or `npm run db:backup`. They write to the Cloudflare account.

### Toolchain
- npm is the only package manager, with package-lock.json. CI installs Node with actions/setup-node and runs `npm ci`.

### Design system
The web UI (everything in public/ except the reader's page area) follows these rules. The tokens live at the top of public/app.css; components use the tokens and never a raw hex value. If you change a colour, re-measure its contrast and update this table in the same commit.

- **Type.** Atkinson Hyperlegible Next for all UI, self-hosted from public/fonts. Body 16px with line height 1.55. Scale: `--text-xs` 13px, `--text-sm` 14px, `--text-md` 16px, `--text-lg` 18px, `--text-xl` 22px, `--text-2xl` 28px. Nothing is set smaller than 13px. Size type in rem, so the browser's text size setting applies.
- **Colour.** Warm paper and ink, with one brown accent. Light and dark follow `prefers-color-scheme`. The reader's own theme setting (light, sepia, dark) applies only inside the reader.

  | Token | Use | Light | Dark |
  |---|---|---|---|
  | `--bg` | page | #fbfaf7 | #171613 |
  | `--panel` | header, tab bar, cards, dialogs, menus | #ffffff | #201e1a |
  | `--sunken` | hover, selected, current-page fill | #f1ece2 | #2c2924 |
  | `--ink` | body text | #1d1b16 | #ece7dc |
  | `--muted` | secondary text, inactive nav | #6b6558 | #a39b8c |
  | `--line` | dividers, card edges (decorative only) | #e2ddd1 | #35312a |
  | `--control` | borders that identify a control | #8a8273 | #7d7568 |
  | `--accent` | links, primary buttons, current tab, focus ring | #7a4b2a | #d79a68 |
  | `--accent-ink` | text on `--accent` | #ffffff | #201e1a |
  | `--danger` / `--ok` | errors, destructive actions / success | #a33a20 / #2f6b43 | #e08a72 / #86c79b |

  Measured contrast, worst case across `--bg`, `--panel` and `--sunken`: ink 14.6:1 (light) and 11.8:1 (dark), muted 4.9:1 and 5.3:1, accent 6.2:1 and 6.0:1, danger 5.6:1 in both, ok 5.4:1 and 7.4:1, accent-ink on accent 7.3:1 and 6.9:1, control 3.2:1 in both. Text needs at least 4.5:1 and controls and focus rings at least 3:1 (WCAG 2.2 AA). `--line` is below 3:1 on purpose, so never use it as the only edge of a control.
- **Space and shape.** The spacing scale is `--space-1` to `--space-7` (4, 8, 12, 16, 24, 32 and 48px). Radii are `--radius-sm` 6px (small buttons, covers), `--radius` 10px (cards, inputs, menus) and `--radius-lg` 14px (hero cards, sheets). The page gutter is 16px and content is at most 1100px wide.
- **Touch and focus.** Every control is at least `--tap` (44px) in both directions. Focus shows as a 2px `--accent` outline with a 2px offset on `:focus-visible`; never remove it. State is never shown by colour alone: the current page also gets weight and an underline or fill, and errors also get text.
- **Navigation.** There is one header, drawn by `mountChrome()` in app.js, and no page hand-writes its own. Main destinations are Home and Library. Preferences, Admin (including sync status), Help and Sign out sit in the account menu, which is a disclosure button over a list of links (not ARIA `role="menu"`). It closes on Escape or an outside click and returns focus to its button. Up to 640px wide, the header shrinks to the brand and the page's own actions, and a bottom tab bar holds Home, Library and Account, clear of the safe-area inset. Account opens the same menu as a sheet above the tab bar. Mark the current page with `aria-current="page"`. Each page starts with a "Skip to content" link.
- **Components.** Primary button: `--accent` fill with `--accent-ink` text, one per view. Secondary button: transparent with a `--control` border. Danger button: `--danger` text and border. Inputs: `--bg` fill, `--control` border and a visible `<label>` (visually hidden only for a lone search field). Cards: `--panel` with a `--line` border, `--radius` and `--shadow`. Use `<dialog>` with `showModal()` for anything modal. Icons are inline stroke SVGs with `aria-hidden="true"` next to a visible label; an icon-only button needs an `aria-label`. No emoji.
- **Motion.** Keep transitions under 200ms, and use none at all under `prefers-reduced-motion: reduce`.

### Deploys outside CI
- Cloudflare Workers Builds deploys the Worker on every push to main, with build command `./build.sh` and deploy command `npx wrangler deploy` (wrangler.toml). .github/workflows/cf-fallback.yml deploys only when the live `/.build-id` does not match the pushed commit.
