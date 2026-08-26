// The small file the eir theme fetches to know which posts have audio ready
// - {postId: audioUrl}. Committed straight into this repo and read by the
// theme via GitHub's raw-content URL, so no separate hosting/CORS setup is
// needed just for this file (see project discussion - Ghost's own upload
// URLs contain an unpredictable ID, e.g. .../13145f0f-7ca7-.../file.mp3,
// confirmed via a live test upload, so the theme can't guess them - this
// manifest is the only reliable way for it to know). Kept as a plain
// {postId: url} map - the theme reads it directly as such - so any extra
// bookkeeping this project needs lives in the separate state file below
// instead of changing this file's shape.
import { readFileSync, writeFileSync, existsSync } from "fs";

const MANIFEST_PATH = "manifest.json";

export function loadManifest() {
    if (!existsSync(MANIFEST_PATH)) return {};
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

export function saveManifest(manifest) {
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

// {postId: publishedAt} - the published_at the manifest entry for that post
// was actually generated from, so a post whose ID gets reused/edited into a
// later day's edition (confirmed happening periodically - EIR's publishing
// workflow sometimes edits an already-published post in place, bumping its
// title/content/published_at, rather than creating a fresh post) is detected
// and reprocessed instead of being silently skipped as "already done" by an
// ID-only check. Separate from manifest.json (rather than folded into it as
// {url, publishedAt}) so the theme's existing {postId: url} contract never
// has to change.
const STATE_PATH = "processed-state.json";

export function loadState() {
    if (!existsSync(STATE_PATH)) return {};
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

export function saveState(state) {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}
