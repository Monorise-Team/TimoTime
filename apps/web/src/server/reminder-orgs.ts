import "server-only";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Wspólny rejestr firm widzianych w procesie (osobne kopie modułów w Next.js: instrumentation vs trasy API).
const processGlobal = globalThis as typeof globalThis & { __timotimeTrackedReminderOrgs?: Set<string> };

function getRegistry(): Set<string> {
  return (processGlobal.__timotimeTrackedReminderOrgs ??= new Set<string>());
}

/** Zapamiętuje firmę w procesie, aby zadanie przypomnień obejmowało też firmy korzystające z aplikacji mobilnej. */
export function trackOrganizationForReminders(organizationId: string): void {
  if (UUID_REGEX.test(organizationId)) {
    getRegistry().add(organizationId);
  }
}

export function getTrackedReminderOrganizations(): readonly string[] {
  return [...getRegistry()];
}

export function resetTrackedReminderOrganizationsForTests(): void {
  getRegistry().clear();
}
