import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import ProjectArtifacts, {
    MAX_ARCHIVE_FILE_BYTES,
    MAX_PREVIEW_FILE_BYTES,
} from "../src/project-artifacts.js";
import WorkspaceManager from "../src/workspace.js";

function makeProject() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-artifacts-"));
    const workspaceManager = new WorkspaceManager({ agentRoot: root });
    workspaceManager.createProject("Preview Demo");
    const workspace = workspaceManager.getActiveWorkspace();

    return {
        root,
        workspace,
        workspaceManager,
        artifacts: new ProjectArtifacts(workspaceManager),
    };
}

function tarEntryNames(gzippedArchive) {
    const tar = gunzipSync(gzippedArchive);
    const names = [];
    let offset = 0;

    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) {
            break;
        }

        const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
        const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
        const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
        const size = Number.parseInt(sizeText || "0", 8);
        names.push(prefix ? `${prefix}/${name}` : name);
        offset += 512 + Math.ceil(size / 512) * 512;
    }

    return names;
}

test("static project previews stay inside the selected project's safe public root", (t) => {
    const { root, workspace, artifacts } = makeProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-artifacts-outside-"));
    fs.mkdirSync(path.join(workspace, "public", "assets"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "public", "index.html"), "<main>Tic Tac Toe</main>");
    fs.writeFileSync(path.join(workspace, "public", "app.js"), "console.log('game ready');");
    fs.writeFileSync(path.join(workspace, "public", "assets", "board.svg"), "<svg></svg>");
    fs.writeFileSync(path.join(workspace, "public", "notes.txt"), "not a static asset");
    fs.writeFileSync(path.join(workspace, ".env"), "NVIDIA_API_KEY=secret");
    fs.writeFileSync(path.join(outside, "outside.js"), "outside secret");
    fs.symlinkSync(path.join(outside, "outside.js"), path.join(workspace, "public", "linked.js"));

    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    assert.deepEqual(artifacts.previewStatus(), {
        state: "ready",
        available: true,
        project: "preview-demo",
        url: "/api/projects/preview/",
        downloadUrl: "/api/projects/download",
        message: null,
    });

    const page = artifacts.readPreviewFile();
    assert.equal(page.contentType, "text/html; charset=utf-8");
    assert.match(page.contents.toString("utf8"), /Tic Tac Toe/);
    assert.equal(artifacts.readPreviewFile("app.js").contentType, "text/javascript; charset=utf-8");
    assert.equal(artifacts.readPreviewFile("assets/board.svg").contentType, "image/svg+xml");

    for (const unsafePath of [
        "../.env",
        "%2e%2e%2f.env",
        "%2e%2e%5c.env",
        ".env",
        "linked.js",
        "notes.txt",
        "bad%00name.js",
    ]) {
        assert.throws(
            () => artifacts.readPreviewFile(unsafePath),
            (error) => error?.code === "PREVIEW_ASSET_NOT_FOUND"
        );
    }
});

test("source downloads exclude links, secrets, dependency trees, and key material", (t) => {
    const { root, workspace, artifacts } = makeProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-artifacts-outside-"));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "node_modules", "example"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "public.html"), "<main>safe source</main>");
    fs.writeFileSync(path.join(workspace, "src", "main.js"), "export const game = true;");
    fs.writeFileSync(path.join(workspace, ".gitignore"), "node_modules\n");
    fs.writeFileSync(path.join(workspace, ".env.local"), "token");
    fs.writeFileSync(path.join(workspace, ".npmrc"), "//registry.example/:_authToken=secret");
    fs.writeFileSync(path.join(workspace, ".netrc"), "machine example login secret");
    fs.writeFileSync(path.join(workspace, ".ssh", "id_rsa"), "private key");
    fs.writeFileSync(path.join(workspace, "certificate.pem"), "certificate");
    fs.writeFileSync(path.join(workspace, "server.key"), "private key");
    fs.writeFileSync(path.join(workspace, "id_deploy"), "private key");
    fs.writeFileSync(path.join(workspace, ".git", "config"), "secret git config");
    fs.writeFileSync(path.join(workspace, "node_modules", "example", "index.js"), "dependency");
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside");
    fs.symlinkSync(path.join(outside, "outside.txt"), path.join(workspace, "src", "linked.txt"));

    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    const archive = artifacts.createSourceArchive();
    assert.equal(archive.filename, "preview-demo-source.tar.gz");
    const names = tarEntryNames(archive.contents);
    const contents = gunzipSync(archive.contents).toString("utf8");

    assert.deepEqual(names, [
        "preview-demo/.gitignore",
        "preview-demo/public.html",
        "preview-demo/src/main.js",
    ]);
    assert.doesNotMatch(contents, /private key|secret git config|_authToken/i);

    const publishable = artifacts.sourceFiles();
    assert.equal(publishable.project, "preview-demo");
    assert.deepEqual(publishable.files.map((file) => file.path), [
        ".gitignore",
        "public.html",
        "src/main.js",
    ]);
    assert.doesNotMatch(Buffer.concat(publishable.files.map((file) => file.contents)).toString("utf8"), /private key|secret git config|_authToken/i);
});

test("preview and download operations report unavailable projects and enforce their size caps", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-artifacts-"));
    const workspaceManager = new WorkspaceManager({ agentRoot: root });
    const unselected = new ProjectArtifacts(workspaceManager);

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    assert.throws(
        () => unselected.previewStatus(),
        (error) => error?.code === "NO_ACTIVE_PROJECT" && error.status === 409
    );

    workspaceManager.createProject("No Preview");
    const workspace = workspaceManager.getActiveWorkspace();
    const artifacts = new ProjectArtifacts(workspaceManager);
    fs.writeFileSync(path.join(workspace, "README.md"), "Source only");

    assert.deepEqual(artifacts.previewStatus(), {
        state: "unavailable",
        available: false,
        project: "no-preview",
        url: null,
        downloadUrl: "/api/projects/download",
        message: "This project has no safe public/index.html or index.html file to preview.",
    });

    fs.mkdirSync(path.join(workspace, "public"));
    fs.writeFileSync(path.join(workspace, "public", "index.html"), "<main>safe</main>");
    fs.writeFileSync(
        path.join(workspace, "public", "large.js"),
        Buffer.alloc(MAX_PREVIEW_FILE_BYTES + 1)
    );
    assert.throws(
        () => artifacts.readPreviewFile("large.js"),
        (error) => error?.code === "PREVIEW_ASSET_TOO_LARGE" && error.status === 413
    );

    fs.writeFileSync(path.join(workspace, "source.bin"), Buffer.alloc(MAX_ARCHIVE_FILE_BYTES + 1));
    assert.throws(
        () => artifacts.createSourceArchive(),
        (error) => error?.code === "PROJECT_ARCHIVE_TOO_LARGE" && error.status === 413
    );
});
