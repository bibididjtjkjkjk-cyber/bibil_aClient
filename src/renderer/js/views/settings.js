import { h, field, switchEl, settingRow, selectEl, debounce, toast, safe, clear, confirmDialog } from '../ui.js';
import { LOCALES, t } from '../i18n.js';
import { state, saveSettings } from '../state.js';

const api = window.bibil;

export function settingsView(root) {
  const s = () => state.settings;
  const save = (patch) => saveSettings(patch).catch((e) => toast(t('Не удалось сохранить: {msg}', { msg: e.message }), 'error'));
  const saveDebounced = debounce(save, 500);

  const text = (value, onInput, attrs = {}) => h('input', { type: 'text', value: value ?? '', oninput: (e) => onInput(e.target.value), ...attrs });
  const section = (title, ...kids) => h('div', {}, h('h2', {}, title), h('div', { class: 'card' }, kids));

  // ---------- Оформление ----------
  const appearance = section(t('Оформление'),
    settingRow('Язык интерфейса / Мова / Language', 'Русский · Українська · English', selectEl(
      LOCALES.map((l) => ({ value: l.value, label: l.label })), s().launcher.language || 'ru',
      (v) => save({ launcher: { language: v } }))),
    settingRow(t('Тема'), t('Тёмная, светлая или «Полночь» (чёрная)'), selectEl(
      [{ value: 'dark', label: t('Тёмная') }, { value: 'light', label: t('Светлая') }, { value: 'midnight', label: t('Полночь') }], s().launcher.theme, (v) => save({ launcher: { theme: v } }))),
    settingRow(t('Акцентный цвет'), null, h('input', { type: 'color', value: s().launcher.accent, oninput: (e) => saveDebounced({ launcher: { accent: e.target.value } }) })),
    settingRow(t('Анимации'), t('Плавные переходы и эффекты интерфейса'), switchEl(s().launcher.animations, (v) => save({ launcher: { animations: v } }))),
    settingRow(t('При запуске игры'), t('Что делать с окном лаунчера'), selectEl(
      [{ value: 'keep', label: t('Оставить') }, { value: 'minimize', label: t('Свернуть') }, { value: 'hide', label: t('Скрыть до выхода из игры') }], s().launcher.onLaunch, (v) => save({ launcher: { onLaunch: v } }))),
    settingRow(t('Показывать снапшоты'), t('В списке версий при создании профиля'), switchEl(s().launcher.showSnapshots, (v) => save({ launcher: { showSnapshots: v } }))),
    settingRow(t('Повтор запуска после краша JVM'), t('Если Java 25 вылетела с кодом 0xC0000005, игра запустится ещё раз (до 2 попыток) в безопасном режиме'), switchEl(s().launcher.autoRetry, (v) => save({ launcher: { autoRetry: v } }))));

  // ---------- Игра ----------
  const maxMB = Math.max(1024, state.info.maxRamMb || Math.floor((state.info.totalMemMB * 0.7) / 256) * 256);
  const ramLabel = h('b');
  const minLabel = h('b');
  const ramMax = h('input', { type: 'range', min: 512, max: maxMB, step: 256, value: Math.min(s().game.ramMax, maxMB) });
  const ramMin = h('input', { type: 'range', min: 256, max: maxMB, step: 256, value: Math.min(s().game.ramMin, maxMB) });
  const showRam = () => { ramLabel.textContent = `${(ramMax.value / 1024).toFixed(2)} ${t('ГБ')}`; minLabel.textContent = `${(ramMin.value / 1024).toFixed(2)} ${t('ГБ')}`; };
  ramMax.addEventListener('input', () => { showRam(); saveDebounced({ game: { ramMax: Number(ramMax.value) } }); });
  ramMin.addEventListener('input', () => { showRam(); saveDebounced({ game: { ramMin: Number(ramMin.value) } }); });
  showRam();

  const num = (v, key, min, max) => h('input', { type: 'number', min, max, value: v, oninput: (e) => saveDebounced({ game: { [key]: Number(e.target.value) } }) });
  const game = section(t('Игра'),
    field(t('Максимум памяти (-Xmx)'), h('div', {}, ramMax, ramLabel), t('Доступно в системе: {n} ГБ. Слишком много памяти вызывает вылеты — рекомендуется 3–6 ГБ.', { n: (state.info.totalMemMB / 1024).toFixed(1) })),
    field(t('Начальная память (-Xms)'), h('div', {}, ramMin, minLabel)),
    field(t('Графический бэкенд'), selectEl([
      { value: 'opengl', label: t('OpenGL (рекомендуется)') },
      { value: 'vulkan', label: t('Vulkan (может падать на AMD)') },
      { value: 'default', label: t('Как в игре') },
    ], s().game.graphicsBackend, (v) => save({ game: { graphicsBackend: v } })),
      t('MC 26.x после сбоя сама переключает бэкенд; на AMD Vulkan вылетает в amdvlk64.dll. Лаунчер фиксирует OpenGL перед каждым запуском.')),
    field(t('JVM-аргументы'), text(s().game.jvmArgs, (v) => saveDebounced({ game: { jvmArgs: v } })),
      t('По умолчанию пусто. Лишние флаги -Xmx/-Xms и GC могут выронить игру — не добавляйте их без необходимости.')),
    field(t('Аргументы игры'), text(s().game.gameArgs, (v) => saveDebounced({ game: { gameArgs: v } }), { placeholder: t('например: --quickPlayMultiplayer play.example.com') })),
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, field(t('Ширина окна'), num(s().game.width, 'width', 320, 7680))),
      h('div', { class: 'grow' }, field(t('Высота окна'), num(s().game.height, 'height', 240, 4320)))),
    settingRow(t('Полноэкранный режим'), null, switchEl(s().game.fullscreen, (v) => save({ game: { fullscreen: v } }))));

  // ---------- Оптимизация графики ----------
  const OPTIMIZATION_PRESETS = {
    balanced: {
      renderDistance: 10, simulationDistance: 6, graphics: 'fast', particles: 'decreased',
      clouds: 'off', entityDistance: 0.75, mipmapLevels: 2, maxFps: 144, vsync: false,
    },
    performance: {
      renderDistance: 6, simulationDistance: 5, graphics: 'fast', particles: 'minimal',
      clouds: 'off', entityDistance: 0.5, mipmapLevels: 0, maxFps: 260, vsync: false,
    },
  };
  const initialOptimization = s().game.optimization;
  let selectedPreset = initialOptimization.preset;
  const optimizationInputs = {};
  const optimizationLabels = {};
  const optimizationEnabled = settingRow(
    t('Применять оптимизацию'),
    t('Пресет включает настройки автоматически; ручные изменения сохраняются как свой вариант.'),
    switchEl(initialOptimization.enabled, (v) => save({ game: { optimization: { enabled: v } } }))
  );
  const optimizationDisplay = (key, value) => {
    if (key === 'renderDistance' || key === 'simulationDistance') return `${value} ${t('чанков')}`;
    if (key === 'entityDistance') return `${Math.round(Number(value) * 100)}%`;
    if (key === 'maxFps') return Number(value) === 260 ? t('Без ограничений') : `${value} FPS`;
    return String(value);
  };
  const optimizationPreset = selectEl([
    { value: 'balanced', label: t('Сбалансированный') },
    { value: 'performance', label: t('Максимум FPS') },
    { value: 'custom', label: t('Настраиваемый') },
  ], selectedPreset, (preset) => {
    selectedPreset = preset;
    if (preset === 'custom') {
      save({ game: { optimization: { preset } } });
      return;
    }
    const values = OPTIMIZATION_PRESETS[preset];
    for (const [key, value] of Object.entries(values)) {
      optimizationInputs[key].value = value;
      if (optimizationLabels[key]) optimizationLabels[key].textContent = optimizationDisplay(key, value);
    }
    optimizationEnabled.querySelector('input').checked = true;
    save({ game: { optimization: { ...values, preset, enabled: true } } });
  });
  const saveOptimizationDebounced = debounce(() => {
    const values = Object.fromEntries(Object.entries(optimizationInputs).map(([key, input]) => [
      key, input.type === 'checkbox' ? input.checked : (input.type === 'range' ? Number(input.value) : input.value),
    ]));
    save({ game: { optimization: {
      ...values, preset: selectedPreset, enabled: optimizationEnabled.querySelector('input').checked,
    } } });
  }, 350);
  const optimizationRange = (key, min, max, step = 1) => {
    const value = initialOptimization[key];
    const input = h('input', { type: 'range', min, max, step, value });
    const label = h('b', { class: 'small' }, optimizationDisplay(key, value));
    optimizationInputs[key] = input;
    optimizationLabels[key] = label;
    input.addEventListener('input', () => {
      label.textContent = optimizationDisplay(key, input.value);
      selectedPreset = 'custom';
      optimizationPreset.value = 'custom';
      saveOptimizationDebounced();
    });
    return h('div', { class: 'optimization-range' }, input, label);
  };
  const optimizationSelect = (key, options) => {
    const input = selectEl(options, initialOptimization[key], () => {
      selectedPreset = 'custom';
      optimizationPreset.value = 'custom';
      saveOptimizationDebounced();
    });
    optimizationInputs[key] = input;
    return input;
  };
  optimizationInputs.vsync = h('input', {
    type: 'checkbox',
    checked: initialOptimization.vsync,
    onchange: () => {
      selectedPreset = 'custom';
      optimizationPreset.value = 'custom';
      saveOptimizationDebounced();
    },
  });
  const optimization = section(t('Оптимизация Minecraft'),
    h('div', { class: 'optimization-intro' },
      h('b', {}, t('Управляйте производительностью без сторонних программ')),
      h('p', { class: 'small muted' }, t('Настройки графики, дистанции, частиц и FPS применяются отдельно для каждого профиля. Отключите оптимизацию, чтобы управлять ими в самой игре.'))),
    optimizationEnabled,
    field(t('Пресет'), optimizationPreset, t('«Максимум FPS» упрощает графику и снижает нагрузку на слабых компьютерах.')),
    h('div', { class: 'optimization-grid' },
      field(t('Дальность прорисовки'), optimizationRange('renderDistance', 2, 32)),
      field(t('Дальность симуляции'), optimizationRange('simulationDistance', 5, 32))),
    h('div', { class: 'optimization-grid' },
      field(t('Графика'), optimizationSelect('graphics', [
        { value: 'fast', label: t('Быстрая') }, { value: 'fancy', label: t('Красивая') },
      ])),
      field(t('Частицы'), optimizationSelect('particles', [
        { value: 'all', label: t('Все') }, { value: 'decreased', label: t('Уменьшено') }, { value: 'minimal', label: t('Минимум') },
      ]))),
    h('div', { class: 'optimization-grid' },
      field(t('Облака'), optimizationSelect('clouds', [
        { value: 'off', label: t('Выкл.') }, { value: 'fast', label: t('Быстрые') }, { value: 'fancy', label: t('Красивые') },
      ])),
      field(t('Дальность сущностей'), optimizationRange('entityDistance', 0.5, 2, 0.1))),
    h('div', { class: 'optimization-grid' },
      field(t('Уровни mipmap'), optimizationRange('mipmapLevels', 0, 4)),
      field(t('Ограничение FPS'), optimizationSelect('maxFps', [
        { value: 30, label: '30 FPS' }, { value: 60, label: '60 FPS' }, { value: 75, label: '75 FPS' },
        { value: 120, label: '120 FPS' }, { value: 144, label: '144 FPS' }, { value: 165, label: '165 FPS' },
        { value: 240, label: '240 FPS' }, { value: 260, label: t('Без ограничений') },
      ]))),
    settingRow(t('Вертикальная синхронизация'), t('Отключение может увеличить FPS, но привести к разрывам изображения.'),
      h('label', { class: 'switch' }, optimizationInputs.vsync, h('i'))));

  // ---------- Java ----------
  const javaList = h('div', { class: 'small muted' }, t('Нажмите «Найти Java», чтобы увидеть установленные версии.'));
  const javaInput = text(s().java.path, (v) => saveDebounced({ java: { path: v } }), { placeholder: t('Автоматически') });
  async function detectJava() {
    javaList.textContent = t('Поиск…');
    const found = await safe(api.invoke('java:detect'), t('Ошибка поиска Java'));
    if (!found) return;
    clear(javaList);
    if (!found.length) javaList.textContent = t('Java не найдена — лаунчер скачает нужную версию автоматически (если включено).');
    for (const j of found) {
      javaList.append(h('div', { class: 'row', style: { margin: '4px 0' } },
        h('span', { class: 'chip' }, `Java ${j.major}`), h('span', { class: 'grow small', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, j.path + (j.bundled ? t(' (встроенная)') : '')),
        h('button', { class: 'btn sm', onclick: () => { javaInput.value = j.path; save({ java: { path: j.path } }); } }, t('Использовать'))));
    }
  }
  const java = section('Java',
    field(t('Путь к Java (пусто — автоопределение по версии игры)'), javaInput),
    settingRow(t('Автоматически скачивать Java'), t('Eclipse Temurin (Adoptium), если подходящей Java нет'), switchEl(s().java.autoDownload, (v) => save({ java: { autoDownload: v } }))),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: detectJava }, t('Найти Java')),
      h('button', { class: 'btn', onclick: () => safe(api.invoke('app:openPath', 'root')) }, t('Папка игры'))),
    javaList);

  // ---------- Discord ----------
  const dStatus = h('span', { class: 'chip' });
  const STATUS = {
    disabled: [t('Выключено'), ''], 'no-client-id': [t('Нет Application ID'), 'warn'], connecting: [t('Подключение…'), ''],
    connected: [t('Подключено'), 'ok'], unavailable: [t('Discord недоступен'), 'bad'],
  };
  const showStatus = (st) => {
    const [label, cls] = STATUS[st.state] || [st.state, ''];
    dStatus.className = `chip ${cls}`;
    dStatus.textContent = label + (st.detail ? ` — ${st.detail}` : '');
  };
  api.invoke('discord:status').then(showStatus).catch(() => {});
  const offStatus = api.on('discord:status', showStatus);

  const d = () => s().discord;
  const dd = (k) => (v) => save({ discord: { [k]: v } });
  const discord = section('Discord Rich Presence',
    h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'muted' }, t('Статус:')), dStatus,
      h('button', { class: 'btn sm', onclick: () => safe(api.invoke('discord:reconnect'), t('Не удалось переподключиться')) }, t('Переподключить'))),
    settingRow(t('Показывать активность в Discord'), t('Включает и выключает Rich Presence целиком'), switchEl(d().enabled, dd('enabled'))),
    field('Discord Application ID', text(d().clientId, (v) => saveDebounced({ discord: { clientId: v.trim() } }), { placeholder: '18–19 цифр из Developer Portal' }),
      t('Создайте приложение с названием bibil_aClient на discord.com/developers и загрузите арт «logo» (см. README).')),
    field(t('Ключ картинки (ассет Discord)'), text(d().largeImageKey, (v) => saveDebounced({ discord: { largeImageKey: v.trim() } }), { placeholder: 'logo' }),
      t('Ключ ассета из Rich Presence → Art Assets. Файл: build/discord-logo-1024.png.')),
    field(t('Свой текст статуса'), text(d().customText, (v) => saveDebounced({ discord: { customText: v } }), { maxlength: 100, placeholder: t('Пусто — стандартный текст') })),
    settingRow(t('Версия Minecraft'), null, switchEl(d().showVersion, dd('showVersion'))),
    settingRow(t('Загрузчик (Fabric)'), null, switchEl(d().showLoader, dd('showLoader'))),
    settingRow(t('Название профиля'), null, switchEl(d().showProfile, dd('showProfile'))),
    settingRow(t('Прошедшее время'), null, switchEl(d().showElapsed, dd('showElapsed'))),
    settingRow(t('Показывать статус, когда игра не запущена'), t('Пока вы в лаунчере'), switchEl(d().showInLauncher, dd('showInLauncher'))),
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, field(t('Текст кнопки (необязательно)'), text(d().buttonLabel, (v) => saveDebounced({ discord: { buttonLabel: v } }), { maxlength: 32 }))),
      h('div', { class: 'grow' }, field(t('Ссылка кнопки (https)'), text(d().buttonUrl, (v) => saveDebounced({ discord: { buttonUrl: v.trim() } }), { placeholder: 'https://…' })))));

  // ---------- Аккаунты ----------
  const auth = section(t('Вход в аккаунт'),
    field('Azure Application (client) ID', text(s().auth.azureClientId, (v) => saveDebounced({ auth: { azureClientId: v.trim() } }), { placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' }),
      t('Нужен для входа через Microsoft (см. README, раздел «Microsoft-вход»). Локальный ник доступен и без него.')));

  // ---------- Оновлення клієнта ----------
  const uStatus = h('span', { class: 'chip' });
  const uProgress = h('div', { class: 'small muted', style: { marginTop: '6px' } });
  const U_STATUS = {
    idle: [t('Не перевірялось'), ''], checking: [t('Перевіряємо…'), ''], available: [t('Є оновлення'), 'warn'],
    'up-to-date': [t('Актуальна версія'), 'ok'], downloading: [t('Завантаження…'), ''],
    downloaded: [t('Завантажено — можна встановити'), 'ok'], installing: [t('Встановлення…'), ''],
    error: [t('Помилка'), 'bad'], unavailable: [t('Недоступне'), ''],
  };
  let updateInfo = null;
  const showUpdate = (info) => {
    if (!info) return;
    updateInfo = info;
    const [label, cls] = U_STATUS[info.state] || [info.state, ''];
    uStatus.className = `chip ${cls}`;
    uStatus.textContent = label + (info.latest ? ` · ${info.latest}` : '');
    uProgress.textContent = info.progress > 0 && info.state === 'downloading' ? `${info.progress}%` : (info.message || '');
  };
  api.invoke('update:info').then(showUpdate).catch(() => {});
  const offUpdate = api.on('update:state', showUpdate);
  const u = () => s().updater;
  const du = (k) => (v) => save({ updater: { [k]: v } });
  const installUpdate = () => safe(api.invoke('update:install'), t('Не вдалося встановити оновлення'));
  const updates = section(t('Оновлення клієнта'),
    h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'muted' }, t('Статус:')), uStatus,
      h('button', { class: 'btn sm', onclick: () => safe(api.invoke('update:check'), t('Не вдалося перевірити оновлення')) }, t('Перевірити')),
      h('button', { class: 'btn sm', onclick: installUpdate }, t('Встановити'))),
    uProgress,
    settingRow(t('Увімкнути автооновлення'), null, switchEl(u().enabled, du('enabled'))),
    settingRow(t('Перевіряти при запуску'), null, switchEl(u().autoCheck, du('autoCheck'))),
    settingRow(t('Встановлювати автоматично'), t('Після завантаження, якщо гра не запущена'), switchEl(u().autoInstall, du('autoInstall'))),
    field(t('Адреса оновлень (HTTPS)'), text(u().url, (v) => saveDebounced({ updater: { url: v.trim() } }), { placeholder: t('не потрібна — Railway') }),
      t('Адреса вже зашита в збірку (сервер оновлень на Railway): оновлення перевіряються автоматично. Адресу вводьте тільки якщо хочете інший сервер (там мають лежати latest.yml і Setup.exe). Портативна версія не оновлюється.')));

  const about = section(t('О программе'),
    h('div', { class: 'small muted' }, `bibil_aClient v${state.info.version} · Electron ${state.info.electron} · ${t('данные:')} ${state.info.userData}`),
    h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Является официальным продуктом Mojang от bibil_a'),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { class: 'btn sm', onclick: () => safe(api.invoke('app:openPath', 'userData')) }, t('Открыть папку данных')),
      h('button', { class: 'btn sm danger', onclick: async () => {
        if (!(await confirmDialog(t('Сбросить все настройки лаунчера к безопасным значениям? Профили и аккаунты останутся.'), { okLabel: 'Сбросить', danger: true }))) return;
        if (await safe(api.invoke('settings:reset').then(() => true), t('Не удалось сбросить настройки'))) location.reload();
      } }, t('Сбросить настройки'))));

  root.append(h('h1', {}, t('Настройки')), h('p', { class: 'sub' }, t('Изменения сохраняются автоматически.')), appearance, game, optimization, java, discord, auth, updates, about);

  return () => { offStatus(); offUpdate(); };
}
