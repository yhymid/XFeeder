# TDR — Adaptive Network Friendly Mode (TASK 14)

Data: 7 października 2026. Status: decyzja badawcza; brak zmiany zachowania produkcyjnego.

## Decyzja

**Nie implementować automatycznego wykrywania obciążenia łącza.** Zachować ręczny,
deterministyczny Friendly Mode, presety i jawne limity Custom. Nie dodawać domyślnych
pingów, speedtestów, sterowników ani zmian ustawień routera/systemu.

To wniosek z analizy dostępnych sygnałów, a nie wynik laboratoryjnego pomiaru
wszystkich trzech systemów. XFeeder widzi tylko własne aplikacyjne transfery.
Z ich spowolnienia nie potrafi niezawodnie rozróżnić obciążenia hosta, Wi-Fi, trasy,
serwera, proxy, własnego limitera ani opóźnień przeglądarki.

## Porównanie opcji

| Opcja | Wiarygodność wykrycia nasycenia przez inną aplikację | Prywatność i ruch | Uprawnienia | Windows / Linux / macOS | Koszt utrzymania |
| --- | --- | --- | --- | --- | --- |
| Pasywna obserwacja własnych transferów | Niska: małe, sporadyczne feedy nie sondują dostępnej pojemności; limiter sam wpływa na wynik | Brak dodatkowego ruchu; bez zapisywania URL | Zwykły proces | Wszystkie | Niski, ale tuning progów i fałszywe alarmy trudne |
| Lekkie probe'y latency | Mierzą konkretny cel/trasy, nie zapas pasma; wzrost RTT nie identyfikuje sprawcy | Ujawniają adres i harmonogram aktywności odbiorcy probe; generują ruch | TCP/HTTPS zwykle bez administratora; ICMP zależy od OS/polityki | Możliwe na wszystkich, różne zachowanie | Średni: wybór celu, baseline, timeouty, rate limit |
| Liczniki interfejsów OS | Pokazują ruch interfejsu, nie wąskie gardło WAN; Ethernet 1 Gb/s nie oznacza Internetu 1 Gb/s | Lokalne, obejmują aktywność innych aplikacji | Odczyt zwykle dostępny, zależny od sandboxa/systemu | Osobne API i obsługa VPN/interfejsów na każdym OS | Wysoki: natywne bindingi, zerowanie liczników, wiele interfejsów |
| Linux traffic control | Potrafi zarządzać kolejką przy znanej pojemności; sam nie ustala uniwersalnie dostępnego pasma | Lokalne, wpływa na ruch całego hosta | CAP_NET_ADMIN / administrator do konfiguracji | Tylko Linux | Wysoki; konflikt z konfiguracją hosta i kontenerami |
| QoS/AQM routera | Najlepszy punkt obserwacji lokalnego wąskiego gardła, gdy router je kontroluje i jest poprawnie skonfigurowany | Dostęp do statystyk ruchu całej sieci | Uprawnienia do routera | Niezależny od OS klienta, zależny od routera | Wysoki i zależny od producenta |
| Brak automatycznego wykrywania | Nie zgaduje obciążenia; działanie zgodne z jawnym limitem użytkownika | Bez probe i zbierania ruchu innych aplikacji | Zwykły proces | Wszystkie | Najniższy |

## Podstawa techniczna

Linux udostępnia liczniki interfejsów przez m.in. procfs, sysfs i netlink. Liczniki
opisują pakiety/bajty interfejsu; nie są pomiarem wolnej pojemności ścieżki do
serwera. [Dokumentacja jądra Linux](https://docs.kernel.org/networking/statistics.html).
Windows ma odrębne API pobierania informacji o interfejsie
[GetIfEntry2](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-getifentry2).
macOS udostępnia informacje o interfejsach przez
[getifaddrs](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/getifaddrs.3.html).
Z tych źródeł wnioskujemy, że jednolita, przenośna warstwa wymagałaby osobnych
implementacji; żadne z tych API nie daje XFeederowi gotowej, niezawodnej informacji
„inna aplikacja wysyca Internet”.

Konfiguracja administracyjna sieci na Linux wymaga odpowiednich capabilities;
zakres CAP_NET_ADMIN opisuje [dokumentacja capabilities](https://man7.org/linux/man-pages/man7/capabilities.7.html).
AQM działa na kolejkach urządzenia sieciowego; uzasadnienie i ograniczenia opisuje
[RFC 7567](https://www.rfc-editor.org/rfc/rfc7567.html).
Limiter aplikacji może ograniczać własny ruch, lecz nie ma kontroli nad kolejkami
innych aplikacji ani routera. Nie może obiecać niższego pingu ani priorytetu gier.

## Warunki ewentualnego powrotu do tematu

Wyłącznie osobne zadanie i dobrowolny eksperyment: pasywne dane bez URL/sekretów,
brak zewnętrznych probe domyślnie, pominięcie czasu własnego throttlingu, długie
okna agregacji, histereza i dolna granica aktywności. Konieczne byłyby porównania
z ground truth na Windows/Linux/macOS, VPN, Wi-Fi i zmiennych serwerach.
Nie należy uruchamiać transferów tylko po to, by sprawdzić, czy trzeba transferować
mniej — taka pętla sama zmienia mierzony sygnał.
