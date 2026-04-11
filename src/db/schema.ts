import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const installations = pgTable("installations", {
  id: serial("id").primaryKey(),
  githubInstallationId: integer("github_installation_id").notNull().unique(),
  owner: text("owner").notNull(),
  accessToken: text("access_token"),
  tokenExpiresAt: timestamp("token_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const repos = pgTable("repos", {
  id: serial("id").primaryKey(),
  installationId: integer("installation_id")
    .references(() => installations.id)
    .notNull(),
  repoName: text("repo_name").notNull(),
  repoFullName: text("repo_full_name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  repoFullNameIdx: uniqueIndex("repos_repo_full_name_idx").on(table.repoFullName),
}));

export const analyses = pgTable("analyses", {
  id: serial("id").primaryKey(),
  repoId: integer("repo_id")
    .references(() => repos.id)
    .notNull(),
  commitSha: text("commit_sha").notNull(),
  tag: text("tag"),
  spec: text("spec").notNull(),
  status: text("status", { enum: ["success", "partial", "failed"] }).notNull(),
  errors: jsonb("errors"),
  endpointCount: integer("endpoint_count"),
  prNumber: integer("pr_number"),
  prUrl: text("pr_url"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  repoIdIdx: index("analyses_repo_id_idx").on(table.repoId),
}));

export const webhookEvents = pgTable("webhook_events", {
  id: serial("id").primaryKey(),
  eventType: text("event_type").notNull(),
  action: text("action"),
  repoFullName: text("repo_full_name"),
  payload: jsonb("payload").notNull(),
  processed: text("processed", {
    enum: ["pending", "processing", "done", "skipped", "error"],
  })
    .notNull()
    .default("pending"),
  processedAt: timestamp("processed_at"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
