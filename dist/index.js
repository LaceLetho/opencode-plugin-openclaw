import { createServer } from "http";
import { EventEmitter } from "events";
const tasks = new Map();
let runningTasks = 0;
const events = new EventEmitter();
const config = {
    port: 9090,
    openclawWebhookUrl: "",
    openclawApiKey: "",
    maxConcurrentTasks: 5
};
const readBody = (req) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
};
const waitForSlot = () => {
    return new Promise((resolve) => {
        const handler = () => {
            events.off("slot-freed", handler);
            resolve();
        };
        events.once("slot-freed", handler);
    });
};
const notifyOpenclaw = async (task) => {
    if (!task.callbackUrl)
        return;
    const payload = {
        taskId: task.id,
        status: task.status,
        result: task.result,
        error: task.error,
        sessionId: task.sessionId,
        completedAt: task.updatedAt.toISOString()
    };
    try {
        const res = await fetch(task.callbackUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(config.openclawApiKey ? { "Authorization": `Bearer ${config.openclawApiKey}` } : {})
            },
            body: JSON.stringify(payload)
        });
        if (!res.ok) {
            console.error(`[openclaw] Callback failed for task ${task.id}: ${res.status} ${res.statusText}`);
        }
        else {
            console.log(`[openclaw] Callback sent for task: ${task.id}`);
        }
    }
    catch (err) {
        console.error(`[openclaw] Failed to send callback for task ${task.id}:`, err);
    }
};
const OpenclawPlugin = async ({ client }) => {
    const server = createServer(async (req, res) => {
        const url = req.url || "/";
        const method = req.method || "GET";
        res.setHeader("Content-Type", "application/json");
        if (url === "/health" && method === "GET") {
            res.writeHead(200);
            res.end(JSON.stringify({ status: "ok", tasks: tasks.size, running: runningTasks }));
            return;
        }
        if (url === "/tasks" && method === "POST") {
            try {
                const body = await readBody(req);
                const payload = JSON.parse(body);
                if (!payload.taskId || !payload.prompt) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "Missing required fields: taskId, prompt" }));
                    return;
                }
                const task = {
                    id: payload.taskId,
                    prompt: payload.prompt,
                    callbackUrl: payload.callbackUrl || config.openclawWebhookUrl,
                    status: "pending",
                    createdAt: new Date(),
                    updatedAt: new Date()
                };
                tasks.set(task.id, task);
                console.log(`[openclaw] Task received: ${task.id}`);
                res.writeHead(202);
                res.end(JSON.stringify({ taskId: task.id, status: "accepted" }));
                const executeTask = async () => {
                    if (runningTasks >= config.maxConcurrentTasks) {
                        console.log(`[openclaw] Task ${task.id} queued (max concurrent reached)`);
                        await waitForSlot();
                    }
                    runningTasks++;
                    task.status = "running";
                    task.updatedAt = new Date();
                    try {
                        console.log(`[openclaw] Executing task: ${task.id}`);
                        const sessionResult = await client.session.create();
                        const session = sessionResult.data || sessionResult;
                        task.sessionId = session.id;
                        const response = await client.session.prompt({ path: { id: session.id } }, { content: task.prompt });
                        const message = response.data || response;
                        task.status = "completed";
                        task.result = message.info?.content || message.content || JSON.stringify(message);
                        task.updatedAt = new Date();
                        console.log(`[openclaw] Task completed: ${task.id}`);
                        await notifyOpenclaw(task);
                    }
                    catch (err) {
                        task.status = "failed";
                        task.error = err instanceof Error ? err.message : String(err);
                        task.updatedAt = new Date();
                        console.error(`[openclaw] Task failed: ${task.id}`, err);
                        await notifyOpenclaw(task);
                    }
                    finally {
                        runningTasks--;
                        events.emit("slot-freed");
                    }
                };
                executeTask();
            }
            catch (err) {
                console.error("[openclaw] Failed to handle task request:", err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: "Internal server error" }));
            }
            return;
        }
        if (url.startsWith("/tasks/") && method === "GET") {
            const taskId = url.split("/")[2];
            const task = tasks.get(taskId);
            if (!task) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: "Task not found" }));
                return;
            }
            res.writeHead(200);
            res.end(JSON.stringify({
                taskId: task.id,
                status: task.status,
                result: task.result,
                error: task.error,
                createdAt: task.createdAt,
                updatedAt: task.updatedAt
            }));
            return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
    });
    await new Promise((resolve, reject) => {
        server.listen(config.port, () => {
            console.log(`[openclaw] Webhook server listening on port ${config.port}`);
            resolve();
        });
        server.on("error", reject);
    });
    return {
        config: async (cfg) => {
            const openclawCfg = cfg.openclaw;
            if (openclawCfg) {
                Object.assign(config, openclawCfg);
            }
            if (!config.openclawWebhookUrl) {
                console.log("[openclaw] No default callback URL configured");
            }
        },
        dispose: async () => {
            server.close();
            events.removeAllListeners();
            console.log("[openclaw] Plugin disposed");
        }
    };
};
export default OpenclawPlugin;
//# sourceMappingURL=index.js.map