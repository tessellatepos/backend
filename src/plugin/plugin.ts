import {
    PluginApiMountDefinition,
    PluginDatabaseMount,
    PluginManifest,
    PluginPermissionProvider,
    PluginUIMountDefinition,
} from "@tessellatepos/plugin-sdk";
import type {
    AuthProvider,
    MemberAuthProvider,
    PaymentProcessor,
    HookContext,
    HookDefinition,
    HookResult,
    EventDefinition,
} from "@tessellatepos/plugin-sdk/server";
import { validateAuthProvider } from "@/auth/providers";
import {
    MemberAuthError,
    validateMemberAuthProvider,
} from "@/auth/members/providers";
import { validatePaymentProcessor } from "@/services/processors/plugin";

interface PluginMounts {
    ui: PluginUIMountDefinition[];
    api: PluginApiMountDefinition[];
    database: PluginDatabaseMount[];
    auth: AuthProvider[];
    memberAuth: MemberAuthProvider[];
    paymentProcessor: PaymentProcessor[];
}

type HookHandler = (...args: unknown[]) => unknown;
type EventHandler = (...args: unknown[]) => void;

export class Plugin {
    protected manifest: PluginManifest;
    protected permissions: PluginPermissionProvider;
    private mounts: PluginMounts = {
        ui: [],
        api: [],
        database: [],
        auth: [],
        memberAuth: [],
        paymentProcessor: [],
    };
    private hookHandlers: Map<string, HookHandler[]> = new Map();
    private eventListeners: Map<string, EventHandler[]> = new Map();

    constructor(
        manifest: PluginManifest,
        permissions: PluginPermissionProvider,
    ) {
        this.manifest = manifest;
        this.permissions = permissions;
    }

    // ── Mounts ──

    /**
     * Adds a mount. Registering an `auth` provider needs the AUTH permission
     * and a valid provider; otherwise this throws, so the plugin fails to
     * load.
     * @param kind which kind of mount
     * @param mount the mount definition
     * A `paymentProcessor` needs the PAYMENT permission and an id inside the
     * plugin's namespace, likewise.
     * @throws AuthProviderError for an `auth` mount that is not allowed or
     * not valid
     * @throws PaymentProcessorError for a `paymentProcessor` mount that is not
     * allowed or not valid
     */
    public register<K extends keyof PluginMounts>(
        kind: K,
        mount: PluginMounts[K][number],
    ) {
        if (kind === "auth") {
            validateAuthProvider(
                this.manifest.name,
                this.permissions.auth,
                mount,
            );
        }
        if (kind === "memberAuth") {
            validateMemberAuthProvider(
                this.manifest.name,
                this.permissions.memberAuth,
                mount,
            );
        }
        if (kind === "api") {
            this.validateApiMount(mount as PluginApiMountDefinition);
        }
        if (kind === "paymentProcessor") {
            validatePaymentProcessor(
                this.manifest.name,
                this.permissions.payment,
                mount,
            );
        }
        (this.mounts[kind] as PluginMounts[K][number][]).push(mount);
    }

    // A "member" route is served on the public member surface, so it needs
    // the permission, stays off the gateway, and cannot shadow the host's own
    // /auth routes there.
    private validateApiMount(mount: PluginApiMountDefinition) {
        const name = this.manifest.name;
        if (mount.access === undefined || mount.access === "staff") return;
        if (mount.access !== "member") {
            throw new MemberAuthError(
                `Plugin "${name}": route "${mount.route}" access must be "staff" or "member"`,
            );
        }
        if (!this.permissions.memberAuth) {
            throw new MemberAuthError(
                `Plugin "${name}" declared a member route without the MEMBER_AUTH permission; add "MEMBER_AUTH" to tessellate.permissions in its package.json`,
            );
        }
        if (mount.gateway) {
            throw new MemberAuthError(
                `Plugin "${name}": member route "${mount.route}" cannot also be exposed through the gateway`,
            );
        }
        if (mount.route === "/auth" || mount.route.startsWith("/auth/")) {
            throw new MemberAuthError(
                `Plugin "${name}": member route "${mount.route}" is reserved for the host's member sign-in`,
            );
        }
    }

    public get<K extends keyof PluginMounts>(kind: K): PluginMounts[K] {
        return this.mounts[kind];
    }

    public getPermissions(): PluginPermissionProvider {
        return this.permissions;
    }

    public getManifest(): PluginManifest {
        return this.manifest;
    }

    // ── Hooks (pre-event, can modify or block) ──
    // Type is inferred from the HookDefinition the plugin passes in.

    public hook<TInput, TOutput>(
        def: HookDefinition<TInput, TOutput>,
        handler: (
            input: TInput,
            ctx: HookContext,
        ) => HookResult<TOutput> | Promise<HookResult<TOutput>>,
    ): void {
        const list = this.hookHandlers.get(def.name) ?? [];
        list.push(handler as unknown as HookHandler);
        this.hookHandlers.set(def.name, list);
    }

    public getHookHandlers(name: string): HookHandler[] {
        return this.hookHandlers.get(name) ?? [];
    }

    // ── Events (post-event, fire and forget) ──
    // Type is inferred from the EventDefinition.

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any[] needed for Parameters<THandler> to extract arg types
    public on<THandler extends (...args: any[]) => void>(
        def: EventDefinition<THandler>,
        handler: THandler,
    ): void {
        const list = this.eventListeners.get(def.name) ?? [];
        list.push(handler as unknown as EventHandler);
        this.eventListeners.set(def.name, list);
    }

    public getEventListeners(name: string): EventHandler[] {
        return this.eventListeners.get(name) ?? [];
    }
}
