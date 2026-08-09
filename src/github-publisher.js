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
                "GitHub could not be reached. No additional files were attempted.",
                "GITHUB_UNAVAILABLE",
                503
            );
        }

        if (response.status === 404) {
            return { state: "missing" };
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

    async publish({ confirmation } = {}) {
        this.requireConfiguration(confirmation);
        const source = this.projectArtifacts.sourceFiles();
        let created = 0;
        let updated = 0;

        for (const file of source.files) {
            const sha = await this.existingFileSha(file.path);
            const body = {
                message: `chore: sync ${source.project} source`,
                content: file.contents.toString("base64"),
                branch: this.branch,
            };

            if (sha) {
                body.sha = sha;
            }

            const url = `${GITHUB_API_URL}/repos/${this.repository}/contents/${encodedPath(file.path)}`;
            const result = await this.request(url, {
                method: "PUT",
                headers: { ...this.headers(), "content-type": "application/json; charset=utf-8" },
                body: JSON.stringify(body),
            });

            if (result.state === "missing") {
                throw publisherError(
                    "GitHub could not find the configured repository or branch.", "GITHUB_TARGET_NOT_FOUND", 404);
            }

            if (sha) {
                updated += 1;
            } else {
                created += 1;
            }
        }

        return {
            state: "complete",
            repository: this.repository,
            branch: this.branch,
            project: source.project,
            created,
            updated,
            total: source.files.length,
            message: `Published ${source.files.length} safe source file${source.files.length === 1 ? "" : "s"} to ${this.repository} (${this.branch}). Existing remote files not in this project were not deleted.`,
        };
    }
}
