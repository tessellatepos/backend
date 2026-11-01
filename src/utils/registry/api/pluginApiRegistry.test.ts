import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PluginPermissionProvider } from "@tessellatepos/plugin-sdk";
import { closeTestDb, setupTestDb } from "@/test/db";
import { TessellatePluginDatabaseRegistry } from "@/utils/registry/database/pluginDatabaseRegistry";
import { buildPluginServerContext } from "./pluginApiRegistry";

const none: PluginPermissionProvider = {
    cart: false,
    catalog: false,
    checkout: false,
    device: false,
    order: false,
    customer: false,
    auth: false,
};

describe("plugin server context customer access", () => {
    before(setupTestDb);
    after(closeTestDb);
    const registry = new TessellatePluginDatabaseRegistry();

    it("rejects customer calls from a plugin without CUSTOMER", async () => {
        const ctx = buildPluginServerContext("p", registry, null, none);
        await assert.rejects(ctx.getCustomer("c1"), /CUSTOMER permission/);
        await assert.rejects(ctx.findCustomers({}), /CUSTOMER permission/);
    });

    it("serves customer calls to a plugin with CUSTOMER", async () => {
        const ctx = buildPluginServerContext("p", registry, null, {
            ...none,
            customer: true,
            auth: false,
        });
        assert.equal(await ctx.getCustomer("does-not-exist"), null);
        const page = await ctx.findCustomers({ limit: 1 });
        assert.ok(Array.isArray(page.customers));
    });
});
