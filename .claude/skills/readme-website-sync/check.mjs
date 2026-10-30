#!/usr/bin/env node
// Mechanical checks that docs/index.html still mirrors README.md. Run from the
// repository root:
//
//   node .claude/skills/readme-website-sync/check.mjs
//
// It does not judge wording; SKILL.md covers that. It checks the things that
// drift silently: a README section with no counterpart on the site, a site
// section pointing at a README heading that no longer exists, and a handful of
// facts that must read the same in both places. Exits 1 if anything is off.

import { readFileSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");
const site = readFileSync("docs/index.html", "utf8");

const problems = [];

// Every `## Heading` in the README needs a `sync:` marker on the site that
// names it in quotes, and every marker that names a README heading must name
// one that exists. Sections listed here are mirrored differently on purpose.
const NOT_MIRRORED = new Map([]);

const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
const markers = [...site.matchAll(/<!--\s*sync:([\s\S]*?)-->/g)].map((m) => m[1].trim());
const named = markers
  .filter((m) => m.startsWith("README"))
  .flatMap((m) => [...m.matchAll(/"([^"]+)"/g)].map((q) => q[1]));

for (const heading of headings) {
  if (NOT_MIRRORED.has(heading)) continue;
  if (!named.includes(heading)) problems.push(`README section "${heading}" has no sync: marker on the site.`);
}
for (const name of named) {
  if (!headings.includes(name)) problems.push(`The site's sync: marker names README section "${name}", which does not exist.`);
}

// Facts that must agree. Each pattern pulls a value out of both files; if the
// sets differ, one of them is stale.
const strip = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const text = { README: readme.replace(/\s+/g, " "), site: strip(site) };
const facts = [
  ["Node version", /Node (\d+)/g],
  ["npm version", /npm (\d+\.\d+)/g],
  ["catalog address", /\/opds\/[\d.]+/g],
  ["web reader formats", /(EPUB, CBZ, MOBI, AZW3 and FB2)/g],
];
for (const [label, pattern] of facts) {
  const values = Object.fromEntries(
    Object.entries(text).map(([where, body]) => [where, [...new Set([...body.matchAll(pattern)].map((m) => m[1] ?? m[0]))].sort()]),
  );
  if (JSON.stringify(values.README) !== JSON.stringify(values.site)) {
    problems.push(`${label} differs: README has [${values.README.join(", ")}], site has [${values.site.join(", ")}].`);
  }
}

if (problems.length) {
  console.log(problems.map((p) => `- ${p}`).join("\n"));
  process.exit(1);
}
console.log(`In step: ${headings.length} README sections mirrored, ${facts.length} facts agree.`);
