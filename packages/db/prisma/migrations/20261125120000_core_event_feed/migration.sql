-- Tabele kanału zdarzeń Core: kursor ostatniego zdarzenia oraz deduplikacja przetworzonych zdarzeń.
-- Nie zawierają danych osób ani firm, więc pozostają bez RLS.

-- CreateTable
CREATE TABLE "event_feed_cursors" (
    "id" TEXT NOT NULL,
    "sequence" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_feed_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "consumer" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","event_id")
);

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- Jawne uprawnienia dla roli aplikacji na wypadek braku domyślnych przywilejów (bez DELETE).
GRANT SELECT, INSERT, UPDATE ON "public"."event_feed_cursors", "public"."processed_events" TO timo_time_app;
