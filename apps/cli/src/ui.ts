import pc from "picocolors";

export const ui = {
  info: (msg: string) => process.stderr.write(`${pc.cyan("ℹ")} ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`${pc.yellow("⚠")} ${msg}\n`),
  error: (msg: string) => process.stderr.write(`${pc.red("✖")} ${msg}\n`),
  success: (msg: string) => process.stderr.write(`${pc.green("✔")} ${msg}\n`),
  dim: (msg: string) => process.stderr.write(`${pc.dim(msg)}\n`),
};
