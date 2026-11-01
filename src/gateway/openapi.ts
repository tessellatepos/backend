/**
 * OpenAPI 3.1 for the gateway, generated from the same descriptors that serve
 * the routes. It lists only the operations the calling credential may use.
 */
import { z } from "zod";
import type { Scope } from "@tessellatepos/sdk";
import type { GatewayEntry, GatewayRegistry } from "@/gateway/registry";
import { GATEWAY_PREFIX } from "@/gateway/registry";

type JsonObject = Record<string, unknown>;

const ERROR_SCHEMA: JsonObject = {
    type: "object",
    properties: {
        message: { type: "string" },
        code: { type: "string" },
    },
    required: ["message", "code"],
};

/**
 * Converts a zod schema to JSON Schema for the wire form (`io: input`), so an
 * amount reads as a digit string.
 * @param schema the zod schema
 * @returns the JSON Schema without its `$schema` marker
 */
export function toWireJsonSchema(schema: z.ZodType): JsonObject {
    const json = z.toJSONSchema(schema, {
        io: "input",
        unrepresentable: "any",
        reused: "inline",
    }) as JsonObject;
    delete json.$schema;
    return json;
}

/**
 * Converts `/items/:locationId` to OpenAPI's `/items/{locationId}`.
 * @param publicPath a public gateway path
 * @returns the OpenAPI path template
 */
export function toOpenApiPath(publicPath: string): string {
    return publicPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function tagOf(entry: GatewayEntry): string {
    if (entry.owner.kind === "plugin") return `plugin:${entry.owner.name}`;
    const parts = entry.publicPath.slice(GATEWAY_PREFIX.length).split("/");
    return parts[1] || "gateway";
}

function parametersOf(entry: GatewayEntry): JsonObject[] {
    const params: JsonObject[] = [];
    for (const match of entry.publicPath.matchAll(/:([A-Za-z0-9_]+)/g)) {
        params.push({
            name: match[1],
            in: "path",
            required: true,
            schema: { type: "string" },
        });
    }
    const request = entry.operation.request;
    if (
        request &&
        (entry.operation.method === "GET" ||
            entry.operation.method === "DELETE")
    ) {
        const json = toWireJsonSchema(request);
        const properties = (json.properties ?? {}) as Record<
            string,
            JsonObject
        >;
        const required = (json.required ?? []) as string[];
        for (const [name, schema] of Object.entries(properties)) {
            params.push({
                name,
                in: "query",
                required: required.includes(name),
                schema,
            });
        }
    }
    return params;
}

/**
 * Describes one operation.
 * @param entry the operation
 * @returns the OpenAPI operation object
 */
function operationObject(entry: GatewayEntry): JsonObject {
    const { operation } = entry;
    const isBody = !(
        operation.method === "GET" || operation.method === "DELETE"
    );
    const op: JsonObject = {
        operationId: operation.operationId,
        summary: operation.summary,
        tags: [tagOf(entry)],
        security: [{ basicAuth: [] }],
        parameters: parametersOf(entry),
        responses: {
            "200": {
                description: "OK",
                content: {
                    "application/json": {
                        schema: toWireJsonSchema(operation.response),
                    },
                },
            },
            "400": {
                description: "Invalid request",
                content: { "application/json": { schema: ERROR_SCHEMA } },
            },
            "401": {
                description: "No valid credential",
                content: { "application/json": { schema: ERROR_SCHEMA } },
            },
            "403": {
                description: "Not allowed for this credential",
                content: { "application/json": { schema: ERROR_SCHEMA } },
            },
            "429": {
                description: "Rate limited",
                content: { "application/json": { schema: ERROR_SCHEMA } },
            },
        },
    };
    if (isBody && operation.request) {
        op.requestBody = {
            required: true,
            content: {
                "application/json": {
                    schema: toWireJsonSchema(operation.request),
                },
            },
        };
    }
    return op;
}

/**
 * Builds the document for a caller holding `scopes`.
 * @param registry every declared operation
 * @param scopes the calling credential's scopes
 * @returns the OpenAPI 3.1 document
 */
export function buildOpenApiDocument(
    registry: GatewayRegistry,
    scopes: readonly Scope[],
): JsonObject {
    const allows = (scope: Scope) =>
        scopes.includes("*") || scopes.includes(scope);
    const paths: Record<string, Record<string, JsonObject>> = {};
    for (const entry of registry.list()) {
        if (!allows(entry.operation.scope)) continue;
        // Relative to `servers`, which already carries the /gateway/v1 prefix.
        const path = toOpenApiPath(
            entry.publicPath.slice(GATEWAY_PREFIX.length) || "/",
        );
        paths[path] ??= {};
        paths[path][entry.operation.method.toLowerCase()] =
            operationObject(entry);
    }
    return {
        openapi: "3.1.0",
        info: {
            title: "Tessellate gateway",
            version: "v1",
            description:
                "Operations this credential may call. Authenticate with HTTP Basic: the client id as the user name and the client secret as the password.",
        },
        servers: [{ url: GATEWAY_PREFIX }],
        paths,
        components: {
            securitySchemes: {
                basicAuth: { type: "http", scheme: "basic" },
            },
        },
    };
}
