import type { PluginInput, Hooks } from "@opencode-ai/plugin"

export interface OpenclawConfig {
  port?: number
  openclawWebhookUrl?: string
  openclawApiKey?: string
}

export interface CallbackConfig {
  url: string
  apiKey?: string
  agentId?: string
  channel?: string
  deliver?: boolean
}

declare module "@opencode-ai/plugin" {
  interface Config {
    openclaw?: OpenclawConfig
  }
}

export type { PluginInput, Hooks }
