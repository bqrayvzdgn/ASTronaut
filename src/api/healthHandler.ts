import { Request, Response } from "express";
import { execFile } from "child_process";
import { checkDatabaseHealth } from "../db/connection";

export async function healthHandler(_req: Request, res: Response) {
  const [dbOk, dotnetOk] = await Promise.all([
    checkDatabaseHealth(),
    checkDotnetSdk(),
  ]);

  const status = dbOk && dotnetOk ? "ok" : "error";
  const statusCode = status === "ok" ? 200 : 503;

  res.status(statusCode).json({
    status,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks: {
      database: dbOk ? "ok" : "error",
      dotnetSdk: dotnetOk ? "ok" : "error",
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
