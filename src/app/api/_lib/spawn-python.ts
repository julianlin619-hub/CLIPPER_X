import { spawn } from "child_process";
import path from "path";

export const SCRIPTS_DIR = path.join(process.cwd(), "scripts");

/**
 * Run a Python script and return its stdout as a string.
 * Rejects with a descriptive error on non-zero exit.
 */
export function spawnPython(scriptPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [scriptPath, ...args], { env: { ...process.env } });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Script exited with code ${code}:\n${stderr || stdout}`));
      } else {
        resolve(stdout);
      }
    });

    proc.on("error", (err) => reject(err));
  });
}
