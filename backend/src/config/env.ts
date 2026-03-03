import dotenv from "dotenv";

dotenv.config();

interface EnvConfig {
    PORT: number;
    NODE_ENV: string;
    SUPABASE_URL: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    SUPABASE_JWT_SECRET: string;
}

function getEnvVar(key: string): string {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

export const env: EnvConfig = {
    PORT: parseInt(process.env["PORT"] ?? "3000", 10),
    NODE_ENV: process.env["NODE_ENV"] ?? "development",
    SUPABASE_URL: getEnvVar("SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: getEnvVar("SUPABASE_SERVICE_ROLE_KEY"),
    SUPABASE_JWT_SECRET: getEnvVar("SUPABASE_JWT_SECRET"),
};
