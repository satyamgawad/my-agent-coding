export const ALLOWED_TERMINAL_COMMANDS = [
    "pwd",
    "ls",
    "npm install",
    "npm test",
    "npm run build",
    "node --version",
    "node --check <relative-file>",
];

function isAllowedTerminalCommand(command) {
    if (
        [
            "pwd",
            "ls",
            "npm install",
            "npm test",
            "npm run build",
            "node --version",
        ].includes(command)
    ) {
        return true;
    }

    return /^node --check (?![-/])[^\s]+$/.test(command);
}

export const TOOL_ARGUMENT_SCHEMAS = {
    createProject: {
        required: { name: { type: "string", nonEmpty: true } },
    },
    listProjects: {},
    selectProject: {
        required: { name: { type: "string", nonEmpty: true } },
    },
    listFiles: {
        required: { directory: { type: "string", nonEmpty: true } },
    },
    readFile: {
        required: { filePath: { type: "string", nonEmpty: true } },
    },
    writeFile: {
        required: {
            filePath: { type: "string", nonEmpty: true },
            content: { type: "string" },
        },
    },
    editFile: {
        required: {
            filePath: { type: "string", nonEmpty: true },
            oldText: { type: "string", nonEmpty: true },
            newText: { type: "string" },
        },
        optional: { replaceAll: { type: "boolean" } },
    },
    projectTree: {
        required: { directory: { type: "string", nonEmpty: true } },
    },
    terminal: {
        required: { command: { type: "string", nonEmpty: true } },
    },
    test: {},
    rememberLesson: {
        required: { lesson: { type: "string", nonEmpty: true } },
        optional: { tags: { type: "string" } },
    },
    readAgentSource: {
        required: { filePath: { type: "string", nonEmpty: true } },
    },
    writeAgentSource: {
        required: {
            filePath: { type: "string", nonEmpty: true },
            content: { type: "string" },
        },
    },
    editAgentSource: {
        required: {
            filePath: { type: "string", nonEmpty: true },
            oldText: { type: "string", nonEmpty: true },
            newText: { type: "string" },
        },
        optional: { replaceAll: { type: "boolean" } },
    },
    testAgentSource: {},
};

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateField(name, value, rules) {
    if (typeof value !== rules.type) {
        return `${name} must be a ${rules.type}.`;
    }

    if (rules.nonEmpty && !value.trim()) {
        return `${name} must be a non-empty string.`;
    }

    return null;
}

export function validateToolArguments(toolName, toolArguments) {
    const schema = TOOL_ARGUMENT_SCHEMAS[toolName];

    if (!schema) {
        return {
            valid: false,
            error: `No argument schema is defined for ${toolName}.`,
        };
    }

    if (!isPlainObject(toolArguments)) {
        return { valid: false, error: "arguments must be an object." };
    }

    const required = schema.required ?? {};
    const optional = schema.optional ?? {};
    const allowedNames = new Set([
        ...Object.keys(required),
        ...Object.keys(optional),
    ]);

    for (const name of Object.keys(toolArguments)) {
        if (!allowedNames.has(name)) {
            return { valid: false, error: `unknown argument: ${name}.` };
        }
    }

    for (const [name, rules] of Object.entries(required)) {
        if (!(name in toolArguments)) {
            return {
                valid: false,
                error: `missing required argument: ${name}.`,
            };
        }

        const error = validateField(name, toolArguments[name], rules);

        if (error) {
            return { valid: false, error };
        }
    }

    for (const [name, rules] of Object.entries(optional)) {
        if (!(name in toolArguments)) {
            continue;
        }

        const error = validateField(name, toolArguments[name], rules);

        if (error) {
            return { valid: false, error };
        }
    }

    if (
        toolName === "terminal" &&
        !isAllowedTerminalCommand(toolArguments.command)
    ) {
        return {
            valid: false,
            error: `command must be one of: ${ALLOWED_TERMINAL_COMMANDS.join(", ")}.`,
        };
    }

    return { valid: true };
}
