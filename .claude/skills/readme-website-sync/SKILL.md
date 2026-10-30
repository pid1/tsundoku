---
name: readme-website-sync
description: Keep tsundoku's README.md and its website (docs/index.html, published at pid1.github.io/tsundoku) saying the same thing. Use whenever README.md changes, whenever a change adds, removes or renames a feature, a reader, an address, a requirement or a setting, before opening a PR that touches either file, or when asked to update or check the README or the website.
---

# Keeping the README and the website in sync

tsundoku describes itself in two places that drift apart easily:

- **`README.md`**, the source of truth. It's what GitHub shows, written in the style of Cygnus-Strategy/sadr's README: short sections, plain sentences, detail pushed out to `USAGE.md` and `docs/security.md`.
- **`docs/index.html`**, the website, published by GitHub Pages from `docs/`. It's a designed page that tells the same story in the same order, condensed into panels and tables.

The README leads. Change it first, then bring the site to match. Never put a claim on the site that the README doesn't make. If the site needs a fact, it belongs in the README (or USAGE.md) first.

## How the two line up

Each `<section>` on the site starts with a `sync:` comment naming what it mirrors:

```html
<!-- sync: README "What it does" -->
```

| README section | Site section |
|---|---|
| name line and "What is tsundoku?" | the hero |
| "From upload to reading" | the four-step flow |
| "What it does" | the feature panels (`#features`) |
| "Install" | `#install`. The agent prompt stays in the README; the site links to it |
| "Connect a reader" | `#readers` |
| "Design principles" | the principles list |
| "License" | the footer |
| USAGE.md "Screens", "Free tier" | `#screenshots`, `#limits` |

A new README section needs a new site section with its own marker. A removed or renamed README section means removing or renaming its counterpart and marker.

## Steps

1. **Read both files in full**, plus the diff that prompted this. Work out what changed in the README, or what the change made untrue in either file.
2. **Check claims against the code, not memory.** Before writing that something exists, find it: routes in `src/routes/`, settings in `public/app.js` (`DEVICE_SETTING_OPTIONS`, `READER_FONTS`), formats in `READABLE_FORMATS`, requirements in `package.json` and `.npmrc`. Remove anything the code no longer does.
3. **Update the README first** if it's behind the code, keeping its style: sentence case headings, short sentences, one idea per bullet, no marketing language.
4. **Update the site section by section**, following the markers. Condense rather than copy: a README bullet usually becomes one feature panel, and a README paragraph a sentence or two. Keep the site's existing markup and classes; add CSS only for a new kind of block.
5. **Run the check** from the repository root:

   ```bash
   node .claude/skills/readme-website-sync/check.mjs
   ```

   It confirms every README section has a site counterpart and that the Node and npm versions, the catalog address and the web reader's formats match. It exits 1 and lists what's wrong. It can't judge wording, so step 4 still matters.
6. **Look at the page.** Serve it with `python3 -m http.server 8790 --directory docs` and open http://127.0.0.1:8790 at desktop and phone widths. Check that no section is empty, that the tables fit, and that every link resolves.
7. **Check the in-app help too.** `public/help.html` repeats the reader setup. If the catalog address, the sync settings or the reader instructions changed, update it in the same PR.

## Things that go stale

- **Screenshots** in `docs/screenshots/` are shared by the README, USAGE.md and the site. When the UI changes visibly, say in the PR that they need retaking. Never edit an image to fake a UI it doesn't show.
- **Version tags and release links.** Link to the releases page rather than a single tag, unless the README does.
- **Counts and limits** ("2,000–5,000 EPUBs", free-tier figures) come from USAGE.md's free-tier table, which records the date the figures were read. Keep the site's date in step.
- **Removed features.** The site's old "What it is not" list once said "No in-browser reader" long after the reader shipped. When a non-goal becomes a feature, delete the non-goal everywhere.
