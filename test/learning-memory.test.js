import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import LearningMemory from "../src/learning-memory.js";

test("learning memory keeps bounded, redacted lessons and retrieves relevant advice", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-memory-test-"));
    const memoryPath = path.join(root, "agent-lessons.json");
    const memory = new LearningMemory({
        filePath: memoryPath,
        now: () => new Date("2026-08-10T12:00:00.000Z"),
    });

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const stored = memory.remember({
        lesson: "When repairing authentication, validate session expiry. API_KEY=super-secret",
        tags: "authentication, session, security",
    });
    memory.remember({
        lesson: "For static previews, preserve the restricted iframe sandbox.",
        tags: "preview, security",
    });

    assert.match(stored.lesson, /API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(fs.readFileSync(memoryPath, "utf8"), /super-secret/);
    assert.deepEqual(
        memory.retrieve("Fix authentication session handling.").map((item) => item.lesson),
        [stored.lesson]
    );
});

test("learning memory rejects unsafe files and never blocks retrieval on invalid local data", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-agent-memory-test-"));
    const target = path.join(root, "outside.json");
    const memoryPath = path.join(root, "agent-lessons.json");
    fs.writeFileSync(target, "[]");
    fs.symlinkSync(target, memoryPath);

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const memory = new LearningMemory({ filePath: memoryPath });
    assert.throws(() => memory.remember({ lesson: "Keep tests focused." }), {
        code: "MEMORY_UNSAFE_FILE",
    });
    assert.deepEqual(memory.retrieve("test behavior"), []);
});
