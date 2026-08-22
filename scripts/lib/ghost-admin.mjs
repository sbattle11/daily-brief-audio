// Same JWT auth pattern as algolia-search/scripts/lib/ghost-admin.mjs - a
// dedicated "Daily Brief Audio" custom integration's Admin API key, kept
// separate from the Algolia one (least-privilege, same habit as before).
import jwt from "jsonwebtoken";
import { readFileSync } from "fs";

function adminToken() {
    const [id, secret] = process.env.GHOST_ADMIN_KEY.split(":");
    return jwt.sign({}, Buffer.from(secret, "hex"), {
        keyid: id,
        algorithm: "HS256",
        expiresIn: "5m",
        audience: "/admin/",
    });
}

export async function adminFetch(path, options = {}) {
    const res = await fetch(`${process.env.GHOST_API_URL}/ghost/api/admin${path}`, {
        ...options,
        headers: { Authorization: `Ghost ${adminToken()}`, ...(options.headers || {}) },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Ghost Admin API ${res.status}: ${JSON.stringify(body)}`);
    return body;
}

// Paginates through /posts/ with the given query params, yielding every post.
export async function* browsePosts(params) {
    let page = 1;
    while (true) {
        const qs = new URLSearchParams({ ...params, page: String(page), limit: "100" });
        const body = await adminFetch(`/posts/?${qs.toString()}`);
        for (const post of body.posts) yield post;
        if (page >= body.meta.pagination.pages) break;
        page++;
    }
}

// Uploads a local audio file to Ghost's own media storage (Ghost Pro:
// Publisher plan, so no per-file size concern at our ~13MB/file scale - see
// project notes). Endpoint/field names confirmed against the official
// @tryghost/admin-api SDK source (POST /media/upload/, multipart field
// "file", optional "purpose" - defaulted to "image" in the SDK, so the exact
// value Ghost expects for audio needs a live empirical check; see
// test-connection.mjs). Returns the public URL Ghost assigns the file.
export async function uploadAudio(filePath, filename) {
    const buffer = readFileSync(filePath);
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "audio/mpeg" }), filename);
    form.append("purpose", "audio");

    const res = await fetch(`${process.env.GHOST_API_URL}/ghost/api/admin/media/upload/`, {
        method: "POST",
        headers: { Authorization: `Ghost ${adminToken()}` },
        body: form,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Ghost media upload ${res.status}: ${JSON.stringify(body)}`);
    return body.media[0].url;
}
