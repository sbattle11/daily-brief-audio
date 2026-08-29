// {postId: [seconds, seconds, ...]} - one start-time offset per real
// article within that post's stitched audio, in order. A deliberately
// SEPARATE file from manifest.json (added 2026-08-29, chapter-navigation
// feature/"next article"/"previous article" buttons), not a change to that
// file's shape: manifest.json is documented (see manifest.mjs) as being kept
// as a plain {postId: url} map specifically so the theme's existing
// fetch/parse code never has to change - adding a new file here preserves
// that untouched, and a post narrated before this feature shipped simply
// has no entry (the theme treats that as "no chapters available", not an
// error). Committed straight into this repo and published the same way as
// manifest.json - the theme fetches it as a second, independent request.
import { readFileSync, writeFileSync, existsSync } from "fs";

const CHAPTERS_PATH = "chapters.json";

export function loadChapters() {
    if (!existsSync(CHAPTERS_PATH)) return {};
    return JSON.parse(readFileSync(CHAPTERS_PATH, "utf8"));
}

export function saveChapters(chapters) {
    writeFileSync(CHAPTERS_PATH, JSON.stringify(chapters, null, 2) + "\n");
}
