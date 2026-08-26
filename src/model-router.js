import Nemotron from "./nemotron.js";

export const DEFAULT_LOCAL_MODEL = "qwen2.5-coder:7b";
export const DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";

const UNAVAILABLE_MODEL_TTL_MS = 15 * 60 * 1_000;

export function nemotronUltraModelFromEnvironment(environment = process.env) {
    const apiKey = environment.NVIDIA_NEMOTRON_ULTRA_API_KEY || environment.NVIDIA_ULTRA_API_KEY || environment.NVIDIA_API_KEY;
    if (!apiKey) return null;

    return environment.NVIDIA_NEMOTRON_ULTRA_MODEL || environment.NVIDIA_ULTRA_MODEL || DEFAULT_NVIDIA_NEMOTRON_ULTRA_MODEL;
}

function localProfile(modelId) {
    const id = typeof modelId === "string" && modelId.trim()
        ? modelId.trim()
        : DEFAULT_LOCAL_MODEL;

    return {
        id,
        label: id === DEFAULT_LOCAL_MODEL ? "Qwen 2.5 Coder 7B" : id,
        summary: "Local Ollama coding model",
        endpoint: "ollama",
    };
}

function automaticRoute(ultraModel, localModel) {
    const local = localProfile(localModel);

    if (!ultraModel) {
        return [local];
    }

    return [
        {
            id: ultraModel,
            label: "Nemotron 3 Ultra",
            summary: "NVIDIA-hosted coding model with local Qwen fallback",
            endpoint: "nvidiaUltra",
        },
        local,
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

/**
 * Always choose the best available route automatically: NVIDIA Nemotron when
 * it is configured, then the private local Ollama model as a fallback.
 */
export default class ModelRouter {
    constructor({
        ultraModel = nemotronUltraModelFromEnvironment(),
        localModel = process.env.OLLAMA_MODEL || DEFAULT_LOCAL_MODEL,
        createModel = (profile) => new Nemotron({ model: profile.id, endpoint: profile.endpoint }),
        onRoute,
        unavailableProfiles = new Map(),
        now = () => Date.now(),
    } = {}) {
        this.ultraModel = ultraModel;
        this.localModel = localModel;
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
            automaticRoute(this.ultraModel, this.localModel)
        );
        this.notifyRoute(false);
        return this.activeProfile;
    }

    notifyRoute(fallback, error = null) {
        this.onRoute?.({
            profile: this.activeProfile,
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
