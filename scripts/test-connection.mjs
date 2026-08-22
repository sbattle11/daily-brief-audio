// One-off verification script - not part of the daily pipeline. Confirms
// the Admin API key works, the "Daily Brief" tag filter matches real posts,
// and (the real point of this check) measures the ACTUAL plain-text length
// of a real Daily Brief's full content - the public site undercounts this
// badly since it's paywalled and truncates at the free-preview point (only
// ~5,200 characters showed up over a plain fetch of the live page). Only
// the Admin API sees the full body.
import "dotenv/config";
import { browsePosts } from "./lib/ghost-admin.mjs";
import { htmlToPlainText } from "./lib/html-to-text.mjs";

const posts = browsePosts({ filter: "tag:daily-brief", formats: "html", order: "published_at DESC", limit: "3" });

let count = 0;
for await (const post of posts) {
    count++;
    const text = htmlToPlainText(post.html || "");
    console.log(`\n"${post.title}" (${post.published_at})`);
    console.log(`  raw HTML length:   ${post.html?.length ?? 0}`);
    console.log(`  plain text length: ${text.length}`);
    console.log(`  first 150 chars:   ${text.slice(0, 150)}...`);
    if (count >= 3) break;
}

if (count === 0) {
    console.log('No posts found with tag "daily-brief" - check the tag slug (Ghost Admin -> the tag\'s own settings page shows its exact slug).');
}
