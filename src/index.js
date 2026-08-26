import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import Agent from "./agent.js";
import ModelRouter from "./model-router.js";
import Nemotron from "./nemotron.js";
import ProjectSession, { AGENT_CONVERSATION_ID } from "./project-session.js";
import WorkspaceManager from "./workspace.js";

const TOOL_PROGRESS = {
    createProject: "Created project",
    listProjects: "Listed projects",
    selectProject: "Selected project",
    listFiles: "Listed files",
    projectTree: "Inspected project structure",
    projectReadiness: "Checked project readiness",
    createProjectPlan: "Saved project milestones",
    readProjectPlan: "Read project milestones",
    updateMilestone: "Updated a milestone",
    readFile: "Read file",
    writeFile: "Wrote file",
    editFile: "Updated file",
    terminal: "Ran development command",
    test: "Ran tests",
};

export function parseArguments(argumentsList) {
    const debug = argumentsList.includes("--debug");
    const help = argumentsList.includes("--help") || argumentsList.includes("-h");
    const task = argumentsList
        .filter((argument) => !["--debug", "--help", "-h"].includes(argument))
        .join(" ")
        .trim();

    return { debug, help, task };
}

function createReporter(debug) {
    return ({ message, details }) => {
        if (details?.tool) {
            const action = TOOL_PROGRESS[details.tool] || details.tool;
            const project = details.result?.project;
            const suffix = project ? ` “${project}”` : "";
            console.log(`${details.ok ? "✓" : "✗"} ${action}${suffix}`);
        } else if (message.startsWith("model: retrying")) {
            console.log("↻ Reconnecting to the model…");
        } else if (message.startsWith("model: using")) {
            console.log(`◌ ${message.slice("model: ".length)}`);
        } else if (message.startsWith("model: switched")) {
            console.log(`↳ ${message.slice("model: ".length)}`);
        } else {
            console.log(message);
        }

        if (!debug && details && !details.ok) {
            console.error(`  ${details.error.code}: ${details.error.message}`);
        }

        if (debug && details) {
            console.error("[debug]", JSON.stringify(details));
        }
    };
}

export function createAgent(debug) {
    const workspaceManager = new WorkspaceManager({ agentRoot: process.cwd() });
    const report = createReporter(debug);
    const model = new ModelRouter({
        createModel: (profile) => new Nemotron({ debug, model: profile.id, endpoint: profile.endpoint }),
        onRoute: ({ profile, fallback }) => {
            report({
                message: `model: ${fallback ? "switched to" : "using"} ${profile.label}`,
            });
        },
    });
    return new Agent(model, {
        workspaceManager,
        onEvent: report,
    });
}

export function taskFailed(result) {
    return typeof result === "string" && (
        result.startsWith("❌") || result.startsWith("Stopped after")
    );
}

export async function runOneTask(agent, task, { sessionContext } = {}) {
    console.log("\nWorking…");
    const result = await agent.run(task, { sessionContext });
    console.log(`\n${taskFailed(result) ? "Agent could not complete the task" : "Agent"}: ${result}`);
    return result;
}

/**
 * Run a task with the same bounded conversation used by the dashboard. Local
 * conversation storage is helpful context, not a dependency for completing a
 * task, so a damaged or unavailable history never blocks the agent.
 */
export async function runRememberedTask(agent, task, projectSession) {
    let sessionContext = [];

    try {
        sessionContext = projectSession?.recent(AGENT_CONVERSATION_ID) || [];
    } catch {
        console.warn("⚠ Saved conversation is unavailable; continuing without prior context.");
    }

    const result = await runOneTask(agent, task, { sessionContext });

    try {
        projectSession?.record(AGENT_CONVERSATION_ID, { task, outcome: result });
    } catch {
        console.warn("⚠ Task finished, but its conversation context could not be saved.");
    }

    return result;
}

async function runInteractive(agent) {
    const terminal = createInterface({ input: stdin, output: stdout });
    const projectSession = new ProjectSession({ workspaceManager: agent.workspaceManager });
    let interrupted = false;
    console.log("🤖 My Coding Agent");
    console.log("Describe a coding task. Type exit or quit when you are finished.\n");

    terminal.on("SIGINT", () => {
        interrupted = true;
        console.log("\nAgent: Goodbye.");
        terminal.close();
    });

    try {
        while (!interrupted) {
            let task;

            try {
                task = (await terminal.question("You: ")).trim();
            } catch (error) {
                if (interrupted) {
                    break;
                }

                throw error;
            }

            if (!task) {
                continue;
            }

            if (["exit", "quit"].includes(task.toLowerCase())) {
                console.log("Agent: Goodbye.");
                break;
            }

            await runRememberedTask(agent, task, projectSession);
            console.log("");
        }
    } finally {
        terminal.close();
    }
}

export async function main() {
    const { debug, help, task } = parseArguments(process.argv.slice(2));

    if (help) {
        console.log("Usage: npm start [-- --debug] [\"coding task\"]");
        console.log("With no task, starts an interactive coding session.");
        return;
    }

    const agent = createAgent(debug);
    const projectSession = new ProjectSession({ workspaceManager: agent.workspaceManager });

    if (task) {
        const result = await runRememberedTask(agent, task, projectSession);
        if (taskFailed(result)) {
            process.exitCode = 1;
        }
        return;
    }

    await runInteractive(agent);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error("❌ Agent could not start:", error.message);
        process.exitCode = 1;
    });
}
