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

test("GitHub publisher commits only safe active-project source in one branch update", async (t) => {
    const projectArtifacts = publisherFixture(t);
    const requests = [];
    const publisher = new GitHubPublisher({
        projectArtifacts,
        token: "github-private-token",
        repository: "owner/generated-apps",
        branch: "main",
        async fetchImpl(url, options = {}) {
            requests.push({ url, options });
            const method = options.method || "GET";
            const pathname = new URL(url).pathname;

            if (method === "GET" && pathname.endsWith("/git/ref/heads/main")) {
                return new Response(JSON.stringify({ object: { sha: "base-commit" } }));
            }

            if (method === "GET" && pathname.endsWith("/git/commits/base-commit")) {
                return new Response(JSON.stringify({ tree: { sha: "base-tree" } }));
            }

            if (method === "GET" && pathname.endsWith("/contents/app.js")) {
                return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
            }

            if (method === "GET" && pathname.endsWith("/contents/package.json")) {
                return new Response(JSON.stringify({ sha: "existing-package" }));
            }

            if (method === "POST" && pathname.endsWith("/git/blobs")) {
                const blobCount = requests.filter((request) => (
                    request.options.method === "POST" && request.url.endsWith("/git/blobs")
                )).length;
                return new Response(JSON.stringify({ sha: `blob-${blobCount}` }), { status: 201 });
            }

            if (method === "POST" && pathname.endsWith("/git/trees")) {
                return new Response(JSON.stringify({ sha: "next-tree" }), { status: 201 });
            }

            if (method === "POST" && pathname.endsWith("/git/commits")) {
                return new Response(JSON.stringify({ sha: "next-commit" }), { status: 201 });
            }

            if (method === "PATCH" && pathname.endsWith("/git/refs/heads/main")) {
                return new Response(JSON.stringify({ object: { sha: "next-commit" } }));
            }

            throw new Error(`Unexpected GitHub request: ${method} ${pathname}`);
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
        created: 1,
        updated: 1,
        total: 2,
        message: "Published 2 safe source files to owner/generated-apps (main) in one commit. Existing remote files not in this project were not deleted.",
    });

    const blobs = requests
        .filter((request) => request.options.method === "POST" && request.url.endsWith("/git/blobs"))
        .map((request) => JSON.parse(request.options.body));
    assert.equal(blobs.length, 2);
    assert.equal(blobs.every((blob) => blob.encoding === "base64"), true);
    assert.equal(blobs.some((blob) => Buffer.from(blob.content, "base64").toString("utf8").includes("never-publish")), false);
    assert.equal(requests.some((request) => /\.env|node_modules/.test(request.url)), false);
    assert.equal(requests.some((request) => request.options.method === "PUT"), false);

    const tree = JSON.parse(requests.find((request) => request.url.endsWith("/git/trees")).options.body);
    assert.deepEqual(tree, {
        base_tree: "base-tree",
        tree: [
            { path: "app.js", mode: "100644", type: "blob", sha: "blob-1" },
            { path: "package.json", mode: "100644", type: "blob", sha: "blob-2" },
        ],
    });
    const commit = JSON.parse(requests.find((request) => request.url.endsWith("/git/commits")).options.body);
    assert.deepEqual(commit, {
        message: "chore: sync notes-app source",
        tree: "next-tree",
        parents: ["base-commit"],
    });
    const refUpdate = JSON.parse(requests.find((request) => request.options.method === "PATCH").options.body);
    assert.deepEqual(refUpdate, { sha: "next-commit", force: false });
    assert.doesNotMatch(JSON.stringify(result), /github-private-token/);
});

test("GitHub publisher rejects an uninitialized branch before writing source", async (t) => {
    const projectArtifacts = publisherFixture(t);
    const requests = [];
    const publisher = new GitHubPublisher({
        projectArtifacts,
        token: "github-private-token",
        repository: "owner/generated-apps",
        async fetchImpl(url, options = {}) {
            requests.push({ url, options });
            return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        },
    });

    await assert.rejects(
        publisher.publish({ confirmation: "owner/generated-apps" }),
        { code: "GITHUB_BRANCH_UNINITIALIZED" }
    );
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/git\/ref\/heads\/main$/);
});

test("GitHub publisher refuses to force-push when the branch changes", async () => {
    const publisher = new GitHubPublisher({
        projectArtifacts: {},
        token: "github-private-token",
        repository: "owner/generated-apps",
        async fetchImpl(_url, options = {}) {
            assert.equal(options.method, "PATCH");
            assert.deepEqual(JSON.parse(options.body), { sha: "next-commit", force: false });
            return new Response(JSON.stringify({ message: "Conflict" }), { status: 409 });
        },
    });

    await assert.rejects(
        publisher.updateBranch("next-commit"),
        { code: "GITHUB_BRANCH_CHANGED" }
    );
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
