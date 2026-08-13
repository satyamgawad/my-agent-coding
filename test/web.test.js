import assert from "node:assert/strict";
import test from "node:test";
import { createWebTools } from "../src/tools/web.js";

function publicLookup() {
    return [{ address: "93.184.216.34", family: 4 }];
}

test("web research searches public results and reads bounded public page text", async () => {
    const requested = [];
    const tools = createWebTools({
        lookup: async () => publicLookup(),
        fetchImpl: async (url) => {
            requested.push(String(url));
            if (String(url).includes("duckduckgo.com")) {
                return new Response([
                    '<a class="result__a" href="https://example.com/docs">Example docs</a>',
                    '<a class="result__a" href="https://example.com/docs">Duplicate</a>',
                ].join(""), { headers: { "content-type": "text/html" } });
            }

            return new Response("<title>Example guide</title><main><h1>Useful reference</h1><script>ignored()</script><p>Readable details.</p></main>", {
                headers: { "content-type": "text/html; charset=utf-8" },
            });
        },
    });

    const search = await tools.webSearch({ query: "example documentation" });
    assert.equal(search.results.length, 1);
    assert.deepEqual(search.results[0], { title: "Example docs", url: "https://example.com/docs" });

    const page = await tools.readWebPage({ url: search.results[0].url });
    assert.equal(page.title, "Example guide");
    assert.match(page.content, /Useful reference Readable details/);
    assert.doesNotMatch(page.content, /ignored/);
    assert.equal(requested.length, 2);
});

test("web research blocks private and redirecting-to-private network addresses", async () => {
    const tools = createWebTools({
        lookup: async (hostname) => hostname === "private.example"
            ? [{ address: "127.0.0.1", family: 4 }]
            : publicLookup(),
        fetchImpl: async () => new Response(null, {
            status: 302,
            headers: { location: "http://private.example/secret" },
        }),
    });

    await assert.rejects(
        () => tools.readWebPage({ url: "http://127.0.0.1:3333" }),
        (error) => error.code === "WEB_ADDRESS_BLOCKED"
    );
    await assert.rejects(
        () => tools.readWebPage({ url: "https://public.example/start" }),
        (error) => error.code === "WEB_ADDRESS_BLOCKED"
    );
});
