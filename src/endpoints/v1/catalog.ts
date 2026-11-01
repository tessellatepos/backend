import express, {
    type NextFunction,
    type Request,
    type RequestHandler,
    type Response,
    Router,
} from "express";
import { Logger } from "tslog";
import {
    getActiveProviderId,
    getCatalogWriter,
    providerInfo,
    visibleCatalogScope,
} from "@/services/providers";
import type { CatalogWriteProvider } from "@/services/providers/types";
import {
    CatalogError,
    getItem,
    listCategories,
    listItems,
    toApiItem,
    type WriteContext,
} from "@/services/db/catalogManage";
import { exportCatalogCsv } from "@/services/db/catalogImport";
import { MAX_CSV_BYTES } from "@/services/catalogCsv";
import {
    parseCategoryInput,
    parseItemInput,
    parseItemPatch,
    parseItemQuery,
    type Validated,
} from "@/services/catalogValidation";
import { refreshCatalogCache } from "@/services/catalogSync";
import { emitDatabaseEvent } from "@/services/websocket/events";
import { requireScope } from "@/middleware/authenticate";
import { getParamValue } from "@/utils/expressHelpers";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";

const catalogRouter: Router = express.Router();

const logger = new Logger();

export const catalogv1Endpoint: ITessellateApiRouter = {
    route_path: "/catalog",
    version: "v1",
    router: catalogRouter,
};

const read = requireScope("catalog:read");
const write = requireScope("catalog:write");

/**
 * @param req the request, after a scope guard has run
 * @returns the caller's location limit
 */
function contextOf(req: Request): WriteContext {
    return { allowedLocations: req.principal?.location_ids ?? [] };
}

/**
 * Guard: 409 when the active provider owns the catalog. Run after the scope
 * guard so an anonymous caller still gets 401, not a hint about the provider.
 * @param _req the request
 * @param res the response; carries the provider's catalog writes on success
 * @param next continues the chain
 */
function requireManageableCatalog(
    _req: Request,
    res: Response,
    next: NextFunction,
) {
    const writer = getCatalogWriter();
    if (!writer) {
        res.status(409).json({
            code: "provider_readonly",
            message: "The catalog is managed in Square and is read-only here",
        });
        return;
    }
    res.locals.writer = writer;
    next();
}

/** @returns the catalog writes requireManageableCatalog put on the response */
function writerOf(res: Response): CatalogWriteProvider {
    return res.locals.writer as CatalogWriteProvider;
}

/**
 * Wraps a handler so a CatalogError becomes its status and anything else a
 * logged 500. Error bodies never carry request values.
 * @param fn the handler
 * @returns the Express handler
 */
function handle(
    fn: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
    return async (req, res) => {
        try {
            await fn(req, res);
        } catch (err) {
            if (err instanceof CatalogError) {
                res.status(err.status).json({
                    code: err.code,
                    message: err.message,
                    errors: err.errors,
                });
                return;
            }
            logger.error("Catalog request failed:", err);
            res.status(500).json({ message: "Catalog request failed" });
        }
    };
}

function invalid(res: Response, result: Validated<unknown> & { ok: false }) {
    res.status(400).json({
        code: "invalid_request",
        message: "Invalid request",
        errors: result.errors,
    });
}

/**
 * Refreshes the till cache and tells open tills to refetch. A failure here
 * must not undo a write that already committed.
 * @param locationIds the storefronts the write touched
 */
async function announce(locationIds: string[]) {
    try {
        await refreshCatalogCache();
    } catch (err) {
        logger.error("Catalog cache refresh failed:", err);
    }
    if (locationIds.length === 0) {
        emitDatabaseEvent({ type: "catalog_updated", payload: {} });
    }
    for (const locationId of locationIds) {
        emitDatabaseEvent({
            type: "catalog_updated",
            payload: { locationId },
        });
    }
}

/**
 * Categories belong to the whole catalog, not a storefront, so a principal
 * pinned to some storefronts cannot change them.
 * @param req the request
 * @param res the response
 * @param next continues the chain
 */
function requireUnpinned(req: Request, res: Response, next: NextFunction) {
    if (req.principal?.location_ids === "all") {
        next();
        return;
    }
    res.status(403).json({ message: "Forbidden" });
}

function idParam(req: Request): string | undefined {
    const id = getParamValue(req.params.id as string | string[] | undefined);
    return id && id.length <= 255 ? id : undefined;
}

const notFound = (res: Response, what: string) =>
    res.status(404).json({ code: "not_found", message: `${what} not found` });

// ---------------------------------------------------------------- items

catalogRouter.get(
    "/items",
    read,
    handle(async (req, res) => {
        const query = parseItemQuery(req.query as Record<string, unknown>);
        if (!query.ok) return invalid(res, query);
        const { items, total } = await listItems(
            query.value,
            visibleCatalogScope(),
            contextOf(req),
        );
        res.json({
            items: items.map(toApiItem),
            total,
            limit: query.value.limit,
            offset: query.value.offset,
            canManage: providerInfo[getActiveProviderId()].canManageCatalog,
        });
    }),
);

catalogRouter.get(
    "/items/:id",
    read,
    handle(async (req, res) => {
        const id = idParam(req);
        const item = id
            ? await getItem(id, visibleCatalogScope(), contextOf(req))
            : null;
        if (!item) return notFound(res, "Item");
        res.json(toApiItem(item));
    }),
);

catalogRouter.post(
    "/items",
    write,
    requireManageableCatalog,
    handle(async (req, res) => {
        const draft = parseItemInput(req.body);
        if (!draft.ok) return invalid(res, draft);
        const result = await writerOf(res).createItem(
            draft.value,
            contextOf(req),
        );
        await announce(result.locationIds);
        res.status(201).json(toApiItem(result.item));
    }),
);

catalogRouter.put(
    "/items/:id",
    write,
    requireManageableCatalog,
    handle(async (req, res) => {
        const draft = parseItemInput(req.body);
        if (!draft.ok) return invalid(res, draft);
        const id = idParam(req);
        const result = id
            ? await writerOf(res).updateItem(
                  id,
                  { draft: draft.value },
                  contextOf(req),
              )
            : null;
        if (!result) return notFound(res, "Item");
        await announce(result.locationIds);
        res.json(toApiItem(result.item));
    }),
);

catalogRouter.patch(
    "/items/:id",
    write,
    requireManageableCatalog,
    handle(async (req, res) => {
        const patch = parseItemPatch(req.body);
        if (!patch.ok) return invalid(res, patch);
        const id = idParam(req);
        const result = id
            ? await writerOf(res).updateItem(
                  id,
                  { patch: patch.value },
                  contextOf(req),
              )
            : null;
        if (!result) return notFound(res, "Item");
        await announce(result.locationIds);
        res.json(toApiItem(result.item));
    }),
);

// Archives by default so past orders keep resolving; ?hard=true deletes for
// good, and only while no order references the item.
catalogRouter.delete(
    "/items/:id",
    write,
    requireManageableCatalog,
    handle(async (req, res) => {
        const hard = req.query.hard;
        if (hard !== undefined && hard !== "true" && hard !== "false") {
            return invalid(res, {
                ok: false,
                errors: [{ path: "hard", message: "must be true or false" }],
            });
        }
        const id = idParam(req);
        if (hard === "true") {
            const removed = id
                ? await writerOf(res).deleteItem(id, contextOf(req))
                : null;
            if (!removed) return notFound(res, "Item");
            await announce(removed.locationIds);
            res.status(204).end();
            return;
        }
        const result = id
            ? await writerOf(res).archiveItem(id, true, contextOf(req))
            : null;
        if (!result) return notFound(res, "Item");
        await announce(result.locationIds);
        res.json(toApiItem(result.item));
    }),
);

// ----------------------------------------------------------- categories

catalogRouter.get(
    "/categories",
    read,
    handle(async (_req, res) => {
        res.json({
            categories: await listCategories(visibleCatalogScope()),
            canManage: providerInfo[getActiveProviderId()].canManageCatalog,
        });
    }),
);

catalogRouter.post(
    "/categories",
    write,
    requireManageableCatalog,
    requireUnpinned,
    handle(async (req, res) => {
        const input = parseCategoryInput(req.body);
        if (!input.ok) return invalid(res, input);
        const category = await writerOf(res).createCategory(input.value);
        await announce([]);
        res.status(201).json(category);
    }),
);

for (const [method, partial] of [
    ["put", false],
    ["patch", true],
] as const) {
    catalogRouter[method](
        "/categories/:id",
        write,
        requireManageableCatalog,
        requireUnpinned,
        handle(async (req, res) => {
            const input = parseCategoryInput(req.body, partial);
            if (!input.ok) return invalid(res, input);
            const id = idParam(req);
            // PUT replaces: what it leaves out is cleared.
            const fields = partial
                ? input.value
                : {
                      parentCategoryId: null,
                      imageURL: null,
                      ...input.value,
                  };
            const category = id
                ? await writerOf(res).updateCategory(id, fields)
                : null;
            if (!category) return notFound(res, "Category");
            await announce([]);
            res.json(category);
        }),
    );
}

catalogRouter.delete(
    "/categories/:id",
    write,
    requireManageableCatalog,
    requireUnpinned,
    handle(async (req, res) => {
        const id = idParam(req);
        if (!id || !(await writerOf(res).deleteCategory(id))) {
            return notFound(res, "Category");
        }
        await announce([]);
        res.status(204).end();
    }),
);

// ------------------------------------------------------- import / export

// CSV text goes in the body as text/csv (a JSON {"csv": "..."} body also
// works for small files). The scope guard runs first, so nothing is read for
// an anonymous caller.
catalogRouter.post(
    "/import",
    write,
    requireManageableCatalog,
    requireUnpinned,
    express.text({ type: ["text/csv", "text/plain"], limit: MAX_CSV_BYTES }),
    handle(async (req, res) => {
        const dryRunParam = req.query.dryRun;
        if (
            dryRunParam !== undefined &&
            dryRunParam !== "true" &&
            dryRunParam !== "false"
        ) {
            return invalid(res, {
                ok: false,
                errors: [{ path: "dryRun", message: "must be true or false" }],
            });
        }
        const body: unknown = req.body;
        const csv =
            typeof body === "string"
                ? body
                : typeof (body as { csv?: unknown } | undefined)?.csv ===
                    "string"
                  ? (body as { csv: string }).csv
                  : undefined;
        if (csv === undefined) {
            return invalid(res, {
                ok: false,
                errors: [
                    {
                        path: "(body)",
                        message: "must be CSV text (text/csv) or {csv}",
                    },
                ],
            });
        }
        const dryRun = dryRunParam === "true";
        const report = await writerOf(res).importCatalog(
            csv,
            { dryRun },
            contextOf(req),
        );
        if (report.applied) await announce([]);
        res.status(dryRun || report.applied ? 200 : 422).json(report);
    }),
);

catalogRouter.get(
    "/export",
    read,
    handle(async (req, res) => {
        const query = parseItemQuery({
            archived: "all",
            ...(req.query as Record<string, unknown>),
        });
        if (!query.ok) return invalid(res, query);
        const { items } = await listItems(
            { ...query.value, limit: 1_000_000, offset: 0 },
            visibleCatalogScope(),
            contextOf(req),
        );
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            'attachment; filename="catalog.csv"',
        );
        res.send(exportCatalogCsv(items));
    }),
);

// Body-parser failures (oversized or unreadable CSV) as JSON, not HTML.
catalogRouter.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
        const status = (err as { status?: number } | null)?.status;
        if (status === 413) {
            res.status(413).json({
                code: "import_too_large",
                message: "The file is too large",
            });
        } else if (status === 400) {
            res.status(400).json({
                code: "invalid_request",
                message: "The request body could not be read",
            });
        } else {
            next(err);
        }
    },
);
