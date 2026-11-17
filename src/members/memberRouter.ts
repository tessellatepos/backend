/**
 * The member surface, mounted at /member/:pluginName. The host runs the
 * whole sign-in (redirect, callback, session cookie, sign-out) under
 * /member/<plugin>/auth/*, and then hands everything else to the plugin's
 * routes declared with `access: "member"`.
 */
import express, {
    type Request,
    type RequestHandler,
    type Response,
    type Router,
} from "express";
import { randomBytes } from "node:crypto";
import { Logger } from "tslog";
import { events } from "@tessellatepos/plugin-sdk/server";
import type { Member } from "@tessellatepos/sdk";
import {
    MEMBER_COOKIE,
    MEMBER_SESSION_MS,
    extractMemberToken,
    readCookie,
} from "@/auth/members/sessions";
import {
    MemberOAuthError,
    buildAuthorizeUrl,
    createPkce,
    exchangeCode,
    fetchMemberProfile,
    isSafeReturnTo,
    type FetchLike,
} from "@/auth/members/oauth";
import { safeEqual } from "@/services/crypto";
import { urlConfig } from "@/config/urls";
import {
    completeMemberSignIn,
    endMemberSession,
    getActiveMemberSource,
    listPublicMemberSources,
    type MemberEvents,
} from "@/services/members";
import { takeToken } from "@/gateway/rateLimit";
import type { TessellatePluginApiRegistry } from "@/utils/registry/api/pluginApiRegistry";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

const logger = new Logger();

const FLOW_COOKIE = "tessellate_member_flow";
const FLOW_MS = 10 * 60 * 1000;
const MAX_REASON = 200;

/** Whether a request may proceed. Throwing fails the request closed. */
export type MemberLimiter = (req: Request) => Promise<boolean>;

/** Per-IP limit on the public sign-in routes. Fails closed if Redis is down. */
export const redisMemberLimiter: MemberLimiter = async (req) => {
    const { allowed } = await takeToken(
        `member:rl:${req.ip ?? "unknown"}`,
        30,
        30,
    );
    return allowed;
};

/** Everything the router depends on, so tests can stand in for the world. */
export interface MemberRouterOptions {
    pluginApi: Pick<TessellatePluginApiRegistry, "dispatchMember">;
    /** Where member events go for a request; defaults to the plugin registry. */
    eventsFor?: (req: Request) => MemberEvents;
    limiter?: MemberLimiter;
    fetch?: FetchLike;
}

/**
 * Member events go to the owning plugin only.
 * @param registry the plugin registry
 * @returns the events sink
 */
export function memberEventsFor(
    registry: TessellatePluginRegistry,
): MemberEvents {
    return {
        created: (m) =>
            registry.emitToPlugin(m.plugin, events.memberCreated, m),
        updated: (m, prev) =>
            registry.emitToPlugin(m.plugin, events.memberUpdated, m, prev),
        deleted: (m) =>
            registry.emitToPlugin(m.plugin, events.memberDeleted, m.id),
    };
}

function pluginOf(req: Request): string {
    return (req.params as Record<string, string>).pluginName;
}

function registryOf(req: Request): TessellatePluginRegistry {
    return (req.app.locals as { pluginRegistry: TessellatePluginRegistry })
        .pluginRegistry;
}

function trustedOrigins(): string[] {
    return [
        ...(urlConfig.publicUrl ? [urlConfig.publicUrl] : []),
        ...(urlConfig.frontendUrl ? [urlConfig.frontendUrl] : []),
        ...urlConfig.memberOrigins,
    ];
}

function baseUrl(req: Request): string {
    return urlConfig.publicUrl ?? `${req.protocol}://${req.get("host")}`;
}

function cookie(
    name: string,
    value: string,
    path: string,
    maxAgeMs: number,
    secure: boolean,
): string {
    return [
        `${name}=${value}`,
        `Path=${path}`,
        `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
        "HttpOnly",
        "SameSite=Lax",
        ...(secure ? ["Secure"] : []),
    ].join("; ");
}

function redirectWith(
    res: Response,
    returnTo: string | undefined,
    params: Record<string, string>,
    body: unknown,
) {
    if (!returnTo) {
        res.json(body);
        return;
    }
    const url = new URL(returnTo, "http://placeholder.invalid");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    res.redirect(
        returnTo.startsWith("/")
            ? `${url.pathname}${url.search}${url.hash}`
            : url.toString(),
    );
}

/**
 * Builds the member surface router.
 * @param options its dependencies
 * @returns a router to mount at /member/:pluginName
 */
export function createMemberRouter(options: MemberRouterOptions): Router {
    const router: Router & { memberSurface?: true } = express.Router({
        mergeParams: true,
    });
    // Marks the router so the route inventory test can walk it.
    router.memberSurface = true;
    const doFetch = options.fetch ?? fetch;
    const limiter = options.limiter ?? redisMemberLimiter;
    const eventsFor =
        options.eventsFor ?? ((req) => memberEventsFor(registryOf(req)));

    const limit: RequestHandler = async (req, res, next) => {
        try {
            if (await limiter(req)) {
                next();
                return;
            }
            res.status(429).json({ message: "Too many requests" });
        } catch (err) {
            logger.error("Member rate limiter unavailable:", err);
            res.status(503).json({ message: "Service unavailable" });
        }
    };

    // The logins a plugin's site can offer.
    router.get("/auth/providers", async (req, res, next) => {
        try {
            const plugin = pluginOf(req);
            const providers = await listPublicMemberSources(plugin);
            res.json({
                providers: providers.map((p) => ({
                    ...p,
                    start_url: `/member/${encodeURIComponent(plugin)}/auth/${encodeURIComponent(p.id)}/start`,
                })),
            });
        } catch (err) {
            next(err);
        }
    });

    router.get("/auth/:providerId/start", limit, async (req, res, next) => {
        try {
            const plugin = pluginOf(req);
            const providerId = req.params.providerId as string;
            const source = await getActiveMemberSource(plugin, providerId);
            if (!source) {
                res.status(404).json({ message: "Unknown member login" });
                return;
            }
            const returnTo =
                typeof req.query.returnTo === "string"
                    ? req.query.returnTo
                    : undefined;
            if (returnTo && !isSafeReturnTo(returnTo, trustedOrigins())) {
                res.status(400).json({ message: "returnTo is not allowed" });
                return;
            }
            const state = randomBytes(24).toString("base64url");
            const pkce = createPkce();
            const redirectUri = `${baseUrl(req)}/member/${encodeURIComponent(plugin)}/auth/${encodeURIComponent(providerId)}/callback`;
            const flow = Buffer.from(
                JSON.stringify({
                    state,
                    verifier: pkce.verifier,
                    returnTo,
                    providerId,
                }),
            ).toString("base64url");
            res.setHeader(
                "Set-Cookie",
                cookie(
                    FLOW_COOKIE,
                    flow,
                    `/member/${encodeURIComponent(plugin)}/auth`,
                    FLOW_MS,
                    baseUrl(req).startsWith("https://"),
                ),
            );
            res.redirect(
                buildAuthorizeUrl(
                    source.config,
                    redirectUri,
                    state,
                    pkce.challenge,
                ),
            );
        } catch (err) {
            next(err);
        }
    });

    router.get("/auth/:providerId/callback", limit, async (req, res, next) => {
        const plugin = pluginOf(req);
        const providerId = req.params.providerId as string;
        const authPath = `/member/${encodeURIComponent(plugin)}/auth`;
        const secure = baseUrl(req).startsWith("https://");
        const clearFlow = cookie(FLOW_COOKIE, "", authPath, 0, secure);
        try {
            // The flow cookie ties this callback to the browser that started
            // it. Without a matching state, nothing is exchanged.
            let flow: {
                state: string;
                verifier: string;
                returnTo?: string;
                providerId: string;
            } | null = null;
            try {
                const raw = readCookie(req.headers.cookie, FLOW_COOKIE);
                flow = raw
                    ? JSON.parse(Buffer.from(raw, "base64url").toString())
                    : null;
            } catch {
                flow = null;
            }
            const state =
                typeof req.query.state === "string" ? req.query.state : "";
            if (
                !flow ||
                flow.providerId !== providerId ||
                typeof flow.state !== "string" ||
                !safeEqual(flow.state, state)
            ) {
                res.setHeader("Set-Cookie", clearFlow);
                res.status(400).json({ message: "Invalid or expired sign-in" });
                return;
            }
            const returnTo =
                flow.returnTo && isSafeReturnTo(flow.returnTo, trustedOrigins())
                    ? flow.returnTo
                    : undefined;

            if (typeof req.query.error === "string") {
                res.setHeader("Set-Cookie", clearFlow);
                redirectWith(
                    res,
                    returnTo,
                    { member: "cancelled" },
                    { status: "cancelled" },
                );
                return;
            }
            const code =
                typeof req.query.code === "string" ? req.query.code : "";
            const source = await getActiveMemberSource(plugin, providerId);
            if (!code || !source) {
                res.setHeader("Set-Cookie", clearFlow);
                res.status(400).json({ message: "Invalid or expired sign-in" });
                return;
            }

            const redirectUri = `${baseUrl(req)}${authPath}/${encodeURIComponent(providerId)}/callback`;
            let profile;
            try {
                const accessToken = await exchangeCode(
                    source.config,
                    redirectUri,
                    code,
                    flow.verifier,
                    doFetch,
                );
                profile = await fetchMemberProfile(
                    providerId,
                    source.config,
                    accessToken,
                    doFetch,
                );
            } catch (err) {
                if (!(err instanceof MemberOAuthError)) throw err;
                logger.warn(
                    `Member login "${plugin}/${providerId}" failed: ${err.message}`,
                );
                res.setHeader("Set-Cookie", clearFlow);
                redirectWith(
                    res,
                    returnTo,
                    { member: "error" },
                    { status: "error" },
                );
                return;
            }

            const result = await completeMemberSignIn(
                source,
                profile,
                eventsFor(req),
            );
            const cookies = [clearFlow];
            switch (result.kind) {
                case "signed-in":
                    cookies.push(
                        cookie(
                            MEMBER_COOKIE,
                            result.token,
                            `/member/${encodeURIComponent(plugin)}`,
                            MEMBER_SESSION_MS,
                            secure,
                        ),
                    );
                    res.setHeader("Set-Cookie", cookies);
                    redirectWith(
                        res,
                        returnTo,
                        { member: "ok" },
                        {
                            status: "signed-in",
                            member: publicMember(result.member),
                        },
                    );
                    return;
                case "pending":
                    res.setHeader("Set-Cookie", cookies);
                    redirectWith(
                        res,
                        returnTo,
                        { member: "pending" },
                        { status: "pending" },
                    );
                    return;
                case "disabled":
                    res.setHeader("Set-Cookie", cookies);
                    redirectWith(
                        res,
                        returnTo,
                        { member: "disabled" },
                        { status: "disabled" },
                    );
                    return;
                case "denied": {
                    res.setHeader("Set-Cookie", cookies);
                    const reason = result.reason.slice(0, MAX_REASON);
                    redirectWith(
                        res,
                        returnTo,
                        { member: "denied", reason },
                        { status: "denied", reason },
                    );
                    return;
                }
            }
        } catch (err) {
            next(err);
        }
    });

    router.post("/auth/logout", async (req, res, next) => {
        try {
            const token = extractMemberToken(
                req.headers.cookie,
                req.headers.authorization,
            );
            if (token) await endMemberSession(token);
            const plugin = pluginOf(req);
            res.setHeader(
                "Set-Cookie",
                cookie(
                    MEMBER_COOKIE,
                    "",
                    `/member/${encodeURIComponent(plugin)}`,
                    0,
                    baseUrl(req).startsWith("https://"),
                ),
            );
            res.status(204).end();
        } catch (err) {
            next(err);
        }
    });

    // Who am I, for the member's own site. Needs a session.
    router.get("/auth/me", (req, res) => {
        const principal = req.principal;
        if (
            principal?.kind !== "member" ||
            principal.plugin !== pluginOf(req)
        ) {
            res.status(401).json({ message: "Unauthorized" });
            return;
        }
        res.json({
            id: principal.id,
            display_name: principal.display_name ?? "",
            plugin: principal.plugin,
        });
    });

    // Anything else under /auth is the host's, never a plugin's.
    router.use("/auth", (_req: Request, res: Response) => {
        res.status(404).json({ message: "Not Found" });
    });

    router.use(options.pluginApi.dispatchMember);
    router.use((_req: Request, res: Response) => {
        res.status(404).json({ message: "Not Found" });
    });
    return router;
}

function publicMember(member: Member) {
    return {
        id: member.id,
        display_name: member.display_name,
        plugin: member.plugin,
    };
}
