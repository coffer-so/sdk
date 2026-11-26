import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

const envFile = resolve(__dirname, "../.env");
if (existsSync(envFile)) loadEnvFile(envFile);
