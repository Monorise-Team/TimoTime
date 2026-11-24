import { AppBackdrop, Badge, Button, Card } from "@monorise-team/ui";
import { Clock, Coffee, MonitorSmartphone, Smartphone } from "lucide-react";

const APP_URL = process.env.TIMOTIME_APP_URL ?? "https://timo-time.monorise.studio";

const HIGHLIGHTS = [
  {
    icon: <Clock />,
    title: "Start i stop jednym kliknięciem",
    body: "Rozpoczynasz pracę, przerwę, pracę zdalną albo wyjście służbowe. Przełączenie statusu zamyka poprzedni wpis automatycznie.",
  },
  {
    icon: <Coffee />,
    title: "Przejrzysta lista dnia i tygodnia",
    body: "Widzisz wszystkie swoje wpisy z dzisiaj i z bieżącego tygodnia wraz z czasem trwania oraz sumami dla każdego dnia.",
  },
  {
    icon: <MonitorSmartphone />,
    title: "Przeglądarka i telefon",
    body: "Pracujesz przy biurku albo w magazynie: oba miejsca łączą się z tym samym kontem Monorise i tym samym API.",
  },
  {
    icon: <Smartphone />,
    title: "Jedno logowanie Monorise",
    body: "Bez osobnych haseł. Konto pracownika i firma pochodzą bezpośrednio z MonoriseCore.",
  },
];

export default function ProductPage() {
  return (
    <>
      <AppBackdrop />
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <a href="/" className="flex items-center gap-2 text-sm font-semibold tracking-wide uppercase">
          <span className="mr-glow flex size-8 items-center justify-center rounded-xl bg-accent text-accent-fg">
            <Clock className="size-4" aria-hidden />
          </span>
          TimoTime
        </a>
        <Button asChild variant="primary" size="md" className="rounded-full">
          <a href={APP_URL}>Otwórz TimoTime</a>
        </Button>
      </header>

      <main id="main" className="mx-auto flex max-w-5xl flex-col gap-16 px-6 pt-10 pb-20">
        <section className="mr-enter flex max-w-2xl flex-col gap-5">
          <Badge tone="accent" className="w-fit px-2.5">
            Pierwsza wersja
          </Badge>
          <h1 className="font-display text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">
            Ewidencja czasu pracy dla zespołu w biurze i w terenie
          </h1>
          <p className="text-lg leading-relaxed text-text-secondary">
            TimoTime zapisuje rozpoczęcie i zakończenie pracy, przerwy, pracę zdalną oraz wyjścia służbowe. Jedno konto
            Monorise w przeglądarce i na telefonie.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="primary" size="lg" className="rounded-full">
              <a href={APP_URL}>Przejdź do aplikacji</a>
            </Button>
          </div>
        </section>

        <section aria-labelledby="mozliwosci-tytul" className="flex flex-col gap-5">
          <h2 id="mozliwosci-tytul" className="font-display text-2xl font-semibold">
            Co zawiera pierwsza wersja
          </h2>
          <div className="grid gap-card sm:grid-cols-2">
            {HIGHLIGHTS.map((item) => (
              <Card key={item.title} surface="reading" className="flex flex-col gap-3 p-6">
                <span className="flex size-10 items-center justify-center rounded-xl bg-accent-light text-accent [&_svg]:size-5">
                  {item.icon}
                </span>
                <h3 className="text-base font-semibold">{item.title}</h3>
                <p className="text-sm leading-relaxed text-text-secondary">{item.body}</p>
              </Card>
            ))}
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-5xl flex-col gap-2 px-6 pb-10 text-sm text-text-tertiary sm:flex-row sm:justify-between">
        <span>© {new Date().getFullYear()} Monorise. TimoTime jest produktem Monorise.</span>
        <a href="https://monorise.studio" className="hover:text-text-primary">
          monorise.studio
        </a>
      </footer>
    </>
  );
}
