// Concatenates several MP3 chunk files (one per chunkText() piece, each
// synthesized separately by Google TTS) into one continuous file. Uses
// ffmpeg's stream copy (no re-encode - all chunks come from the same
// Google TTS call with identical output settings, so their frames are
// compatible) via the concat demuxer, which avoids the click/glitch risk of
// naive byte-concatenation at chunk boundaries. ffmpeg-static bundles a
// real binary so this runs identically on a local Windows dev machine and
// on GitHub Actions' Linux runners - no separate system install needed.
import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import ffmpegPath from "ffmpeg-static";

export async function stitchAudio(chunkPaths, outputPath) {
    if (chunkPaths.length === 1) {
        writeFileSync(outputPath, await import("fs").then((fs) => fs.readFileSync(chunkPaths[0])));
        return;
    }

    const listPath = path.join(path.dirname(outputPath), `concat-list-${Date.now()}.txt`);
    // Absolute paths only - ffmpeg's concat demuxer resolves relative paths
    // in the list file against the list file's OWN directory, not the
    // process cwd, so a relative path here would silently double up with
    // that directory (confirmed empirically: "data\data/chunk0.mp3").
    const listContent = chunkPaths
        .map((p) => path.resolve(p).replace(/\\/g, "/"))
        .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
        .join("\n");
    writeFileSync(listPath, listContent);

    await new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, [
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", listPath,
            "-c", "copy",
            outputPath,
        ]);
        let stderr = "";
        proc.stderr.on("data", (d) => { stderr += d; });
        proc.on("close", (code) => {
            unlinkSync(listPath);
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
        });
    });
}
