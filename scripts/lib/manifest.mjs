// The small file the eir theme fetches to know which posts have audio ready
// - {postId: audioUrl}. Committed straight into this repo and read by the
// theme via GitHub's raw-content URL, so no separate hosting/CORS setup is
// needed just for this file (see project discussion - Ghost's own upload
// URLs contain an unpredictable ID, e.g. .../13145f0f-7ca7-.../file.mp3,
// confirmed via a live test upload, so the theme can't guess them - this
// manifest is the only reliable way for it to know).
import { readFileSync, writeFileSync, existsSync } from "fs";

const MANIFEST_PATH = "manifest.json";

export function loadManifest() {
    if (!existsSync(MANIFEST_PATH)) return {};
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

export function saveManifest(manifest) {
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}
