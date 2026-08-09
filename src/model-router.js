import Nemotron from "./nemotron.js";

export const MODEL_PROFILES = Object.freeze({
    flash: Object.freeze({
        id: "deepseek-ai/deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        summary: "Fast lane",
    }),
    ultra: Object.freeze({
        id: "nvidia/nemotron-3-ultra-550b-a55b",
        label: "Nemotron 3 Ultra",
        summary: "Balanced lane",
    }),
    glm: Object.freeze({
        id: "z-ai/glm-5.2",
        label: "GLM-5.2",
        summary: "Deep-work lane",
    }),
});

export const MODEL_MODES = new Set(["auto", "flash", "ultra", "glm", "custom"]);

// Keep Auto responsive for everyday work.  A normal app or website request is
// usually an iterative task, so it starts on Flash; the heavier lanes are
// reserved for requests that explicitly signal more coordination or reasoning.
const DEEP_WORK_TASK = /\b(architect(?:ure)?|long[- ]horizon|migrat|rewrite|security|system design|threat model)\b/i;
const SUBSTANTIAL_TASK = /\b(authentication|database|deploy|full[- ]stack|large|multi[- ]file|refactor|integration|performance)\b/i;
const DEEP_WORK_LENGTH = 1_200;

function routeForTask(task) {
    if (task.length > DEEP_WORK_LENGTH || DEEP_WORK_TASK.test(task)) {
        return [MODEL_PROFILES.glm, MODEL_PROFILES.ultra, MODEL_PROFILES.flash];
    }

    if (SUBSTANTIAL_TASK.test(task)) {
        return [MODEL_PROFILES.ultra, MODEL_PROFILES.glm, MODEL_PROFILES.flash];
    }

    return [MODEL_PROFILES.flash, MODEL_PROFILES.ultra, MODEL_PROFILES.glm];
}

function routeForMode(mode, task, customModel) {
    if (mode === "custom") {
        return [{
            id: customModel,
            label: customModel,
            summary: "Custom model",
        }];
    }

    if (mode === "auto") {
        return routeForTask(task);
    }

    const selected = MODEL_PROFILES[mode];
    return [
        selected,
        ...routeForTask(task).filter((profile) => profile.id !== selected.id),
    ];
}

function isRetryableModelError(error) {
    const message = String(error?.message || error);
    return (
        /connection|network|timeout|temporar|rate limit|\b429\b|\b5\d\d\b/i.test(message) ||
        ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"].includes(error?.code)
    );
}

export default class ModelRouter {
    constructor({
        mode,
        customModel = process.env.NVIDIA_MODEL,
        createModel = (profile) => new Nemotron({ model: profile.id }),
        onRoute,
    } = {}) {
        this.mode = mode || (customModel ? "custom" : "auto");

        if (!MODEL_MODES.has(this.mode)) {
            throw new Error(`Unsupported model mode: ${this.mode}.`);
        }

        if (this.mode === "custom" && !customModel) {
            throw new Error("NVIDIA_MODEL is required when NVIDIA_MODEL_MODE is custom.");
        }

        this.customModel = customModel;
        this.createModel = createModel;
        this.onRoute = onRoute;
        this.route = null;
        this.routeIndex = 0;
        this.models = new Map();
    }

    get activeProfile() {
        return this.route?.[this.routeIndex] || null;
    }

    selectRoute(task) {
        if (this.route) {
            return this.activeProfile;
        }

        this.route = routeForMode(this.mode, task, this.customModel);
        this.notifyRoute(false);
        return this.activeProfile;
    }

    notifyRoute(fallback, error = null) {
        this.onRoute?.({
            profile: this.activeProfile,
            mode: this.mode,
            fallback,
            error: error ? String(error.message || error) : null,
        });
    }

    modelFor(profile) {
        if (!this.models.has(profile.id)) {
            this.models.set(profile.id, this.createModel(profile));
        }

        return this.models.get(profile.id);
    }

    async generate(prompt, options) {
        this.selectRoute(prompt);

        while (true) {
            try {
                return await this.modelFor(this.activeProfile).generate(prompt, options);
            } catch (error) {
                if (!isRetryableModelError(error) || this.routeIndex >= this.route.length - 1) {
                    throw error;
                }

                this.routeIndex += 1;
                this.notifyRoute(true, error);
            }
        }
    }
}
