// Google Cloud Text-to-Speech REST API - one call per chunk from
// chunk-text.mjs (each already kept under the 5,000-byte per-request cap).
// Uses simple API-key auth (?key=...) rather than a service-account/OAuth
// flow - simplest option for a single server-side script like this.
// Confirmed live and working end-to-end against real production Ghost
// content, 2026-08-22.
const ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";

// Chirp3-HD: same 1M-character/month free allowance as Neural2, but a real
// quality step up (per Google's own docs, adds natural intonation/emotional
// range that Neural2/WaveNet don't) - confirmed GA (not allowlisted) and
// confirmed to support the plain synchronous text:synthesize call this
// script uses (not streaming-only). "Iapetus" (male) is the user's chosen
// voice, picked after listening to real generated samples of several
// Chirp3-HD options (see docs.cloud.google.com/text-to-speech/docs/
// list-voices-and-types for the full voice list, ~30 options).
const DEFAULT_VOICE = { languageCode: "en-US", name: "en-US-Chirp3-HD-Iapetus" };

// Extra pause at real paragraph breaks (user request) - not achievable via
// any plain-text trick (extra spaces/newlines aren't a documented or
// reliable way to control pause length), so this switches every request to
// SSML input specifically so the PARA_BREAK_MARKER token from
// html-to-text.mjs can become a real <break> tag with a precise duration.
// 750ms was picked as a clearly-longer-than-a-sentence pause without
// dragging the piece; easy to retune once heard for real.
import { PARA_BREAK_MARKER, EMPHASIS_START, EMPHASIS_END, LEAD_IN_MARKER } from "./html-to-text.mjs";
const PARAGRAPH_BREAK_MS = 750;

// Lead-in pause before the very first word of a Daily Brief (user request,
// 2026-08-26 - a player's own startup/buffering can clip the first
// fraction of a second, heard as the first word being slightly cut off).
// 500ms was the user's own suggested "half a second or so"; easy to retune.
const LEAD_IN_MS = 500;

// Emphasis via a slight slowdown, no pitch shift - the ONLY one of several
// SSML approaches the user confirmed actually sounded like real emphasis on
// this voice (2026-08-22): a dedicated <emphasis level="strong"> tag and a
// pitch-shifting <prosody pitch="+3st"> both sounded odd; <prosody rate>
// alone, tested on multiple real words in full sentences ("talk", "did",
// "real"), sounded natural. 80% was the tested value; easy to retune.
const EMPHASIS_RATE = "80%";

function escapeXml(str) {
    // Only & < > matter for SSML well-formedness - the markers themselves
    // contain none of these, so escaping first and inserting the real
    // tags after is always safe (never double-escapes them).
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toSsml(text) {
    const escaped = escapeXml(text);
    const withLeadIn = escaped.split(LEAD_IN_MARKER).join(`<break time="${LEAD_IN_MS}ms"/>`);
    const withBreaks = withLeadIn.split(PARA_BREAK_MARKER).join(`<break time="${PARAGRAPH_BREAK_MS}ms"/>`);
    const withEmphasis = withBreaks
        .split(EMPHASIS_START).join(`<prosody rate="${EMPHASIS_RATE}">`)
        .split(EMPHASIS_END).join("</prosody>");
    return `<speak>${withEmphasis}</speak>`;
}

export async function synthesizeChunk(text) {
    const res = await fetch(`${ENDPOINT}?key=${process.env.GOOGLE_TTS_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            input: { ssml: toSsml(text) },
            voice: DEFAULT_VOICE,
            audioConfig: { audioEncoding: "MP3", speakingRate: 1.0 },
        }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Google TTS ${res.status}: ${JSON.stringify(body)}`);
    return Buffer.from(body.audioContent, "base64");
}

// Google enforces an undocumented per-sentence limit distinct from the
// 5,000-byte request cap chunk-text.mjs already handles - confirmed live to
// be triggered by something about Google's OWN sentence/quote-boundary
// parsing across a whole request, not any single sentence's raw length
// (two different real Daily Brief passages each failed within their full
// chunk despite succeeding fine in isolation - one was a stray table-of-
// contents block, since fixed at the source in html-to-text.mjs; the other
// was a ~190-char quoted sentence that only failed alongside later text in
// the same request, most likely a quote-nesting/pairing confusion spanning
// further than expected). Chasing every such trigger with more up-front
// text analysis isn't tractable - Google's parser isn't documented and
// this is now the second distinct cause found by live testing alone.
// Instead, this makes the pipeline self-healing: on exactly this error,
// split the offending chunk at its nearest sentence boundary to the
// midpoint and retry each half independently (recursively, if a half still
// fails) - turns an unpredictable parsing edge case into a bounded retry
// rather than a hand-tuned rule for each new case as it's discovered.
const SENTENCE_TOO_LONG = /sentences that are too long/i;
const MAX_SPLIT_DEPTH = 4; // up to 16 pieces - far more than any real brief should ever need

function splitNearMidpoint(text) {
    const mid = Math.floor(text.length / 2);
    // Prefer a real sentence boundary (period/!/? + whitespace) nearest the
    // midpoint, searching outward in both directions so a split lands as
    // close to the middle (and as grammatically clean) as possible.
    for (let offset = 0; offset < text.length / 2; offset++) {
        for (const pos of [mid + offset, mid - offset]) {
            if (pos > 0 && pos < text.length && /[.!?]\s/.test(text.slice(pos - 1, pos + 1))) {
                return pos + 1;
            }
        }
    }
    // No sentence boundary anywhere - fall back to the nearest whitespace to the midpoint.
    for (let offset = 0; offset < text.length / 2; offset++) {
        for (const pos of [mid + offset, mid - offset]) {
            if (text[pos] === " ") return pos + 1;
        }
    }
    return -1; // one unbroken run with no whitespace at all - can't split further
}

function ensureTerminated(piece) {
    // Replaces (not appends to) any trailing comma/semicolon/colon/dash -
    // same fix as terminated() in chunk-text.mjs, same reason: appending
    // instead of replacing produced double punctuation like "...has,."
    if (/[.!?]\s*$/.test(piece)) return piece;
    return piece.trimEnd().replace(/[,;:—–]+$/, "") + ".";
}

export async function synthesizeWithRetry(text, depth = 0) {
    try {
        return [await synthesizeChunk(text)];
    } catch (err) {
        if (!SENTENCE_TOO_LONG.test(err.message) || depth >= MAX_SPLIT_DEPTH) throw err;

        const splitAt = splitNearMidpoint(text);
        if (splitAt === -1) throw err; // nothing left to split on - surface the real error

        const left = ensureTerminated(text.slice(0, splitAt).trim());
        const right = text.slice(splitAt).trim();
        const leftAudio = await synthesizeWithRetry(left, depth + 1);
        const rightAudio = await synthesizeWithRetry(right, depth + 1);
        return [...leftAudio, ...rightAudio];
    }
}
