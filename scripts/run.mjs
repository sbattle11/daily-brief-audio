// Daily entry point. Run on a cron firing every 15 minutes, all day (not
// scoped to any particular UTC hour range) and self-gates on local time -
// see isTargetWindow() below - so "Eastern time, pinned year-round"
// survives the DST transition automatically with zero maintenance, instead
// of drifting an hour twice a year like a fixed-UTC cron window would.
//
// Target window is 4:45am-8am ET. Originally just a single hour (4am ET),
// then widened to 4am-8am ET 2026-08-24 after that single-hour window got
// silently skipped two mornings in a row (2026-08-23, 2026-08-24) - and
// even with that wider window and an hourly cron, the same silent-skip
// pattern recurred again on 2026-08-27 and 2026-08-28 (confirmed via the
// GitHub Actions API: zero runs attempted in the gap, not failed ones, and
// the workflow's own state/concurrency/quota were all checked and ruled
// out as a cause - this is GitHub's own scheduler dropping ticks, not
// something wrong in this repo). Fix this time: the cron itself now fires
// every 15 minutes all day (see the workflow YAML) instead of once an
// hour, so a dropped tick has 15-minute-wide neighbors to fall back on
// instead of hour-wide ones. The lower bound was moved from 4:00am to
// 4:45am (Daily Briefs actually publish around 4:40-4:41am ET, confirmed
// against real posts - no need to check before that) purely to skip
// pointless early no-op ticks; it does not affect reliability either way,
// since a run that finds nothing new just exits (the manifest already
// makes reprocessing idempotent).
import "dotenv/config";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { browsePosts, uploadAudio } from "./lib/ghost-admin.mjs";
import { chunkText } from "./lib/chunk-text.mjs";
import { synthesizeWithRetry } from "./lib/tts.mjs";
import { stitchAudio } from "./lib/stitch.mjs";
import { loadManifest, saveManifest, loadState, saveState } from "./lib/manifest.mjs";
import { loadChapters, saveChapters } from "./lib/chapters.mjs";
import { splitIntoArticles, articleHtmlToPlainText, stripByline, LEAD_IN_MARKER } from "./lib/html-to-text.mjs";
import { getAudioDuration } from "./lib/audio-duration.mjs";

// Fixed sound assets (added 2026-08-29, user request) - both pre-converted
// to Google TTS's own real output format (24kHz mono MP3, confirmed via a
// live sample) so they splice into the concat list in stitch.mjs cleanly
// via stream-copy, with no re-encoding step needed anywhere in the
// pipeline. See assets/ for the originals' provenance.
const TRANSITION_SOUND_PATH = path.join(import.meta.dirname, "..", "assets", "transition.mp3");
const OUTRO_SOUND_PATH = path.join(import.meta.dirname, "..", "assets", "outro.mp3");

// "EIR Daily Alert for <full date>" spoken intro (user request, 2026-08-29)
// - full month/day/year, not the site's own no-year kicker convention
// (user's explicit choice - this is a standalone spoken announcement, not
// a webpage UI label sitting next to other dated content). Uses the POST's
// own published_at, not "today" - the 48h rolling lookback window (see
// main() below) can process more than one post's edition in a single run,
// each potentially a different calendar date.
function formatIntroDate(publishedAtIso) {
    return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "long",
        day: "numeric",
        year: "numeric",
    }).format(new Date(publishedAtIso));
}

const TARGET_START_MINUTES_ET = 4 * 60 + 45; // 4:45am
const TARGET_END_MINUTES_ET = 8 * 60; // exclusive - so the window is 4:45am-7:59am ET

function isTargetWindow() {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === "hour").value);
    const minute = Number(parts.find((p) => p.type === "minute").value);
    const minutesInNY = hour * 60 + minute;
    return minutesInNY >= TARGET_START_MINUTES_ET && minutesInNY < TARGET_END_MINUTES_ET;
}

export async function processPost(post, manifest, chapters, state, tmpDir) {
    console.log(`Generating audio for "${post.title}" (${post.id})...`);

    const articles = splitIntoArticles(post.html || "");
    console.log(`  ${articles.length} article(s) found`);

    const allPaths = [];
    let fileIndex = 0;
    // Running total of everything appended so far, in seconds - lets each
    // article's start-time offset in the FINAL stitched file be recorded as
    // it's reached, instead of re-deriving it afterward from the finished
    // file (chapter-navigation feature, user request 2026-08-29: "next
    // article"/"previous article" buttons need real timestamps to jump to).
    // Measuring every piece as it's added (a TTS chunk or a fixed sound
    // asset) with the same getAudioDuration() rather than assuming a fixed
    // duration for the sound assets keeps this correct even if
    // transition.mp3/outro.mp3 are ever swapped for a different-length file.
    let elapsedSeconds = 0;
    async function addPath(filePath) {
        allPaths.push(filePath);
        elapsedSeconds += await getAudioDuration(filePath);
    }

    // Shared by the intro line and every article below - chunks arbitrary
    // text via the existing, unmodified chunkText()/synthesizeWithRetry()
    // and appends each resulting audio file to the single flat path list
    // stitchAudio() concatenates at the end. Keeping this one shared helper
    // (rather than a separate code path for the intro) means the intro line
    // gets exactly the same chunking/retry-on-failure safety net as any
    // other text, even though in practice it's always one short sentence.
    async function synthesizeToFiles(text) {
        const chunks = chunkText(text);
        for (const chunk of chunks) {
            // Usually one buffer per chunk; more than one only if
            // synthesizeWithRetry had to split this chunk further after
            // Google rejected it (see tts.mjs) - either way, each buffer
            // becomes its own numbered file in the correct left-to-right
            // order for stitching.
            const audioBuffers = await synthesizeWithRetry(chunk);
            for (const audio of audioBuffers) {
                const chunkPath = path.join(tmpDir, `chunk-${fileIndex}.mp3`);
                writeFileSync(chunkPath, audio);
                await addPath(chunkPath);
                fileIndex++;
            }
        }
    }

    // Intro: spoken date announcement. Carries LEAD_IN_MARKER itself now
    // (moved here from html-to-text.mjs's old whole-post htmlToPlainText -
    // the intro, not the first article, is the true start of the audio now,
    // so that's where the player-startup-clipping protection belongs).
    const introDate = formatIntroDate(post.published_at);
    await synthesizeToFiles(`${LEAD_IN_MARKER} EIR Daily Alert for ${introDate}.`);

    // Transition sound strictly BETWEEN articles (user request, 2026-08-29)
    // - never before the first or after the last, since the spoken intro
    // and the outro sound already bookend those. splitIntoArticles has
    // already stripped the "Contents" jump-link block and the plain-text
    // section-group headings ("In-Depth" etc.) before this point (see its
    // own doc comment in html-to-text.mjs), so `articles` here only ever
    // contains real per-article fragments - chapterSeconds below is safe to
    // treat as "one entry per real article" with nothing to skip.
    const chapterSeconds = [];
    for (let i = 0; i < articles.length; i++) {
        if (i > 0) await addPath(TRANSITION_SOUND_PATH);
        chapterSeconds.push(elapsedSeconds); // this article's own start time, before its audio is appended
        // Byline/dateline kept only on the lead article (i === 0); every
        // supporting article has it stripped (user request, 2026-09-01) -
        // repeating "by {author} — {date}" after every headline through a
        // whole brief was flagged as redundant. See stripByline's own doc
        // comment in html-to-text.mjs.
        const withoutByline = i === 0 ? articles[i] : stripByline(articles[i]);
        await synthesizeToFiles(articleHtmlToPlainText(withoutByline));
    }

    await addPath(OUTRO_SOUND_PATH);

    const stitchedPath = path.join(tmpDir, "stitched.mp3");
    await stitchAudio(allPaths, stitchedPath);

    const filename = `daily-brief-${post.slug}.mp3`;
    const url = await uploadAudio(stitchedPath, filename);
    console.log(`  uploaded: ${url}`);

    manifest[post.id] = url;
    saveManifest(manifest);
    // Kept in a separate file (chapters.json), never folded into
    // manifest.json - manifest.json is deliberately kept as a plain
    // {postId: url} map the theme reads directly as such (see manifest.mjs's
    // own doc comment), so adding a wholly new file for this is lower-risk
    // than changing that established, working contract: the theme's
    // existing manifest fetch/parse code needs zero changes either way, and
    // a post narrated before this feature shipped just has no entry here
    // (frontend treats that as "no chapters available", not an error).
    chapters[post.id] = chapterSeconds;
    saveChapters(chapters);
    state[post.id] = post.published_at;
    saveState(state);
}

async function main() {
    if (!isTargetWindow() && process.env.FORCE_RUN !== "1") {
        console.log(`Outside the target window (4:45am-8:00am America/New_York) - exiting. Set FORCE_RUN=1 to override for testing.`);
        return;
    }

    const manifest = loadManifest();
    const chapters = loadChapters();
    const state = loadState();

    // Rolling 48h lookback rather than "since last run" - matches the
    // eir-algolia-sync project's reasoning: GitHub Actions runners are
    // ephemeral, nothing persists between runs except what's committed
    // (the manifest/state files themselves), so a stateless window that's
    // self-healing on a missed run beats tracking a separate watermark.
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const posts = browsePosts({ filter: `tag:daily-brief+published_at:>'${since}'`, formats: "html", order: "published_at ASC" });

    const toProcess = [];
    for await (const post of posts) {
        // Keyed on published_at, not just post.id: EIR's publishing
        // workflow periodically edits an already-narrated post in place
        // into the next day's edition (title/content/published_at all
        // change, id doesn't) - confirmed happening repeatedly in
        // production. An id-only check would treat that post as already
        // done forever and silently narrate stale content, so a post whose
        // published_at has moved on since its last recorded run is treated
        // as new work.
        if (state[post.id] === post.published_at) continue; // already narrated for this exact edition - skip (idempotent)
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
                await processPost(post, manifest, chapters, state, tmpDir);
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
