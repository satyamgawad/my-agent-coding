import { lookup as defaultLookup } from "node:dns/promises";
import net from "node:net";

const MAX_SEARCH_QUERY_CHARS = 500;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_PAGE_CHARS = 12_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 12_000;
const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";

function webError(message, code = "WEB_REQUEST_FAILED") {
    const error = new Error(message);
    error.code = code;
    return error;
}

function decodeEntities(value) {
    return String(value || "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function textFromHtml(html) {
    return decodeEntities(
        String(html || "")
            .replace(/<!--([\s\S]*?)-->/g, " ")
            .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    );
}

function pageTitle(html) {
    const title = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return title ? textFromHtml(title[1]).slice(0, 300) : null;
}

function ipv4IsPrivate(address) {
    const parts = address.split(".").map((part) => Number(part));

    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return true;
    }

    const [first, second] = parts;
    return first === 0 ||
        first === 10 ||
        first === 127 ||
        first >= 224 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        (first === 198 && (second === 18 || second === 19));
}

function ipv6IsPrivate(address) {
    const normalized = address.toLowerCase().split("%")[0];

    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff")) {
        return true;
    }

    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? ipv4IsPrivate(mapped[1]) : false;
}

function isPrivateAddress(address) {
    const family = net.isIP(address);
    return family === 4 ? ipv4IsPrivate(address) : family === 6 ? ipv6IsPrivate(address) : true;
}

export async function assertPublicWebUrl(value, { lookup = defaultLookup } = {}) {
    let url;

    try {
        url = new URL(value);
    } catch {
        throw webError("Use a complete public http or https URL.", "INVALID_WEB_URL");
    }

    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw webError("Use a public http or https URL without embedded credentials.", "INVALID_WEB_URL");
    }

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
        throw webError("Local network addresses are not available to web research.", "WEB_ADDRESS_BLOCKED");
    }

    const literalFamily = net.isIP(hostname);

    if (literalFamily) {
        if (isPrivateAddress(hostname)) {
            throw webError("Private network addresses are not available to web research.", "WEB_ADDRESS_BLOCKED");
        }
        return url;
    }

    let addresses;

    try {
        addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
        throw webError("That web address could not be resolved.", "WEB_ADDRESS_UNAVAILABLE");
    }

    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((record) => isPrivateAddress(record?.address || ""))) {
        throw webError("That web address is not a public internet destination.", "WEB_ADDRESS_BLOCKED");
    }

    return url;
}

async function readLimitedBody(response) {
    const reader = response.body?.getReader?.();

    if (!reader) {
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_PAGE_BYTES) {
            throw webError("The web page is too large to inspect safely.", "WEB_RESPONSE_TOO_LARGE");
        }
        return text;
    }

    const decoder = new TextDecoder();
    const chunks = [];
    let size = 0;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;

        if (size > MAX_PAGE_BYTES) {
            await reader.cancel();
            throw webError("The web page is too large to inspect safely.", "WEB_RESPONSE_TOO_LARGE");
        }

        chunks.push(decoder.decode(value, { stream: true }));
    }

    chunks.push(decoder.decode());
    return chunks.join("");
}

async function requestPublicPage(url, { fetchImpl, lookup, signal } = {}) {
    let target = await assertPublicWebUrl(url, { lookup });

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        let response;

        try {
            response = await fetchImpl(target, {
                method: "GET",
                headers: {
                    accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.1",
                    "user-agent": "MyCodingAgent/1.0 (project research)",
                },
                redirect: "manual",
                signal,
            });
        } catch (error) {
            if (signal?.aborted) throw signal.reason || error;
            throw webError("The web request could not be completed.", "WEB_REQUEST_FAILED");
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            if (!location || redirect === MAX_REDIRECTS) {
                throw webError("The web page redirected too many times.", "WEB_REDIRECT_LIMIT");
            }
            target = await assertPublicWebUrl(new URL(location, target).toString(), { lookup });
            continue;
        }

        if (!response.ok) {
            throw webError(`The web page returned HTTP ${response.status}.`, "WEB_HTTP_ERROR");
        }

        const contentType = response.headers.get("content-type") || "";
        if (!/^(?:text\/|application\/(?:json|xml|javascript))/i.test(contentType)) {
            throw webError("The web page did not return readable text content.", "WEB_CONTENT_UNSUPPORTED");
        }

        return { target, contentType, body: await readLimitedBody(response) };
    }

    throw webError("The web page could not be reached.", "WEB_REQUEST_FAILED");
}

function unwrapSearchUrl(value) {
    try {
        const url = new URL(decodeEntities(value), SEARCH_ENDPOINT);
        const redirected = url.searchParams.get("uddg");
        return redirected ? decodeURIComponent(redirected) : url.toString();
    } catch {
        return null;
    }
}

function searchResults(html) {
    const results = [];
    const anchors = String(html || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi);

    for (const match of anchors) {
        const attributes = match[1] || "";
        const className = attributes.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] || "";

        if (!/(?:^|\s)result__a(?:\s|$)/.test(className)) continue;

        const href = attributes.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
        const url = href ? unwrapSearchUrl(href) : null;
        const title = textFromHtml(match[2]).slice(0, 300);

        if (!url || !title || results.some((result) => result.url === url)) continue;
        results.push({ title, url });
        if (results.length === 6) break;
    }

    return results;
}

function requestSignal(signal) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(webError("The web request timed out.", "WEB_TIMEOUT")), REQUEST_TIMEOUT_MS);

    const cancel = () => controller.abort(signal.reason || new Error("Request cancelled."));
    if (signal?.aborted) {
        cancel();
    } else {
        signal?.addEventListener("abort", cancel, { once: true });
    }

    return {
        signal: controller.signal,
        cleanup() {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", cancel);
        },
    };
}

export function createWebTools({ fetchImpl = globalThis.fetch, lookup = defaultLookup } = {}) {
    if (typeof fetchImpl !== "function") {
        throw new Error("Web research requires a fetch implementation.");
    }

    return {
        async webSearch({ query }, { signal } = {}) {
            const safeQuery = typeof query === "string" ? query.trim().slice(0, MAX_SEARCH_QUERY_CHARS) : "";
            if (!safeQuery) throw webError("webSearch requires a search query.", "INVALID_WEB_QUERY");

            const request = requestSignal(signal);

            try {
                const endpoint = new URL(SEARCH_ENDPOINT);
                endpoint.searchParams.set("q", safeQuery);
                const { body } = await requestPublicPage(endpoint.toString(), {
                    fetchImpl,
                    lookup,
                    signal: request.signal,
                });
                const results = searchResults(body);

                return {
                    query: safeQuery,
                    results,
                    message: results.length > 0
                        ? `${results.length} public search result${results.length === 1 ? "" : "s"} found. Read a result page before relying on details.`
                        : "No readable public search results were found.",
                };
            } finally {
                request.cleanup();
            }
        },

        async readWebPage({ url }, { signal } = {}) {
            const request = requestSignal(signal);

            try {
                const page = await requestPublicPage(url, {
                    fetchImpl,
                    lookup,
                    signal: request.signal,
                });
                const readable = /^text\/html|application\/xhtml\+xml/i.test(page.contentType)
                    ? textFromHtml(page.body)
                    : String(page.body || "").replace(/\s+/g, " ").trim();

                return {
                    url: page.target.toString(),
                    title: pageTitle(page.body),
                    content: readable.slice(0, MAX_PAGE_CHARS),
                    truncated: readable.length > MAX_PAGE_CHARS,
                };
            } finally {
                request.cleanup();
            }
        },
    };
}
