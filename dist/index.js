import { createServer } from "http";
const sessionRegistry = new Map();
let pluginConfig = {
    port: 9090,
    openclawWebhookUrl: "",
    openclawApiKey: "",
};
/**
 * Logger utility for structured logging to stdout
 * Railway Dashboard captures stdout/stderr for log visibility
 */
const log = (level, message, meta) => {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    const logLine = `${timestamp} [openclaw-plugin] [${level}] ${message}${metaStr}`;
    if (level === "ERROR") {
        console.error(logLine);
    }
    else if (level === "WARN") {
        console.warn(logLine);
    }
    else {
        console.log(logLine);
    }
};
const logger = {
    debug: (message, meta) => {
        if (process.env.LOG_LEVEL?.toLowerCase() === "debug") {
            log("DEBUG", message, meta);
        }
    },
    info: (message, meta) => log("INFO", message, meta),
    warn: (message, meta) => log("WARN", message, meta),
    error: (message, meta) => log("ERROR", message, meta),
};
const readBody = (req) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
};
const formatCallbackMessage = (sessionId, state) => {
    const lines = [];
    if (state.hasError) {
        lines.push(`Task failed: ${sessionId}`);
        if (state.errorMessage) {
            lines.push(`\nError:\n${state.errorMessage}`);
        }
    }
    else {
        lines.push(`Task completed: ${sessionId}`);
    }
    if (state.textParts.length > 0) {
        lines.push("\nResult:");
        lines.push(state.textParts.join(""));
    }
    if (state.toolOutputs.length > 0) {
        lines.push("\n\nTools executed:");
        for (const tool of state.toolOutputs) {
            lines.push(`\n[${tool.tool}]:`);
            if (tool.error) {
                lines.push(`  Error: ${tool.error}`);
            }
            else {
                lines.push(`  ${tool.output}`);
            }
        }
    }
    return lines.join("\n");
};
const sendCallback = async (sessionId, state) => {
    const payload = {
        message: formatCallbackMessage(sessionId, state),
        name: "OpenCode Task",
        agentId: state.config.agentId || "main",
        wakeMode: "now",
        deliver: state.config.deliver ?? true,
        channel: state.config.channel || "last",
    };
    logger.info("Sending callback to OpenClaw", {
        sessionId,
        callbackUrl: state.config.url,
        agentId: payload.agentId,
        hasError: state.hasError,
        textParts: state.textParts.length,
        toolOutputs: state.toolOutputs.length,
    });
    const startTime = Date.now();
    try {
        const res = await fetch(state.config.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(state.config.apiKey ? { Authorization: `Bearer ${state.config.apiKey}` } : {}),
            },
            body: JSON.stringify(payload),
        });
        const duration = Date.now() - startTime;
        if (!res.ok) {
            logger.error("Callback failed", {
                sessionId,
                status: res.status,
                statusText: res.statusText,
                duration,
            });
        }
        else {
            logger.info("Callback sent successfully", {
                sessionId,
                status: res.status,
                duration,
            });
        }
    }
    catch (err) {
        logger.error("Failed to send callback", {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
            duration: Date.now() - startTime,
        });
    }
};
const handleSessionComplete = async (sessionId, state) => {
    logger.info("Session completed, triggering callback", {
        sessionId,
        status: state.status,
        hasError: state.hasError,
    });
    await sendCallback(sessionId, state);
    sessionRegistry.delete(sessionId);
    logger.info("Session removed from registry", { sessionId, remainingSessions: sessionRegistry.size });
};
export default async function OpenclawPlugin({}) {
    logger.info("Initializing OpenClaw plugin", { port: pluginConfig.port });
    const server = createServer(async (req, res) => {
        const url = req.url || "/";
        const method = req.method || "GET";
        const startTime = Date.now();
        res.setHeader("Content-Type", "application/json");
        // Log all HTTP requests
        logger.debug("HTTP request received", { method, url, userAgent: req.headers["user-agent"] });
        if (url === "/health" && method === "GET") {
            res.writeHead(200);
            res.end(JSON.stringify({
                status: "ok",
                registeredSessions: sessionRegistry.size,
            }));
            logger.debug("Health check served", { duration: Date.now() - startTime });
            return;
        }
        if (url === "/register" && method === "POST") {
            try {
                const body = await readBody(req);
                const { sessionId, callbackConfig } = JSON.parse(body);
                logger.info("Callback registration request", {
                    sessionId,
                    callbackUrl: callbackConfig?.url,
                    agentId: callbackConfig?.agentId,
                });
                if (!sessionId || !callbackConfig?.url) {
                    logger.warn("Invalid callback registration - missing fields", { sessionId, hasUrl: !!callbackConfig?.url });
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "Missing required fields: sessionId, callbackConfig.url" }));
                    return;
                }
                sessionRegistry.set(sessionId, {
                    config: {
                        url: callbackConfig.url,
                        apiKey: callbackConfig.apiKey || pluginConfig.openclawApiKey,
                        agentId: callbackConfig.agentId || "main",
                        channel: callbackConfig.channel || "last",
                        deliver: callbackConfig.deliver ?? true,
                    },
                    textParts: [],
                    toolOutputs: [],
                    hasError: false,
                });
                logger.info("Callback registered successfully", {
                    sessionId,
                    callbackUrl: callbackConfig.url,
                    agentId: callbackConfig.agentId || "main",
                    totalRegistered: sessionRegistry.size,
                });
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, sessionId }));
            }
            catch (err) {
                logger.error("Failed to register callback", {
                    error: err instanceof Error ? err.message : String(err),
                });
                res.writeHead(500);
                res.end(JSON.stringify({ error: "Internal server error" }));
            }
            return;
        }
        logger.warn("Unknown endpoint accessed", { method, url });
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
    });
    await new Promise((resolve, reject) => {
        server.listen(pluginConfig.port, () => {
            logger.info("Plugin HTTP server started", {
                port: pluginConfig.port,
                logLevel: process.env.LOG_LEVEL || "info",
            });
            resolve();
        });
        server.on("error", (err) => {
            logger.error("Failed to start HTTP server", { error: err.message });
            reject(err);
        });
    });
    return {
        config: async (cfg) => {
            if (cfg.openclaw) {
                Object.assign(pluginConfig, cfg.openclaw);
                logger.info("Configuration updated", {
                    port: pluginConfig.port,
                    hasApiKey: !!pluginConfig.openclawApiKey,
                });
            }
        },
        "message.part.updated": async (event) => {
            const part = event.part;
            if (!part?.sessionID)
                return;
            const state = sessionRegistry.get(part.sessionID);
            if (!state)
                return;
            logger.debug("Message part updated", {
                sessionId: part.sessionID,
                partType: part.type,
                partId: part.id,
            });
            switch (part.type) {
                case "text": {
                    if (part.text) {
                        state.textParts.push(part.text);
                        logger.debug("Text part accumulated", {
                            sessionId: part.sessionID,
                            textLength: part.text.length,
                            totalParts: state.textParts.length,
                        });
                    }
                    break;
                }
                case "tool": {
                    if (part.state) {
                        switch (part.state.status) {
                            case "completed":
                                state.toolOutputs.push({
                                    tool: part.tool,
                                    output: part.state.output || "(no output)",
                                });
                                logger.debug("Tool execution completed", {
                                    sessionId: part.sessionID,
                                    tool: part.tool,
                                    totalTools: state.toolOutputs.length,
                                });
                                break;
                            case "error":
                                state.hasError = true;
                                state.toolOutputs.push({
                                    tool: part.tool,
                                    output: "",
                                    error: part.state.error || "Unknown error",
                                });
                                logger.warn("Tool execution failed", {
                                    sessionId: part.sessionID,
                                    tool: part.tool,
                                    error: part.state.error,
                                });
                                break;
                        }
                    }
                    break;
                }
                case "reasoning": {
                    logger.debug("Reasoning part received", { sessionId: part.sessionID });
                    break;
                }
            }
        },
        "message.part.delta": async (event) => {
            const { sessionID, field, delta } = event;
            if (!sessionID || field !== "text" || !delta)
                return;
            const state = sessionRegistry.get(sessionID);
            if (!state)
                return;
            if (state.textParts.length > 0) {
                state.textParts[state.textParts.length - 1] += delta;
            }
            else {
                state.textParts.push(delta);
            }
            logger.debug("Text delta received", {
                sessionId: sessionID,
                deltaLength: delta.length,
                totalLength: state.textParts.join("").length,
            });
        },
        "session.updated": async (event) => {
            const info = event.info;
            if (!info?.id)
                return;
            const state = sessionRegistry.get(info.id);
            if (!state)
                return;
            const previousStatus = state.status;
            state.status = info.status;
            logger.info("Session status updated", {
                sessionId: info.id,
                previousStatus,
                currentStatus: info.status,
                hasText: state.textParts.length > 0,
                hasTools: state.toolOutputs.length > 0,
            });
            if (info.status === "completed" || info.status === "failed") {
                if (info.status === "failed") {
                    state.hasError = true;
                    logger.warn("Session failed, triggering error callback", { sessionId: info.id });
                }
                await handleSessionComplete(info.id, state);
            }
        },
        "session.error": async (event) => {
            const { sessionID, error } = event;
            if (!sessionID)
                return;
            const state = sessionRegistry.get(sessionID);
            if (!state)
                return;
            state.hasError = true;
            state.errorMessage = error?.message || String(error);
            logger.error("Session error received", {
                sessionId: sessionID,
                error: state.errorMessage,
            });
        },
        "session.deleted": async (event) => {
            const sessionId = event.info?.id || event.sessionId;
            if (sessionId && sessionRegistry.has(sessionId)) {
                logger.info("Session deleted, removing callback registration", {
                    sessionId,
                    wasTracked: true,
                });
                sessionRegistry.delete(sessionId);
            }
        },
        dispose: async () => {
            logger.info("Plugin disposing", { registeredSessions: sessionRegistry.size });
            server.close();
            sessionRegistry.clear();
            logger.info("Plugin disposed");
        },
    };
}
//# sourceMappingURL=index.js.map