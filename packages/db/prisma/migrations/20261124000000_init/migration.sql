-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "time_entry_kind" AS ENUM ('WORK', 'BREAK', 'REMOTE', 'BUSINESS_TRIP');

-- CreateTable
CREATE TABLE "auth"."sessions" (
    "id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "data" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "kind" "time_entry_kind" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "time_entries_ended_after_started_check" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at")
);

-- CreateIndex
CREATE INDEX "sessions_account_id_idx" ON "auth"."sessions"("account_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "auth"."sessions"("expires_at");

-- CreateIndex
CREATE INDEX "time_entries_organization_id_account_id_started_at_idx" ON "time_entries"("organization_id", "account_id", "started_at");

-- Jedna osoba może mieć jednocześnie tylko jeden otwarty wpis czasu pracy.
CREATE UNIQUE INDEX "time_entries_one_open_per_account_idx" ON "time_entries"("organization_id", "account_id") WHERE "ended_at" IS NULL;
