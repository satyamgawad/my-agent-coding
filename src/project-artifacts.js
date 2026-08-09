import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

// These limits keep a preview/download endpoint from turning a generated
// project into an unbounded memory or bandwidth sink. They intentionally
// apply before a file is read into memory.
export const MAX_PREVIEW_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ARCHIVE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 500;
export const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;

const PREVIEW_CANDIDATES = ["public/index.html", "index.html"];
const PROTECTED_PATH_SEGMENTS = new Set([".git", "node_modules"]);
const SENSITIVE_PATH_SEGMENTS = new Set([
    ".aws",
    ".config",
    ".credentials",
    ".docker",
    ".gnupg",
    ".kube",
    ".netrc",
    ".npmrc",
    ".secrets",
    ".ssh",
    "authorized_keys",
    "credentials",
    "known_hosts",
]);

function artifactError(message, code, status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function isInside(parent, candidate) {
    return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function isProtectedSegment(segment) {
    const lowerCaseSegment = segment.toLowerCase();

    return (
        !segment ||
        segment.includes("\\") ||
        PROTECTED_PATH_SEGMENTS.has(lowerCaseSegment) ||
        SENSITIVE_PATH_SEGMENTS.has(lowerCaseSegment) ||
        lowerCaseSegment === ".env" ||
        lowerCaseSegment.startsWith(".env.") ||
        lowerCaseSegment.endsWith(".pem") ||
        lowerCaseSegment.endsWith(".key") ||
        lowerCaseSegment.endsWith(".p12") ||
        lowerCaseSegment.endsWith(".pfx") ||
        lowerCaseSegment.startsWith("id_")
    );
}

function relativePathSegments(relativePath, { allowEmpty = false } = {}) {
    if (typeof relativePath !== "string" || relativePath.includes("\0")) {
        throw artifactError("Preview path is invalid.", "PREVIEW_ASSET_NOT_FOUND", 404);
    }

    if (!relativePath && allowEmpty) {
        return [];
    }

    if (
        !relativePath ||
        path.isAbsolute(relativePath) ||
        path.win32.isAbsolute(relativePath) ||
        relativePath.includes("\\")
    ) {
        throw artifactError("Preview asset was not found.", "PREVIEW_ASSET_NOT_FOUND", 404);
    }

    const segments = relativePath.split("/");

    if (
        segments.some(
            (segment) =>
                segment === "." ||
                segment === ".." ||
                isProtectedSegment(segment)
        )
    ) {
        throw artifactError("Preview asset was not found.", "PREVIEW_ASSET_NOT_FOUND", 404);
    }

    return segments;
}

function decodePreviewPath(encodedPath) {
    try {
        return decodeURIComponent(encodedPath);
    } catch {
        throw artifactError("Preview asset was not found.", "PREVIEW_ASSET_NOT_FOUND", 404);
    }
}

function inaccessibleFileError() {
    return artifactError("Preview asset was not found.", "PREVIEW_ASSET_NOT_FOUND", 404);
}

function regularFileAt(workspace, relativePath) {
    const segments = relativePathSegments(relativePath);
    let candidate = workspace;

    for (let index = 0; index < segments.length; index += 1) {
        candidate = path.join(candidate, segments[index]);
        let details;

        try {
            details = fs.lstatSync(candidate);
        } catch {
            throw inaccessibleFileError();
        }

        // Do not follow any symlink, including a link that still points back
        // inside the active project. This makes the public route's boundary
        // easier to reason about and avoids link-swap surprises.
        if (details.isSymbolicLink()) {
            throw inaccessibleFileError();
        }

        if (index < segments.length - 1 && !details.isDirectory()) {
            throw inaccessibleFileError();
        }

        if (index === segments.length - 1 && !details.isFile()) {
            throw inaccessibleFileError();
        }
    }

    let resolved;

    try {
        resolved = fs.realpathSync(candidate);
    } catch {
        throw inaccessibleFileError();
    }

    if (!isInside(workspace, resolved)) {
        throw inaccessibleFileError();
    }

    let details;

    try {
        details = fs.statSync(resolved);
    } catch {
        throw inaccessibleFileError();
    }

    if (!details.isFile()) {
        throw inaccessibleFileError();
    }

    return { path: resolved, details };
}

function previewRootFor(workspace) {
    for (const candidate of PREVIEW_CANDIDATES) {
        try {
            const file = regularFileAt(workspace, candidate);

            if (file.details.size > MAX_PREVIEW_FILE_BYTES) {
                continue;
            }

            return {
                indexPath: candidate,
                rootPath: path.dirname(candidate) === "." ? "" : path.dirname(candidate),
                file,
            };
        } catch {
            // A missing or unsafe public/index.html must not prevent a safe
            // root index.html from being used as the project's preview.
        }
    }

    return null;
}

function mimeType(filePath) {
    switch (path.extname(filePath).toLowerCase()) {
        case ".html":
        case ".htm":
            return "text/html; charset=utf-8";
        case ".css":
            return "text/css; charset=utf-8";
        case ".js":
        case ".mjs":
            return "text/javascript; charset=utf-8";
        case ".json":
        case ".webmanifest":
            return "application/json; charset=utf-8";
        case ".svg":
            return "image/svg+xml";
        case ".png":
            return "image/png";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        case ".gif":
            return "image/gif";
        case ".webp":
            return "image/webp";
        case ".avif":
            return "image/avif";
        case ".ico":
            return "image/x-icon";
        case ".woff":
            return "font/woff";
        case ".woff2":
            return "font/woff2";
        case ".ttf":
            return "font/ttf";
        case ".otf":
            return "font/otf";
        case ".mp3":
            return "audio/mpeg";
        case ".wav":
            return "audio/wav";
        case ".mp4":
            return "video/mp4";
        case ".webm":
            return "video/webm";
        default:
            return null;
    }
}

function archivePathParts(archivePath) {
    const byteLength = Buffer.byteLength(archivePath, "utf8");

    if (byteLength <= 100) {
        return { name: archivePath, prefix: "" };
    }

    const separator = archivePath.lastIndexOf("/");

    if (separator > 0) {
        const prefix = archivePath.slice(0, separator);
        const name = archivePath.slice(separator + 1);

        if (
            Buffer.byteLength(name, "utf8") <= 100 &&
            Buffer.byteLength(prefix, "utf8") <= 155
        ) {
            return { name, prefix };
        }
    }

    throw artifactError(
        "A project source path is too long to include in the download.",
        "PROJECT_ARCHIVE_PATH_TOO_LONG",
        413
    );
}

function writeText(header, offset, length, value) {
    const source = Buffer.from(value, "utf8");
    source.copy(header, offset, 0, Math.min(source.length, length));
}

function writeOctal(header, offset, length, value) {
    const encoded = value.toString(8);

    if (encoded.length > length - 1) {
        throw artifactError("The source download could not be created.", "PROJECT_ARCHIVE_FAILED", 500);
    }

    writeText(header, offset, length, `${encoded.padStart(length - 1, "0")}\0`);
}

function tarHeader(archivePath, size, modifiedAt) {
    const { name, prefix } = archivePathParts(archivePath);
    const header = Buffer.alloc(512, 0);

    writeText(header, 0, 100, name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, size);
    writeOctal(header, 136, 12, Math.max(0, Math.floor(modifiedAt / 1000)));
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeText(header, 257, 6, "ustar\0");
    writeText(header, 263, 2, "00");
    writeText(header, 265, 32, "coding-agent");
    writeText(header, 297, 32, "coding-agent");
    writeText(header, 345, 155, prefix);

    let checksum = 0;
    for (const byte of header) {
        checksum += byte;
    }
    writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);

    return header;
}

function tarEntry(archivePath, contents, modifiedAt) {
    const padding = (512 - (contents.length % 512)) % 512;
    return Buffer.concat([
        tarHeader(archivePath, contents.length, modifiedAt),
        contents,
        Buffer.alloc(padding),
    ]);
}

function safeArchiveFiles(workspace) {
    const files = [];
    let totalBytes = 0;

    function collect(directory, relativeDirectory = "") {
        let entries;

        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            throw artifactError("The active project could not be read.", "PROJECT_ARCHIVE_FAILED", 500);
        }

        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (entry.isSymbolicLink() || isProtectedSegment(entry.name)) {
                continue;
            }

            const relativePath = relativeDirectory
                ? `${relativeDirectory}/${entry.name}`
                : entry.name;
            const fullPath = path.join(directory, entry.name);
            let details;

            try {
                details = fs.lstatSync(fullPath);
            } catch {
                continue;
            }

            if (details.isSymbolicLink()) {
                continue;
            }

            if (details.isDirectory()) {
                collect(fullPath, relativePath);
                continue;
            }

            if (!details.isFile()) {
                continue;
            }

            if (details.size > MAX_ARCHIVE_FILE_BYTES) {
                throw artifactError(
                    `A project file is larger than ${MAX_ARCHIVE_FILE_BYTES} bytes.`,
                    "PROJECT_ARCHIVE_TOO_LARGE",
                    413
                );
            }

            if (files.length >= MAX_ARCHIVE_FILES || totalBytes + details.size > MAX_ARCHIVE_BYTES) {
                throw artifactError(
                    "The active project is too large to download safely.",
                    "PROJECT_ARCHIVE_TOO_LARGE",
                    413
                );
            }

            let resolvedPath;
            try {
                resolvedPath = fs.realpathSync(fullPath);
            } catch {
                continue;
            }

            if (!isInside(workspace, resolvedPath)) {
                continue;
            }

            files.push({ relativePath, details });
            totalBytes += details.size;
        }
    }

    collect(workspace);
    return files;
}

function readBoundedFile(workspace, relativePath, maximumBytes, errorCode, errorMessage) {
    // Resolve every segment again immediately before the read. In particular,
    // this refuses a directory or file that was changed to a symlink after a
    // route or archive walk first inspected it.
    const file = regularFileAt(workspace, relativePath);

    if (file.details.size > maximumBytes) {
        throw artifactError(errorMessage, errorCode, 413);
    }

    let contents;
    try {
        contents = fs.readFileSync(file.path);
    } catch {
        throw inaccessibleFileError();
    }

    if (contents.length > maximumBytes) {
        throw artifactError(errorMessage, errorCode, 413);
    }

    return { contents, details: file.details };
}

export default class ProjectArtifacts {
    constructor(workspaceManager) {
        this.workspaceManager = workspaceManager;
    }

    activeProject() {
        const context = this.workspaceManager.getContext();

        if (!context.project) {
            throw artifactError(
                "Select a project before opening its preview.",
                "NO_ACTIVE_PROJECT",
                409
            );
        }

        return {
            project: context.project,
            workspace: this.workspaceManager.getActiveWorkspace(),
        };
    }

    previewStatus() {
        const { project, workspace } = this.activeProject();
        const preview = previewRootFor(workspace);

        if (!preview) {
            return {
                state: "unavailable",
                available: false,
                project,
                url: null,
                downloadUrl: "/api/projects/download",
                message: "This project has no safe public/index.html or index.html file to preview.",
            };
        }

        return {
            state: "ready",
            available: true,
            project,
            url: "/api/projects/preview/",
            downloadUrl: "/api/projects/download",
            message: null,
        };
    }

    readPreviewFile(encodedPath = "") {
        const { workspace } = this.activeProject();
        const preview = previewRootFor(workspace);

        if (!preview) {
            throw artifactError(
                "This project has no safe static page to preview.",
                "STATIC_PREVIEW_NOT_FOUND",
                404
            );
        }

        const requestPath = decodePreviewPath(encodedPath);
        const requestSegments = relativePathSegments(requestPath, { allowEmpty: true });
        const baseSegments = preview.rootPath ? relativePathSegments(preview.rootPath) : [];
        const relativePath = [...baseSegments, ...(requestSegments.length ? requestSegments : ["index.html"])].join("/");
        const file = regularFileAt(workspace, relativePath);
        const contentType = mimeType(relativePath);

        if (!contentType) {
            throw inaccessibleFileError();
        }

        if (file.details.size > MAX_PREVIEW_FILE_BYTES) {
            throw artifactError(
                `Preview files must be smaller than ${MAX_PREVIEW_FILE_BYTES} bytes.`,
                "PREVIEW_ASSET_TOO_LARGE",
                413
            );
        }

        return {
            contents: readBoundedFile(
                workspace,
                relativePath,
                MAX_PREVIEW_FILE_BYTES,
                "PREVIEW_ASSET_TOO_LARGE",
                `Preview files must be smaller than ${MAX_PREVIEW_FILE_BYTES} bytes.`
            ).contents,
            contentType,
        };
    }

    createSourceArchive() {
        const { project, workspace } = this.activeProject();
        const files = safeArchiveFiles(workspace);

        if (files.length === 0) {
            throw artifactError(
                "The active project has no downloadable source files.",
                "PROJECT_ARCHIVE_EMPTY",
                404
            );
        }

        let totalBytes = 0;
        const entries = files.map((file) => {
            const loaded = readBoundedFile(
                workspace,
                file.relativePath,
                MAX_ARCHIVE_FILE_BYTES,
                "PROJECT_ARCHIVE_TOO_LARGE",
                `A project file is larger than ${MAX_ARCHIVE_FILE_BYTES} bytes.`
            );
            totalBytes += loaded.contents.length;

            if (totalBytes > MAX_ARCHIVE_BYTES) {
                throw artifactError(
                    "The active project is too large to download safely.",
                    "PROJECT_ARCHIVE_TOO_LARGE",
                    413
                );
            }

            return tarEntry(`${project}/${file.relativePath}`, loaded.contents, loaded.details.mtimeMs);
        });
        const archive = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

        return {
            project,
            filename: `${project}-source.tar.gz`,
            contents: archive,
        };
    }
}
