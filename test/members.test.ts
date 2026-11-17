import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Member } from "@tessellatepos/sdk";
import type { MemberAuthProvider } from "@tessellatepos/plugin-sdk/server";
import { pool } from "@/services/db/postgres";
import { memberProviders } from "@/auth/members/providers";
import {
    completeMemberSignIn,
    getActiveMemberSource,
    removeMember,
    resolveMemberPrincipal,
    saveMemberSource,
    updateMember,
    type MemberEvents,
} from "@/services/members";
import { createMemberRouter } from "@/members/memberRouter";
import { startTestApp, type TestApp } from "./helpers/app";
import { migrateTestDb } from "./helpers/db";

const plugin = `tab-${randomUUID().slice(0, 8)}`;
const other = `other-${randomUUID().slice(0, 8)}`;

function provider(extra: Partial<MemberAuthProvider> = {}): MemberAuthProvider {
    return {
        id: "discord",
        label: "Discord",
        oauth: {
            authorizationUrl: "https://idp.test/authorize",
            tokenUrl: "https://idp.test/token",
            userInfoUrl: "https://idp.test/me",
            clientId: "",
            clientSecret: "",
        },
        ...extra,
    };
}

function recorder() {
    const log: string[] = [];
    const events: MemberEvents = {
        created: (m) => log.push(`created:${m.status}`),
        updated: (m, prev) => log.push(`updated:${prev.status}>${m.status}`),
        deleted: (m) => log.push(`deleted:${m.id}`),
    };
    return { log, events };
}

async function activate(
    signup: "open" | "approval" | null,
    pluginName = plugin,
) {
    await saveMemberSource(pluginName, "discord", {
        enabled: true,
        signup,
        clientId: "cid",
        clientSecret: "secret",
    });
    const source = await getActiveMemberSource(pluginName, "discord");
    assert.ok(source);
    return source;
}

const profile = (subject: string, name = "Sam") => ({
    provider: "discord",
    subject,
    name,
    raw: {},
});

describe("member sign-in", () => {
    before(async () => {
        await migrateTestDb();
    });
    beforeEach(() => {
        memberProviders.removePlugin(plugin);
        memberProviders.removePlugin(other);
    });
    after(async () => {
        await pool.query(
            `DELETE FROM "tessellate-members" WHERE plugin = ANY($1)`,
            [[plugin, other]],
        );
        await pool.query(
            `DELETE FROM "tessellate-member-sources" WHERE plugin = ANY($1)`,
            [[plugin, other]],
        );
    });

    it("stays inactive until the owner enables it and adds credentials", async () => {
        memberProviders.register({ pluginName: plugin, provider: provider() });
        assert.equal(await getActiveMemberSource(plugin, "discord"), null);
        await saveMemberSource(plugin, "discord", { enabled: true });
        assert.equal(await getActiveMemberSource(plugin, "discord"), null);
        await saveMemberSource(plugin, "discord", {
            clientId: "c",
            clientSecret: "s",
        });
        assert.ok(await getActiveMemberSource(plugin, "discord"));
    });

    it("open signup creates an active member with a working session", async () => {
        memberProviders.register({ pluginName: plugin, provider: provider() });
        const source = await activate("open");
        const { log, events } = recorder();
        const result = await completeMemberSignIn(
            source,
            profile("u-open"),
            events,
        );
        assert.equal(result.kind, "signed-in");
        if (result.kind !== "signed-in") return;
        assert.equal(result.member.status, "active");
        assert.deepEqual(log, ["created:active"]);

        const principal = await resolveMemberPrincipal(result.token, plugin);
        assert.equal(principal?.kind, "member");
        assert.deepEqual(principal?.scopes, [`plugin:${plugin}:member`]);
        assert.deepEqual(principal?.roles, []);
        // A member of one plugin is nobody on another plugin's routes.
        assert.equal(await resolveMemberPrincipal(result.token, other), null);

        // A second login is the same member, not a new one.
        const again = await completeMemberSignIn(
            source,
            profile("u-open"),
            events,
        );
        assert.equal(
            again.kind === "signed-in" && again.member.id,
            result.member.id,
        );
        assert.deepEqual(log, ["created:active"]);
    });

    it("approval signup waits for staff, then lets them in", async () => {
        memberProviders.register({ pluginName: plugin, provider: provider() });
        const source = await activate(null); // the plugin default is approval
        const { log, events } = recorder();
        const first = await completeMemberSignIn(
            source,
            profile("u-wait"),
            events,
        );
        assert.equal(first.kind, "pending");
        if (first.kind !== "pending") return;
        assert.deepEqual(log, ["created:pending"]);

        const again = await completeMemberSignIn(
            source,
            profile("u-wait"),
            events,
        );
        assert.equal(again.kind, "pending");

        await updateMember(first.member.id, { status: "active" }, events);
        const ok = await completeMemberSignIn(
            source,
            profile("u-wait"),
            events,
        );
        assert.equal(ok.kind, "signed-in");
        assert.ok(log.includes("updated:pending>active"));
    });

    it("lets the owner override the plugin's signup choice", async () => {
        memberProviders.register({
            pluginName: plugin,
            provider: provider({ signup: "open" }),
        });
        const source = await activate("approval");
        const result = await completeMemberSignIn(
            source,
            profile("u-override"),
            recorder().events,
        );
        assert.equal(result.kind, "pending");
    });

    it("disabling ends sessions and blocks the next login", async () => {
        memberProviders.register({ pluginName: plugin, provider: provider() });
        const source = await activate("open");
        const { events } = recorder();
        const result = await completeMemberSignIn(
            source,
            profile("u-off"),
            events,
        );
        assert.equal(result.kind, "signed-in");
        if (result.kind !== "signed-in") return;
        await updateMember(result.member.id, { status: "disabled" }, events);
        assert.equal(await resolveMemberPrincipal(result.token, plugin), null);
        const next = await completeMemberSignIn(
            source,
            profile("u-off"),
            events,
        );
        assert.equal(next.kind, "disabled");
    });

    it("lets the plugin deny, and a throwing plugin denies", async () => {
        memberProviders.register({
            pluginName: plugin,
            provider: provider({
                resolveMember: (p) =>
                    p.subject === "u-boom"
                        ? (() => {
                              throw new Error("boom");
                          })()
                        : { deny: "not in the club" },
            }),
        });
        const source = await activate("open");
        const { log, events } = recorder();
        const denied = await completeMemberSignIn(
            source,
            profile("u-no"),
            events,
        );
        assert.deepEqual(denied, { kind: "denied", reason: "not in the club" });
        const boom = await completeMemberSignIn(
            source,
            profile("u-boom"),
            events,
        );
        assert.equal(boom.kind, "denied");
        assert.deepEqual(log, []); // nobody was created
    });

    it("deleting a member removes sessions and tells the plugin", async () => {
        memberProviders.register({ pluginName: plugin, provider: provider() });
        const source = await activate("open");
        const { log, events } = recorder();
        const result = await completeMemberSignIn(
            source,
            profile("u-del"),
            events,
        );
        assert.equal(result.kind, "signed-in");
        if (result.kind !== "signed-in") return;
        assert.equal(await removeMember(result.member.id, events), true);
        assert.equal(await resolveMemberPrincipal(result.token, plugin), null);
        assert.ok(log.includes(`deleted:${result.member.id}`));
        assert.equal(await removeMember(result.member.id, events), false);
    });
});

describe("member sign-in over HTTP", () => {
    let server: TestApp;
    const created: Member[] = [];

    before(async () => {
        await migrateTestDb();
        memberProviders.removePlugin(plugin);
        memberProviders.register({ pluginName: plugin, provider: provider() });
        await activate("open");
        // The identity provider, standing in for the real one.
        const idp = (async (url: string | URL | Request) => {
            const target = String(url);
            if (target.endsWith("/token")) {
                return Response.json({ access_token: "at" });
            }
            return Response.json({ id: "http-user", username: "sam" });
        }) as typeof fetch;
        server = await startTestApp((app) => {
            app.use(
                "/member/:pluginName",
                createMemberRouter({
                    pluginApi: {
                        dispatchMember: (_req, res) => {
                            res.status(404).end();
                        },
                    },
                    limiter: async () => true,
                    fetch: idp,
                    eventsFor: () => ({
                        created: (m) => created.push(m),
                        updated: () => {},
                        deleted: () => {},
                    }),
                }),
            );
        });
    });
    after(async () => {
        await server.close();
        await pool.query(`DELETE FROM "tessellate-members" WHERE plugin = $1`, [
            plugin,
        ]);
        await pool.query(
            `DELETE FROM "tessellate-member-sources" WHERE plugin = $1`,
            [plugin],
        );
        await pool.end();
    });

    const cookieOf = (res: Response, name: string) =>
        res.headers
            .getSetCookie()
            .map((c) => c.split(";")[0])
            .find((c) => c.startsWith(`${name}=`));

    it("lists the login, runs the redirect flow and signs the member in", async () => {
        const providers = await (
            await fetch(`${server.url}/member/${plugin}/auth/providers`)
        ).json();
        assert.equal(providers.providers[0].id, "discord");

        const start = await fetch(
            `${server.url}/member/${plugin}/auth/discord/start?returnTo=/tab`,
            { redirect: "manual" },
        );
        assert.equal(start.status, 302);
        const authorize = new URL(start.headers.get("location") ?? "");
        const state = authorize.searchParams.get("state");
        assert.ok(state);
        assert.equal(
            authorize.searchParams.get("code_challenge_method"),
            "S256",
        );
        const flow = cookieOf(start, "tessellate_member_flow");
        assert.ok(flow);

        // A callback without the browser's flow cookie is refused.
        const forged = await fetch(
            `${server.url}/member/${plugin}/auth/discord/callback?code=c&state=${state}`,
            { redirect: "manual" },
        );
        assert.equal(forged.status, 400);

        // With the wrong state, nothing is exchanged either.
        const wrongState = await fetch(
            `${server.url}/member/${plugin}/auth/discord/callback?code=c&state=nope`,
            { redirect: "manual", headers: { cookie: flow } },
        );
        assert.equal(wrongState.status, 400);

        const callback = await fetch(
            `${server.url}/member/${plugin}/auth/discord/callback?code=c&state=${state}`,
            { redirect: "manual", headers: { cookie: flow } },
        );
        assert.equal(callback.status, 302);
        assert.equal(callback.headers.get("location"), "/tab?member=ok");
        const session = cookieOf(callback, "tessellate_member");
        assert.ok(session);
        assert.equal(created.length, 1);

        // The session cookie authenticates /auth/me on this plugin only.
        const me = await fetch(`${server.url}/member/${plugin}/auth/me`, {
            headers: { cookie: session },
        });
        assert.equal(me.status, 200);
        assert.equal((await me.json()).plugin, plugin);
        const elsewhere = await fetch(`${server.url}/member/${other}/auth/me`, {
            headers: { cookie: session },
        });
        assert.equal(elsewhere.status, 401);

        // Sign out ends it.
        const out = await fetch(`${server.url}/member/${plugin}/auth/logout`, {
            method: "POST",
            headers: { cookie: session },
        });
        assert.equal(out.status, 204);
        const after = await fetch(`${server.url}/member/${plugin}/auth/me`, {
            headers: { cookie: session },
        });
        assert.equal(after.status, 401);
    });

    it("refuses an unsafe returnTo and an unknown login", async () => {
        const bad = await fetch(
            `${server.url}/member/${plugin}/auth/discord/start?returnTo=https://evil.test/`,
            { redirect: "manual" },
        );
        assert.equal(bad.status, 400);
        const unknown = await fetch(
            `${server.url}/member/${plugin}/auth/nope/start`,
            { redirect: "manual" },
        );
        assert.equal(unknown.status, 404);
    });
});
