import { PARA_BREAK_MARKER } from "./html-to-text.mjs";

// Splits article text into pieces small enough for one Google TTS request.
// Two SEPARATE limits are enforced here, confirmed as genuinely distinct via
// a live failure: an overall 5,000-BYTE cap per request (documented -
// https://docs.cloud.google.com/text-to-speech/quotas), AND a much smaller,
// UNDOCUMENTED per-sentence length limit Google enforces on its own internal
// sentence-boundary parsing within a request - hit live on real Daily Brief
// content (a long quoted passage using only commas/ellipses, no internal
// period, well under the 4500-byte chunk cap but still rejected: "This
// request contains sentences that are too long"). Google Developer forum
// reports place failures as low as ~360 chars even on Neural2
// (discuss.google.dev/t/this-request-contains-sentences-that-are-too-long-
// consider-splitting-up-long-sentences/130332) - MAX_SENTENCE_CHARS is set
// well under that with margin, since Chirp3-HD's actual threshold isn't
// published anywhere either.
const MAX_CHUNK_BYTES = 4500; // safety margin under Google's 5000-byte-per-request cap
// Raised from 250 to 340, 2026-08-25: a real live Daily Brief sentence at
// 312 chars (a long quoted rhetorical passage, several clauses joined by
// commas, no internal period) was getting force-split here even though
// Google's own synthesis accepted it fine at full length elsewhere - the
// proactive split converted its commas into hard periods via terminated()
// below, turning one flowing sentence into five short choppy fragments in a
// row ("...from every point of the earth. from innocent children to the
// aged. from individuals to communities. rises toward Heaven."), and that
// unnatural staccato rhythm is the most likely trigger for a real narration
// bug: the voice repeated a phrase and inserted a garbled word right at one
// of those forced boundaries (caught by the user listening, 2026-08-25).
// 340 clears that specific 312-char sentence while staying under the
// forum-reported ~360-char failure floor. This value only controls
// PROACTIVE splitting, done blind before ever calling Google - the REACTIVE
// synthesizeWithRetry() in tts.mjs (splitting only after an actual
// rejection) is the real safety net for genuinely-too-long sentences, and
// doesn't risk this failure mode since it only ever runs when Google has
// already said no.
const MAX_SENTENCE_CHARS = 340;

function byteLength(str) {
    return Buffer.byteLength(str, "utf8");
}

// CRITICAL: this file previously used `text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g)`
// to split on sentence boundaries - a real, severe bug, confirmed live: 31%
// of a real Daily Brief's text (8,305 of 26,885 chars) was silently
// dropped, audible as large skipped passages and garbled fragments
// ("S. K." spliced together from unrelated text). Root cause: JS's
// String.match with the global flag, when a pattern fails to match at the
// current search position, just ADVANCES THE SEARCH POSITION AND KEEPS
// GOING - any span the pattern can't match anywhere gets silently omitted
// from the result, with no error, no signal, nothing. Any period NOT
// followed by whitespace (any abbreviation - "U.K.", "Aug.", a decimal
// number) could make the pattern fail across a huge stretch of an
// otherwise-normal paragraph, especially in content this quote-and-
// attribution-heavy. A regex-based tiling approach can only be made safe
// here by manually proving every character is accounted for - which is
// exactly what a hand-written scanner guarantees by construction, so both
// splitters below are manual index-walks, not regex .match() calls.
//
// splitOnBoundary(text, isBoundaryChar) walks every character exactly
// once, always in order, and flushes a piece only at a real boundary (the
// boundary character followed by whitespace or end-of-string - so "U.K."
// is never mistaken for two sentences, same intent as the old regex, but
// this version cannot skip anything: every character between `start` and
// `text.length` ends up in exactly one returned piece, always.
function splitOnBoundary(text, isBoundaryChar) {
    const pieces = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (!isBoundaryChar(text[i])) continue;
        const next = text[i + 1];
        if (next !== undefined && !/\s/.test(next)) continue; // e.g. the "." in "U.K." - not a real boundary
        pieces.push(text.slice(start, i + 1));
        start = i + 1;
    }
    if (start < text.length) pieces.push(text.slice(start));
    return pieces;
}

const isSentenceEnd = (ch) => ch === "." || ch === "!" || ch === "?";

// Ensures a piece ends with real terminal punctuation. Critical, not
// cosmetic: pieces get concatenated with plain whitespace when packed into
// request chunks below, so if a forced split point has no terminal
// punctuation of its own, Google's OWN sentence-boundary detection would
// just see straight through the split and reconstruct the exact same
// over-length run it was rejecting in the first place - confirmed this is
// what happened on the first attempt at this fix (tracking pieces
// internally without punctuating them left a 516-char unpunctuated run
// after reassembly, still over the limit). Any trailing comma/semicolon/
// colon/dash is REPLACED (not appended to) - confirmed live a second real
// bug from appending instead: a clause ending "...has," became "...has,."
// (double punctuation) rather than the intended "...has." - inserting a
// period at each forced split makes the boundary real in the text Google
// actually receives, not just in this function's own bookkeeping, at the
// minor cost of a synthetic pause in the audio at that exact point, which
// only happens on the rare over-length-sentence edge case to begin with.
function terminated(piece) {
    if (/[.!?]\s*$/.test(piece)) return piece;
    return piece.trimEnd().replace(/[,;:—–]+$/, "") + ".";
}

// Priority order for a forced split point inside one over-length sentence,
// strongest (most natural-sounding) pause first: semicolon, then a real
// paragraph break (if the marker happens to fall inside this run-on
// "sentence" - rare, but a stronger, more natural boundary than mere
// punctuation), then colon, then comma/dash last. Fixed 2026-08-25 after a
// real narration bug (caught by the user listening): the previous version
// split at EVERY comma in the whole sentence unconditionally, however many
// that produced - a single 312-char sentence with 4 commas became 5 short,
// choppy fragments in a row (each converted to a hard period by
// terminated() below), and that unnatural staccato rhythm is the likely
// trigger for the voice repeating a phrase and inserting a garbled word at
// one of those forced boundaries. Checked one tier at a time (see
// findBestSplitPoint), stopping at the first tier that has ANY match,
// rather than fragmenting on the weakest available type everywhere it
// occurs. Each entry returns the match length at `pos` (0/falsy for no
// match), so the paragraph-break marker (a multi-character literal) and
// single-character punctuation share exactly the same search.
const SPLIT_BOUNDARY_TIERS = [
    (text, pos) => (text[pos] === ";" ? 1 : 0),
    (text, pos) => (text.startsWith(PARA_BREAK_MARKER, pos) ? PARA_BREAK_MARKER.length : 0),
    (text, pos) => (text[pos] === ":" ? 1 : 0),
    (text, pos) => {
        const ch = text[pos];
        if (ch !== "," && ch !== "—" && ch !== "–") return 0;
        const next = text[pos + 1];
        if (next !== undefined && !/\s/.test(next)) return 0; // e.g. "3,500" - not a real boundary
        return 1;
    },
];

// Finds the occurrence of a candidate boundary nearest the middle of `text`,
// among positions where `matchLengthAt(text, pos)` reports a real match
// (returning the match's length, or 0/falsy for no match at that position) -
// shared by every tier in SPLIT_BOUNDARY_TIERS so all of them use the same
// "balanced halves, not a lopsided fragment" search. CRITICAL: only accepts
// a candidate that leaves BOTH sides non-empty (0 < split < text.length) - a
// candidate sitting at the very start or very end of `text` would make
// `left` (or `right`) IDENTICAL to `text` itself, and since the caller
// recurses on both halves, that non-decreasing input previously caused
// genuine infinite recursion (a real crash, hit live on real Daily Brief
// content, 2026-08-25: a paragraph-break marker landed at the tail end of an
// over-length "sentence," so splitting there produced an unchanged `left`
// and an empty `right` - forever). Rejecting any non-progressing candidate
// here, at the search level, guarantees every accepted split makes the
// recursion's input strictly shorter, so it must terminate.
function nearestMatch(text, matchLengthAt) {
    const mid = Math.floor(text.length / 2);
    for (let offset = 0; offset <= text.length; offset++) {
        for (const pos of [mid + offset, mid - offset]) {
            if (pos < 0 || pos >= text.length) continue;
            const len = matchLengthAt(text, pos);
            if (!len) continue;
            const splitAt = pos + len;
            if (splitAt <= 0 || splitAt >= text.length) continue; // would not shrink either side - reject, keep searching
            return splitAt;
        }
    }
    return -1;
}

// Finds ONE split point (the index to slice after) for `text`, checking
// SPLIT_BOUNDARY_TIERS in priority order and, within the winning tier, the
// occurrence nearest the middle - so a genuinely long sentence gets cut into
// two roughly balanced halves rather than a lopsided fragment. Returns -1 if
// nothing at all is usable, so the caller can fall back to a hard
// word-boundary split.
function findBestSplitPoint(text) {
    for (const matchLengthAt of SPLIT_BOUNDARY_TIERS) {
        const split = nearestMatch(text, matchLengthAt);
        if (split !== -1) return split;
    }
    return -1;
}

// Hard word-boundary split - last resort, only reached when a sentence has
// no semicolon, colon, comma, dash, OR paragraph break anywhere to split on
// at all (effectively never, in real prose).
function splitOnWordBoundary(sentence) {
    const words = sentence.split(/\s+/);
    const pieces = [];
    let current = "";
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= MAX_SENTENCE_CHARS) {
            current = candidate;
        } else {
            if (current) pieces.push(terminated(current));
            current = word;
        }
    }
    if (current) pieces.push(terminated(current));
    return pieces;
}

// Breaks one over-length "sentence" (as found by the primary . ! ? split)
// into pieces Google won't reject. Recursive and minimal: makes exactly ONE
// split at the single best available point (see findBestSplitPoint), then
// only recurses into a half if THAT half is still too long - so a sentence
// that only needs one cut gets exactly one, instead of fragmenting at every
// occurrence of the weakest boundary type up front. terminated() is safe to
// call unconditionally here (it's a no-op on text that already ends in real
// .!? punctuation), so the base case doesn't need to track separately
// whether a given piece came from a forced cut or was already a complete,
// properly-punctuated sentence.
// Belt-and-suspenders depth cap, on top of nearestMatch() already rejecting
// any non-progressing split: 8 levels allows up to 256 pieces, far more than
// any real sentence should ever need, so hitting this at all would mean
// some future edge case neither safeguard anticipated - falling back to the
// word-boundary splitter (which cannot recurse, so cannot loop) rather than
// crashing the whole run over one unusual sentence.
const MAX_SPLIT_DEPTH = 8;

function splitLongSentence(sentence, depth = 0) {
    if (sentence.length <= MAX_SENTENCE_CHARS) return [terminated(sentence)];
    if (depth >= MAX_SPLIT_DEPTH) return splitOnWordBoundary(sentence);

    const splitAt = findBestSplitPoint(sentence);
    if (splitAt === -1) return splitOnWordBoundary(sentence);

    // Deliberately NOT trimmed: chunkText() below packs returned pieces back
    // together with plain concatenation (no separator of its own), relying
    // on each piece already carrying its own natural leading/trailing
    // whitespace from the original text - trimming here previously stripped
    // that and produced runs like "purpose.it contains" with no space at
    // the seam (caught by testing this fix before shipping it).
    const left = sentence.slice(0, splitAt);
    const right = sentence.slice(splitAt);
    return [...splitLongSentence(left, depth + 1), ...splitLongSentence(right, depth + 1)];
}

export function chunkText(text) {
    const rawSentences = splitOnBoundary(text, isSentenceEnd);
    // Every unit past this point is guaranteed <= MAX_SENTENCE_CHARS, so the
    // per-sentence failure mode can't recur regardless of how they get
    // packed into byte-sized request chunks below.
    const units = rawSentences.flatMap(splitLongSentence);

    const chunks = [];
    let current = "";
    for (const unit of units) {
        const candidate = current + unit;
        if (byteLength(candidate) <= MAX_CHUNK_BYTES) {
            current = candidate;
        } else {
            if (current.trim()) chunks.push(current.trim());
            current = unit;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}
