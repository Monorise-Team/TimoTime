/**
 * Punkt startowy serwera Next.js: w środowisku Node.js uruchamia cykliczne odpytywanie kanału zdarzeń Core.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startCoreEventPolling } = await import("./server/event-feed");
    startCoreEventPolling();
  }
}
