import express, { Request, Response, Router } from "express";
import { Logger } from "tslog";
import type { MemberQuery, MemberStatus } from "@tessellatepos/sdk";
import { requireScope } from "@/middleware/authenticate";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import { getParamValue } from "@/utils/expressHelpers";
import { memberEventsFor } from "@/members/memberRouter";
import {
    InvalidMemberCursorError,
    MAX_MEMBER_PAGE_SIZE,
} from "@/services/db/members";
import {
    MemberValidationError,
    exportMember,
    getMember,
    listAdminMemberSources,
    listMembers,
    removeMember,
    saveMemberSource,
    updateMember,
    validateMemberPatch,
} from "@/services/members";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

// Guards: members:read to see members, members:write to approve, disable,
// rename or link one, members:admin to delete, export, and to change the
// member logins (which hold provider secrets).
const memberRouter: Router = express.Router();

const logger = new Logger();

export const membersv1Endpoint: ITessellateApiRouter = {
    route_path: "/members",
    version: "v1",
    router: memberRouter,
};

const STATUSES: readonly string[] = ["active", "pending", "disabled"];
const MAX_FIELD = 2048;

function pluginRegistry(req: Request): TessellatePluginRegistry {
    return (req.app.locals as { pluginRegistry: TessellatePluginRegistry })
        .pluginRegistry;
}

function queryString(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

/** Validation problems are 400 with the rule violated; anything else is 500. */
function fail(res: Response, error: unknown, what: string, id?: string) {
    if (
        error instanceof MemberValidationError ||
        error instanceof InvalidMemberCursorError
    ) {
        res.status(400).json({ message: error.message });
        return;
    }
    // Members are PII: log the id only, never their fields.
    logger.error(`Failed to ${what}`, id ?? "", error);
    res.status(500).json({ message: `Failed to ${what}` });
}

memberRouter.get("/", requireScope("members:read"), async (req, res) => {
    try {
        const status = queryString(req.query.status);
        if (status && !STATUSES.includes(status)) {
            res.status(400).json({
                message: "status must be active, pending or disabled",
            });
            return;
        }
        const limit = queryString(req.query.limit);
        const parsedLimit = limit === undefined ? undefined : Number(limit);
        if (
            parsedLimit !== undefined &&
            (!Number.isInteger(parsedLimit) ||
                parsedLimit < 1 ||
                parsedLimit > MAX_MEMBER_PAGE_SIZE)
        ) {
            res.status(400).json({
                message: `limit must be 1 to ${MAX_MEMBER_PAGE_SIZE}`,
            });
            return;
        }
        const query: MemberQuery = {
            text: queryString(req.query.text),
            plugin: queryString(req.query.plugin),
            status: status as MemberStatus | undefined,
            limit: parsedLimit,
            cursor: queryString(req.query.cursor),
        };
        res.json(await listMembers(query));
    } catch (error) {
        fail(res, error, "list members");
    }
});

// The member logins plugins declared, with the owner's settings. No secrets.
memberRouter.get(
    "/sources",
    requireScope("members:admin"),
    async (_req, res) => {
        try {
            res.json({ sources: await listAdminMemberSources() });
        } catch (error) {
            fail(res, error, "list member logins");
        }
    },
);

memberRouter.put(
    "/sources/:plugin/:provider",
    requireScope("members:admin"),
    async (req, res) => {
        try {
            const body = req.body as Record<string, unknown> | undefined;
            if (typeof body !== "object" || body === null) {
                throw new MemberValidationError("body must be an object");
            }
            const patch: Parameters<typeof saveMemberSource>[2] = {};
            if (body.enabled !== undefined) {
                if (typeof body.enabled !== "boolean") {
                    throw new MemberValidationError(
                        "enabled must be a boolean",
                    );
                }
                patch.enabled = body.enabled;
            }
            if (body.signup !== undefined) {
                if (
                    body.signup !== null &&
                    body.signup !== "open" &&
                    body.signup !== "approval"
                ) {
                    throw new MemberValidationError(
                        'signup must be "open", "approval" or null',
                    );
                }
                patch.signup = body.signup;
            }
            for (const field of ["clientId", "clientSecret"] as const) {
                const value = body[field];
                if (value === undefined) continue;
                if (typeof value !== "string" || value.length > MAX_FIELD) {
                    throw new MemberValidationError(
                        `${field} must be a string of at most ${MAX_FIELD} characters`,
                    );
                }
                patch[field] = value;
            }
            await saveMemberSource(
                getParamValue(req.params.plugin) ?? "",
                getParamValue(req.params.provider) ?? "",
                patch,
            );
            const source = (await listAdminMemberSources()).find(
                (s) =>
                    s.plugin === req.params.plugin &&
                    s.id === req.params.provider,
            );
            res.json(source);
        } catch (error) {
            fail(res, error, "save member login");
        }
    },
);

memberRouter.get("/:id", requireScope("members:read"), async (req, res) => {
    const id = getParamValue(req.params.id) ?? "";
    try {
        const member = await getMember(id);
        if (!member) {
            res.status(404).json({ message: "Member not found" });
            return;
        }
        res.json(member);
    } catch (error) {
        fail(res, error, "get member", id);
    }
});

memberRouter.patch("/:id", requireScope("members:write"), async (req, res) => {
    const id = getParamValue(req.params.id) ?? "";
    try {
        const patch = validateMemberPatch(req.body);
        const member = await updateMember(
            id,
            patch,
            memberEventsFor(pluginRegistry(req)),
        );
        if (!member) {
            res.status(404).json({ message: "Member not found" });
            return;
        }
        res.json(member);
    } catch (error) {
        fail(res, error, "update member", id);
    }
});

memberRouter.delete("/:id", requireScope("members:admin"), async (req, res) => {
    const id = getParamValue(req.params.id) ?? "";
    try {
        const removed = await removeMember(
            id,
            memberEventsFor(pluginRegistry(req)),
        );
        if (!removed) {
            res.status(404).json({ message: "Member not found" });
            return;
        }
        res.status(204).end();
    } catch (error) {
        fail(res, error, "delete member", id);
    }
});

memberRouter.get(
    "/:id/export",
    requireScope("members:admin"),
    async (req, res) => {
        const id = getParamValue(req.params.id) ?? "";
        try {
            const data = await exportMember(id);
            if (!data) {
                res.status(404).json({ message: "Member not found" });
                return;
            }
            res.json(data);
        } catch (error) {
            fail(res, error, "export member", id);
        }
    },
);
