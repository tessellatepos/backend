class BackendPluginManager {
    private plugins = new Map<string, BackendPlugin>();

    async loadFromGitHub(namespace: string): Promise<void> {
        const plugin = await import(namespace);

        await this.register(plugin.default);
    }

    async register(plugin: BackendPlugin): Promise<void> {
        this.plugins.set(plugin.namespace, plugin);
    }
}