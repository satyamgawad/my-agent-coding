import fs from "node:fs";
import path from "node:path";

const MEMORY_DIRECTORY = ".agent-data";
const MEMORY_FILE = "agent-lessons.json";
const MAX_LESSONS = 80;
const MAX_LESSON_CHARS = 600;
const MAX_TAGS = 5;
const MAX_FILE_BYTES = 128 * 1024;
const STOP_WORDS = new Set([
    "about", "after", "agent", "build", "change", "code", "from", "have",
    "improve", "into", "make", "project", "should", "that", "the", "this",
    "with", "your",
]);

function memoryError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isInside(parent, candidate) {
    return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function sanitizeLesson(value) {
    if (typeof value !== "string") {
        throw memoryError("A lesson must be text.", "INVALID_LESSON");
    }

    const compact = value
        .replace(/\s+/g, " ")
        .replace(
            /(?:api[_-]?key|access[_-]?token|token|password|secret)\s*(?:=|:)\s*[^\s,;]+/gi,
            (match) => `${match.split(/\s*(?:=|:)\s*/)[0]}=[REDACTED]`
        )
        .trim();

    if (!compact) {
        throw memoryError("A lesson cannot be empty.", "INVALID_LESSON");
    }

    return compact.slice(0, MAX_LESSON_CHARS);
}

function sanitizeTags(value) {
    if (typeof value !== "string") {
        return [];
    }

    return [...new Set(value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((tag) => tag.length >= 2 && tag.length <= 32)
    )].slice(0, MAX_TAGS);
}

function taskTerms(value) {
    return new Set(
        String(value || "")
            .toLowerCase()
            .match(/[a-z0-9]{3,}/g)
            ?.filter((term) => !STOP_WORDS.has(term)) || []
    );
}

function isLesson(value) {
    return value &&
        typeof value === "object" &&
        typeof value.lesson === "string" &&
        Array.isArray(value.tags) &&
        typeof value.createdAt === "string";
}

export default class LearningMemory {
    constructor({ workspaceManager, filePath, now = () => new Date() } = {}) {
        if (!workspaceManager && !filePath) {
            throw new TypeError("Learning memory needs a workspace manager or file path.");
        }

        this.workspaceManager = workspaceManager || null;
        this.filePath = filePath ? path.resolve(filePath) : null;
        this.now = now;
    }

    resolveFilePath() {
        if (this.filePath) {
            return this.filePath;
        }

        const projectsRoot = this.workspaceManager.resolveProjectsRoot({ create: true });
        const directory = path.join(projectsRoot, MEMORY_DIRECTORY);

        if (!isInside(projectsRoot, directory)) {
            throw memoryError("Learning memory is outside the projects directory.", "MEMORY_OUTSIDE_PROJECTS");
        }

        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }

        const details = fs.lstatSync(directory);

        if (!details.isDirectory() || details.isSymbolicLink()) {
            throw memoryError("Learning memory must use a local directory.", "MEMORY_UNSAFE_DIRECTORY");
        }

        const resolvedDirectory = fs.realpathSync(directory);

        if (!isInside(projectsRoot, resolvedDirectory)) {
            throw memoryError("Learning memory resolves outside the projects directory.", "MEMORY_OUTSIDE_PROJECTS");
        }

        return path.join(resolvedDirectory, MEMORY_FILE);
    }

    readAll() {
        const filePath = this.resolveFilePath();

        if (!fs.existsSync(filePath)) {
            return [];
        }

        const details = fs.lstatSync(filePath);

        if (!details.isFile() || details.isSymbolicLink()) {
            throw memoryError("Learning memory must be a local file.", "MEMORY_UNSAFE_FILE");
        }

        if (details.size > MAX_FILE_BYTES) {
            throw memoryError("Learning memory is too large to use safely.", "MEMORY_TOO_LARGE");
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            return Array.isArray(parsed) ? parsed.filter(isLesson).slice(-MAX_LESSONS) : [];
        } catch {
            throw memoryError("Learning memory is not valid local data.", "MEMORY_INVALID");
        }
    }

    writeAll(lessons) {
        const filePath = this.resolveFilePath();
        const temporaryPath = `${filePath}.tmp`;
        fs.writeFileSync(temporaryPath, `${JSON.stringify(lessons, null, 2)}\n`, "utf8");
        fs.renameSync(temporaryPath, filePath);
    }

    remember({ lesson, tags } = {}) {
        const cleanLesson = sanitizeLesson(lesson);
        const cleanTags = sanitizeTags(tags);
        const lessons = this.readAll();
        const duplicate = lessons.find((item) => item.lesson.toLowerCase() === cleanLesson.toLowerCase());

        if (duplicate) {
            duplicate.tags = [...new Set([...duplicate.tags, ...cleanTags])].slice(0, MAX_TAGS);
            this.writeAll(lessons);
            return { ...duplicate, updated: true };
        }

        const entry = {
            lesson: cleanLesson,
            tags: cleanTags,
            createdAt: this.now().toISOString(),
        };
        const updated = [...lessons, entry].slice(-MAX_LESSONS);
        this.writeAll(updated);
        return { ...entry, updated: false };
    }

    retrieve(task, limit = 3) {
        const terms = taskTerms(task);

        try {
            return this.readAll()
                .map((lesson, index) => {
                    const lessonTerms = taskTerms(`${lesson.lesson} ${lesson.tags.join(" ")}`);
                    const score = [...terms].reduce(
                        (total, term) => total + (lesson.tags.includes(term) ? 4 : lessonTerms.has(term) ? 1 : 0),
                        0
                    );
                    return { ...lesson, score, index };
                })
                .filter((lesson) => lesson.score > 0)
                .sort((left, right) => right.score - left.score || right.index - left.index)
                .slice(0, Math.min(Math.max(Number(limit) || 0, 0), 5))
                .map(({ lesson, tags, createdAt }) => ({ lesson, tags, createdAt }));
        } catch {
            // Memory is optional assistance. A damaged local lesson file must
            // never block normal coding work.
            return [];
        }
    }
}
