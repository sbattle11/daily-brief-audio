// One-off smoke test for the risky platform-specific pieces of this
// pipeline (ffmpeg-static's bundled binary, Google API connectivity, Node
// module resolution) - specifically to verify they work on GitHub Actions'
// actual Ubuntu runners, since every previous test in this project ran on
// the developer's Windows machine and Linux was never exercised at all.
// Deliberately does NOT touch real Ghost content or upload anything -
// pure infrastructure check. Temporary: delete this file and its workflow
// once confirmed passing.
import "dotenv/config";
import { synthesizeChunk } from "./lib/tts.mjs";
import { stitchAudio } from "./lib/stitch.mjs";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";

async function main() {
    console.log("1/3: Calling Google TTS...");
    const audioA = await synthesizeChunk("This is a smoke test.");
    const audioB = await synthesizeChunk("Checking ffmpeg on Linux.");
    console.log(`  OK, got ${audioA.length} + ${audioB.length} bytes`);

    console.log("2/3: Stitching with ffmpeg-static...");
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "smoke-test-"));
    const pathA = path.join(tmpDir, "a.mp3");
    const pathB = path.join(tmpDir, "b.mp3");
    const stitchedPath = path.join(tmpDir, "stitched.mp3");
    writeFileSync(pathA, audioA);
    writeFileSync(pathB, audioB);
    await stitchAudio([pathA, pathB], stitchedPath);
    console.log("  OK, stitched successfully");

    console.log("3/3: Verifying output...");
    const fs = await import("fs");
    const stitchedSize = fs.statSync(stitchedPath).size;
    if (stitchedSize < audioA.length) throw new Error(`Stitched file (${stitchedSize} bytes) is smaller than a single input - stitching likely failed`);
    console.log(`  OK, stitched file is ${stitchedSize} bytes`);

    rmSync(tmpDir, { recursive: true, force: true });
    console.log("SMOKE TEST PASSED");
}

main().catch((err) => {
    console.error("SMOKE TEST FAILED:", err);
    process.exit(1);
});
