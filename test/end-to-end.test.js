import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Agent from "../src/agent.js";
import { createTestWorkspace, scriptedModel, toolCall } from "./helpers.js";

const packageJson = `${JSON.stringify(
    {
        name: "todo-app",
        private: true,
        type: "module",
        scripts: {
            test: "node --test",
            build: "node --check app.js",
        },
    },
    null,
    2
)}\n`;

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Todo App</title>
    <style>
      body { background: #fff; color: #111; font-family: system-ui, sans-serif; }
    </style>
  </head>
  <body>
    <main><h1>Todos</h1><p>A focused task list.</p></main>
  </body>
</html>
`;

const appSource = `export function createTodo(text) {
  return { id: crypto.randomUUID(), text, completed: false };
}

export function defaultTheme() {
  return "light";
}
`;

const testSource = `import assert from "node:assert/strict";
import test from "node:test";
import { createTodo, defaultTheme } from "./app.js";

test("creates an incomplete todo", () => {
  assert.deepEqual(createTodo("Ship it").text, "Ship it");
  assert.equal(defaultTheme(), "light");
});
`;

test("scripted end-to-end session creates, modifies, inspects, and protects a Todo project", async (t) => {
    const { root, workspaceManager, tools } = createTestWorkspace(t);

    const createAgent = new Agent(
        scriptedModel([
            toolCall("createProject", { name: "Todo App" }),
            toolCall("projectTree", { directory: "." }),
            toolCall("writeFile", { filePath: "package.json", content: packageJson }),
            toolCall("readFile", { filePath: "package.json" }),
            toolCall("writeFile", { filePath: "index.html", content: indexHtml }),
            toolCall("readFile", { filePath: "index.html" }),
            toolCall("writeFile", { filePath: "app.js", content: appSource }),
            toolCall("readFile", { filePath: "app.js" }),
            toolCall("writeFile", { filePath: "todo.test.js", content: testSource }),
            toolCall("readFile", { filePath: "todo.test.js" }),
            toolCall("terminal", { command: "npm run build" }),
            toolCall("test"),
            { content: "Created the Todo application, verified each file, and passed build and tests." },
        ]),
        { workspaceManager, tools }
    );

    assert.match(
        await createAgent.run("Create a simple Todo application."),
        /passed build and tests/
    );

    const todoRoot = path.join(root, "projects", "todo-app");
    assert.equal(workspaceManager.getActiveWorkspace(), fs.realpathSync(todoRoot));
    assert.deepEqual(fs.readdirSync(todoRoot).sort(), [
        "app.js",
        "index.html",
        "package.json",
        "todo.test.js",
    ]);

    const darkModeAgent = new Agent(
        scriptedModel([
            toolCall("projectTree", { directory: "." }),
            toolCall("readFile", { filePath: "index.html" }),
            toolCall("editFile", {
                filePath: "index.html",
                oldText: "      body { background: #fff; color: #111; font-family: system-ui, sans-serif; }",
                newText: "      body { background: #fff; color: #111; font-family: system-ui, sans-serif; }\n      body[data-theme=\"dark\"] { background: #111; color: #f5f5f5; }",
            }),
            toolCall("readFile", { filePath: "index.html" }),
            toolCall("editFile", {
                filePath: "app.js",
                oldText: 'export function defaultTheme() {\n  return "light";\n}',
                newText: 'export function defaultTheme() {\n  return "light";\n}\n\nexport function darkTheme() {\n  return "dark";\n}',
            }),
            toolCall("readFile", { filePath: "app.js" }),
            toolCall("terminal", { command: "npm run build" }),
            toolCall("test"),
            { content: "Added dark mode styles, verified the edits, and passed build and tests." },
        ]),
        { workspaceManager, tools }
    );

    assert.match(await darkModeAgent.run("Add dark mode."), /Added dark mode styles/);
    assert.match(fs.readFileSync(path.join(todoRoot, "index.html"), "utf8"), /data-theme="dark"/);
    assert.match(fs.readFileSync(path.join(todoRoot, "app.js"), "utf8"), /darkTheme/);

    const explainAgent = new Agent(
        scriptedModel([
            toolCall("projectTree", { directory: "." }),
            toolCall("readFile", { filePath: "package.json" }),
            { content: "This project has a static page in index.html, reusable Todo logic in app.js, and Node tests in todo.test.js." },
        ]),
        { workspaceManager, tools }
    );
    assert.match(await explainAgent.run("Explain the structure of this project."), /reusable Todo logic/);

    const safetyPrompts = [];
    const safetyAgent = new Agent(
        scriptedModel(
            [
                toolCall("readFile", { filePath: "../../.ssh/config" }),
                { content: "I could not read that file because it is outside the active project workspace." },
            ],
            safetyPrompts
        ),
        { workspaceManager, tools }
    );
    assert.match(await safetyAgent.run("Read ../../.ssh/config"), /path is outside the workspace/);
    assert.match(safetyPrompts[1], /path is outside the workspace/);
});
