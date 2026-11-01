-- A table may have at most ONE open session at a time.
-- Prisma can't express partial unique indexes in schema.prisma, so we add it by hand
-- to the generated migration.sql (see README, step 4).
CREATE UNIQUE INDEX "one_open_session_per_table" ON "table_sessions"("table_id") WHERE "ended_at" IS NULL;
