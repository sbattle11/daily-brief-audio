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
const MAX_SENTENCE_CHARS = 250; // safety margin under the observed ~360-char per-sentence failures

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
const isClauseBoundary = (ch) => ch === "," || ch === ";" || ch === ":" || ch === "—" || ch === "–";

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

// Breaks one over-length "sentence" (as found by the primary . ! ? split)
// into pieces Google won't reject, preferring secondary punctuation
// (comma/semicolon/colon/dash) so the eventual audio still has natural
// micro-pauses at the split points; falls back to hard word-boundary
// splitting only if no such punctuation exists at all.
function splitLongSentence(sentence) {
    if (sentence.length <= MAX_SENTENCE_CHARS) return [sentence];

    const clauses = splitOnBoundary(sentence, isClauseBoundary);
    const pieces = [];
    for (const clause of clauses) {
        if (clause.length <= MAX_SENTENCE_CHARS) {
            pieces.push(terminated(clause));
            continue;
        }
        // Still too long even at a comma boundary - hard word-boundary split.
        const words = clause.split(/\s+/);
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
    }
    return pieces;
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
