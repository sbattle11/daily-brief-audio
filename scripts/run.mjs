// Daily entry point. Run on an HOURLY GitHub Actions cron (not a single
// once-a-day cron) and self-gates on local time - see isTargetHour() below
// - so "Eastern time, pinned year-round" survives the DST transition
// automatically with zero maintenance, instead of drifting an hour twice a
// year like a fixed-UTC cron would.
//
// Target window is 4am-8am ET, not a single hour - widened 2026-08-24
// after a single-hour window (just 4am ET) got silently skipped two
// mornings in a row: GitHub Actions' scheduling jitter on cron triggers is
// large enough (observed hopping from 07:47 UTC straight to 09:01 UTC, and
// separately from 05:56 UTC straight to 09:29 UTC) that it can jump clean
// over a single target hour, and since every run outside the window exits
// immediately with no work done, that meant NO run that day ever attempted
// to process the new brief at all. Daily Briefs actually publish around
// 4:40-4:41am ET (confirmed against real posts), so a multi-hour window
// starting there costs nothing extra (the manifest already makes
// reprocessing idempotent - a run that finds nothing new just exits) while
// making it overwhelmingly likely at least one run lands inside the
// window regardless of jitter.
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

const TARGET_HOUR_START_ET = 4;
const TARGET_HOUR_END_ET = 7; // inclusive - so the window is 4:00am-7:59am ET

function isTargetHour() {
    const hourInNY = Number(
        new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date())
    );
    return hourInNY >= TARGET_HOUR_START_ET && hourInNY <= TARGET_HOUR_END_ET;
}

export async function processPost(post, manifest, tmpDir) {
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
        console.log(`Outside the target window (${TARGET_HOUR_START_ET}am-${TARGET_HOUR_END_ET + 1}am America/New_York) - exiting. Set FORCE_RUN=1 to override for testing.`);
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

// Only auto-run when this file is executed directly (the normal scheduled
// job) - NOT when another script imports processPost() from it (see
// reprocess-post.mjs), which would otherwise also trigger this module's own
// main() as an unrelated side effect of the import alone (harmless here
// since it just logs its target-window gate message and returns, but
// confusing output for a script that isn't running the scheduled job).
// pathToFileURL (not manual string-building) handles Windows drive-letter
// paths correctly - confirmed live that a hand-built "file://" + argv[1]
// string does NOT match import.meta.url on Windows (missing the extra
// slash before the drive letter), which silently broke this guard entirely
// on the first attempt.
import { pathToFileURL } from "url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error("FATAL:", err);
        process.exit(1);
    });
}
