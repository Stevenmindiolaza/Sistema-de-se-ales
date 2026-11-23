'use strict';
const fs = require('fs');
const path = require('path');

/** Persistencia ligera en JSON local (escritura atómica con debounce). */
class Store {
  constructor(file = path.join(__dirname, '..', 'data', 'db.json')) {
    this.file = file;
    this.timer = null;
    this.data = { signals: [] };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(this.data.signals)) this.data.signals = [];
    } catch { /* archivo nuevo */ }
  }
  all() { return this.data.signals; }
  add(sig) { this.data.signals.push(sig); this._save(); }
  save() { this._save(); }
  clear() { this.data.signals = []; this._save(); }
  _save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const tmp = this.file + '.tmp';
      fs.writeFile(tmp, JSON.stringify(this.data), (e) => {
        if (!e) fs.rename(tmp, this.file, () => {});
      });
    }, 300);
  }
}
module.exports = Store;
