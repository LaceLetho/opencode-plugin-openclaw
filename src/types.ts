import type { PluginInput, Hooks } from "@opencode-ai/plugin"

// Plugin configuration is now loaded from environment variables only
// to avoid compatibility issues with opencode.json
export interface OpenclawConfig {
  port?: number
  openclawApiKey?: string
}

export interface CallbackConfig {
  url: string
  apiKey?: string
  agentId?: string
  channel?: string
  deliver?: boolean
  to?: string
}

// Removed: Config module extension for opencode.json
// Plugin now only uses environment variables for configuration

export type { PluginInput, Hooks }
