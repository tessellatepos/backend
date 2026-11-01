import express, { Request, Response, Router } from "express";
import { Logger } from "tslog";
import { requireScope } from "@/middleware/authenticate";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import { getParamValue } from "@/utils/expressHelpers";
import { authProviders, providerKind } from "@/auth/providers";
import {
    listAdminProviders,
    listPublicProviders,
    rebuildAuth,
    saveSettings,
    toAdminView,
    type ProviderSettingsPatch,
} from "@/services/authProviders";

const authProvidersRouter: Router = express.Router();

const logger = new Logger();

export const authProvidersv1Endpoint: ITessellateApiRouter = {
    route_path: "/auth-providers",
    version: "v1",
    router: authProvidersRouter,
};

const MAX_FIELD = 2048;

function fieldError(name: string): string {
    return `${name} must be a string of at most ${MAX_FIELD} characters`;
}

function isText(value: unknown): value is string {
    return typeof value === "string" && value.length <= MAX_FIELD;
}

function isHttpUrl(value: string): boolean {
    try {
        const { protocol } = new URL(value);
        return protocol === "https:" || protocol === "http:";
    } catch {
        return false;
    }
}

/**
 * Checks a PUT body. Unknown keys are ignored.
 * @returns the patch, or a message describing what is wrong
 */
function parsePatch(
    body: unknown,
    kind: ReturnType<typeof providerKind>,
): ProviderSettingsPatch | string {
    const b = (body && typeof body === "object" ? body : {}) as Record<
        string,
        unknown
    >;
    const patch: ProviderSettingsPatch = {};
    if (b.enabled !== undefined) {
        if (typeof b.enabled !== "boolean") return "enabled must be a boolean";
        patch.enabled = b.enabled;
    }
    for (const key of ["clientId", "clientSecret", "discoveryUrl"] as const) {
        if (b[key] === undefined) continue;
        if (kind === "custom") return "This sign-in method has no settings";
        if (!isText(b[key])) return fieldError(key);
        patch[key] = b[key];
    }
    if (patch.discoveryUrl && !isHttpUrl(patch.discoveryUrl)) {
        return "discoveryUrl must be an http(s) URL";
    }
    if (patch.discoveryUrl !== undefined && kind !== "oidc") {
        return "discoveryUrl only applies to OpenID Connect sign-in methods";
    }
    if (b.scopes !== undefined) {
        if (kind === "custom" || kind === "social") {
            return "scopes do not apply to this sign-in method";
        }
        if (!Array.isArray(b.scopes) || !b.scopes.every(isText)) {
            return fieldError("scopes[]");
        }
        patch.scopes = b.scopes;
    }
    return patch;
}

// Public so the login screen can draw its buttons. Names only, no config.
authProvidersRouter.get("/public", async (_req: Request, res: Response) => {
    try {
        res.json(await listPublicProviders());
    } catch (err) {
        logger.error("Listing public sign-in methods failed:", err);
        res.status(500).json({ message: "Listing sign-in methods failed" });
    }
});

authProvidersRouter.get(
    "/",
    requireScope("settings:admin"),
    async (_req: Request, res: Response) => {
        try {
            res.json(await listAdminProviders());
        } catch (err) {
            logger.error("Listing sign-in methods failed:", err);
            res.status(500).json({ message: "Listing sign-in methods failed" });
        }
    },
);

// Changes the owner's settings, then rebuilds the auth instance so the
// change applies at once. A secret is accepted here and never returned.
authProvidersRouter.put(
    "/:id",
    requireScope("settings:admin"),
    async (req: Request, res: Response) => {
        const id = getParamValue(req.params.id);
        const entry = id ? authProviders.get(id) : undefined;
        if (!entry) {
            res.status(404).json({ message: "Sign-in method not found" });
            return;
        }
        const patch = parsePatch(req.body, providerKind(entry.provider));
        if (typeof patch === "string") {
            res.status(400).json({ message: patch });
            return;
        }
        let settings;
        try {
            settings = await saveSettings(entry, patch);
        } catch (err) {
            logger.error(`Saving sign-in method "${entry.provider.id}" failed`);
            logger.debug(err instanceof Error ? err.message : "unknown error");
            res.status(500).json({
                message: "Saving the sign-in method failed",
            });
            return;
        }
        try {
            await rebuildAuth();
        } catch (err) {
            logger.error(
                `Reloading sign-in methods failed: ${err instanceof Error ? err.message : "unknown error"}`,
            );
            res.status(500).json({
                message: "Saved, but sign-in methods could not be reloaded",
            });
            return;
        }
        res.json(toAdminView(entry, settings));
    },
);
