/**
 * In-process invocation: the gateway calls the same handler the internal
 * route uses, with no HTTP hop. The request is a thin copy of the gateway
 * request with the url, params, query and body replaced; the response is
 * captured instead of written.
 */
import type { Request, Response } from "express";
import type { GatewayEntry } from "@/gateway/registry";

/** What a handler answered. */
export interface CapturedResponse {
    status: number;
    headers: Record<string, string>;
    /** The parsed JSON body, or the raw string a handler sent. */
    body: unknown;
}

/** The parts of the request a handler may read that the gateway replaces. */
export interface InvokeInput {
    params: Record<string, string>;
    query?: unknown;
    body?: unknown;
}

/**
 * Fills `:name` placeholders in a path with encoded values.
 * @param template the path, e.g. "/by-location/:locationId"
 * @param params the values by name
 * @returns the concrete path
 */
export function fillPath(
    template: string,
    params: Record<string, string>,
): string {
    return template.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
        const value = params[name];
        if (value === undefined) {
            throw new Error(`No value for route parameter "${name}"`);
        }
        return encodeURIComponent(value);
    });
}

/**
 * A response that records what is sent and reports it once, when the
 * handler finishes. It supports the subset of the Express response API the
 * internal handlers use.
 */
class CaptureResponse {
    statusCode = 200;
    locals: Record<string, unknown> = {};
    private readonly headers = new Map<string, string>();
    private done = false;
    private readonly onDone: (result: CapturedResponse) => void;

    constructor(onDone: (result: CapturedResponse) => void) {
        this.onDone = onDone;
    }

    get headersSent(): boolean {
        return this.done;
    }

    status(code: number): this {
        this.statusCode = code;
        return this;
    }

    set(name: string, value: string | string[]): this {
        this.headers.set(name.toLowerCase(), String(value));
        return this;
    }

    header(name: string, value: string | string[]): this {
        return this.set(name, value);
    }

    setHeader(name: string, value: string | string[]): this {
        return this.set(name, value);
    }

    get(name: string): string | undefined {
        return this.headers.get(name.toLowerCase());
    }

    getHeader(name: string): string | undefined {
        return this.get(name);
    }

    type(contentType: string): this {
        return this.set("content-type", contentType);
    }

    vary(): this {
        return this;
    }

    json(body: unknown): this {
        if (!this.get("content-type"))
            this.set("content-type", "application/json");
        return this.end(body);
    }

    send(body?: unknown): this {
        return this.end(body);
    }

    sendStatus(code: number): this {
        this.statusCode = code;
        return this.end(String(code));
    }

    end(body?: unknown): this {
        if (this.done) return this;
        this.done = true;
        this.onDone({
            status: this.statusCode,
            headers: Object.fromEntries(this.headers),
            body,
        });
        return this;
    }
}

/**
 * Runs an operation's handler in process and resolves with what it answered.
 * Rejects when the handler throws, or when no route matched (the internal
 * route is missing, which means the descriptor is out of date).
 * @param entry the operation
 * @param req the gateway request, for the principal and app
 * @param input the replaced parts of the request
 * @returns the captured response
 */
export function invokeEntry(
    entry: GatewayEntry,
    req: Request,
    input: InvokeInput,
): Promise<CapturedResponse> {
    const params = { ...entry.invokeParams, ...input.params };
    const url = fillPath(entry.invokeTemplate, params);
    const inner = Object.create(req) as Request;
    Object.defineProperties(inner, {
        method: {
            value: entry.operation.method,
            writable: true,
            configurable: true,
            enumerable: true,
        },
        url: {
            value: url,
            writable: true,
            configurable: true,
            enumerable: true,
        },
        originalUrl: {
            value: url,
            writable: true,
            configurable: true,
            enumerable: true,
        },
        params: {
            value: params,
            writable: true,
            configurable: true,
            enumerable: true,
        },
        query: {
            value: input.query ?? {},
            writable: true,
            configurable: true,
            enumerable: true,
        },
        body: {
            value: input.body,
            writable: true,
            configurable: true,
            enumerable: true,
        },
    });

    return new Promise<CapturedResponse>((resolve, reject) => {
        const res = new CaptureResponse(resolve);
        try {
            entry.handle(inner, res as unknown as Response, (err?: unknown) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve({ status: 404, headers: {}, body: undefined });
            });
        } catch (err) {
            reject(err);
        }
    });
}
