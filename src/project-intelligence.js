import fs from "node:fs";
import path from "node:path";
import { isProtectedPath } from "./tools/sandbox.js";

const MAX_CONTEXT_FILES = 80;
const MAX_CONTEXT_FILE_BYTES = 64 * 1024;
const MAX_CONTEXT_CHUNKS = 4;
const MAX_CHUNK_CHARS = 2_400;
const MAX_CONTEXT_CHARS = 9_000;
const SOURCE_EXTENSIONS = new Set([
    ".c", ".cc", ".cpp", ".css", ".cjs", ".go", ".h", ".html", ".java",
    ".js", ".json", ".jsx", ".md", ".mjs", ".php", ".py", ".rb", ".rs",
    ".scss", ".sh", ".sql", ".svelte", ".toml", ".ts", ".tsx", ".txt", ".vue",
    ".xml", ".yaml", ".yml",
]);
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "coverage", "dist", "build"]);
const SENSITIVE_FILE_NAME = /(?:^|[._-])(?:credential|secret|token|private|service[-_]?account)(?:[._-]|$)|^id_rsa$/i;
const SENSITIVE_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|client[_-]?secret|password)(\s*[:=]\s*)(["'`])[^\n]*?\3/gi;
const STOP_WORDS = new Set([
    "about", "after", "agent", "app", "application", "build", "code", "create", "from",
    "have", "into", "make", "need", "project", "that", "the", "this", "with", "your",
]);

function canReadProjectFile(filePath, workspace) {
    if (isProtectedPath(filePath, workspace)) {
        return false;
    }

    const extension = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath).toLowerCase();
    return !SENSITIVE_FILE_NAME.test(basename) && (
        SOURCE_EXTENSIONS.has(extension) || basename.startsWith("readme")
    );
}

function redactSensitiveAssignments(content) {
    return content.replace(SENSITIVE_ASSIGNMENT, (_match, name, operator, quote) => {
        return `${name}${operator}${quote}[REDACTED]${quote}`;
    });
}

function walkProjectFiles(workspace, {
    maxFiles = MAX_CONTEXT_FILES,
    maxFileBytes = MAX_CONTEXT_FILE_BYTES,
} = {}) {
    const files = [];

    function visit(directory) {
        if (files.length >= maxFiles) {
            return;
        }

        let entries;

        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (files.length >= maxFiles || entry.isSymbolicLink()) {
                continue;
            }

            const fullPath = path.join(directory, entry.name);

            if (isProtectedPath(fullPath, workspace)) {
                continue;
            }

            if (entry.isDirectory()) {
                if (!SKIPPED_DIRECTORIES.has(entry.name)) {
                    visit(fullPath);
                }
                continue;
            }

            if (!entry.isFile() || !canReadProjectFile(fullPath, workspace)) {
                continue;
            }

            try {
                if (fs.statSync(fullPath).size > maxFileBytes) {
                    continue;
                }

                files.push({
                    filePath: path.relative(workspace, fullPath).split(path.sep).join("/"),
                    content: redactSensitiveAssignments(fs.readFileSync(fullPath, "utf8")),
                });
            } catch {
                // A project can change while it is being inspected. Skip that
                // file rather than interrupting the task or exposing an error.
            }
        }
    }

    visit(workspace);
    return files;
}

function taskTerms(task) {
    const tokens = String(task || "")
        .toLowerCase()
        .match(/[a-z][a-z0-9_-]{1,}/g) || [];

    return [...new Set(tokens.filter((token) => !STOP_WORDS.has(token)))].slice(0, 24);
}

function countMatches(content, term) {
    let matches = 0;
    let from = 0;

    while (matches < 8) {
        const found = content.indexOf(term, from);

        if (found === -1) {
            break;
        }

        matches += 1;
        from = found + term.length;
    }

    return matches;
}

function scoreText(filePath, content, terms) {
    const loweredPath = filePath.toLowerCase();
    const loweredContent = content.toLowerCase();
    let score = 0;

    for (const term of terms) {
        score += countMatches(loweredContent, term);
        if (loweredPath.includes(term)) {
            score += 4;
        }
    }

    if (/^(readme|package\.json)/i.test(filePath)) {
        score += 0.25;
    }

    return score;
}

function chunksForFile(file) {
    const lines = file.content.split(/\r?\n/);
    const chunks = [];
    let buffer = [];
    let startLine = 1;
    let length = 0;

    function addChunk() {
        if (buffer.length === 0) {
            return;
        }

        chunks.push({
            filePath: file.filePath,
            startLine,
            endLine: startLine + buffer.length - 1,
            content: buffer.join("\n"),
        });
    }

    lines.forEach((line, index) => {
        const nextLength = length + line.length + 1;

        if (buffer.length > 0 && nextLength > MAX_CHUNK_CHARS) {
            addChunk();
            buffer = [];
            startLine = index + 1;
            length = 0;
        }

        buffer.push(line);
        length += line.length + 1;
    });

    addChunk();
    return chunks;
}

export function isTestFile(filePath) {
    return /(?:^|\/)(?:test(?:s)?\/|.*\.(?:test|spec)\.[cm]?[jt]sx?$|test\.[cm]?[jt]sx?$)/.test(
        filePath
    );
}

export function hasMeaningfulTestAssertion(fileContent) {
    if (typeof fileContent !== "string") {
        return false;
    }

    return /\b(?:assert\.(?:equal|notEqual|deepEqual|notDeepEqual|strictEqual|notStrictEqual|ok|throws|rejects|match|doesNotMatch|ifError)|expect\s*\([^\n]+\)\s*\.|should(?:\.|\())/.test(
        fileContent
    );
}

export class ProjectContextRetriever {
    constructor(workspaceManager) {
        this.workspaceManager = workspaceManager;
    }

    retrieve(task) {
        let workspace;
        let project;

        try {
            workspace = this.workspaceManager.getActiveWorkspace();
            project = this.workspaceManager.getContext().project;
        } catch {
            return null;
        }

        const terms = taskTerms(task);
        const files = walkProjectFiles(workspace);
        const candidates = [];

        for (const file of files) {
            const fileScore = scoreText(file.filePath, file.content, terms);

            for (const chunk of chunksForFile(file)) {
                const score = fileScore + scoreText(chunk.filePath, chunk.content, terms);

                if (score > 0 || /^(readme|package\.json)/i.test(chunk.filePath)) {
                    candidates.push({ ...chunk, score });
                }
            }
        }

        const chunks = candidates
            .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath))
            .slice(0, MAX_CONTEXT_CHUNKS);

        if (chunks.length === 0) {
            return null;
        }

        let characters = 0;
        const selected = [];

        for (const chunk of chunks) {
            const heading = `[${chunk.filePath}:${chunk.startLine}-${chunk.endLine}]\n`;
            const remaining = MAX_CONTEXT_CHARS - characters - heading.length;

            if (remaining <= 0) {
                break;
            }

            const content = chunk.content.slice(0, remaining);
            selected.push({ ...chunk, content });
            characters += heading.length + content.length + 2;
        }

        if (selected.length === 0) {
            return null;
        }

        return {
            project,
            chunks: selected.map(({ filePath, startLine, endLine }) => ({ filePath, startLine, endLine })),
            prompt: selected
                .map((chunk) => `[${chunk.filePath}:${chunk.startLine}-${chunk.endLine}]\n${chunk.content}`)
                .join("\n\n"),
        };
    }
}

function check(id, label, status, detail, weight = 0) {
    return { id, label, status, detail, weight };
}

export class ProjectEvaluator {
    constructor(workspaceManager) {
        this.workspaceManager = workspaceManager;
    }

    evaluate() {
        let workspace;
        let project;

        try {
            workspace = this.workspaceManager.getActiveWorkspace();
            project = this.workspaceManager.getContext().project;
        } catch {
            return {
                state: "idle",
                project: null,
                score: 0,
                message: "Select a project to see its local engineering readiness checks.",
                checks: [],
            };
        }

        const files = walkProjectFiles(workspace);
        const packageFile = files.find((file) => file.filePath === "package.json");
        const testFiles = files.filter((file) => isTestFile(file.filePath));
        const sourceFiles = files.filter((file) => {
            return file.filePath !== "package.json" && !isTestFile(file.filePath) &&
                !/^readme(?:\.[^/]+)?$/i.test(path.basename(file.filePath));
        });
        const readmeFile = files.find((file) => /^readme(?:\.[^/]+)?$/i.test(path.basename(file.filePath)));
        let manifest = null;

        try {
            manifest = packageFile ? JSON.parse(packageFile.content) : null;
        } catch {
            manifest = null;
        }

        const hasTestScript = typeof manifest?.scripts?.test === "string" && manifest.scripts.test.trim().length > 0;
        const hasBuildScript = typeof manifest?.scripts?.build === "string" && manifest.scripts.build.trim().length > 0;
        const meaningfulTests = testFiles.filter((file) => hasMeaningfulTestAssertion(file.content));
        const checks = [
            check(
                "source",
                "Implementation files",
                sourceFiles.length > 0 ? "pass" : "fail",
                sourceFiles.length > 0 ? `${sourceFiles.length} source file${sourceFiles.length === 1 ? "" : "s"} found.` : "Add an implementation source file.",
                25
            ),
            check(
                "manifest",
                "Project manifest",
                packageFile && manifest ? "pass" : "fail",
                packageFile && manifest ? "package.json is valid." : packageFile ? "package.json is not valid JSON." : "Add a package.json manifest.",
                15
            ),
            check(
                "tests",
                "Behavior tests",
                meaningfulTests.length > 0 ? "pass" : "fail",
                meaningfulTests.length > 0 ? `${meaningfulTests.length} test file${meaningfulTests.length === 1 ? "" : "s"} includes an assertion.` : testFiles.length > 0 ? "Tests need at least one meaningful assertion." : "Add a behavior-focused test file.",
                25
            ),
            check(
                "test-command",
                "Test command",
                hasTestScript ? "pass" : "fail",
                hasTestScript ? "npm test is configured." : "Add a test script to package.json.",
                20
            ),
            check(
                "build-command",
                "Build command",
                hasBuildScript ? "pass" : "warn",
                hasBuildScript ? "npm run build is configured." : "Optional: add a build script for compile-time checks.",
                5
            ),
            check(
                "documentation",
                "Project notes",
                readmeFile ? "pass" : "warn",
                readmeFile ? `${readmeFile.filePath} documents the project.` : "Optional: add a README with setup and usage notes.",
                10
            ),
        ];
        const score = checks.reduce((total, item) => total + (item.status === "pass" ? item.weight : 0), 0);
        const requiredChecks = checks.filter((item) => ["source", "manifest", "tests", "test-command"].includes(item.id));
        const ready = requiredChecks.every((item) => item.status === "pass");

        return {
            state: ready ? "ready" : "needs-attention",
            project,
            score,
            message: ready
                ? "Core implementation and test checks are ready. Review optional checks before delivery."
                : "Complete the failed core checks before relying on this project.",
            checks: checks.map(({ weight, ...item }) => item),
        };
    }
}
