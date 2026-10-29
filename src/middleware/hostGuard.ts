import type { NextFunction, Request, Response } from "express";
import {
    evaluateHost,
    normalizeHost,
    urlConfig,
    type UrlConfig,
} from "@/config/urls";

/**
 * Builds the host middleware: ALLOWED_HOSTS (421) and the public-host guard
 * (404 for anything but /gateway/*, /webhooks/* and /health on PUBLIC_URL's
 * host). Keys off the raw Host header (port stripped), never X-Forwarded-Host, which a
 * client can set; `trust proxy` is only for req.protocol and req.ip.
 * @param config the configuration to enforce
 * @returns an Express middleware
 */
export function hostGuard(config: UrlConfig = urlConfig) {
    return (req: Request, res: Response, next: NextFunction) => {
        const verdict = evaluateHost(
            normalizeHost(req.headers.host),
            req.path,
            config,
        );
        if (verdict === "misdirected") {
            res.status(421).json({ message: "Misdirected Request" });
        } else if (verdict === "not-found") {
            res.status(404).json({ message: "Not Found" });
        } else {
            next();
        }
    };
}
