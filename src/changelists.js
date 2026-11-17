'use strict';

const { randomUUID } = require('node:crypto');

const STORAGE_KEY = 'repolens.changelists.v1';
const DEFAULT_LIST_ID = 'default';

function fileKey(repoKey, uri) {
  const resource = typeof uri === 'string' ? uri : uri?.toString();
  if (typeof repoKey !== 'string' || !repoKey || typeof resource !== 'string' || !resource) {
    throw new Error('Select valid files to move.');
  }
  return JSON.stringify([repoKey, resource]);
}

function validFileKey(value) {
  try {
    const parts = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 2 && parts.every(part => typeof part === 'string' && part);
  } catch {
    return false;
  }
}

function normalizedName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Enter a changelist name.');
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw new Error('Changelist names cannot contain line breaks or control characters.');
  }
  const name = value.trim();
  if ([...name].length > 80) throw new Error('Changelist names must be 80 characters or fewer.');
  return name;
}

const comparableName = value => value.normalize('NFKC').toLowerCase();

class ChangelistStore {
  constructor(workspaceState) {
    this.workspaceState = workspaceState;
    this._lists = [{ id: DEFAULT_LIST_ID, name: 'Default' }];
    this._activeId = DEFAULT_LIST_ID;
    this._files = new Map();
    this._renameLinks = new Map();
    this._pending = Promise.resolve();
    this._lastError = undefined;

    const saved = workspaceState.get(STORAGE_KEY);
    if (!saved || saved.version !== 1) return;
    const lists = [];
    const ids = new Set();
    const names = new Set();
    for (const item of Array.isArray(saved.lists) ? saved.lists : []) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) continue;
      let name;
      try { name = normalizedName(item.name); } catch { continue; }
      const comparable = comparableName(name);
      if (names.has(comparable)) continue;
      ids.add(item.id);
      names.add(comparable);
      lists.push({ id: item.id, name });
    }
    if (!ids.has(DEFAULT_LIST_ID)) {
      const conflicting = lists.findIndex(list => comparableName(list.name) === comparableName('Default'));
      if (conflicting >= 0) {
        ids.delete(lists[conflicting].id);
        lists.splice(conflicting, 1);
      }
      lists.unshift({ id: DEFAULT_LIST_ID, name: 'Default' });
      ids.add(DEFAULT_LIST_ID);
    }
    this._lists = lists;
    this._activeId = ids.has(saved.activeId) ? saved.activeId : DEFAULT_LIST_ID;
    if (saved.files && typeof saved.files === 'object' && !Array.isArray(saved.files)) {
      for (const [key, listId] of Object.entries(saved.files)) {
        if (validFileKey(key) && ids.has(listId)) this._files.set(key, listId);
      }
    }
  }

  get lists() { return this._lists.map(list => ({ ...list })); }
  get activeId() { return this._activeId; }
  get lastError() { return this._lastError; }

  listFor(repoKey, uri) {
    return this._files.get(fileKey(repoKey, uri)) || DEFAULT_LIST_ID;
  }

  serialize() {
    return { version: 1, lists: this.lists, activeId: this.activeId, files: Object.fromEntries(this._files) };
  }

  _save() {
    const snapshot = this.serialize();
    this._pending = this._pending.catch(() => {}).then(async () => {
      try {
        await this.workspaceState.update(STORAGE_KEY, snapshot);
        this._lastError = undefined;
      } catch (error) {
        this._lastError = error;
        throw error;
      }
    });
    // sync() stays synchronous; flush() and async mutations surface persistence failures.
    this._pending.catch(() => {});
    return this._pending;
  }

  flush() { return this._pending; }

  _list(id) {
    const list = this._lists.find(item => item.id === id);
    if (!list) throw new Error('Changelist not found.');
    return list;
  }

  _name(name, exceptId) {
    const result = normalizedName(name);
    if (this._lists.some(list => list.id !== exceptId && comparableName(list.name) === comparableName(result))) {
      throw new Error('A changelist with this name already exists.');
    }
    return result;
  }

  async create(name) {
    const list = { id: randomUUID(), name: this._name(name) };
    this._lists.push(list);
    await this._save();
    return { ...list };
  }

  async rename(id, name) {
    const list = this._list(id);
    const updated = this._name(name, id);
    if (list.name !== updated) {
      list.name = updated;
      await this._save();
    }
    return { ...list };
  }

  async remove(id) {
    this._list(id);
    if (id === DEFAULT_LIST_ID) throw new Error('The default changelist cannot be deleted.');
    this._lists = this._lists.filter(list => list.id !== id);
    if (this._activeId === id) this._activeId = DEFAULT_LIST_ID;
    for (const [key, listId] of this._files) {
      if (listId === id) this._files.set(key, DEFAULT_LIST_ID);
    }
    await this._save();
  }

  async setActive(id) {
    this._list(id);
    if (this._activeId === id) return false;
    this._activeId = id;
    await this._save();
    return true;
  }

  async move(files, id) {
    this._list(id);
    if (!Array.isArray(files)) throw new Error('Select valid files to move.');
    const keys = new Set(files.map(file => fileKey(file?.repoKey, file?.uri ?? file?.uriString)));
    for (const key of keys) {
      for (const related of this._renameLinks.get(key) || []) keys.add(related);
    }
    let changed = false;
    for (const key of keys) {
      if (this._files.get(key) === id) continue;
      this._files.set(key, id);
      changed = true;
    }
    if (changed) await this._save();
    return changed;
  }

  sync(snapshots, knownRepoKeys) {
    const records = new Map();
    const renameLinks = new Map();
    const link = (left, right) => {
      if (!renameLinks.has(left)) renameLinks.set(left, new Set());
      renameLinks.get(left).add(right);
    };
    for (const snapshot of snapshots || []) {
      for (const kind of ['working', 'index', 'conflicts']) {
        for (const change of snapshot[kind] || []) {
          const key = fileKey(snapshot.key, change.uri);
          let record = records.get(key);
          if (!record) {
            record = { key, aliases: new Set(), destinations: new Set() };
            records.set(key, record);
          }
          const renamed = change.status === 3 || change.status === 10;
          for (const alias of renamed ? [change.originalUri, change.renameUri] : []) {
            if (alias) record.aliases.add(fileKey(snapshot.key, alias));
          }
          if (renamed && change.renameUri) {
            const destination = fileKey(snapshot.key, change.renameUri);
            record.destinations.add(destination);
            link(key, destination);
            link(destination, key);
          }
        }
      }
    }
    const next = new Map();
    if (knownRepoKeys !== undefined) {
      const known = new Set(knownRepoKeys || []);
      for (const [key, listId] of this._files) {
        if (!known.has(JSON.parse(key)[0])) next.set(key, listId);
      }
    }
    for (const record of records.values()) {
      let listId = this._files.get(record.key);
      if (!listId) {
        for (const alias of record.aliases) {
          listId = this._files.get(alias);
          if (listId) break;
        }
      }
      next.set(record.key, listId || this._activeId);
    }
    // Git can report a staged rename through its old URI until a later refresh.
    // Remember the destination while it is live so that refresh keeps its list.
    for (const record of records.values()) {
      for (const destination of record.destinations) {
        if (!next.has(destination)) next.set(destination, this._files.get(destination) || next.get(record.key));
      }
    }
    this._renameLinks = renameLinks;
    const changed = next.size !== this._files.size || [...next].some(([key, value]) => this._files.get(key) !== value);
    if (changed) {
      this._files = next;
      this._save();
    }
    return changed;
  }
}

module.exports = { ChangelistStore, DEFAULT_LIST_ID, STORAGE_KEY };
