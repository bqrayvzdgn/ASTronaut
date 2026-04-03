import fs from "fs";
import jwt from "jsonwebtoken";
import { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";

import { config } from "../config";
import { logger } from "../utils/logger";
import { db } from "../db/connection";
import { installations } from "../db/schema";

const log = logger.child({ module: "appAuth" });

let cachedPrivateKey: string | null = null;

function getPrivateKey(): string {
  if (cachedPrivateKey) {
    return cachedPrivateKey;
  }
  const keyPath = config.github.privateKeyPath;
  log.info({ keyPath }, "Reading GitHub App private key from disk");
  cachedPrivateKey = fs.readFileSync(keyPath, "utf8");
  return cachedPrivateKey;
}

/**
 * Create a short-lived JWT for authenticating as the GitHub App itself.
 * JWTs are valid for a maximum of 10 minutes per GitHub's spec.
 */
function createAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // issued 60s in the past to account for clock drift
    exp: now + 9 * 60, // 9 min from now; total window = 10 min with 60s IAT backdate
    iss: config.github.appId,
  };
  return jwt.sign(payload, getPrivateKey(), { algorithm: "RS256" });
}

/**
 * Return an Octokit instance authenticated as the GitHub App (not an installation).
 * Use this for app-level endpoints such as listing installations.
 */
export function createAppOctokit(): InstanceType<typeof Octokit> {
  const token = createAppJwt();
  return new Octokit({
    auth: token,
    userAgent: "AutoDocAPI/1.0",
  });
}

/**
 * Buffer (in minutes) before actual expiry when we consider a token stale
 * and proactively refresh it.
 */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Obtain a valid installation access token for the given GitHub App
 * installation. Tokens are cached in the database and reused until they are
 * within 5 minutes of expiry, at which point a fresh one is requested.
 */
export async function getValidToken(installationId: number): Promise<string> {
  // 1. Check if we already have a valid token in the DB
  const [row] = await db
    .select({
      accessToken: installations.accessToken,
      tokenExpiresAt: installations.tokenExpiresAt,
    })
    .from(installations)
    .where(eq(installations.githubInstallationId, installationId))
    .limit(1);

  if (row?.accessToken && row.tokenExpiresAt) {
    const expiresAt = new Date(row.tokenExpiresAt).getTime();
    const bufferDeadline = Date.now() + TOKEN_REFRESH_BUFFER_MS;

    if (expiresAt > bufferDeadline) {
      log.debug(
        { installationId, expiresAt: row.tokenExpiresAt },
        "Reusing cached installation token"
      );
      return row.accessToken;
    }
    log.info(
      { installationId, expiresAt: row.tokenExpiresAt },
      "Cached token expires soon, refreshing"
    );
  }

  // 2. Request a fresh installation access token from GitHub
  const appOctokit = createAppOctokit();
  log.info({ installationId }, "Requesting new installation access token");

  const response = await appOctokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    { installation_id: installationId }
  );

  const newToken = response.data.token;
  const newExpiresAt = new Date(response.data.expires_at);

  // 3. Persist the new token in the DB
  const updateResult = await db
    .update(installations)
    .set({
      accessToken: newToken,
      tokenExpiresAt: newExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(installations.githubInstallationId, installationId));

  // If no row was updated, the installation may not exist in our DB yet.
  // Use upsert as a safety net to create/update the row.
  if (!updateResult.rowCount || updateResult.rowCount === 0) {
    log.warn(
      { installationId },
      "No installation row found; upserting token cache"
    );
    await db
      .insert(installations)
      .values({
        githubInstallationId: installationId,
        owner: "unknown",
        accessToken: newToken,
        tokenExpiresAt: newExpiresAt,
      })
      .onConflictDoUpdate({
        target: installations.githubInstallationId,
        set: {
          accessToken: newToken,
          tokenExpiresAt: newExpiresAt,
          updatedAt: new Date(),
        },
      });
  } else {
    log.info(
      { installationId, expiresAt: newExpiresAt.toISOString() },
      "Installation access token refreshed and persisted"
    );
  }

  return newToken;
}
