/**
 * Rewrite bot/content.lock.json from the current themes and scenarios (version + content hash).
 * Run after bumping a version because the text changed:  npm run content:lock
 */
import { writeFileSync } from "node:fs";
import { contentCatalog } from "../src/content.js";

const lock = Object.fromEntries(contentCatalog().map((c) => [c.id, { version: c.version, hash: c.hash }]));
writeFileSync("bot/content.lock.json", `${JSON.stringify(lock, null, 2)}\n`);
console.log(`content.lock.json: ${Object.keys(lock).length} entries`);
