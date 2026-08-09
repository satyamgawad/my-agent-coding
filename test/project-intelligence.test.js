import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectContextRetriever, ProjectEvaluator } from "../src/project-intelligence.js";
import WorkspaceManager from "../src/workspace.js";

function createWorkspace(testContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-intelligence-test-"));
    const workspaceManager = new WorkspaceManager({ agentRoot: root });

    testContext.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    return { root, workspaceManager };
}

test("local retrieval returns relevant safe project context without protected files", (t) => {
    const { root, workspaceManager } = createWorkspace(t);
    workspaceManager.createProject("Theme Studio");
    const project = path.join(root, "projects", "theme-studio");

    fs.mkdirSync(path.join(project, "src"));
    fs.writeFileSync(path.join(project, "src", "theme.js"), [
        "export function applyTheme(theme) {",
        "  document.documentElement.dataset.theme = theme;",
        "}",
    ].join("\n"));
    fs.writeFileSync(path.join(project, "README.md"), "# Theme Studio\nUse the theme switcher to change the page theme.\n");
    fs.writeFileSync(path.join(project, ".env"), "NVIDIA_API_KEY=private-value\n");
    fs.writeFileSync(path.join(project, "client.js"), 'const api_key = "private-value";\nexport const syncTheme = () => "theme";\n');
    fs.writeFileSync(path.join(project, "service-account.json"), '{"token":"private-value"}\n');

    const retrieved = new ProjectContextRetriever(workspaceManager).retrieve(
        "Fix the theme switcher so it updates the page theme."
    );

    assert.equal(retrieved.project, "theme-studio");
    assert.match(retrieved.prompt, /src\/theme\.js/);
    assert.match(retrieved.prompt, /applyTheme/);
    assert.doesNotMatch(retrieved.prompt, /private-value|NVIDIA_API_KEY/);
    assert.match(retrieved.prompt, /api_key = "\[REDACTED\]"/);
    assert.doesNotMatch(retrieved.prompt, /service-account\.json/);
});

test("project evaluation measures source, test, command, and documentation readiness", (t) => {
    const { root, workspaceManager } = createWorkspace(t);
    workspaceManager.createProject("Calculator");
    const project = path.join(root, "projects", "calculator");

    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
        scripts: { test: "node --test", build: "node --check app.js" },
    }));
    fs.writeFileSync(path.join(project, "app.js"), "export const add = (left, right) => left + right;\n");
    fs.writeFileSync(path.join(project, "app.test.js"), [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'import { add } from "./app.js";',
        'test("adds values", () => assert.equal(add(2, 3), 5));',
    ].join("\n"));
    fs.writeFileSync(path.join(project, "README.md"), "# Calculator\n\nA small arithmetic utility.\n");

    const evaluation = new ProjectEvaluator(workspaceManager).evaluate();

    assert.equal(evaluation.state, "ready");
    assert.equal(evaluation.score, 100);
    assert.equal(evaluation.checks.every((item) => item.status === "pass"), true);
});

test("project evaluation does not accept empty tests as behavior coverage", (t) => {
    const { root, workspaceManager } = createWorkspace(t);
    workspaceManager.createProject("Incomplete");
    const project = path.join(root, "projects", "incomplete");

    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    fs.writeFileSync(path.join(project, "app.js"), "export const ready = true;\n");
    fs.writeFileSync(path.join(project, "app.test.js"), 'import test from "node:test"; test("runs", () => {});\n');

    const evaluation = new ProjectEvaluator(workspaceManager).evaluate();
    const tests = evaluation.checks.find((item) => item.id === "tests");

    assert.equal(evaluation.state, "needs-attention");
    assert.equal(tests.status, "fail");
    assert.match(tests.detail, /meaningful assertion/);
});
