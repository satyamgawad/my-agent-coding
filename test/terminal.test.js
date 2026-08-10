import assert from "node:assert/strict";
import test from "node:test";
import { createTestWorkspace } from "./helpers.js";

test("terminal runs only allowlisted commands inside the selected project", async (t) => {
    const { workspaceManager, tools } = createTestWorkspace(t);
    tools.createProject.execute({ name: "Terminal" });
    tools.writeFile.execute({
        filePath: "package.json",
        content: JSON.stringify({ scripts: { test: "node --test" } }),
    });
    tools.writeFile.execute({
        filePath: "sample.test.js",
        content: 'import test from "node:test"; test("ok", () => {});\n',
    });

    const pwd = await tools.terminal.execute({ command: "pwd" });
    assert.equal(pwd.exitCode, 0);
    assert.equal(pwd.stdout.trim(), workspaceManager.getActiveWorkspace());
    assert.equal((await tools.test.execute({})).exitCode, 0);
    assert.equal((await tools.terminal.execute({ command: "node --check sample.test.js" })).exitCode, 0);
});

test("terminal runs generated project scripts without inherited service secrets", async (t) => {
    const secretName = "MY_AGENT_TERMINAL_TEST_SECRET";
    const previousSecret = process.env[secretName];
    process.env[secretName] = "must-not-reach-generated-code";
    t.after(() => {
        if (previousSecret === undefined) {
            delete process.env[secretName];
            return;
        }

        process.env[secretName] = previousSecret;
    });

    const { tools } = createTestWorkspace(t);
    tools.createProject.execute({ name: "Clean Environment" });
    tools.writeFile.execute({
        filePath: "package.json",
        content: JSON.stringify({ scripts: { test: "node --test" } }),
    });
    tools.writeFile.execute({
        filePath: "environment.test.js",
        content: [
            'import assert from "node:assert/strict";',
            'import test from "node:test";',
            `test("does not receive parent secrets", () => assert.equal(process.env.${secretName}, undefined));`,
            "",
        ].join("\n"),
    });

    const result = await tools.test.execute({});
    assert.equal(result.exitCode, 0, result.stderr);
});

test("terminal rejects shell syntax, arbitrary commands, traversal, and executable node snippets", async (t) => {
    const { tools } = createTestWorkspace(t);
    tools.createProject.execute({ name: "Terminal" });

    for (const command of [
        "ls ..",
        "npm run lint",
        "node -e process.exit(0)",
        "pwd; whoami",
        "cat ../../.ssh/config",
    ]) {
        await assert.rejects(
            () => tools.terminal.execute({ command }),
            /terminal supports only|unsafe/
        );
    }
});

test("terminal requires a manifest before testing or building a new project", async (t) => {
    const { tools } = createTestWorkspace(t);
    tools.createProject.execute({ name: "Empty" });

    for (const command of ["npm test", "npm run build"]) {
        await assert.rejects(
            () => tools.terminal.execute({ command }),
            /active project has no package\.json/
        );
    }
});
