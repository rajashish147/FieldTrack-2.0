import type { FastifyLoggerOptions } from "fastify";
import type { PinoLoggerOptions } from "fastify/types/logger.js";

type LoggerConfig = FastifyLoggerOptions & PinoLoggerOptions;

const developmentLogger: LoggerConfig = {
    level: "debug",
    transport: {
        target: "pino-pretty",
        options: {
            colorize: true,
            translateTime: "HH:MM:ss Z",
            ignore: "pid,hostname",
        },
    },
};

const productionLogger: LoggerConfig = {
    level: "info",
};

export function getLoggerConfig(nodeEnv: string): LoggerConfig {
    return nodeEnv === "production" ? productionLogger : developmentLogger;
}
