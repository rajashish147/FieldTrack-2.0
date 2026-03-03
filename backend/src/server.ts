import { env } from "./config/env.js";
import { buildApp } from "./app.js";

async function start(): Promise<void> {
    const app = await buildApp();

    try {
        await app.listen({ port: env.PORT, host: "0.0.0.0" });
        app.log.info(`Server running in ${env.NODE_ENV} mode`);
    } catch (error) {
        app.log.error(error, "Failed to start server");
        process.exit(1);
    }
}

start();
