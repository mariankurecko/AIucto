import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export function readYaml<T>(configDir: string, relativePath: string): T {
  const filePath = path.resolve(configDir, relativePath);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Configuration file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");

  try {
    return YAML.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `Invalid YAML in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function getConfigDir(): string {
  return process.env.AI_OS_CONFIG_DIR
    ? path.resolve(process.env.AI_OS_CONFIG_DIR)
    : path.resolve(process.cwd(), "config");
}
