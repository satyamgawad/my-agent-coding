import { MODEL_PROFILES } from "./model-router.js";

export const DEFAULT_MODEL_HEALTH_TTL_MS = 5 * 60 * 1_000;

function profileList(profiles) {
    return Object.entries(profiles).map(([mode, profile]) => ({
        mode,
        id: profile.id,
        label: profile.label,
        summary: profile.summary,
    }));
}

function modelIds(catalog) {
    if (!Array.isArray(catalog)) {
        throw new TypeError("The model catalog must be an array.");
    }

    return new Set(catalog.map((model) => (
        typeof model === "string" ? model : model?.id
    )).filter(Boolean));
}

function publicFailure(profiles, checkedAt) {
    return {
        status: "unknown",
        checkedAt: new Date(checkedAt).toISOString(),
        cached: false,
        models: profileList(profiles).map((profile) => ({
            ...profile,
            available: null,
        })),
        error: "Model availability could not be checked.",
    };
}

/**
 * Caches a provider's model catalog and maps it to this agent's named routes.
 *
 * `listModels` is deliberately injected: callers can use any provider client and
 * tests never need a network connection. It may resolve model ID strings or
 * provider records containing an `id` property.
 */
export default class ModelHealth {
    constructor({
        listModels,
        profiles = MODEL_PROFILES,
        ttlMs = DEFAULT_MODEL_HEALTH_TTL_MS,
        now = () => Date.now(),
    } = {}) {
        if (typeof listModels !== "function") {
            throw new TypeError("ModelHealth requires a listModels function.");
        }

        if (!Number.isFinite(ttlMs) || ttlMs < 0) {
            throw new TypeError("Model health TTL must be a non-negative number.");
        }

        this.listModels = listModels;
        this.profiles = profiles;
        this.ttlMs = ttlMs;
        this.now = now;
        this.cache = null;
        this.inFlight = null;
    }

    invalidate() {
        this.cache = null;
    }

    async check({ force = false } = {}) {
        const requestedAt = this.now();

        if (!force && this.cache && requestedAt < this.cache.expiresAt) {
            return { ...this.cache.result, cached: true };
        }

        if (!force && this.inFlight) {
            return this.inFlight;
        }

        const check = this.refresh();
        this.inFlight = check;

        try {
            return await check;
        } finally {
            if (this.inFlight === check) {
                this.inFlight = null;
            }
        }
    }

    async refresh() {
        const checkedAt = this.now();

        try {
            const availableIds = modelIds(await this.listModels());
            const models = profileList(this.profiles).map((profile) => ({
                ...profile,
                available: availableIds.has(profile.id),
            }));
            const availableCount = models.filter((profile) => profile.available).length;
            const status = availableCount === models.length
                ? "ready"
                : availableCount > 0
                    ? "degraded"
                    : "unavailable";
            const result = {
                status,
                checkedAt: new Date(checkedAt).toISOString(),
                cached: false,
                models,
            };

            this.cache = {
                expiresAt: checkedAt + this.ttlMs,
                result,
            };
            return result;
        } catch {
            // Provider error messages can be noisy or expose operational detail,
            // so the dashboard receives a stable, safe failure state instead.
            return publicFailure(this.profiles, checkedAt);
        }
    }
}
