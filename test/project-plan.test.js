import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createTestWorkspace } from "./helpers.js";

test("private project plans persist ordered milestones without entering generated source", (t) => {
    const { root, tools } = createTestWorkspace(t);
    tools.createProject.execute({ name: "Launch Platform" });

    const created = tools.createProjectPlan.execute({
        goal: "Ship the core platform in small verified milestones.",
        milestones: [
            {
                id: "foundation",
                title: "Foundation",
                description: "Set up the core architecture and tests.",
            },
            {
                id: "delivery",
                title: "Delivery",
                description: "Verify and prepare the delivered workflow.",
                dependsOn: ["foundation"],
            },
        ],
    });

    assert.equal(created.state, "active");
    assert.deepEqual(created.progress, { completed: 0, total: 2 });
    assert.equal(tools.listFiles.execute({ directory: "." }).includes(".agent-data"), false);
    assert.equal(
        fs.existsSync(path.join(root, "projects", ".agent-data", "project-plans", "launch-platform.json")),
        true
    );
    assert.throws(
        () => tools.updateMilestone.execute({ id: "delivery", status: "in_progress" }),
        { code: "MILESTONE_DEPENDENCY_INCOMPLETE" }
    );

    tools.updateMilestone.execute({ id: "foundation", status: "in_progress" });
    tools.updateMilestone.execute({ id: "foundation", status: "completed", notes: "Core checks passed." });
    tools.updateMilestone.execute({ id: "delivery", status: "in_progress" });
    const completed = tools.updateMilestone.execute({ id: "delivery", status: "completed" });

    assert.equal(completed.state, "completed");
    assert.deepEqual(completed.progress, { completed: 2, total: 2 });
    assert.equal(completed.milestones[0].notes, "Core checks passed.");
    assert.equal(tools.readProjectPlan.execute({}).state, "completed");
    assert.throws(
        () => tools.updateMilestone.execute({ id: "foundation", status: "pending" }),
        { code: "MILESTONE_DEPENDENT_ACTIVE" }
    );
});

test("project plans reject unsafe dependency graphs and malformed saved metadata", (t) => {
    const { root, tools } = createTestWorkspace(t);
    tools.createProject.execute({ name: "Plan Safety" });

    assert.throws(
        () => tools.createProjectPlan.execute({
            goal: "Unsafe plan",
            milestones: [
                { id: "first", title: "First", dependsOn: ["second"] },
                { id: "second", title: "Second" },
            ],
        }),
        { code: "INVALID_PROJECT_PLAN" }
    );

    const planPath = path.join(root, "projects", ".agent-data", "project-plans", "plan-safety.json");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, JSON.stringify({ version: 1, project: "plan-safety", goal: "bad", milestones: [] }));

    assert.throws(
        () => tools.readProjectPlan.execute({}),
        { code: "PROJECT_PLAN_INVALID" }
    );
});
