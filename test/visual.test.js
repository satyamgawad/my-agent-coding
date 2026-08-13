import assert from "node:assert/strict";
import test from "node:test";
import { createTestWorkspace } from "./helpers.js";

test("visual checks open a static project in Chromium at desktop and mobile sizes", async (t) => {
    const { tools } = createTestWorkspace(t);
    tools.createProject.execute({ name: "Visual" });
    tools.writeFile.execute({
        filePath: "public/index.html",
        content: [
            "<!doctype html>",
            "<html><head><title>Visual test</title><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head>",
            "<body><main><h1>Visual test</h1><label for=\"name\">Name</label><input id=\"name\"><button type=\"button\">Save</button></main></body></html>",
        ].join(""),
    });

    const result = await tools.visualCheck.execute({});
    assert.equal(result.state, "ready");
    assert.equal(result.entryPath, "public/index.html");
    assert.deepEqual(result.viewports.map((view) => view.viewport), ["desktop", "mobile"]);
    assert.ok(result.viewports.every((view) => view.screenshotBytes > 0));
    assert.equal(result.consoleErrors.length, 0);
});
