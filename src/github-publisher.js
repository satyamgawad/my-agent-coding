const GITHUB_API_URL = "https://api.github.com";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,249}$/;

function publisherError(message, code, status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function normalizedRepository(value) {
    const repository = typeof value === "string" ? value.trim() : "";
    return REPOSITORY_PATTERN.test(repository) ? repository : null;
}

function normalizedBranch(value) {
    const branch = typeof value === "string" ? value.trim() : "main";
    return BRANCH_PATTERN.test(branch) ? branch : null;
}

function encodedPath(filePath) {
    return filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function requiredSha(value, message) {
    if (typeof value === "string" && value) {
        return value;
    }

    throw publisherError(message, "GITHUB_INVALID_RESPONSE", 502);
}

export default class GitHubPublisher {
    constructor({
        projectArtifacts,
        token = process.env.GITHUB_TOKEN || "",
        repository = process.env.GITHUB_REPOSITORY || "",
        branch = process.env.GITHUB_BRANCH || "main",
        fetchImpl = globalThis.fetch,
    } = {}) {
        if (!projectArtifacts) {
            throw new TypeError("GitHub publishing needs project artifacts.");
        }

        this.projectArtifacts = projectArtifacts;
        this.token = typeof token === "string" ? token.trim() : "";
        this.repository = normalizedRepository(repository);
        this.branch = normalizedBranch(branch);
        this.fetch = fetchImpl;
    }

    status() {
        const configured = Boolean(this.token && this.repository && this.branch && typeof this.fetch === "function");

        return {
            state: configured ? "ready" : "needs-configuration",
            configured,
            repository: this.repository,
            branch: this.branch,
            message: configured
                ? `Ready to publish safe source files to ${this.repository} (${this.branch}).`
                : "Set GITHUB_TOKEN and GITHUB_REPOSITORY to enable opt-in source publishing.",
        };
    }

    requireConfiguration(confirmation) {
        const status = this.status();

        if (!status.configured) {
            throw publisherError(
                "GitHub publishing is not configured.",
                "GITHUB_NOT_CONFIGURED",
                409
            );
        }

        if (confirmation !== this.repository) {
            throw publisherError(
                "Confirm the configured GitHub repository before publishing.",
                "GITHUB_REPOSITORY_NOT_CONFIRMED",
                409
            );
        }
    }

    headers() {
        return {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${this.token}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "my-coding-agent",
        };
    }

    async request(url, options) {
        let response;

        try {
            response = await this.fetch(url, options);
        } catch {
            throw publisherError(
                "GitHub could not be reached. Check the configured branch before retrying the publish.",
                "GITHUB_UNAVAILABLE",
                503
            );
        }

        if (response.status === 404) {
            return { state: "missing" };
        }

        if (options?.method === "PATCH" && [409, 422].includes(response.status)) {
            throw publisherError(
                "The configured GitHub branch changed before publishing could finish. No source changes were applied; review the branch and try again.",
                "GITHUB_BRANCH_CHANGED",
                409
            );
        }

        if (!response.ok) {
            const status = response.status === 401 || response.status === 403 ? 403 : 502;
            const message = status === 403
                ? "GitHub denied access to the configured repository."
                : "GitHub could not update the configured repository.";
            throw publisherError(message, "GITHUB_REQUEST_FAILED", status);
        }

        try {
            return { state: "ok", body: await response.json() };
        } catch {
            return { state: "ok", body: {} };
        }
    }

    async existingFileSha(filePath) {
        const url = `${GITHUB_API_URL}/repos/${this.repository}/contents/${encodedPath(filePath)}?ref=${encodeURIComponent(this.branch)}`;
        const result = await this.request(url, { headers: this.headers() });

        if (result.state === "missing") {
            return null;
        }

        return typeof result.body?.sha === "string" ? result.body.sha : null;
    }

    async branchHead() {
        const ref = `heads/${this.branch}`;
        const url = `${GITHUB_API_URL}/repos/${this.repository}/git/ref/${encodedPath(ref)}`;
        const result = await this.request(url, { headers: this.headers() });

        if (result.state === "missing") {
            throw publisherError(
                "The configured GitHub branch needs an initial commit before source can be published safely.",
                "GITHUB_BRANCH_UNINITIALIZED",
                409
            );
        }

        return requiredSha(
            result.body?.object?.sha,
            "GitHub returned an invalid branch reference."
        );
    }

    async commitTree(commitSha) {
        const url = `${GITHUB_API_URL}/repos/${this.repository}/git/commits/${encodeURIComponent(commitSha)}`;
        const result = await this.request(url, { headers: this.headers() });

        if (result.state === "missing") {
            throw publisherError(
                "GitHub could not find the configured branch commit.",
                "GITHUB_TARGET_NOT_FOUND",
                404
            );
        }

        return requiredSha(result.body?.tree?.sha, "GitHub returned an invalid commit tree.");
    }

    async createBlob(contents) {
        const url = `${GITHUB_API_URL}/repos/${this.repository}/git/blobs`;
        const result = await this.request(url, {
            method: "POST",
            headers: { ...this.headers(), "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({
                content: contents.toString("base64"),
                encoding: "base64",
            }),
        });

        if (result.state === "missing") {
            throw publisherError(
                "GitHub could not find the configured repository or branch.",
                "GITHUB_TARGET_NOT_FOUND",
                404
            );
        }

        return requiredSha(result.body?.sha, "GitHub did not return a source blob ID.");
    }

    async createTree(baseTree, entries) {
        const url = `${GITHUB_API_URL}/repos/${this.repository}/git/trees`;
        const result = await this.request(url, {
            method: "POST",
            headers: { ...this.headers(), "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({ base_tree: baseTree, tree: entries }),
        });

        if (result.state === "missing") {
            throw publisherError(
                "GitHub could not find the configured repository or branch.",
                "GITHUB_TARGET_NOT_FOUND",
                404
            );
        }

        return requiredSha(result.body?.sha, "GitHub did not return a source tree ID.");
    }

    async createCommit(tree, parent, project) {
        const url = `${GITHUB_API_URL}/repos/${this.repository}/git/commits`;
        const result = await this.request(url, {
            method: "POST",
            headers: { ...this.headers(), "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({
                message: `chore: sync ${project} source`,
                tree,
                parents: [parent],
            }),
        });

        if (result.state === "missing") {
            throw publisherError(
                "GitHub could not find the configured repository or branch.",
                "GITHUB_TARGET_NOT_FOUND",
                404
            );
        }

        return requiredSha(result.body?.sha, "GitHub did not return a commit ID.");
    }

    async updateBranch(commitSha) {
        const ref = `heads/${this.branch}`;
        const url = `${GITHUB_API_URL}/repos/${this.repository}/git/refs/${encodedPath(ref)}`;
        const result = await this.request(url, {
            method: "PATCH",
            headers: { ...this.headers(), "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({ sha: commitSha, force: false }),
        });

        if (result.state === "missing") {
            throw publisherError(
                "GitHub could not find the configured repository or branch.",
                "GITHUB_TARGET_NOT_FOUND",
                404
            );
        }
    }

    async publish({ confirmation } = {}) {
        this.requireConfiguration(confirmation);
        const source = this.projectArtifacts.sourceFiles();
        const parent = await this.branchHead();
        const baseTree = await this.commitTree(parent);
        const existingFiles = [];

        for (const file of source.files) {
            existingFiles.push(await this.existingFileSha(file.path));
        }

        const treeEntries = [];

        for (const file of source.files) {
            treeEntries.push({
                path: file.path,
                mode: "100644",
                type: "blob",
                sha: await this.createBlob(file.contents),
            });
        }

        const tree = await this.createTree(baseTree, treeEntries);
        const commit = await this.createCommit(tree, parent, source.project);
        await this.updateBranch(commit);
        const updated = existingFiles.filter(Boolean).length;
        const created = source.files.length - updated;

        return {
            state: "complete",
            repository: this.repository,
            branch: this.branch,
            project: source.project,
            created,
            updated,
            total: source.files.length,
            message: `Published ${source.files.length} safe source file${source.files.length === 1 ? "" : "s"} to ${this.repository} (${this.branch}) in one commit. Existing remote files not in this project were not deleted.`,
        };
    }
}
