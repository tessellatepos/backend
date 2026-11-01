import { getAuth } from "@/services/auth";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import { Router } from "express";
import { getParamValue } from "@/utils/expressHelpers";
import { hasScope, requireScope } from "@/middleware/authenticate";
import { getConfigDeviceByID } from "@/services/db/configDevice";
import {
    issueDeviceToken,
    pairingCodeMatches,
    revokeDeviceToken,
} from "@/auth/deviceToken";

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
    const device = await getConfigDeviceByID(deviceId);
    const hasProof =
        isAdmin ||
        (!!device &&
            pairingCodeMatches(req.body?.pairingCode, device.pairing_code));
    // Same answer for "no such device" and "wrong proof", so ids can't be probed.
    if (!hasProof) {
        res.status(401).json({ message: "Unauthorized" });
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
        res.json({ message: "Device token revoked" });
    },
);

// Resolve the instance per request: it is built after plugins load and may be
// rebuilt later.
authRouter.all("/*splat", (req, res, next) => {
    void toNodeHandler(getAuth())(req, res).catch(next);
});
