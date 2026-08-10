import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DATABASE_DIRECTORY = ".agent-data";
const DATABASE_FILE = "task-history.sqlite";
const MAX_RECORDS = 50;

function historyError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isInside(parent, candidate) {
    return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function cleanText(value, maximumLength = 120) {
    if (typeof value !== "string") {
        return null;
    }

    const text = value.trim();
    return text ? text.slice(0, maximumLength) : null;
}

function cleanDuration(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function cleanLimit(value) {
    return Number.isInteger(value) && value > 0
        ? Math.min(value, MAX_RECORDS)
        : 12;
}

export default class TaskHistory {
    constructor({ workspaceManager, databasePath } = {}) {
        if (!workspaceManager && !databasePath) {
            throw new TypeError("Task history needs a workspace manager or database path.");
        }

        this.workspaceManager = workspaceManager || null;
        this.databasePath = databasePath ? path.resolve(databasePath) : null;
    }

    resolveDatabasePath() {
        if (this.databasePath) {
            return this.databasePath;
        }

        const projectsRoot = this.workspaceManager.resolveProjectsRoot({ create: true });
        const directory = path.join(projectsRoot, DATABASE_DIRECTORY);

        if (!isInside(projectsRoot, directory)) {
            throw historyError("Task history storage is outside the projects directory.", "HISTORY_OUTSIDE_PROJECTS");
        }

        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }

        const details = fs.lstatSync(directory);

        if (!details.isDirectory() || details.isSymbolicLink()) {
            throw historyError("Task history storage must be a local directory.", "HISTORY_UNSAFE_DIRECTORY");
        }

        const resolvedDirectory = fs.realpathSync(directory);

        if (!isInside(projectsRoot, resolvedDirectory)) {
            throw historyError("Task history storage resolves outside the projects directory.", "HISTORY_OUTSIDE_PROJECTS");
        }

        return path.join(resolvedDirectory, DATABASE_FILE);
    }

    open() {
        const databasePath = this.resolveDatabasePath();

        if (fs.existsSync(databasePath)) {
            const details = fs.lstatSync(databasePath);

            if (!details.isFile() || details.isSymbolicLink()) {
                throw historyError("Task history database must be a local file.", "HISTORY_UNSAFE_DATABASE");
            }
        }

        const database = new DatabaseSync(databasePath);
        database.exec(`
            CREATE TABLE IF NOT EXISTS task_history (
                id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL,
                project TEXT,
                model TEXT,
                status TEXT NOT NULL CHECK (status IN ('complete', 'failed', 'cancelled')),
                duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0)
            ) STRICT;
            CREATE INDEX IF NOT EXISTS task_history_created_at ON task_history (id DESC);
        `);
        return database;
    }

    record({ createdAt = new Date().toISOString(), project, model, ok = false, cancelled = false, durationMs = 0 } = {}) {
        const database = this.open();

        try {
            const status = cancelled ? "cancelled" : ok ? "complete" : "failed";
            const entry = {
                createdAt: typeof createdAt === "string" ? createdAt : new Date().toISOString(),
                project: cleanText(project, 64),
                model: cleanText(model, 120),
                status,
                durationMs: cleanDuration(durationMs),
            };
            const result = database.prepare(`
                INSERT INTO task_history (created_at, project, model, status, duration_ms)
                VALUES (?, ?, ?, ?, ?)
            `).run(entry.createdAt, entry.project, entry.model, entry.status, entry.durationMs);

            // Keep the on-disk history bounded as well as the dashboard view.
            // Without this pruning, the read limit would hide an ever-growing
            // SQLite file on a persistent deployment volume.
            database.prepare(`
                DELETE FROM task_history
                WHERE id NOT IN (
                    SELECT id FROM task_history
                    ORDER BY id DESC
                    LIMIT ?
                )
            `).run(MAX_RECORDS);

            return { id: Number(result.lastInsertRowid), ...entry };
        } finally {
            database.close();
        }
    }

    recent(limit) {
        const database = this.open();

        try {
            return database.prepare(`
                SELECT id, created_at AS createdAt, project, model, status, duration_ms AS durationMs
                FROM task_history
                ORDER BY id DESC
                LIMIT ?
            `).all(cleanLimit(limit)).map((record) => ({ ...record }));
        } finally {
            database.close();
        }
    }
}
