/**
 * Seed script: Populates the tasks table with example data for development.
 *
 * Usage: npx tsx src/db/seed.ts
 *
 * Requires PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE env vars
 * (or a running Postgres with defaults from docker-compose).
 */

import "dotenv/config";
import { query, pool } from "./client.js";
import { runMigrations } from "./migrate.js";

interface SeedTask {
  title: string;
  context?: string;
  scope: string;
  priority?: string;
  tags?: string[];
  blocked_reason?: string;
  scheduled_date?: string;
  due_date?: string;
}

const OPEN_TASKS: SeedTask[] = [
  {
    title: "Set up monitoring dashboard",
    context: "Track server health, response times, and error rates",
    scope: "work",
    priority: "high",
    tags: ["infrastructure", "observability"],
  },
  {
    title: "Write integration tests for auth flow",
    scope: "work",
    priority: "normal",
    tags: ["testing"],
  },
  {
    title: "Review and update dependencies",
    context: "Check for security patches and breaking changes",
    scope: "work",
    priority: "low",
    tags: ["maintenance"],
    scheduled_date: "2026-04-15",
  },
  {
    title: "Plan weekend hiking trip",
    scope: "personal",
    tags: ["outdoors"],
    scheduled_date: "2026-04-12",
  },
  {
    title: "Research new keyboard options",
    context: "Looking at split ergonomic keyboards",
    scope: "personal",
    priority: "low",
    tags: ["hardware", "ergonomics"],
  },
];

const COMPLETED_TASKS: Omit<SeedTask, "blocked_reason">[] = [
  { title: "Initial project setup", scope: "work", tags: ["infrastructure"] },
  { title: "Docker Compose configuration", scope: "work", tags: ["infrastructure", "docker"] },
  { title: "PostgreSQL schema design", scope: "work", tags: ["database"] },
  { title: "Embedding pipeline integration", scope: "work", tags: ["search", "embeddings"] },
];

async function seed() {
  console.log("Running migrations...");
  await runMigrations();

  console.log("Seeding open tasks...");
  for (const task of OPEN_TASKS) {
    await query(
      `INSERT INTO tasks (title, context, scope, priority, tags, blocked_reason, scheduled_date, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        task.title,
        task.context ?? null,
        task.scope,
        task.priority ?? null,
        task.tags ?? [],
        task.blocked_reason ?? null,
        task.scheduled_date ?? null,
        task.due_date ?? null,
      ]
    );
  }
  console.log(`  Inserted ${OPEN_TASKS.length} open tasks`);

  console.log("Seeding completed tasks...");
  for (const task of COMPLETED_TASKS) {
    await query(
      `INSERT INTO tasks (title, context, scope, priority, tags, status, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'completed', now())`,
      [
        task.title,
        task.context ?? null,
        task.scope,
        task.priority ?? null,
        task.tags ?? [],
      ]
    );
  }
  console.log(`  Inserted ${COMPLETED_TASKS.length} completed tasks`);

  console.log("Done.");
  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
