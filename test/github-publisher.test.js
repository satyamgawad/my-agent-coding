import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import GitHubPublisher from "../src/github-publisher.js";
import ProjectArtifacts from "../src/project-artifacts.js";
import WorkspaceManager from "../src/workspace.js";

function publisherFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-github-test-"));
    const workspaceManager = new WorkspaceManager({ agentRoot: root });
    workspaceManager.createProject("Notes App");
    const workspace = workspaceManager.getActiveWorkspace();
    fs.mkdirSync(path.join(workspace, "node_modules", "ignored"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "app.js"), "export const notes = []\n");
    fs.writeFileSync(path.join(workspace, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(path.join(workspace, ".env"), "GITHUB_TOKEN=never-publish\n");
    fs.writeFileSync(path.join(workspace, "node_modules", "ignored", "index.js"), "not source\n");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    return new ProjectArtifacts(workspaceManager);
}

test("GitHub publisher sends only safe active-project source after exact confirmation", async (t) => {
    const projectArtifacts = publisherFixture(t);
    const requests = [];
    const publisher = new GitHubPublisher({
        projectArtifacts,
        token: "github-private-token",
        repository: "owner/generated-apps",
        branch: "main",
        async fetchImpl(url, options = {}) {
            requests.push({ url, options });

            if (options.method === "PUT") {
                return new Response(JSON.stringify({ content: { sha: "created" } }), { status: 201 });
            }

            return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        },
    });

    assert.deepEqual(publisher.status(), {
        state: "ready",
        configured: true,
        repository: "owner/generated-apps",
        branch: "main",
        message: "Ready to publish safe source files to owner/generated-apps (main).",
    });

    await assert.rejects(
        publisher.publish({ confirmation: "owner/another-repository" }),
        (error) => error?.code === "GITHUB_REPOSITORY_NOT_CONFIRMED"
    );
    assert.equal(requests.length, 0);

    const result = await publisher.publish({ confirmation: "owner/generated-apps" });
    assert.deepEqual(result, {
        state: "complete",
        repository: "owner/generated-apps",
        branch: "main",
        project: "notes-app",
        created: 2,
        updated: 0,
        total: 2,
        message: "Published 2 safe source files to owner/generated-apps (main). Existing remote files not in this project were not deleted.",
    });

    const updatedFiles = requests
        .filter((request) => request.options.method === "PUT")
        .map((request) => ({ url: request.url, body: JSON.parse(request.options.body) }));
    assert.equal(updatedFiles.length, 2);
    assert.equal(updatedFiles.every((request) => request.url.includes("owner/generated-apps/contents/")), true);
    assert.equal(updatedFiles.some((request) => /\.env|node_modules/.test(request.url)), false);
    assert.equal(updatedFiles.some((request) => Buffer.from(request.body.content, "base64").toString("utf8").includes("never-publish")), false);
    assert.doesNotMatch(JSON.stringify(result), /github-private-token/);
});

test("GitHub publisher reports missing configuration without exposing a token", () => {
    const projectArtifacts = { sourceFiles() { throw new Error("must not read source"); } };
    const publisher = new GitHubPublisher({
        projectArtifacts,
        token: "",
        repository: "not valid/repo/name",
    });

    assert.deepEqual(publisher.status(), {
        state: "needs-configuration",
        configured: false,
        repository: null,
        branch: "main",
        message: "Set GITHUB_TOKEN and GITHUB_REPOSITORY to enable opt-in source publishing.",
    });
    assert.throws(
        () => publisher.requireConfiguration("not valid/repo/name"),
        (error) => error?.code === "GITHUB_NOT_CONFIGURED" && !error.message.includes("github-private-token")
    );
});
