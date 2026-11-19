import { h, field, switchEl, settingRow, selectEl, debounce, toast, safe, clear, confirmDialog } from '../ui.js';
import { state, saveSettings } from '../state.js';

const api = window.bibil;

export function settingsView(root) {
  const s = () => state.settings;
  const save = (patch) => saveSettings(patch).catch((e) => toast(`Не удалось сохранить: ${e.message}`, 'error'));
  const saveDebounced = debounce(save, 500);

  const text = (value, onInput, attrs = {}) => h('input', { type: 'text', value: value ?? '', oninput: (e) => onInput(e.target.value), ...attrs });
  const section = (title, ...kids) => h('div', {}, h('h2', {}, title), h('div', { class: 'card' }, kids));

  // ---------- Оформление ----------
  const appearance = section('Оформление',
    settingRow('Тема', 'Тёмная, светлая или «Полночь» (чёрная)', selectEl(
      [{ value: 'dark', label: 'Тёмная' }, { value: 'light', label: 'Светлая' }, { value: 'midnight', label: 'Полночь' }], s().launcher.theme, (v) => save({ launcher: { theme: v } }))),
    settingRow('Акцентный цвет', null, h('input', { type: 'color', value: s().launcher.accent, oninput: (e) => saveDebounced({ launcher: { accent: e.target.value } }) })),
    settingRow('Анимации', 'Плавные переходы и эффекты интерфейса', switchEl(s().launcher.animations, (v) => save({ launcher: { animations: v } }))),
    settingRow('При запуске игры', 'Что делать с окном лаунчера', selectEl(
      [{ value: 'keep', label: 'Оставить' }, { value: 'minimize', label: 'Свернуть' }, { value: 'hide', label: 'Скрыть до выхода из игры' }], s().launcher.onLaunch, (v) => save({ launcher: { onLaunch: v } }))),
    settingRow('Показывать снапшоты', 'В списке версий при создании профиля', switchEl(s().launcher.showSnapshots, (v) => save({ launcher: { showSnapshots: v } }))),
    settingRow('Повтор запуска после краша JVM', 'Если Java 25 вылетела с кодом 0xC0000005, игра запустится ещё раз (до 2 попыток) в безопасном режиме', switchEl(s().launcher.autoRetry, (v) => save({ launcher: { autoRetry: v } }))));

  // ---------- Игра ----------
  const maxMB = Math.max(1024, state.info.maxRamMb || Math.floor((state.info.totalMemMB * 0.7) / 256) * 256);
  const ramLabel = h('b');
  const minLabel = h('b');
  const ramMax = h('input', { type: 'range', min: 512, max: maxMB, step: 256, value: Math.min(s().game.ramMax, maxMB) });
  const ramMin = h('input', { type: 'range', min: 256, max: maxMB, step: 256, value: Math.min(s().game.ramMin, maxMB) });
  const showRam = () => { ramLabel.textContent = `${(ramMax.value / 1024).toFixed(2)} ГБ`; minLabel.textContent = `${(ramMin.value / 1024).toFixed(2)} ГБ`; };
  ramMax.addEventListener('input', () => { showRam(); saveDebounced({ game: { ramMax: Number(ramMax.value) } }); });
  ramMin.addEventListener('input', () => { showRam(); saveDebounced({ game: { ramMin: Number(ramMin.value) } }); });
  showRam();

  const num = (v, key, min, max) => h('input', { type: 'number', min, max, value: v, oninput: (e) => saveDebounced({ game: { [key]: Number(e.target.value) } }) });
  const game = section('Игра',
    field('Максимум памяти (-Xmx)', h('div', {}, ramMax, ramLabel), `Доступно в системе: ${(state.info.totalMemMB / 1024).toFixed(1)} ГБ. Слишком много памяти вызывает вылеты — рекомендуется 3–6 ГБ.`),
    field('Начальная память (-Xms)', h('div', {}, ramMin, minLabel)),
    field('Графический бэкенд', selectEl([
      { value: 'opengl', label: 'OpenGL (рекомендуется)' },
      { value: 'vulkan', label: 'Vulkan (может падать на AMD)' },
      { value: 'default', label: 'Как в игре' },
    ], s().game.graphicsBackend, (v) => save({ game: { graphicsBackend: v } })),
      'MC 26.x после сбоя сама переключает бэкенд; на AMD Vulkan вылетает в amdvlk64.dll. Лаунчер фиксирует OpenGL перед каждым запуском.'),
    field('JVM-аргументы', text(s().game.jvmArgs, (v) => saveDebounced({ game: { jvmArgs: v } })),
      'По умолчанию пусто. Лишние флаги -Xmx/-Xms и GC могут выронить игру — не добавляйте их без необходимости.'),
    field('Аргументы игры', text(s().game.gameArgs, (v) => saveDebounced({ game: { gameArgs: v } }), { placeholder: 'например: --quickPlayMultiplayer play.example.com' })),
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, field('Ширина окна', num(s().game.width, 'width', 320, 7680))),
      h('div', { class: 'grow' }, field('Высота окна', num(s().game.height, 'height', 240, 4320)))),
    settingRow('Полноэкранный режим', null, switchEl(s().game.fullscreen, (v) => save({ game: { fullscreen: v } }))));

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
    'Применять оптимизацию',
    'Пресет включает настройки автоматически; ручные изменения сохраняются как свой вариант.',
    switchEl(initialOptimization.enabled, (v) => save({ game: { optimization: { enabled: v } } }))
  );
  const optimizationDisplay = (key, value) => {
    if (key === 'renderDistance' || key === 'simulationDistance') return `${value} чанков`;
    if (key === 'entityDistance') return `${Math.round(Number(value) * 100)}%`;
    if (key === 'maxFps') return Number(value) === 260 ? 'Без ограничений' : `${value} FPS`;
    return String(value);
  };
  const optimizationPreset = selectEl([
    { value: 'balanced', label: 'Сбалансированный' },
    { value: 'performance', label: 'Максимум FPS' },
    { value: 'custom', label: 'Настраиваемый' },
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
  const optimization = section('Оптимизация Minecraft',
    h('div', { class: 'optimization-intro' },
      h('b', {}, 'Управляйте производительностью без сторонних программ'),
      h('p', { class: 'small muted' }, 'Настройки графики, дистанции, частиц и FPS применяются отдельно для каждого профиля. Отключите оптимизацию, чтобы управлять ими в самой игре.')),
    optimizationEnabled,
    field('Пресет', optimizationPreset, '«Максимум FPS» упрощает графику и снижает нагрузку на слабых компьютерах.'),
    h('div', { class: 'optimization-grid' },
      field('Дальность прорисовки', optimizationRange('renderDistance', 2, 32)),
      field('Дальность симуляции', optimizationRange('simulationDistance', 5, 32))),
    h('div', { class: 'optimization-grid' },
      field('Графика', optimizationSelect('graphics', [
        { value: 'fast', label: 'Быстрая' }, { value: 'fancy', label: 'Красивая' },
      ])),
      field('Частицы', optimizationSelect('particles', [
        { value: 'all', label: 'Все' }, { value: 'decreased', label: 'Уменьшено' }, { value: 'minimal', label: 'Минимум' },
      ]))),
    h('div', { class: 'optimization-grid' },
      field('Облака', optimizationSelect('clouds', [
        { value: 'off', label: 'Выкл.' }, { value: 'fast', label: 'Быстрые' }, { value: 'fancy', label: 'Красивые' },
      ])),
      field('Дальность сущностей', optimizationRange('entityDistance', 0.5, 2, 0.1))),
    h('div', { class: 'optimization-grid' },
      field('Уровни mipmap', optimizationRange('mipmapLevels', 0, 4)),
      field('Ограничение FPS', optimizationSelect('maxFps', [
        { value: 30, label: '30 FPS' }, { value: 60, label: '60 FPS' }, { value: 75, label: '75 FPS' },
        { value: 120, label: '120 FPS' }, { value: 144, label: '144 FPS' }, { value: 165, label: '165 FPS' },
        { value: 240, label: '240 FPS' }, { value: 260, label: 'Без ограничений' },
      ]))),
    settingRow('Вертикальная синхронизация', 'Отключение может увеличить FPS, но привести к разрывам изображения.',
      h('label', { class: 'switch' }, optimizationInputs.vsync, h('i'))));

  // ---------- Java ----------
  const javaList = h('div', { class: 'small muted' }, 'Нажмите «Найти Java», чтобы увидеть установленные версии.');
  const javaInput = text(s().java.path, (v) => saveDebounced({ java: { path: v } }), { placeholder: 'Автоматически' });
  async function detectJava() {
    javaList.textContent = 'Поиск…';
    const found = await safe(api.invoke('java:detect'), 'Ошибка поиска Java');
    if (!found) return;
    clear(javaList);
    if (!found.length) javaList.textContent = 'Java не найдена — лаунчер скачает нужную версию автоматически (если включено).';
    for (const j of found) {
      javaList.append(h('div', { class: 'row', style: { margin: '4px 0' } },
        h('span', { class: 'chip' }, `Java ${j.major}`), h('span', { class: 'grow small', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, j.path + (j.bundled ? ' (встроенная)' : '')),
        h('button', { class: 'btn sm', onclick: () => { javaInput.value = j.path; save({ java: { path: j.path } }); } }, 'Использовать')));
    }
  }
  const java = section('Java',
    field('Путь к Java (пусто — автоопределение по версии игры)', javaInput),
    settingRow('Автоматически скачивать Java', 'Eclipse Temurin (Adoptium), если подходящей Java нет', switchEl(s().java.autoDownload, (v) => save({ java: { autoDownload: v } }))),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: detectJava }, 'Найти Java'),
      h('button', { class: 'btn', onclick: () => safe(api.invoke('app:openPath', 'root')) }, 'Папка игры')),
    javaList);

  // ---------- Discord ----------
  const dStatus = h('span', { class: 'chip' });
  const STATUS = {
    disabled: ['Выключено', ''], 'no-client-id': ['Нет Application ID', 'warn'], connecting: ['Подключение…', ''],
    connected: ['Подключено', 'ok'], unavailable: ['Discord недоступен', 'bad'],
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
    h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'muted' }, 'Статус:'), dStatus,
      h('button', { class: 'btn sm', onclick: () => safe(api.invoke('discord:reconnect'), 'Не удалось переподключиться') }, 'Переподключить')),
    settingRow('Показывать активность в Discord', 'Включает и выключает Rich Presence целиком', switchEl(d().enabled, dd('enabled'))),
    field('Discord Application ID', text(d().clientId, (v) => saveDebounced({ discord: { clientId: v.trim() } }), { placeholder: '18–19 цифр из Developer Portal' }),
      'Создайте приложение с названием bibil_aClient на discord.com/developers и загрузите арт «logo» (см. README).'),
    field('Ключ картинки (ассет Discord)', text(d().largeImageKey, (v) => saveDebounced({ discord: { largeImageKey: v.trim() } }), { placeholder: 'logo' }),
      'Ключ ассета из Rich Presence → Art Assets. Файл: build/discord-logo-1024.png.'),
    field('Свой текст статуса', text(d().customText, (v) => saveDebounced({ discord: { customText: v } }), { maxlength: 100, placeholder: 'Пусто — стандартный текст' })),
    settingRow('Версия Minecraft', null, switchEl(d().showVersion, dd('showVersion'))),
    settingRow('Загрузчик (Fabric)', null, switchEl(d().showLoader, dd('showLoader'))),
    settingRow('Название профиля', null, switchEl(d().showProfile, dd('showProfile'))),
    settingRow('Прошедшее время', null, switchEl(d().showElapsed, dd('showElapsed'))),
    settingRow('Показывать статус, когда игра не запущена', 'Пока вы в лаунчере', switchEl(d().showInLauncher, dd('showInLauncher'))),
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, field('Текст кнопки (необязательно)', text(d().buttonLabel, (v) => saveDebounced({ discord: { buttonLabel: v } }), { maxlength: 32 }))),
      h('div', { class: 'grow' }, field('Ссылка кнопки (https)', text(d().buttonUrl, (v) => saveDebounced({ discord: { buttonUrl: v.trim() } }), { placeholder: 'https://…' })))));

  // ---------- Аккаунты ----------
  const auth = section('Вход в аккаунт',
    field('Azure Application (client) ID', text(s().auth.azureClientId, (v) => saveDebounced({ auth: { azureClientId: v.trim() } }), { placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' }),
      'Нужен для входа через Microsoft (см. README, раздел «Microsoft-вход»). Локальный ник доступен и без него.'));

  // ---------- Оновлення клієнта ----------
  const uStatus = h('span', { class: 'chip' });
  const uProgress = h('div', { class: 'small muted', style: { marginTop: '6px' } });
  const U_STATUS = {
    idle: ['Не перевірялось', ''], checking: ['Перевіряємо…', ''], available: ['Є оновлення', 'warn'],
    'up-to-date': ['Актуальна версія', 'ok'], downloading: ['Завантаження…', ''],
    downloaded: ['Завантажено — можна встановити', 'ok'], installing: ['Встановлення…', ''],
    error: ['Помилка', 'bad'], unavailable: ['Недоступне', ''],
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
  const installUpdate = () => safe(api.invoke('update:install'), 'Не вдалося встановити оновлення');
  const updates = section('Оновлення клієнта',
    h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'muted' }, 'Статус:'), uStatus,
      h('button', { class: 'btn sm', onclick: () => safe(api.invoke('update:check'), 'Не вдалося перевірити оновлення') }, 'Перевірити'),
      h('button', { class: 'btn sm', onclick: installUpdate }, 'Встановити')),
    uProgress,
    settingRow('Увімкнути автооновлення', null, switchEl(u().enabled, du('enabled'))),
    settingRow('Перевіряти при запуску', null, switchEl(u().autoCheck, du('autoCheck'))),
    settingRow('Встановлювати автоматично', 'Після завантаження, якщо гра не запущена', switchEl(u().autoInstall, du('autoInstall'))),
    field('Адреса оновлень (HTTPS)', text(u().url, (v) => saveDebounced({ updater: { url: v.trim() } }), { placeholder: 'не потрібна — Railway' }),
      'Адреса вже зашита в збірку (сервер оновлень на Railway): оновлення перевіряються автоматично. Адресу вводьте тільки якщо хочете інший сервер (там мають лежати latest.yml і Setup.exe). Портативна версія не оновлюється.'));

  const about = section('О программе',
    h('div', { class: 'small muted' }, `bibil_aClient v${state.info.version} · Electron ${state.info.electron} · данные: ${state.info.userData}`),
    h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Является официальным продуктом Mojang от bibil_a'),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { class: 'btn sm', onclick: () => safe(api.invoke('app:openPath', 'userData')) }, 'Открыть папку данных'),
      h('button', { class: 'btn sm danger', onclick: async () => {
        if (!(await confirmDialog('Сбросить все настройки лаунчера к безопасным значениям? Профили и аккаунты останутся.', { okLabel: 'Сбросить', danger: true }))) return;
        if (await safe(api.invoke('settings:reset').then(() => true), 'Не удалось сбросить настройки')) location.reload();
      } }, 'Сбросить настройки')));

  root.append(h('h1', {}, 'Настройки'), h('p', { class: 'sub' }, 'Изменения сохраняются автоматически.'), appearance, game, optimization, java, discord, auth, updates, about);

  return () => { offStatus(); offUpdate(); };
}
