# bibil_aClient

Лаунчер Minecraft: Java Edition на Electron. Совмещает удобство Lunar Client (профили, Discord-статус, оформление), управление модами через Modrinth и собственные функции.

> Проект не является продуктом Mojang, Microsoft, Modrinth или Discord и не связан с ними.

## Возможности

| Область | Что реализовано |
|---|---|
| Запуск | Собственный установщик версий (вкладка «Версии», «Быстрый старт», автоустановка при создании профиля и перед запуском: клиент, библиотеки, ассеты, Fabric, проверка SHA-1). Версии из официального манифеста Mojang (релизы и снапшоты), профили с отдельными игровыми папками, загрузка клиента/библиотек/ассетов (`minecraft-launcher-core`), установка Fabric через Fabric Meta, автопоиск Java и автозагрузка JRE Temurin (Adoptium), остановка игры, консоль с живым выводом, сохранение логов |
| Аккаунты | Вход Microsoft → Xbox → XSTS → Minecraft (Device Code Flow), refresh-токены шифруются через Electron `safeStorage`; локальные аккаунты для одиночной игры и серверов без онлайн-проверки |
| Моды | Поиск по Modrinth (версия игры + Fabric, категории, сортировка), выбор версии мода, установка с обязательными зависимостями и проверкой SHA-1/SHA-512, опознание уже лежащих в папке модов по хэшу, включение/выключение (`.jar.disabled`), удаление, проверка и установка обновлений |
| Ресурспаки | Отдельный раздел «Ресурспаки»: ставятся в `resourcepacks` (никогда не в `mods`), чтение `pack.mcmeta` прямо из ZIP, проверка `pack_format` на совместимость с версией игры, включение/выключение (`.zip.disabled`), удаление, каталог Modrinth с фильтром по версии Minecraft |
| Запуск | «Быстрый старт» сразу создаёт профиль, скачивает игру и запускает её; кнопка «Играть офлайн» создаёт локальный аккаунт; кнопка «Безопасно» запускает чистую ваниль, временно выключая моды/ресурспаки/шейдеры и пользовательские аргументы; после вылета показывается понятная причина и совет |
| Настройки | Память (-Xmx/-Xms), Java, JVM-аргументы, аргументы игры, размер окна, полный экран; графические пресеты и точная настройка дальности, частиц, облаков, сущностей, mipmap, FPS и VSync для каждого профиля |
| Discord | Rich Presence: вкл/выкл, свой текст, версия Minecraft, загрузчик, профиль, таймер, статус в лаунчере, кнопка со ссылкой; автопереподключение, троттлинг, очистка статуса при отключении и выходе |
| Оформление | Темы (тёмная / светлая / «Полночь»), акцентный цвет, анимации (можно отключить; учитывается `prefers-reduced-motion`); язык интерфейса: русский, українська, English (меню «Настройки → Оформление → Язык интерфейса», сохраняется автоматически) |
| Надёжность | Атомарная запись настроек, восстановление повреждённых JSON, повторы сетевых запросов, проверка хэшей, блокировка параллельных операций над модами профиля, валидация IPC-вызовов |
| Оновлення | GitHub Releases → дзеркало Railway; токен GitHub для обходу rate limit; перевірка версії/ draft/ наявності ассетів/ SHA-512; потокове завантаження з відсотками й швидкістю; етапи завантаження → перевірка → встановлення → перезапуск; безпечний self-update окремим PowerShell-хелпером (працює і для portable); детальні помилки з кодом/HTTP-статусом у UI та лозі |
| Косметика | Вкладка «Косметика»: плащі, крила, ефекти, скайни, аксесуари, пресети; попередній перегляд, статус активного, до 4 активних елементів, збереження окремо для профілю й запис `bibil-cosmetics.json` у папку інстансу; каталог розширюється через `src/main/data/cosmetics.json` або `cosmetics.json` у релізі |
| Сурси (тех-адмін) | Кнопка «Обновить сурсы» / автоперевірка при запуску: `version.json` → `sources-X.Y.Z.zip`, перевірка SHA-512, бекап незакомічених і захищених файлів у `.bibil-sync-backups/`, чистий маніфест із видаленням застарілих файлів; CLI `npm run sources:sync` |

## Архитектура

```
bibil_aClient/
├─ package.json
├─ src/
│  ├─ main/                      # процесс Electron (Node.js)
│  │  ├─ index.js                # окно, сборка сервисов, жизненный цикл
│  │  ├─ preload.js              # contextBridge: белые списки каналов IPC
│  │  ├─ ipc.js                  # обработчики IPC (валидация, единый формат ответа)
│  │  ├─ config.js · paths.js · logger.js · store.js
│  │  ├─ util/  http.js (fetch + повторы + загрузка с проверкой хэша), args.js, zip.js, crash.js
│  │  ├─ data/cosmetics.json     # встроенный каталог косметики (расширяется релизом)
│  │  └─ services/
│  │     ├─ settings.js          # настройки + нормализация/ограничения
│  │     ├─ profiles.js          # CRUD профилей
│  │     ├─ auth.js              # Microsoft/Xbox/Minecraft, хранение токенов
│  │     ├─ versions.js          # манифест Mojang, Fabric Meta, требуемая Java
│  │     ├─ java.js              # поиск и загрузка Java
│  │     ├─ launcher.js          # подготовка и запуск игры
│  │     ├─ modrinth.js          # клиент API Modrinth v2
│  │     ├─ mods.js              # установка/обновление/удаление модов
│  │     ├─ resourcepacks.js     # ресурспаки: папка, pack.mcmeta, совместимость
│  │     ├─ discord.js           # Rich Presence (IPC)
│  │     ├─ discord-activity.js  # чистая сборка активности (покрыта тестами)
│  │     ├─ updater.js           # GitHub + Railway, SHA-512, прогрес, PowerShell-хелпер
│  │     ├─ source-sync.js       # синхронизация сурсов для второго тех-админа
│  │     └─ cosmetics.js         # каталог косметики + локальный выбор по профилям
│  └─ renderer/                  # интерфейс (HTML/CSS/ES-модули, без сборщика)
│     ├─ index.html · styles/app.css
│     └─ js/ main.js, state.js, ui.js, update-ui.js,
│           views/{home,profiles,mods,resourcepacks,cosmetics,accounts,settings,console}.js
├─ .github/workflows/release.yml  # публикация релиза по тегу v*
├─ test/core.test.js             # юнит-тесты (node:test)
└─ scripts/ check-syntax.js, release-meta.js, source-sync.js, repack-zip.js
```

**Технологии:** Electron 33 (`contextIsolation`, `sandbox`, строгий CSP, запрет навигации), Node.js ≥ 18 (встроенный `fetch`), `minecraft-launcher-core`, `discord-rpc`, `electron-builder`. Интерфейс — чистый JS без фреймворков; весь внешний текст вставляется через `textContent`.

**Данные** лежат в `userData` (Windows: `%APPDATA%\bibil_aClient`, Linux: `~/.config/bibil_aClient`, macOS: `~/Library/Application Support/bibil_aClient`): `config/` (settings, profiles, accounts), `minecraft/` (общие assets/libraries/versions), `instances/<id>/` (игровая папка профиля), `runtime/` (скачанная Java), `logs/`.

## Установка и запуск

Требования: Node.js 18+ и npm.

```bash
npm install
npm start          # обычный запуск
npm run dev        # с DevTools
npm test           # юнит-тесты
npm run check      # проверка синтаксиса
```

Сборка установщиков:

```bash
npm run dist:win     # NSIS + portable
npm run dist:linux   # AppImage + deb
npm run dist:mac     # dmg
```

Иконку приложения положите в `build/icon.png` (512×512; для Windows можно `build/icon.ico`) — иначе будет стандартная.

## Обязательная настройка

### 1. Microsoft-вход (Azure client ID)

У Microsoft нет «общего» ключа для сторонних лаунчеров — приложение регистрируется самостоятельно:

1. [Azure Portal](https://portal.azure.com) → *Microsoft Entra ID* → *App registrations* → *New registration*.
2. Тип учётных записей: **Personal Microsoft accounts only** (или «…and organizational»).
3. *Authentication* → *Allow public client flows* = **Yes** (нужно для Device Code).
4. Скопируйте **Application (client) ID**.
5. Новые приложения должны быть одобрены для Minecraft Services API (форма проверки Mojang/Microsoft: https://aka.ms/mce-reviewappid). До одобрения вход может завершаться ошибкой `Invalid app registration`.
6. Вставьте ID в *Настройки → Вход в аккаунт* (или задайте `BIBIL_AZURE_CLIENT_ID`).

### 2. Discord Rich Presence

1. [Discord Developer Portal](https://discord.com/developers/applications) → *New Application* → назовите **bibil_aClient** (это имя видно в статусе «Играет в …»).
2. *Rich Presence → Art Assets*: загрузите аватар `build/discord-logo-1024.png` (1024×1024 PNG, файл уже лежит в проекте) с ключом **`logo`** — именно этот ключ использует лаунчер. Ключ можно изменить в *Настройки → Discord* → «Ключ картинки» или в `settings.json` → `discord.largeImageKey`. Без загрузки в Discord картинка не отобразится: RPC принимает только ассеты приложения.
3. Чтобы статус включался сам у всех, впишите **Application ID** в `BUNDLED_DISCORD_CLIENT_ID` в `src/main/config.js`. Либо введите его в *Настройки → Discord* (или `BIBIL_DISCORD_CLIENT_ID`; для дистрибутива можно прописать ID по умолчанию в `src/main/config.js`).
4. Discord должен быть запущен на том же компьютере. Если его нет — лаунчер молча повторяет подключение раз в 15 с.

Статус в лаунчере: «В лаунчере bibil_aClient · Выбирает сборку». В игре: «Играет в Minecraft» (или ваш текст) + `Minecraft 1.21.1 · Fabric · Профиль: …` и таймер. Данные идут только в локальный клиент Discord.

### 3. User-Agent для Modrinth

Modrinth требует идентифицирующий User-Agent. Замените ссылку в `USER_AGENT` (`src/main/config.js`) на контакты вашего проекта.

### 4. Автооновлення клієнта (Setup і portable)

**Джерело істини — GitHub Releases**, дзеркало **Railway** — лише fallback і сумісність зі старими клієнтами: https://bibil-updates-production.up.railway.app/

Адресу вводити **не потрібно** (`BUNDLED_UPDATE_URL` у `src/main/config.js`, `build.publish` у `package.json`). Лаунчер:

1. `GET /repos/{owner}/{repo}/releases/latest` (токен з `GITHUB_TOKEN` / `GH_TOKEN` / *Настройки → Оновлення → GitHub token* обходить rate limit).
2. При 403/429 із `X-RateLimit-Remaining: 0`, 404 або будь-якій мережевій помилці — автоматично бере `{feed}/latest.json` із Railway.
3. Перевіряє версію, відкидає draft/prerelease, знаходить Setup, portable та `cosmetics.json`, звіряє **SHA-512** саме вибраного ассета.
4. Качає потоком із прогресом (відсотки, швидкість) і показує етапи **Завантаження → Перевірка → Встановлення → Перезапуск**.
5. Запускає окремий PowerShell-хелпер, який чекає закриття лаунчера, підміняє exe (або тихо ставить Setup через `/S`) і перезапускає програму. Тому self-update працює **і для portable-збірки**.

Після зміни версії у `package.json` достатньо запушити тег `vX.Y.Z`:

```bash
git tag v1.1.1 && git push origin v1.1.1
```

`.github/workflows/release.yml` сам перевірить синтаксис/тести, збере `dist:win`, створить `sources-X.Y.Z.zip`, згенерує `latest.json` / `version.json` / `cosmetics.json` і опублікує реліз з усіма ассетами. Якщо в секретах є `RAILWAY_TOKEN`, він додатково оновлює дзеркало.

Локальна публікація (без CI):

```bash
npm run dist:win
git archive --format=zip --output=dist/sources-1.1.1.zip HEAD   # після коміту
npm run release:meta
npm run repack                                                  # bibil_aClient_для_друзей.zip
cd update-server && railway up --service bibil-updates --detach --no-gitignore -y
```

> `update-server/public/` навмисно в `.gitignore` (там лежать великі exe), тому для деплою потрібен `--no-gitignore`. Тимчасово прибирати рядок із `.gitignore` не потрібно.

Статус, деталі помилки (`code`, `stage`, HTTP-статус, URL) і логи — у *Настройки → Оновлення* та плаваючому оверлеї. Користувачі старої збірки, що ще не має цього коду, отримають оновлення через electron-updater і `latest.yml` після першого запуску нової версії.

### 5. Косметика

Вкладка «Косметика» читає вбудований `src/main/data/cosmetics.json`, а якщо реліз містить `cosmetics.json` — бере актуальний каталог звідти (кешується в `userData/cosmetics-remote.json`). Щоб додати предмет, додайте об'єкт у масив `items`:

```json
{
  "id": "cape-my", "type": "cape", "rarity": "epic", "icon": "🧣",
  "colors": ["#7c5cff", "#4be0a0"],
  "name": { "ru": "Плащ", "uk": "Плащ", "en": "Cape" },
  "description": { "ru": "…", "uk": "…", "en": "…" }
}
```

Типи: `cape`, `wings`, `effect`, `skin`, `accessory`, `preset`; рідкість: `common`, `rare`, `epic`, `legendary`. Вибрані ІД (до 4) зберігаються в `userData/cosmetics.json` окремо для кожного профілю й дублюються в `<instance>/bibil-cosmetics.json`, щоб моди могли їх прочитати.

### 6. Синхронізація сурсів (другий тех-адмін)

На другому ПК клонуйте репозиторій і зніміть галочки autoupdate для гри. Далі дві опції:

**Через лаунчер (рекомендовано):** *Настройки → Синхронізація сурсів (тех-адмін)* — вкажіть шлях до клону, увімкніть «Перевіряти сурси при запуску» і натискайте «Обновить сурсы». Перед заміною лаунчер покаже versions `local → remote` і створить бекап.

**Через CLI:**

```bash
npm run sources:sync -- check
npm run sources:sync -- sync --dir "C:\work\bibil_aClient"
```

Що відбувається під час `sync`:

- `version.json` береться з GitHub Releases або Railway; перевіряється SHA-512 архіву `sources-X.Y.Z.zip`;
- `git status --porcelain` знаходить незакомічені правки — вони разом із захищеними файлами копіюються в `.bibil-sync-backups/<дата>/` (захищені: `.git/**`, `node_modules/**`, `dist/**`, `data/**`, `.env*`, `*.zip`, `*.log`, **`src/main/config.js`** з локальними ID/ключами);
- застосовується чистий маніфест: нові файли перезаписуються, застарілі (яких немає в релізі) видаляються, захищені зберігаються;
- у корінь пишеться `.bibil-source-version.json` із версією, часом і шляхом до бекапу; після синхронізації перезапустіть лаунчер **з сурсів** (`npm start`), а не зі старого exe.

Якщо при перевірці з'являється `RATE_LIMIT`, додайте `GITHUB_TOKEN` — інакше сервіс сам перейде на дзеркало. Помилка `NO_DIR` означає, що вказаний каталог не існує.

## Первый запуск

1. Запустите лаунчер — локальный аккаунт и нужные настройки создадутся автоматически.
2. Нажмите «Играть» / «Быстрый старт»: профиль, игра и Java скачаются сами, после чего игра запустится.
3. **Графика.** Minecraft 26.x сам выбирает бэкенд и после неудачного запуска сбрасывает его на «Default». На AMD это означает Vulkan и краш `0xC0000005` в `amdvlk64.dll` (подтверждено в `hs_err_pid*.log`: `Using graphics backend Vulkan, ... AMD proprietary driver`). Лаунчер перед каждым запуском пишет в `options.txt` `preferredGraphicsBackend:"opengl"` — это лечит краш. Менять бэкенд можно в *Настройки → Игра → Графический бэкенд*; обновите Radeon Software, если Vulkan нужен вам сознательно.
4. JVM: лишние `-Xmx/-Xms` и явные `-XX:+Use*GC` / `-XX:MaxGCPauseMillis` отбрасываются. Лаунчер добавляет `--enable-native-access=ALL-UNNAMED` и `--sun-misc-unsafe-memory-access=allow` — без них Java 25 печатает десятки WARNING про `System::load` и `sun.misc.Unsafe` (на сам краш они не влияют).
5. Если игра вылетела: на главной появится причина, лаунчер сам повторит запуск до 2 раз в безопасном режиме (отключается в настройках). Кнопка «Безопасно» запускает чистую ваниль без модов, ресурспаков и пользовательских аргументов. Свежий `hs_err_pid*.log` разбирается автоматически. Если краш нестабильный — попробуйте другую сборку Java 25 и отключите оверлеи GeForce/Discord/MSI Afterburner.
6. Для официальных серверов: *Настройки* → Azure client ID, *Аккаунты* → вход через Microsoft.
5. *Моды* и *Ресурспаки* — устанавливайте только совместимые с версией игры пакеты.

Локальный аккаунт (`Player####`) создаётся автоматически при первом запуске — игра доступна сразу, без Azure ID. Он работает в одиночке и по LAN, но не подходит для официальных серверов с онлайн-проверкой.

## Как играть с друзьями

**Вариант 1 — LAN (без лицензии и без Azure):**
1. Установите Hamachi или ZeroTier, объединитесь в одну сеть.
2. Один игрок создаёт мир → *Открыть в локальную сеть*.
3. Остальные в лаунчере заходят в *Мультиплеер* и подключаются по IP из Hamachi/ZeroTier.
4. У всех должны совпадать версия Minecraft, загрузчик и набор модов/ресурспаков (папки профиля можно просто скопировать).

**Вариант 2 — онлайн-серверы:** у каждого друга должен быть лицензионный Minecraft и вход через Microsoft. Чтобы друзьям не пришлось ничего настраивать, зарегистрируйте Azure-приложение по инструкции выше и впишите его Client ID в `BUNDLED_AZURE_CLIENT_ID` в `src/main/config.js` **до сборки** — после этого собранный лаунчер будет сразу понимать Microsoft-вход.

## Соответствие условиям использования

- **Minecraft:** Microsoft-вход проверяет лицензию; клиент и ресурсы скачиваются напрямую с серверов Mojang, ничего не распространяется. Локальные аккаунты не выполняют онлайн-аутентификацию и не работают на серверах с онлайн-проверкой. Название и ресурсы Minecraft не используются в брендинге.
- **Modrinth:** официальный API v2, уникальный User-Agent, кэширование ответов, загрузка только с CDN из метаданных API с проверкой хэшей.
- **Discord:** только Rich Presence через официальный локальный IPC; без самобота и перехвата данных; статус отключается и очищается по настройке и при выходе.
- Пароли не запрашиваются и не хранятся; токены шифруются средствами ОС.

## Известные ограничения и план развития

Проверено: синтаксис всех файлов и юнит-тесты логики (настройки, профили, Discord-активность, фасеты Modrinth, аргументы, хранилище). **Не проверено в живой среде:** запуск Electron-окна, Microsoft-вход, загрузка игры, обращения к Modrinth/Mojang — в среде разработки не было доступа к этим сервисам, поэтому перед использованием пройдите сценарий «Первый запуск» и сообщайте о найденных ошибках.

Дальнейшие этапы:
1. Quilt / Forge / NeoForge (в `profiles.js` и `launcher.js` уже выделена точка расширения `loader`).
2. Шейдеры из Modrinth (отдельная папка `shaderpacks`), импорт/экспорт сборок `.mrpack`. Ресурспаки уже реализованы.
3. Подпись билдов (GitHub Releases уже публикуются автоматически).
4. Сервера (быстрое подключение через `--quickPlayMultiplayer`), избранное.
5. Интеграционные тесты (Playwright + mock-серверы Mojang/Modrinth).
