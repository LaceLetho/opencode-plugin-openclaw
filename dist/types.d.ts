import type { PluginInput, Hooks } from "@opencode-ai/plugin";
export interface OpenclawConfig {
    port?: number;
    openclawWebhookUrl?: string;
    openclawApiKey?: string;
    maxConcurrentTasks?: number;
}
declare module "@opencode-ai/plugin" {
    interface Config {
        openclaw?: OpenclawConfig;
    }
}
export type { PluginInput, Hooks };
//# sourceMappingURL=types.d.ts.map