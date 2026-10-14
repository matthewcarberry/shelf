#!/usr/bin/env node
// Sets shelf's version everywhere it is written down: the web/server and mobile package.json
// files and their lockfiles, Android versionName (versionCode goes up by one) and iOS
// MARKETING_VERSION.
//
//   node scripts/bump-version.mjs patch|minor|major   bump from the current version
//   node scripts/bump-version.mjs 1.2.3               set an exact version
//   node scripts/bump-version.mjs patch 1.2.3         bump from 1.2.3 instead, such as the
//                                                     newest tag when it is ahead of the files
//
// Prints the new version.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = (relative) => path.join(root, relative);

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node scripts/bump-version.mjs patch|minor|major|X.Y.Z");
  process.exit(1);
}

const current = process.argv[3] || JSON.parse(readFileSync(file("package.json"), "utf8")).version;
const next = nextVersion(current, arg);

function nextVersion(version, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [major, minor, patch] = version.split(".").map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  console.error(`Unknown bump "${bump}". Use patch, minor, major or X.Y.Z.`);
  process.exit(1);
}

function editJson(relative, edit) {
  const data = JSON.parse(readFileSync(file(relative), "utf8"));
  edit(data);
  writeFileSync(file(relative), `${JSON.stringify(data, null, 2)}\n`);
}

function editText(relative, pattern, replace) {
  const text = readFileSync(file(relative), "utf8");
  if (!pattern.test(text)) throw new Error(`${relative} has no match for ${pattern}`);
  pattern.lastIndex = 0;
  writeFileSync(file(relative), text.replace(pattern, replace));
}

for (const dir of [".", "mobile"]) {
  editJson(path.join(dir, "package.json"), (pkg) => {
    pkg.version = next;
  });
  editJson(path.join(dir, "package-lock.json"), (lock) => {
    lock.version = next;
    lock.packages[""].version = next;
  });
}

const gradle = "mobile/android/app/build.gradle";
editText(gradle, /versionName "[^"]*"/, `versionName "${next}"`);
editText(gradle, /versionCode (\d+)/, (_, code) => `versionCode ${Number(code) + 1}`);

editText(
  "mobile/ios/ShelfStreamMobile.xcodeproj/project.pbxproj",
  /MARKETING_VERSION = [^;]+;/g,
  `MARKETING_VERSION = ${next};`,
);

console.log(next);
