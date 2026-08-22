// Daily entry point. Run on an HOURLY GitHub Actions cron (not a single
// once-a-day cron) and self-gates on local time - see isTargetHour() below
// - so "2am Eastern, pinned year-round" survives the DST transition
// automatically with zero maintenance, instead of drifting an hour twice a
// year like a fixed-UTC cron would.
import "dotenv/config";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { browsePosts, uploadAudio } from "./lib/ghost-admin.mjs";
import { chunkText } from "./lib/chunk-text.mjs";
import { synthesizeWithRetry } from "./lib/tts.mjs";
import { stitchAudio } from "./lib/stitch.mjs";
import { loadManifest, saveManifest } from "./lib/manifest.mjs";
import { htmlToPlainText } from "./lib/html-to-text.mjs";

const TARGET_HOUR_ET = 2;

function isTargetHour() {
    const hourInNY = Number(
        new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date())
    );
    return hourInNY === TARGET_HOUR_ET;
}

async function processPost(post, manifest, tmpDir) {
    console.log(`Generating audio for "${post.title}" (${post.id})...`);
    const text = htmlToPlainText(post.html || "");
    const chunks = chunkText(text);
    console.log(`  ${text.length} chars -> ${chunks.length} chunk(s)`);

    const chunkPaths = [];
    let fileIndex = 0;
    for (const chunk of chunks) {
        // Usually one buffer per chunk; more than one only if
        // synthesizeWithRetry had to split this chunk further after Google
        // rejected it (see tts.mjs) - either way, each buffer becomes its
        // own numbered file in the correct left-to-right order for stitching.
        const audioBuffers = await synthesizeWithRetry(chunk);
        for (const audio of audioBuffers) {
            const chunkPath = path.join(tmpDir, `chunk-${fileIndex}.mp3`);
            writeFileSync(chunkPath, audio);
            chunkPaths.push(chunkPath);
            fileIndex++;
        }
    }

    const stitchedPath = path.join(tmpDir, "stitched.mp3");
    await stitchAudio(chunkPaths, stitchedPath);

    const filename = `daily-brief-${post.slug}.mp3`;
    const url = await uploadAudio(stitchedPath, filename);
    console.log(`  uploaded: ${url}`);

    manifest[post.id] = url;
    saveManifest(manifest);
}

async function main() {
    if (!isTargetHour() && process.env.FORCE_RUN !== "1") {
        console.log(`Not the target hour (2am America/New_York) - exiting. Set FORCE_RUN=1 to override for testing.`);
        return;
    }

    const manifest = loadManifest();

    // Rolling 48h lookback rather than "since last run" - matches the
    // eir-algolia-sync project's reasoning: GitHub Actions runners are
    // ephemeral, nothing persists between runs except what's committed
    // (the manifest itself), so a stateless window that's self-healing on
    // a missed run beats tracking a separate watermark.
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const posts = browsePosts({ filter: `tag:daily-brief+published_at:>'${since}'`, formats: "html", order: "published_at ASC" });

    const toProcess = [];
    for await (const post of posts) {
        if (manifest[post.id]) continue; // already has audio - skip (idempotent)
        toProcess.push(post);
    }

    if (!toProcess.length) {
        console.log("No new Daily Briefs need audio.");
        return;
    }

    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "daily-brief-audio-"));
    const failures = [];
    try {
        // One post's failure shouldn't block the others in the same run -
        // matters most when catching up after a missed run finds several
        // posts at once (self-healing rolling window, see above).
        for (const post of toProcess) {
            try {
                await processPost(post, manifest, tmpDir);
            } catch (err) {
                console.error(`  FAILED "${post.title}": ${err.message}`);
                failures.push(post.title);
            }
        }
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }

    if (failures.length) {
        throw new Error(`${failures.length} post(s) failed: ${failures.join(", ")}`);
    }
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
