'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const userData = app.getPath('userData');

const paths = {
  userData,
  root: path.join(userData, 'minecraft'), // общие assets/libraries/versions
  instances: path.join(userData, 'instances'), // игровые директории профилей
  runtime: path.join(userData, 'runtime'), // скачанные Java
  cache: path.join(userData, 'cache'),
  logs: path.join(userData, 'logs'),
  config: path.join(userData, 'config'),

  instanceDir(id) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(String(id))) throw new Error('Некорректный идентификатор профиля');
    return path.join(this.instances, id);
  },

  ensure() {
    for (const d of [this.root, this.instances, this.runtime, this.cache, this.logs, this.config]) {
      fs.mkdirSync(d, { recursive: true });
    }
  },
};

module.exports = paths;
