import { CLIENT_IP_HEADER, getAuth } from "@/services/auth";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import { Router } from "express";
import { FixedWindowLimiter, clientKey } from "@/utils/rateLimiter";
import { getParamValue } from "@/utils/expressHelpers";
import { hasScope, requireScope } from "@/middleware/authenticate";
import { getConfigDeviceByID } from "@/services/db/configDevice";
import { closeSocketsForPrincipal } from "@/services/websocket/websocket";
import {
    issueDeviceToken,
    pairingCodeMatches,
    revokeDeviceToken,
} from "@/auth/deviceToken";

/** Failed device-token exchanges a client IP may make per window. */
export const DEVICE_TOKEN_MAX_FAILURES = 10;
/** Length of the failed-exchange window. */
export const DEVICE_TOKEN_WINDOW_MS = 15 * 60 * 1000;

// Per process (see FixedWindowLimiter), keyed by req.ip. Only failures count:
// an admin or a correct pairing code is never slowed down.
const exchangeFailures = new FixedWindowLimiter(
    DEVICE_TOKEN_MAX_FAILURES,
    DEVICE_TOKEN_WINDOW_MS,
);

/** Clears the device-token failure counts (tests). */
export function resetDeviceTokenLimits(): void {
    exchangeFailures.reset();
}

/** Failed password sign-ins one account may see per window, from anywhere. */
export const SIGN_IN_MAX_FAILURES = 10;
/** Length of the failed sign-in window. */
export const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;

// Per process. Counts failures per username/email regardless of client IP, so
// rotating addresses (the per-IP limit) cannot grind one account's password.
// Cost: someone who knows a username can lock it out for a window.
const signInFailures = new FixedWindowLimiter(
    SIGN_IN_MAX_FAILURES,
    SIGN_IN_WINDOW_MS,
);

/** Clears the per-account sign-in failure counts (tests). */
export function resetSignInLimits(): void {
    signInFailures.reset();
}

/** The account a password sign-in names, normalised, or null. */
function signInIdentifier(req: express.Request): string | null {
    if (
        req.method !== "POST" ||
        !/\/sign-in\/(username|email)$/.test(req.path)
    ) {
        return null;
    }
    const body = req.body as
        { username?: unknown; email?: unknown } | undefined;
    const id = req.path.endsWith("/username") ? body?.username : body?.email;
    return typeof id === "string" && id
        ? id.trim().toLowerCase().slice(0, 256)
        : null;
}

const authRouter: Router = express.Router();

export const authv1Endpoint: ITessellateApiRouter = {
    route_path: "/auth",
    version: "v1",
    router: authRouter,
};

// Exchanges proof of pairing for a long-lived device token. Proof is either
// the device's live pairing code (the one-time secret from
// GET /config/devices/pair-device, valid until the pairing completes) or an
// admin principal holding devices:admin. The code is cleared when pairing
// completes, so afterwards only an admin can mint or rotate a token. A new
// token replaces the old one. The token is returned once and never logged.
authRouter.post("/device-token", async (req, res) => {
    const deviceId: unknown = req.body?.deviceId;
    if (typeof deviceId !== "string" || !deviceId) {
        res.status(400).json({ message: "deviceId is required" });
        return;
    }
    const isAdmin = !!req.principal && hasScope(req.principal, "devices:admin");
    const key = clientKey(req);
    if (!isAdmin && exchangeFailures.isLimited(key)) {
        res.setHeader("Retry-After", exchangeFailures.retryAfterSeconds(key));
        res.status(429).json({ message: "Too many failed attempts" });
        return;
    }
    const device = await getConfigDeviceByID(deviceId);
    const hasProof =
        isAdmin ||
        (!!device &&
            pairingCodeMatches(req.body?.pairingCode, device.pairing_code));
    // Same answer for "no such device" and "wrong proof", so ids can't be probed.
    if (!hasProof) {
        exchangeFailures.record(key);
        res.status(401).json({ message: "Unauthorized" });
        return;
    }
    // A LOCAL till runs in a staff browser on the staff session; it has no
    // token. Refused even for devices:admin.
    if (device?.device_type === "LOCAL") {
        res.status(400).json({
            message: "Local tills do not use device tokens",
        });
        return;
    }
    const token = await issueDeviceToken(deviceId);
    if (!token) {
        res.status(404).json({ message: "Device not found" });
        return;
    }
    res.json({ token, deviceId });
});

authRouter.delete(
    "/device-token/:deviceId",
    requireScope("devices:admin"),
    async (req, res) => {
        const deviceId = getParamValue(req.params.deviceId);
        if (!deviceId || !(await revokeDeviceToken(deviceId))) {
            res.status(404).json({ message: "Device not found" });
            return;
        }
        closeSocketsForPrincipal(deviceId);
        res.json({ message: "Device token revoked" });
    },
);

// Resolve the instance per request: it is built after plugins load and may be
// rebuilt later.
authRouter.all("/*splat", (req, res, next) => {
    // Always overwrite: whatever the client sent under this name is ignored.
    req.headers[CLIENT_IP_HEADER] = clientKey(req);
    const account = signInIdentifier(req);
    if (account) {
        if (signInFailures.isLimited(account)) {
            res.setHeader(
                "Retry-After",
                signInFailures.retryAfterSeconds(account),
            );
            res.status(429).json({ message: "Too many failed attempts" });
            return;
        }
        res.on("finish", () => {
            if (res.statusCode >= 400 && res.statusCode !== 429) {
                signInFailures.record(account);
            }
        });
    }
    void toNodeHandler(getAuth())(req, res).catch(next);
});
