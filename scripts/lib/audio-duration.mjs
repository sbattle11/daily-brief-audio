// Measures a local audio file's duration in seconds, using the same bundled
// ffmpeg-static binary already relied on elsewhere in this project (stitch.mjs)
// rather than adding a new ffprobe-static dependency for one small helper.
// ffmpeg always prints "Duration: HH:MM:SS.ss" to stderr for any input file
// even when (as here) no real output is requested - "-f null -" just
// discards the decoded output, so this never writes a temp file of its own.
//
// Used by run.mjs to compute each article's start-time offset within the
// final stitched Daily Alert audio (chapter-navigation feature, user
// request 2026-08-29), by measuring every piece (TTS chunk or fixed sound
// asset) as it's appended and keeping a running total - see
// processPost()/addPath() in run.mjs.
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

const DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/;

export async function getAudioDuration(filePath) {
    const stderr = await new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, ["-i", filePath, "-f", "null", "-"]);
        let out = "";
        proc.stderr.on("data", (d) => { out += d; });
        proc.on("error", reject);
        proc.on("close", () => resolve(out)); // ffmpeg exits non-zero for "-f null -" with no real output written - that's expected, not a failure; only the printed Duration line matters
    });

    const match = stderr.match(DURATION_RE);
    if (!match) {
        throw new Error(`Could not determine duration of ${filePath}: ${stderr.slice(-300)}`);
    }
    const [, hours, minutes, seconds] = match;
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}
