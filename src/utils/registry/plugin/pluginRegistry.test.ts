import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PluginManifest } from "@tessellatepos/plugin-sdk";
import { events, hooks } from "@tessellatepos/plugin-sdk/server";
import { Plugin } from "@/plugin/plugin";
import { TessellatePluginRegistry } from "./pluginRegistry";

const manifest = { name: "t" } as unknown as PluginManifest;

const permissions = (customer: boolean) => ({
    cart: false,
    catalog: false,
    checkout: false,
    device: false,
    order: false,
    customer,
    auth: false,
});

/** Builds a registry holding one permitted and one unpermitted plugin. */
async function setup() {
    const calls: string[] = [];
    const registry = new TessellatePluginRegistry();
    for (const [name, allowed] of [
        ["allowed", true],
        ["denied", false],
    ] as const) {
        const plugin = new Plugin(manifest, permissions(allowed));
        plugin.hook(hooks.beforeCustomerSave, ({ customer }) => {
            calls.push(`${name}:hook`);
            return { ok: true, value: { ...customer, note: name } };
        });
        plugin.on(events.customerDeleted, () => {
            calls.push(`${name}:event`);
        });
        await registry.loadPlugin(name, plugin);
    }
    return { registry, calls };
}

describe("permission-filtered dispatch", () => {
    it("runHook with requires only calls permitted plugins", async () => {
        const { registry, calls } = await setup();
        const result = await registry.runHook(
            hooks.beforeCustomerSave,
            { customer: { given_name: "Ada" } as never },
            { requires: "customer" },
        );
        assert.deepEqual(calls, ["allowed:hook"]);
        assert.ok(result.ok);
        assert.equal(result.ok && result.value.note, "allowed");
    });

    it("runHook without requires calls every plugin", async () => {
        const { registry, calls } = await setup();
        await registry.runHook(hooks.beforeCustomerSave, {
            customer: { given_name: "Ada" } as never,
        });
        assert.deepEqual(calls, ["allowed:hook", "denied:hook"]);
    });

    it("emitTo with requires only calls permitted plugins", async () => {
        const { registry, calls } = await setup();
        registry.emitTo({ requires: "customer" }, events.customerDeleted, "c1");
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(calls, ["allowed:event"]);
    });

    it("emit without a filter still reaches every plugin", async () => {
        const { registry, calls } = await setup();
        registry.emit(events.customerDeleted, "c1");
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(calls, ["allowed:event", "denied:event"]);
    });

    it("carry rebuilds each handler's input from the previous output", async () => {
        const registry = new TessellatePluginRegistry();
        const seenInputs: unknown[] = [];
        for (const name of ["a", "b"]) {
            const plugin = new Plugin(manifest, permissions(true));
            plugin.hook(hooks.beforeCustomerSave, (input) => {
                seenInputs.push(input);
                return {
                    ok: true,
                    value: { ...input.customer, note: `${name}` },
                };
            });
            await registry.loadPlugin(name, plugin);
        }
        const result = await registry.runHook(
            hooks.beforeCustomerSave,
            { customer: { given_name: "Ada" } as never, existingId: "x" },
            {
                carry: (output, input) => ({ ...input, customer: output }),
            },
        );
        assert.equal(result.ok && result.value.note, "b");
        assert.deepEqual(
            seenInputs.map((i) => Object.keys(i as object).sort()),
            [
                ["customer", "existingId"],
                ["customer", "existingId"],
            ],
        );
    });
});
