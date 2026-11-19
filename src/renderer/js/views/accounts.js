import { h, modal, toast, safe, confirmDialog } from '../ui.js';
import { state, subscribe, refreshAccounts } from '../state.js';

const api = window.bibil;

export function accountsView(root, { go }) {
  const list = h('div', { class: 'list' });
  const addBtn = h('button', { class: 'btn primary', onclick: loginMicrosoft }, '+ Войти через Microsoft');
  const offBtn = h('button', { class: 'btn', onclick: addOffline }, '+ Локальный аккаунт');

  root.append(
    h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, h('h1', {}, 'Аккаунты'),
      h('p', { class: 'sub' }, 'Microsoft — для официальных серверов. Локальный аккаунт работает без входа, но не поддерживает серверы с онлайн-проверкой.')),
      addBtn),
    h('div', { class: 'notice account-notice' }, 'Локальный аккаунт хранится только на этом компьютере и не подтверждает владение Minecraft. Он подходит для одиночной игры, LAN и серверов без онлайн-проверки (с Hamachi/ZeroTier можно играть с друзьями).'),
    list);

  function render() {
    list.replaceChildren();
    offBtn.remove();
    addBtn.after(offBtn);

    if (!state.accounts.length) {
      list.append(h('div', { class: 'empty' }, 'Аккаунтов пока нет. Добавьте Microsoft-аккаунт или создайте локальный.'));
      return;
    }
    for (const a of state.accounts) {
      const active = a.id === state.activeAccountId;
      list.append(h('div', { class: 'card account-card' }, h('div', { class: 'row wrap' },
        h('div', { class: 'logo', style: { width: '38px', height: '38px', fontSize: '18px', borderRadius: '10px' } }, a.name[0].toUpperCase()),
        h('div', { class: 'grow' }, h('b', {}, a.name), h('div', { class: 'small muted' }, a.type === 'msa' ? 'Microsoft · онлайн-проверка' : 'Локальный · без Microsoft-входа')),
        active ? h('span', { class: 'chip ok' }, 'Активный') : h('button', { class: 'btn sm', onclick: async () => { await safe(api.invoke('accounts:setActive', a.id)); await refreshAccounts(); } }, 'Выбрать'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!(await confirmDialog(`Удалить аккаунт ${a.name} из лаунчера?`, { okLabel: 'Удалить', danger: true }))) return;
          await safe(api.invoke('accounts:remove', a.id)); await refreshAccounts();
        } }, 'Удалить'))));
    }
  }

  async function loginMicrosoft() {
    const codeBox = h('div', { class: 'code' }, '…');
    let uri = 'https://www.microsoft.com/link';
    const body = h('div', {}, h('p', {}, 'Откройте страницу Microsoft, введите код и подтвердите вход. Окно можно не закрывать — вход завершится автоматически.'), codeBox,
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => api.invoke('app:openExternal', uri) }, 'Открыть страницу входа'),
        h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(codeBox.textContent).then(() => toast('Код скопирован', 'success')) }, 'Копировать код')),
      h('p', { class: 'muted small', id: 'authStatus' }, 'Ожидание подтверждения…'));

    const off = api.on('auth:code', (c) => {
      codeBox.textContent = c.userCode;
      if (/^https:\/\//.test(c.verificationUri)) uri = c.verificationUri;
    });
    const dlg = modal({ title: 'Вход через Microsoft', body, onClose: () => { off(); api.invoke('accounts:cancelLogin').catch(() => {}); },
      actions: [{ label: 'Отмена', onClick: (c) => c() }] });

    try {
      const acc = await api.invoke('accounts:loginMicrosoft');
      off();
      dlg.close();
      await refreshAccounts();
      toast(`Добро пожаловать, ${acc.name}!`, 'success');
    } catch (e) {
      off();
      dlg.close();
      if (!/отменён/i.test(e.message)) toast(e.message, 'error');
      if (/client.?ID/i.test(e.message)) go('settings');
    }
  }

  function addOffline() {
    const name = h('input', { type: 'text', maxlength: 16, placeholder: 'Ник (3–16 символов)', autocomplete: 'off', spellcheck: false });
    const body = h('div', {}, h('p', { class: 'muted' }, 'Укажите игровой ник: латинские буквы, цифры и _; от 3 до 16 символов. Локальный профиль создаётся без интернета и не авторизует на официальных серверах.'), name);
    const submit = async (close) => {
      const account = await safe(api.invoke('accounts:addOffline', name.value.trim()));
      if (!account) return;
      close();
      await refreshAccounts();
      toast(`Локальный аккаунт ${account.name} готов`, 'success');
    };
    const dlg = modal({ title: 'Добавить локальный аккаунт', body,
      actions: [{ label: 'Отмена', onClick: (c) => c() },
        { label: 'Добавить', primary: true, onClick: submit }] });
    name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        dlg.box.querySelector('.actions .btn.primary').click();
      }
    });
    name.focus();
  }

  render();
  return subscribe((w) => (w === 'accounts' || w === 'settings') && render());
}
