export interface OpenclawConfig {
    port?: number;
    openclawWebhookUrl?: string;
    openclawApiKey?: string;
    maxConcurrentTasks?: number;
}
interface PluginInput {
    client: {
        session: {
            create: () => Promise<any>;
            prompt: (pathParams: {
                path: {
                    id: string;
                };
            }, body: {
                content: string;
            }) => Promise<any>;
        };
    };
}
declare const OpenclawPlugin: ({ client }: PluginInput) => Promise<{
    config: (cfg: {
        openclaw?: OpenclawConfig;
    }) => Promise<void>;
    dispose: () => Promise<void>;
}>;
export default OpenclawPlugin;
//# sourceMappingURL=index.d.ts.map