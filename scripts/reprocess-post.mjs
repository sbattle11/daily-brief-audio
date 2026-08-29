// One-off manual reprocessing for a single post, reusing the exact same
// processPost() logic run.mjs uses for the normal automated pipeline - for
// fixing one already-narrated post (e.g. after a chunk-text.mjs bug fix)
// without waiting for or re-running the full scheduled job. Usage:
//   node scripts/reprocess-post.mjs <postId>
import "dotenv/config";
import { mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { browsePosts } from "./lib/ghost-admin.mjs";
import { loadManifest, loadState } from "./lib/manifest.mjs";
import { loadChapters } from "./lib/chapters.mjs";
import { processPost } from "./run.mjs";

const postId = process.argv[2];
if (!postId) {
    console.error("Usage: node scripts/reprocess-post.mjs <postId>");
    process.exit(1);
}

const posts = browsePosts({ filter: `id:${postId}`, formats: "html" });
let post = null;
for await (const p of posts) post = p;
if (!post) {
    console.error(`No post found with id ${postId}`);
    process.exit(1);
}

const manifest = loadManifest();
const chapters = loadChapters();
const state = loadState();
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "daily-brief-reprocess-"));
try {
    await processPost(post, manifest, chapters, state, tmpDir);
    console.log("Done.");
} finally {
    rmSync(tmpDir, { recursive: true, force: true });
}
