import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { safePath } from "../src/tools/sandbox.js";
import WorkspaceManager from "../src/workspace.js";
import { createTestWorkspace } from "./helpers.js";

test("project tools create, select, and isolate generated workspaces", (t) => {
    const { root, workspaceManager, tools } = createTestWorkspace(t);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "agent.js"), "agent source\n");

    assert.deepEqual(tools.listProjects.execute({}), []);
    assert.deepEqual(tools.createProject.execute({ name: "Todo App" }), {
        project: "todo-app",
        workspace: "projects/todo-app",
    });
    assert.deepEqual(tools.listProjects.execute({}), ["todo-app"]);

    tools.writeFile.execute({ filePath: "index.html", content: "<main>Todo</main>\n" });
    assert.equal(
        fs.readFileSync(path.join(root, "projects", "todo-app", "index.html"), "utf8"),
        "<main>Todo</main>\n"
    );
    assert.equal(fs.readFileSync(path.join(root, "src", "agent.js"), "utf8"), "agent source\n");
    assert.throws(
        () => tools.writeFile.execute({ filePath: "../../src/agent.js", content: "bad" }),
        /outside the workspace/
    );

    tools.createProject.execute({ name: "Portfolio" });
    assert.equal(workspaceManager.getContext().project, "portfolio");
    tools.selectProject.execute({ name: "todo app" });
    assert.equal(tools.readFile.execute({ filePath: "index.html" }), "<main>Todo</main>\n");
});

test("file tools list, read, write, edit, and produce a protected project tree", (t) => {
    const { tools, workspaceManager } = createTestWorkspace(t);
    tools.createProject.execute({ name: "Files" });
    tools.writeFile.execute({ filePath: "src/message.txt", content: "hello world\n" });
    fs.writeFileSync(path.join(workspaceManager.getActiveWorkspace(), ".env"), "secret");

    assert.deepEqual(tools.listFiles.execute({ directory: "." }), ["src"]);
    assert.equal(tools.readFile.execute({ filePath: "src/message.txt" }), "hello world\n");
    assert.deepEqual(
        tools.editFile.execute({
            filePath: "src/message.txt",
            oldText: "world",
            newText: "agent",
        }),
        {
            filePath: "src/message.txt",
            content: "hello agent\n",
            bytes: 12,
            created: false,
            replacements: 1,
        }
    );
    assert.match(tools.projectTree.execute({ directory: "." }), /📁 src\/\n  📄 message.txt/);
    assert.doesNotMatch(tools.projectTree.execute({ directory: "." }), /\.env/);
    assert.throws(() => tools.readFile.execute({ filePath: ".env" }), /path is protected/);
    assert.throws(
        () =>
            tools.editFile.execute({
                filePath: "src/message.txt",
                oldText: "missing",
                newText: "x",
            }),
        /oldText was not found/
    );
    assert.throws(
        () => tools.readFile.execute({ filePath: "src/missing.txt" }),
        {
            code: "FILE_NOT_FOUND",
            message: /does not exist.*writeFile/i,
        }
    );
});

test("sandbox rejects traversal, absolute paths, home paths, protected paths, and escaping symlinks", (t) => {
    const { root, workspaceManager } = createTestWorkspace(t);
    workspaceManager.createProject("Sandbox");
    const workspace = workspaceManager.getActiveWorkspace();

    for (const candidate of [
        "../../.ssh/config",
        "/etc/passwd",
        "~/.ssh/config",
        ".git/config",
        "node_modules/package/index.js",
        ".env.local",
    ]) {
        assert.throws(() => safePath(candidate, workspace), /Access denied/);
    }

    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, "outside-link"), "dir");
    assert.throws(
        () => safePath("outside-link/secret.txt", workspace),
        /resolves outside the workspace through a symlink/
    );
});

test("workspace manager revalidates project roots and active workspaces against symlink swaps", (t) => {
    const { root, workspaceManager } = createTestWorkspace(t);
    workspaceManager.createProject("Safe Project");
    const workspace = workspaceManager.getActiveWorkspace();
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);

    fs.rmSync(workspace, { recursive: true, force: true });
    fs.symlinkSync(outside, workspace, "dir");

    assert.throws(
        () => workspaceManager.getActiveWorkspace(),
        { code: "PROJECT_OUTSIDE_ROOT" }
    );
});

test("workspace manager refuses a projects root that resolves outside the agent", (t) => {
    const { root } = createTestWorkspace(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-outside-"));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.symlinkSync(outside, path.join(root, "projects"), "dir");
    const workspaceManager = new WorkspaceManager({ agentRoot: root });

    assert.throws(
        () => workspaceManager.createProject("Escaped"),
        { code: "PROJECTS_ROOT_OUTSIDE_AGENT" }
    );
    assert.equal(fs.existsSync(path.join(outside, "escaped")), false);
});

test("file inspection and project trees stay bounded for responsive model requests", (t) => {
    const { tools, workspaceManager } = createTestWorkspace(t);
    tools.createProject.execute({ name: "Bounded" });
    const workspace = workspaceManager.getActiveWorkspace();
    fs.writeFileSync(path.join(workspace, "large.txt"), "x".repeat(256 * 1024 + 1));

    assert.throws(
        () => tools.readFile.execute({ filePath: "large.txt" }),
        { code: "FILE_TOO_LARGE" }
    );

    fs.mkdirSync(path.join(workspace, "many-files"));
    for (let index = 0; index < 501; index += 1) {
        fs.writeFileSync(path.join(workspace, "many-files", `file-${index}.txt`), "x");
    }

    assert.match(
        tools.projectTree.execute({ directory: "many-files" }),
        /tree truncated after 500 entries/
    );
});
