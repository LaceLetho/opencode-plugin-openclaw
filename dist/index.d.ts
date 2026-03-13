import type { PluginInput } from "@opencode-ai/plugin";
export interface OpenclawConfig {
    port?: number;
    openclawWebhookUrl?: string;
    openclawApiKey?: string;
}
export default function OpenclawPlugin({}: PluginInput): Promise<{
    config: (cfg: {
        openclaw?: OpenclawConfig;
    }) => Promise<void>;
    "message.part.updated": (event: any) => Promise<void>;
    "message.part.delta": (event: any) => Promise<void>;
    "session.updated": (event: any) => Promise<void>;
    "session.error": (event: any) => Promise<void>;
    "session.deleted": (event: any) => Promise<void>;
    dispose: () => Promise<void>;
}>;
//# sourceMappingURL=index.d.ts.map