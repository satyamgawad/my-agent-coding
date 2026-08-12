import Nemotron from "./nemotron.js";

export const MODEL_PROFILES = Object.freeze({
    nano: Object.freeze({
        id: "nvidia/nemotron-3-nano-30b-a3b",
        label: "Nemotron 3 Nano",
        summary: "Fast lane",
    }),
    oss: Object.freeze({
        id: "openai/gpt-oss-20b",
        label: "GPT-OSS 20B",
        summary: "Responsive open-weight lane",
    }),
    llama: Object.freeze({
        id: "meta/llama-3.3-70b-instruct",
        label: "Llama 3.3 70B",
        summary: "General coding lane",
    }),
    kimi: Object.freeze({
        id: "moonshotai/kimi-k2.6",
        label: "Kimi K2.6",
        summary: "Agentic coding lane",
    }),
    oss120: Object.freeze({
        id: "openai/gpt-oss-120b",
        label: "GPT-OSS 120B",
        summary: "Deep open-weight lane",
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

// "flash" is retained only so an older NVIDIA_MODEL_MODE=flash setting keeps
// working after DeepSeek's removal. The dashboard exposes the clear "nano"
// name and all new model selections.
const LEGACY_MODEL_MODE_ALIASES = Object.freeze({ flash: "nano" });
export const MODEL_MODES = new Set([
    "auto", "smart", "nano", "oss", "llama", "kimi", "oss120", "ultra", "glm", "custom", "flash",
]);

const UNAVAILABLE_MODEL_TTL_MS = 15 * 60 * 1_000;

// Keep Auto responsive for everyday work. A normal app or website request
// starts with Nano; larger open-weight lanes are reserved for tasks that
// explicitly signal more coordination or reasoning.
const DEEP_WORK_TASK = /\b(architect(?:ure)?|long[- ]horizon|migrat|rewrite|security|system design|threat model)\b/i;
const PROJECT_WIDE_TASK = /\b(?:whole|entire|full)\s+(?:project|codebase|repository)\b|\b(?:audit|code review|security review|regression|test coverage)\b|\b(?:polish|upgrade|improve|harden|refactor)\b[\s\S]{0,64}\b(?:agent|project|codebase|repository|application|dashboard)\b/i;
const SUBSTANTIAL_TASK = /\b(authentication|database|deploy|full[- ]stack|large|multi[- ]file|refactor|integration|performance)\b/i;
const DEEP_WORK_LENGTH = 1_200;

function routeForTask(task) {
    if (task.length > DEEP_WORK_LENGTH || DEEP_WORK_TASK.test(task) || PROJECT_WIDE_TASK.test(task)) {
        return [
            MODEL_PROFILES.glm,
            MODEL_PROFILES.kimi,
            MODEL_PROFILES.oss120,
            MODEL_PROFILES.ultra,
            MODEL_PROFILES.llama,
            MODEL_PROFILES.oss,
            MODEL_PROFILES.nano,
        ];
    }

    if (SUBSTANTIAL_TASK.test(task)) {
        return [
            MODEL_PROFILES.ultra,
            MODEL_PROFILES.kimi,
            MODEL_PROFILES.glm,
            MODEL_PROFILES.oss120,
            MODEL_PROFILES.llama,
            MODEL_PROFILES.oss,
            MODEL_PROFILES.nano,
        ];
    }

    return [
        MODEL_PROFILES.nano,
        MODEL_PROFILES.oss,
        MODEL_PROFILES.llama,
        MODEL_PROFILES.ultra,
        MODEL_PROFILES.glm,
        MODEL_PROFILES.kimi,
        MODEL_PROFILES.oss120,
    ];
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

    if (mode === "smart") {
        if (customModel) {
            return [{
                id: customModel,
                label: customModel,
                summary: "Smart fine-tuned custom model",
            }];
        }

        // Smart mode spends an extra model call on an implementation brief and
        // another on an independent final review. Start it on the deepest
        // route so those deliberate passes improve judgement, not only speed.
        return [
            MODEL_PROFILES.glm,
            MODEL_PROFILES.kimi,
            MODEL_PROFILES.oss120,
            MODEL_PROFILES.ultra,
            MODEL_PROFILES.llama,
            MODEL_PROFILES.oss,
            MODEL_PROFILES.nano,
        ];
    }

    const selected = MODEL_PROFILES[mode];
    return [
        selected,
        ...routeForTask(task).filter((profile) => profile.id !== selected.id),
    ];
}

function errorStatus(error) {
    return Number(error?.status || error?.statusCode);
}

function isFailoverEligibleModelError(error) {
    const message = String(error?.message || error);
    const status = errorStatus(error);
    return (
        [404, 408, 409, 410, 425, 429].includes(status) || status >= 500 ||
        /connection|network|timeout|temporar|rate limit|\b429\b|\b5\d\d\b/i.test(message) ||
        /\b(?:404|408|409|410|425)\b/.test(message) ||
        ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"].includes(error?.code)
    );
}

function isUnavailableModelError(error) {
    const status = errorStatus(error);
    return [404, 410].includes(status) || /\b(?:404|410)\b/.test(String(error?.message || error));
}

export default class ModelRouter {
    constructor({
        mode,
        customModel = process.env.NVIDIA_MODEL,
        createModel = (profile) => new Nemotron({ model: profile.id }),
        onRoute,
        unavailableProfiles = new Map(),
        now = () => Date.now(),
    } = {}) {
        const requestedMode = mode || (customModel ? "custom" : "auto");
        this.mode = LEGACY_MODEL_MODE_ALIASES[requestedMode] || requestedMode;

        if (!MODEL_MODES.has(this.mode)) {
            throw new Error(`Unsupported model mode: ${this.mode}.`);
        }

        if (this.mode === "custom" && !customModel) {
            throw new Error("NVIDIA_MODEL is required when NVIDIA_MODEL_MODE is custom.");
        }

        this.customModel = customModel;
        this.createModel = createModel;
        this.onRoute = onRoute;
        this.unavailableProfiles = unavailableProfiles;
        this.now = now;
        this.route = null;
        this.routeIndex = 0;
        this.models = new Map();
    }

    get activeProfile() {
        return this.route?.[this.routeIndex] || null;
    }

    resetTask() {
        this.route = null;
        this.routeIndex = 0;
    }

    routeWithAvailableProfiles(route) {
        const now = this.now();
        const available = route.filter((profile) => {
            const unavailableUntil = this.unavailableProfiles.get(profile.id);

            if (!unavailableUntil) {
                return true;
            }

            if (unavailableUntil <= now) {
                this.unavailableProfiles.delete(profile.id);
                return true;
            }

            return false;
        });

        return available.length > 0 ? available : route;
    }

    selectRoute(task) {
        if (this.route) {
            return this.activeProfile;
        }

        this.route = this.routeWithAvailableProfiles(
            routeForMode(this.mode, task, this.customModel)
        );
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
        this.selectRoute(
            typeof options?.task === "string" && options.task.trim()
                ? options.task
                : prompt
        );

        while (true) {
            try {
                const response = await this.modelFor(this.activeProfile).generate(prompt, options);
                this.unavailableProfiles.delete(this.activeProfile.id);
                return response;
            } catch (error) {
                if (isUnavailableModelError(error)) {
                    this.unavailableProfiles.set(
                        this.activeProfile.id,
                        this.now() + UNAVAILABLE_MODEL_TTL_MS
                    );
                }

                if (!isFailoverEligibleModelError(error) || this.routeIndex >= this.route.length - 1) {
                    throw error;
                }

                this.routeIndex += 1;
                this.notifyRoute(true, error);
            }
        }
    }
}
