import fs from "fs";
import { Request, Response } from "express";
import { execFile } from "child_process";
import { checkDatabaseHealth } from "../db/connection";
import { config } from "../config";

export async function healthHandler(_req: Request, res: Response) {
  const [dbOk, dotnetOk, ginOk] = await Promise.all([
    checkDatabaseHealth(),
    checkDotnetSdk(),
    checkGinAnalyzer(),
  ]);

  // Only DB health is required; analyzers are informational (optional)
  const status = dbOk ? "ok" : "error";
  const statusCode = status === "ok" ? 200 : 503;

  res.status(statusCode).json({
    status,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks: {
      database: dbOk ? "ok" : "error",
      dotnetSdk: dotnetOk ? "ok" : "unavailable",
      ginAnalyzer: ginOk ? "ok" : "unavailable",
    },
  });
}

function checkDotnetSdk(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("dotnet", ["--version"], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

function checkGinAnalyzer(): Promise<boolean> {
  return Promise.resolve(fs.existsSync(config.ginAnalyzerPath));
}
