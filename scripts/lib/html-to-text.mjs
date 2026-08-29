// Converts a Daily Brief's Ghost HTML body into plain narration text.
// Shared by run.mjs and test-connection.mjs (was duplicated in both before -
// factored out once it grew a real preprocessing step, see below).

// Placeholder inserted at every real paragraph break, converted into an
// actual SSML <break> tag by tts.mjs at the point of building the API
// request (kept as a plain marker here, not real SSML, since this text
// still goes through chunk-text.mjs's plain-text splitting logic - see
// tts.mjs for why the marker is safe to carry through that unmodified).
// Exported so tts.mjs uses the exact same literal, not a duplicated guess.
export const PARA_BREAK_MARKER = "[[PARABREAK]]";

// Same pattern as PARA_BREAK_MARKER, for a single emphasized word - tts.mjs
// converts the wrapped span into a real SSML <prosody rate="80%"> tag (a
// slight slowdown, no pitch shift - confirmed by the user as the only one
// of several SSML approaches that actually sounded like real emphasis on
// this voice; a pitch-based <prosody> and the dedicated <emphasis> tag both
// sounded odd). See markEmphasis() below for which <em> spans qualify.
export const EMPHASIS_START = "[[EMPHSTART]]";
export const EMPHASIS_END = "[[EMPHEND]]";

// Same pattern again, for a single fixed-duration pause at the very start
// of the whole audio, before the first word (user request, 2026-08-26): a
// player's own startup/buffering can clip the first fraction of a second of
// audio, which reads as the first word getting slightly cut off - a real
// lead-in pause protects against that regardless of whether the cause is
// the audio itself or a specific player's startup behavior. Placed at the
// very front of the text in htmlToPlainText below (always ends up as the
// first characters of chunk 0, so tts.mjs only ever needs to look for it
// once per post, not per chunk).
export const LEAD_IN_MARKER = "[[LEADIN]]";

export function htmlToPlainText(html) {
    const withoutToc = stripTableOfContents(html || "");
    const withoutLeadLabel = stripLeadLabel(withoutToc);
    const withoutHeadings = stripSectionHeadings(withoutLeadLabel);
    const withHeadlineBreaks = markHeadlineByline(withoutHeadings);
    const withEmphasisMarked = markEmphasis(withHeadlineBreaks);
    // Paragraph-break marker inserted on the RAW HTML, targeting </p>
    // specifically, before the generic tag-stripper below turns every tag
    // (this one included) into an undifferentiated single space - that's
    // exactly the information this marker exists to preserve. Also ensures
    // every paragraph ends in real terminal punctuation first - see
    // ensureParagraphPunctuation() below.
    const withParaMarkers = ensureParagraphPunctuation(withEmphasisMarked).replace(/<\/p>/gi, ` ${PARA_BREAK_MARKER} `);
    const plain = withParaMarkers
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/[↓↑→←]/g, " ") // jump-link arrow glyphs (see stripTableOfContents) - pure UI, never real narration content even outside the TOC block itself
        .replace(/\(EIRNS\)/g, "") // wire-service byline marker ("by Jason Ross (EIRNS) — Aug. 21, 2026") - confirmed present in every byline across every Daily Brief checked, an editorial/production artifact with no narration value, not part of the actual sentence
        // Speaks direct quotes aloud as "quote ..." - TTS otherwise gives a
        // listener no audible signal that a quotation has started. "quote"
        // only, NO "unquote" at the close (user's explicit decision,
        // 2026-08-22, after comparing both ways on real short and long
        // quotes) - betting on the voice's own intonation/delivery shift
        // during the quoted material to signal the end, rather than a
        // second spoken marker. No comma after "quote" itself either (no
        // pause between the word and the quoted text starting).
        // DOUBLE curly quotes only (“ ”), not single (‘ ’), get the spoken
        // "quote" cue: confirmed by counting real usage across 5 real Daily
        // Briefs that ’ is overwhelmingly the possessive/contraction
        // apostrophe ("LaRouche's"), not a closing quote mark (255 total ’
        // characters, only ~21 were real paired single-quotes) - so ’ alone
        // isn't a reliable anchor for anything.
        .replace(/“/g, "quote “")
        // Single-quoted scare-quote phrases ('stabilization forces',
        // 'Emergency Declaration') get an unwanted, distracting emphasis
        // from Google's own TTS engine when the wrapping quote marks are
        // left in (user-flagged, 2026-08-29) - strip just the two wrapping
        // marks, leaving the phrase itself untouched. Safe and reliable
        // here even though ’ alone is ambiguous (see above): the OPENING
        // mark ‘ is never used as an apostrophe in real content (confirmed
        // across the same 5 Daily Briefs - only ever opens a quoted
        // phrase), so anchoring on a real ‘...’ pair and only removing
        // those two characters can't touch an apostrophe/possessive
        // anywhere, including one that happens to sit inside the quoted
        // phrase itself (e.g. ‘the people’s voice’ keeps its own
        // apostrophe - only the outer wrapping marks are removed).
        .replace(/‘([^‘’]*)’/g, "$1")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&[a-z#0-9]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    return `${LEAD_IN_MARKER} ${plain}`;
}

// Ensures every <p> ends in real terminal punctuation before its paragraph
// break, inserting a period if it doesn't already have one (user-flagged,
// 2026-08-27): a recurring feature article ("Next EIR: ...") previews the
// upcoming print issue's contents as a run of bare, unpunctuated <p> lines
// ("Section 1. International", "International Peace Coalition, Week 168:
// Who Is Pushing for Nuclear War?, by Steve Carr", etc.) - real,
// meaningful content (not the auto-generated jump-link "Contents" block
// stripTableOfContents already removes), but each line reads as an
// incomplete fragment without a period, especially the short "Section N."
// labels. Applied to EVERY paragraph, not just short ones - a paragraph
// that already sounds fine isn't hurt by a trailing period, and a blanket
// rule is simpler and more robust than guessing a length threshold for
// which lines "need" one.
//
// Hand-written scan-then-build, not a single regex .replace() - this
// codebase has a documented history of regex text-boundary bugs (see the
// chunk-text.mjs flatMap/.match() bugs elsewhere in this project). A plain
// `.replace(/<\/p>/, callback)` can't correctly do this: the callback can
// only rewrite the matched "</p>" itself, so trying to re-emit earlier
// content (to place a period BEFORE a trailing closing tag like </em>)
// ends up DUPLICATING that tag instead of moving the period before it -
// confirmed by testing a real byline case before shipping this version.
// Scanning first (recording where each period needs to go) then building
// the final string in one left-to-right pass avoids that entirely.
//
// The backward walk from each </p> needs to correctly see PAST trailing
// inline closing tags (a byline paragraph ending "<em>...2026</em></p>"
// must be checked against "2026", not the "</em>" tag) and past trailing
// closing quotes/parens (a paragraph ending ...War?"</p> is already
// terminated by the "?" underneath the closing curly quote, and should
// NOT get a second period after it).
function ensureParagraphPunctuation(html) {
    const insertPositions = [];
    const closeTagRe = /<\/p>/gi;
    let m;
    while ((m = closeTagRe.exec(html))) {
        const offset = m.index;
        let i = offset - 1;
        while (i >= 0) {
            if (/\s/.test(html[i])) {
                i--;
                continue;
            }
            if (html[i] === ">") {
                const tagStart = html.lastIndexOf("<", i);
                if (tagStart === -1) break;
                const tag = html.slice(tagStart, i + 1);
                if (/^<\/[a-z]/i.test(tag)) {
                    // A closing inline tag (</em>, </a>, ...) - hop past it
                    // to check the real text it wraps, not the tag itself.
                    i = tagStart - 1;
                    continue;
                }
                break; // an opening/self-closing tag right before </p> - nothing to punctuate
            }
            break;
        }
        if (i < 0) continue; // empty paragraph, nothing to punctuate

        let j = i;
        while (j >= 0 && /["'”’)\]]/.test(html[j])) j--;
        const alreadyTerminated = j >= 0 && /[.!?…]/.test(html[j]);
        if (!alreadyTerminated) insertPositions.push(i + 1);
    }

    if (insertPositions.length === 0) return html;

    let result = "";
    let last = 0;
    for (const pos of insertPositions) {
        result += html.slice(last, pos) + ".";
        last = pos;
    }
    result += html.slice(last);
    return result;
}

// Marks <em> spans worth speaking with real emphasis. Real usage of <em> in
// this content is heavily mixed and MOSTLY NOT genuine verbal emphasis -
// counted across 30 real Daily Briefs: ~40-60% is byline styling ("by
// Dennis Small (EIRNS)..."), and most of the rest is publication/proper-
// noun italics (Global Times, The Washington Post, ship names like
// Benfold) - a print-style convention, not something a listener wants
// stressed. Emphasizing every <em> would mean constantly emphasizing
// newspaper names throughout every brief.
//
// Heuristic, validated empirically before building this (2026-08-22): a
// SINGLE-WORD <em> span starting with a LOWERCASE letter. Checked real
// usage across 30 briefs - every single uppercase-starting single word
// (87 samples: FT, Economist, Post, Lincoln, Izvestia, etc.) was a proper
// noun, zero exceptions; lowercase-starting single words were mostly
// genuine emphasis (talk, all, did, is, real, everywhere) with a minority
// of foreign/loan words also conventionally italicized (hansei, brecha)
// that would be mis-emphasized - an acceptable, mild failure mode
// (~75-80% correct) compared to the alternative of emphasizing proper
// nouns constantly. No whitespace inside the span = "single word" (a
// trailing comma/semicolon like "other," still counts as a lowercase
// single word - the punctuation isn't spoken, so including it in the
// slowed-down span makes no audible difference).
//
// Articles excluded, 2026-08-27: a real user-flagged case ("...if not
// *the* headquarters...") sounded fake/glitchy - confirmed by generating
// and listening to 5+ real SSML alternatives (rate slowdown - the
// existing approach, pitch shift alone, volume boost alone, SSML
// <emphasis> at both strong and moderate levels) against the real
// sentence AND the full real paragraph for context - none sounded like
// genuine emphasis on an article specifically. Linguistically this tracks:
// real spoken emphasis on "the"/"a"/"an" is rare and subtle (mostly via
// pitch, not the duration-based effect used here), unlike content words
// (talk, did, real - all confirmed working by ear already), so articles
// are excluded outright rather than continuing to chase an SSML treatment
// for them.
const ARTICLES = new Set(["the", "a", "an"]);
function markEmphasis(html) {
    return html.replace(/<em>([^<]*)<\/em>/gi, (match, inner) => {
        const trimmed = inner.trim();
        const isSingleWord = trimmed.length > 0 && !/\s/.test(trimmed);
        const startsLowercase = /^[a-z]/.test(trimmed);
        const isArticle = ARTICLES.has(trimmed.toLowerCase().replace(/[^a-z]/g, ""));
        if (!isSingleWord || !startsLowercase || isArticle) return match; // leave as plain <em> - generic tag-stripper handles it normally, word stays but unemphasized
        return `${EMPHASIS_START}${trimmed}${EMPHASIS_END}`;
    });
}

// "The Lead" is a standalone label heading Ghost always inserts directly
// before the top story's own headline (confirmed identical -
// <h3 id="the-lead">The Lead</h3> - across every Daily Brief checked, same
// verification approach as stripTableOfContents below). Removed entirely
// as its own element; the real headline that immediately follows it is
// untouched and still narrated normally.
function stripLeadLabel(html) {
    return html.replace(/<h3[^>]*id=["']the-lead["'][^>]*>.*?<\/h3>/i, "");
}

// Section-group subheadings ("Strategic War Danger", "New World Paradigm",
// "Collapsing Imperial System", etc. - the same category set used
// elsewhere for site tagging) - Ghost renders these as plain-text <h2>
// elements between groups of articles.
//
// REAL BUG, caught by the user listening (2026-08-22): the first version of
// this function stripped EVERY remaining <h2>, which also silently ate the
// Daily Brief's own lead-article headline - it's ALSO an <h2>
// (`<h2 id="the-anteroom-of-nuclear-war"><a href="...">The Anteroom of
// Nuclear War</a></h2>`), immediately after the (already-stripped)
// "The Lead" h3 label. That's why both regenerated briefs started cold on
// "by Dennis Small..." with no title ever spoken.
//
// Fix: the real distinguishing feature isn't the tag name, it's whether the
// h2 CONTAINS A LINK. A real headline is always wrapped in an <a href> (it
// links to the article's own permalink); a section-group label is always
// plain text with no link inside. Confirmed structurally reliable across 5
// real Daily Briefs: every post had exactly one link-wrapped h2 (the lead
// headline) and multiple plain-text h2s (Contents + section labels) with
// zero ambiguous cases either way. Only plain-text h2s get stripped now.
//
// MUST run after stripTableOfContents, not before - that function locates
// the Contents block specifically via its own `<h2 id="contents">` start
// marker and the next `<h2>` as its end boundary; stripping all h2s first
// would destroy both markers it depends on.
function stripSectionHeadings(html) {
    return html.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (match, inner) => (/<a[\s>]/i.test(inner) ? match : ""));
}

// Separates a headline from the byline paragraph immediately following it
// (user request, 2026-08-25 - the two currently run together with no gap:
// "...Doesn't Need by Jason Ross"). A real headline is always a link-wrapped
// h2 OR h3 immediately followed by the "by {author} (EIRNS) — {date}"
// paragraph Ghost always renders right after it.
//
// REAL BUG, caught by the user listening (2026-08-26): the first version of
// this only matched <h2>, on the wrong assumption that every real headline
// is an h2 (true only of the single "lead" headline at the top of the
// brief). Every other real per-article headline, inside the "In-Depth"
// section, is rendered as an <h3> - the category labels above them
// ("Strategic War Danger" etc, see stripSectionHeadings above) are the
// plain-text <h2>s. Matching h2 only meant every headline after the first
// ran straight into its byline with zero separation, every single day
// since this feature shipped - confirmed by checking the real HTML
// structure of a live post, not assumed.
//
// MUST run after stripSectionHeadings, for the same reason that function
// must run after stripTableOfContents - so this only ever sees real
// headline h2/h3s, not the plain-text h2 category labels about to be
// stripped (h3 has no plain-text-label case at this point in the pipeline
// to worry about excluding - "The Lead" is the only plain h3, and it's
// already removed by stripLeadLabel before this runs).
//
// A literal period, not a silent SSML <break> (tried first, 2026-08-25):
// the break alone left the headline with nowhere to resolve its intonation
// - a title has no terminal punctuation of its own in the source HTML, so
// without a period the voice had no textual signal that the phrase was
// actually finished, just a pause stuck in in the middle of what still
// read as one continuing thought. A real period gives Google's own
// sentence-boundary handling a genuine sentence to close out (falling
// intonation) before the byline starts, rather than manufacturing a pause
// on top of an unfinished-sounding phrase.
function markHeadlineByline(html) {
    return html.replace(/<h[23][^>]*>[\s\S]*?<\/h[23]>/gi, (match) => (/<a[\s>]/i.test(match) ? `${match}. ` : match));
}

// Daily Briefs include a "Contents" jump-link block (<h2 id="contents"> ...
// a run of <h3>/<ul> pairs, one per section, each <li> ending in a "(↓)"
// anchor that jumps to the real content further down) - confirmed via a
// live Google TTS failure that this block breaks synthesis: it's a run of
// headline fragments with no real sentence-ending punctuation between them,
// long enough that Google's own sentence-boundary parser chokes on it
// ("This request contains sentences that are too long"). It's also just
// not something a listener wants read aloud - the real content it points to
// is narrated normally later in the same post regardless. Structurally
// reliable removal: strip everything from the Contents heading up to (not
// including) the next <h2>, which is always the first real section heading
// - confirmed directly against real post HTML before relying on it.
function stripTableOfContents(html) {
    const startMarker = /<h2[^>]*id=["']contents["'][^>]*>/i;
    const match = html.match(startMarker);
    if (!match) return html;

    const start = match.index;
    const afterStart = start + match[0].length;
    const nextH2Offset = html.slice(afterStart).search(/<h2[\s>]/i);
    const end = nextH2Offset === -1 ? html.length : afterStart + nextH2Offset;

    return html.slice(0, start) + html.slice(end);
}
