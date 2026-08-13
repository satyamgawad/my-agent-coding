import Nemotron from "./nemotron.js";

export const DEFAULT_LOCAL_MODEL = "qwen2.5-coder:7b";
export const DEFAULT_GEMMA_MODEL = "gemma4:e2b";

export const MODEL_PROFILES = Object.freeze({
    local: Object.freeze({
        id: DEFAULT_LOCAL_MODEL,
        label: "Qwen 2.5 Coder 7B",
        summary: "Free local Ollama coding model",
    }),
    gemma: Object.freeze({
        id: DEFAULT_GEMMA_MODEL,
        label: "Gemma 4 E2B",
        summary: "Free local Ollama chat, vision, audio, and reasoning model",
    }),
});

// Keep previously saved dashboard preferences working after the move away from
// hosted routes. They now resolve to the single reliable local route.
const LEGACY_MODEL_MODE_ALIASES = Object.freeze({
    flash: "local",
    lightning: "local",
    nano: "local",
    oss: "local",
    llama: "local",
    kimi: "local",
    oss120: "local",
    ultra: "local",
    glm: "local",
});

export const MODEL_MODES = new Set(["auto", "build", "smart", "local", "gemma", "power", "custom"]);

const UNAVAILABLE_MODEL_TTL_MS = 15 * 60 * 1_000;

export function customModelFromEnvironment(environment = process.env) {
    return environment.AGENT_MODEL || null;
}

export function museModelFromEnvironment(environment = process.env) {
    return environment.NVIDIA_MUSE_MODEL || environment.MUSE_MODEL || null;
}

function localProfile(modelId) {
    const id = typeof modelId === "string" && modelId.trim()
        ? modelId.trim()
        : DEFAULT_LOCAL_MODEL;

    return {
        id,
        label: id === DEFAULT_LOCAL_MODEL ? MODEL_PROFILES.local.label : id,
        summary: id === DEFAULT_LOCAL_MODEL
            ? MODEL_PROFILES.local.summary
            : "Local Ollama model",
    };
}

function gemmaProfile(modelId) {
    const id = typeof modelId === "string" && modelId.trim()
        ? modelId.trim()
        : DEFAULT_GEMMA_MODEL;

    return {
        id,
        label: id === DEFAULT_GEMMA_MODEL ? MODEL_PROFILES.gemma.label : id,
        summary: id === DEFAULT_GEMMA_MODEL
            ? MODEL_PROFILES.gemma.summary
            : "Local Ollama chat and reasoning model",
        endpoint: "ollama",
    };
}

function localCodingProfile(modelId) {
    return { ...localProfile(modelId), endpoint: "ollama" };
}

function routeForMode(mode, customModel, museModel, localModel, gemmaModel) {
    const local = localCodingProfile(localModel);

    if (mode === "gemma") {
        const gemma = gemmaProfile(gemmaModel);
        return gemma.id === local.id ? [local] : [gemma, local];
    }

    if (mode === "power") {
        const muse = {
            id: museModel,
            label: "Muse Glimmer 30B",
            summary: "NVIDIA-hosted multimodal reasoning and coding model",
            endpoint: "nvidiaMuse",
        };
        return muse.id === local.id ? [local] : [muse, local];
    }

    if (mode !== "custom") {
        return [local];
    }

    const remote = {
        id: customModel,
        label: customModel,
        summary: "Custom remote model",
        endpoint: "custom",
    };

    // A configured remote model remains optional. If it is unavailable, the
    // agent can continue privately on the local model instead of stopping.
    return remote.id === local.id ? [local] : [remote, local];
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
        customModel = customModelFromEnvironment(),
        museModel = museModelFromEnvironment(),
        localModel = process.env.OLLAMA_MODEL || DEFAULT_LOCAL_MODEL,
        gemmaModel = process.env.OLLAMA_GEMMA_MODEL || DEFAULT_GEMMA_MODEL,
        createModel = (profile) => new Nemotron({ model: profile.id, endpoint: profile.endpoint }),
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
            throw new Error("AGENT_MODEL is required when the custom model route is selected.");
        }

        if (this.mode === "power" && !museModel) {
            throw new Error("NVIDIA_MUSE_MODEL is required when the Power Build route is selected.");
        }

        this.customModel = customModel;
        this.museModel = museModel;
        this.localModel = localModel;
        this.gemmaModel = gemmaModel;
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

            if (!unavailableUntil) return true;
            if (unavailableUntil <= now) {
                this.unavailableProfiles.delete(profile.id);
                return true;
            }

            return false;
        });

        return available.length > 0 ? available : route;
    }

    selectRoute() {
        if (this.route) return this.activeProfile;

        this.route = this.routeWithAvailableProfiles(
            routeForMode(this.mode, this.customModel, this.museModel, this.localModel, this.gemmaModel)
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
        this.selectRoute();

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
