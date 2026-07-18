import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./error.js";

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  modelCacheDir: string;
  dbPath: string;
  vaultPath: string;
  vaultKeyPath: string;
  mirrorsDir: string;
  manifestPath: string;
  jwtSecret: string;
}

export interface CliArgs {
  command: "serve" | "mcp";
  host: string;
  port: number;
  dataDir?: string;
}

const PLACEHOLDER_SHA = "TODO_PIN_SHA256";

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let command: "serve" | "mcp" = "serve";
  let host = "127.0.0.1";
  let port = 8787;
  let dataDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "serve" || arg === "mcp") {
      command = arg;
    } else if (arg === "--port" || arg === "--p") {
      const v = args[++i];
      if (!v) throw new AppError("bad_request", "--port requires a value");
      port = Number.parseInt(v, 10);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        throw new AppError("bad_request", "invalid --port value");
      }
    } else if (arg === "--host") {
      const v = args[++i];
      if (!v) throw new AppError("bad_request", "--host requires a value");
      host = v;
    } else if (arg === "--data-dir") {
      const v = args[++i];
      if (!v) throw new AppError("bad_request", "--data-dir requires a value");
      dataDir = v;
    } else if (arg.startsWith("--port=")) {
      port = Number.parseInt(arg.slice("--port=".length), 10);
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    }
  }

  return { command, host, port, dataDir };
}

export function buildConfig(args: CliArgs, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = resolve(args.dataDir ?? env.XBERG_DATA_DIR ?? resolve(homedir(), ".xberg"));
  const modelCacheDir = resolve(dataDir, "models");
  const dbPath = resolve(dataDir, "meta.sqlite");
  const vaultPath = resolve(dataDir, "vault");
  const vaultKeyPath = resolve(dataDir, "vault.key");
  const mirrorsDir = resolve(dataDir, "mirrors");
  const manifestPath = fileURLToPath(new URL("../models/manifest.json", import.meta.url));
  const jwtSecret = env.XBERG_JWT_SECRET ?? "dev-insecure-change-me";

  const config: AppConfig = {
    host: args.host,
    port: args.port,
    dataDir,
    modelCacheDir,
    dbPath,
    vaultPath,
    vaultKeyPath,
    mirrorsDir,
    manifestPath,
    jwtSecret,
  };

  validateConfig(config);
  return config;
}

function validateConfig(config: AppConfig): void {
  if (!config.dataDir || !config.modelCacheDir || !config.dbPath) {
    throw new AppError("bad_request", "invalid configuration: missing data paths");
  }
  if (!Number.isFinite(config.port) || config.port <= 0) {
    throw new AppError("bad_request", "invalid configuration: port out of range");
  }
}

export { PLACEHOLDER_SHA };
