/**
 * FamilyHub v2.0 — core/db.js
 * All IndexedDB operations: entity CRUD, edge CRUD, query engine, export/import
 * Blueprint §2.1 (schema), §2.2 (settings keys), §10.1 (public API)
 *
 * Uses the native IndexedDB API directly — no external library.
 * The idb library (mentioned in Blueprint §1.1) is omitted here in favour of
 * a thin promise wrapper to keep the file self-contained and dependency-free,
 * consistent with the "no bundler, no framework" principle.
 */

'use strict';

// ── Constants ────────────────────────────────────────────── //

/** Blueprint §1.1 — IndexedDB database name */
export const DB_NAME    = 'familyhub_v2';

/** Blueprint §14.3 — increment ONLY when schema changes */
export const DB_VERSION = 1;

/** Store names (Blueprint §2.1) */
export const STORES = Object.freeze({
  ENTITIES: 'entities',
  EDGES:    'edges',
  SETTINGS: 'settings',
});

// ── Internal state ───────────────────────────────────────── //

/** @type {IDBDatabase|null} */
let _db = null;

// ── Initialisation ───────────────────────────────────────── //

/**
 * Open (or create) the IndexedDB database.
 * Creates all three object stores with indexes on first run.
 * Blueprint §10.1 — initDB()
 *
 * @returns {Promise<IDBDatabase>}
 */
export function initDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[db] Failed to open IndexedDB:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      _db = request.result;

      // Handle unexpected DB closure (e.g. browser storage eviction)
      _db.onclose = () => {
        console.warn('[db] IndexedDB connection closed unexpectedly — will reopen on next call');
        _db = null;
      };

      _db.onerror = (e) => {
        console.error('[db] IndexedDB error:', e.target.error);
      };

      console.log('[db] IndexedDB opened:', DB_NAME, 'v' + DB_VERSION);
      resolve(_db);
    };

    // Blueprint §2.1 — onupgradeneeded: create stores + indexes
    request.onupgradeneeded = (event) => {
      const db      = event.target.result;
      const oldVer  = event.oldVersion;

      console.log('[db] Upgrading schema from v' + oldVer + ' to v' + DB_VERSION);

      // ── entities store ────────────────────────────────────
      // {id, type, createdAt, updatedAt, createdBy, deleted, ...props}
      if (!db.objectStoreNames.contains(STORES.ENTITIES)) {
        const entityStore = db.createObjectStore(STORES.ENTITIES, { keyPath: 'id' });
        entityStore.createIndex('type',       'type',       { unique: false });
        entityStore.createIndex('createdAt',  'createdAt',  { unique: false });
        entityStore.createIndex('updatedAt',  'updatedAt',  { unique: false });
        entityStore.createIndex('createdBy',  'createdBy',  { unique: false });
        console.log('[db] Created store: entities');
      }

      // ── edges store ───────────────────────────────────────
      // {id, fromId, fromType, toId, toType, relation, createdAt, createdBy}
      if (!db.objectStoreNames.contains(STORES.EDGES)) {
        const edgeStore = db.createObjectStore(STORES.EDGES, { keyPath: 'id' });
        edgeStore.createIndex('fromId',           'fromId',             { unique: false });
        edgeStore.createIndex('toId',             'toId',               { unique: false });
        edgeStore.createIndex('relation',         'relation',           { unique: false });
        edgeStore.createIndex('fromId_relation',  ['fromId','relation'],{ unique: false });
        edgeStore.createIndex('toId_relation',    ['toId','relation'],  { unique: false });
        console.log('[db] Created store: edges');
      }

      // ── settings store ────────────────────────────────────
      // {key, value}
      if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
        db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
        console.log('[db] Created store: settings');
      }
    };
  });
}

// ── Internal helpers ─────────────────────────────────────── //

/**
 * Get the open DB instance, opening it if needed.
 * @returns {Promise<IDBDatabase>}
 */
async function _getDB() {
  if (_db) return _db;
  return initDB();
}

/**
 * Wrap an IDBRequest in a Promise.
 * @template T
 * @param {IDBRequest} request
 * @returns {Promise<T>}
 */
function _req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

/**
 * Run a callback inside a transaction, return its result.
 * @param {string|string[]} stores
 * @param {'readonly'|'readwrite'} mode
 * @param {(tx: IDBTransaction) => Promise<*>} fn
 */
async function _tx(stores, mode, fn) {
  const db = await _getDB();
  const tx = db.transaction(stores, mode);

  return new Promise((resolve, reject) => {
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(new Error('Transaction aborted'));

    // Run the callback — it should call resolve via _req
    fn(tx).then(r => { result = r; }).catch(err => {
      tx.abort();
      reject(err);
    });
  });
}

// ── ID generation ─────────────────────────────────────────── //

/**
 * Generate a unique ID.
 * Format: 8-char timestamp base36 + 8-char random base36 = 16 chars
 * @returns {string}
 */
export function uid() {
  const ts  = Date.now().toString(36).padStart(8, '0');
  const rnd = Math.random().toString(36).slice(2, 10).padStart(8, '0');
  return ts + rnd;
}

// ── Entity CRUD (Blueprint §10.1) ─────────────────────────── //

/**
 * Get a single entity by ID.
 * Returns null if not found or soft-deleted.
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getEntity(id) {
  const db     = await _getDB();
  const tx     = db.transaction(STORES.ENTITIES, 'readonly');
  const store  = tx.objectStore(STORES.ENTITIES);
  const entity = await _req(store.get(id));
  if (!entity || entity.deleted) return null;
  return entity;
}

/**
 * Get all non-deleted entities of a given type.
 * Blueprint §10.1 — getEntitiesByType(type)
 * @param {string} type
 * @returns {Promise<Object[]>}
 */
export async function getEntitiesByType(type) {
  const db    = await _getDB();
  const tx    = db.transaction(STORES.ENTITIES, 'readonly');
  const store = tx.objectStore(STORES.ENTITIES);
  const index = store.index('type');
  const all   = await _req(index.getAll(type));
  return all.filter(e => !e.deleted);
}

/**
 * Query entities with optional filters.
 * Blueprint §10.1 — queryEntities(filter)
 *
 * @param {Object} filter
 * @param {string}   [filter.type]        - Entity type key
 * @param {string}   [filter.createdBy]   - Account/member ID
 * @param {string[]} [filter.tags]        - Tag entity IDs (match any)
 * @param {Object}   [filter.dateRange]   - { field, from, to } — ISO date strings
 * @param {boolean}  [filter.includeDeleted=false]
 * @returns {Promise<Object[]>}
 */
export async function queryEntities(filter = {}) {
  const db    = await _getDB();
  const tx    = db.transaction(STORES.ENTITIES, 'readonly');
  const store = tx.objectStore(STORES.ENTITIES);

  let results;

  // Use type index if type filter provided — much faster than full scan
  if (filter.type) {
    results = await _req(store.index('type').getAll(filter.type));
  } else {
    results = await _req(store.getAll());
  }

  // Apply remaining filters
  return results.filter(entity => {
    if (!filter.includeDeleted && entity.deleted) return false;
    if (filter.createdBy && entity.createdBy !== filter.createdBy) return false;

    if (filter.dateRange) {
      const { field, from, to } = filter.dateRange;
      const val = entity[field];
      if (!val) return false;
      if (from && val < from) return false;
      if (to   && val > to)   return false;
    }

    return true;
  });
}

/**
 * Save (create or update) an entity.
 * Sets updatedAt. Adds to dirtyEntities queue for Notion sync.
 * Fires 'entity:saved' event.
 * Blueprint §10.1 — saveEntity(entity)
 *
 * @param {Object} entity - Must have .type. .id will be generated if missing.
 * @param {string} [byAccountId] - Who is making the change (for audit log)
 * @returns {Promise<Object>} The saved entity
 */
export async function saveEntity(entity, byAccountId) {
  if (!entity.type) throw new Error('[db] saveEntity: entity.type is required');

  const now    = new Date().toISOString();
  const isNew  = !entity.id;
  const saved  = {
    ...entity,
    id:        entity.id || uid(),
    createdAt: entity.createdAt || now,
    updatedAt: now,
    createdBy: entity.createdBy || byAccountId || null,
  };

  const db    = await _getDB();
  const tx    = db.transaction([STORES.ENTITIES, STORES.SETTINGS], 'readwrite');
  const store = tx.objectStore(STORES.ENTITIES);
  const sett  = tx.objectStore(STORES.SETTINGS);

  // Write entity
  await _req(store.put(saved));

  // Add to dirty queue for Notion sync
  await _addToDirtyQueue(sett, 'dirtyEntities', saved.id);

  // Write audit log entry
  await _appendAuditLog(sett, {
    action:      isNew ? 'create' : 'update',
    entityType:  saved.type,
    entityId:    saved.id,
    entityTitle: saved.title || saved.name || saved.id,
    byAccountId: byAccountId || null,
    at:          now,
  });

  await _txComplete(tx);

  // Fire event (import events.js lazily to avoid circular deps)
  _fireEvent('entity:saved', { entity: saved, isNew });

  return saved;
}

/**
 * Soft-delete an entity. Sets deleted=true, removes all edges.
 * Blueprint §10.1 — deleteEntity(id)
 *
 * @param {string} id
 * @param {string} [byAccountId]
 * @returns {Promise<void>}
 */
export async function deleteEntity(id, byAccountId) {
  const db   = await _getDB();
  const now  = new Date().toISOString();

  // Get entity first for audit log
  const entity = await getEntity(id);
  if (!entity) return;

  const tx      = db.transaction([STORES.ENTITIES, STORES.EDGES, STORES.SETTINGS], 'readwrite');
  const eStore  = tx.objectStore(STORES.ENTITIES);
  const edStore = tx.objectStore(STORES.EDGES);
  const sStore  = tx.objectStore(STORES.SETTINGS);

  // Soft delete
  await _req(eStore.put({ ...entity, deleted: true, updatedAt: now }));

  // Remove all edges involving this entity
  const fromEdges = await _req(edStore.index('fromId').getAll(id));
  const toEdges   = await _req(edStore.index('toId').getAll(id));
  for (const edge of [...fromEdges, ...toEdges]) {
    await _req(edStore.delete(edge.id));
  }

  // Add to dirty queue
  await _addToDirtyQueue(sStore, 'dirtyEntities', id);

  // Audit log
  await _appendAuditLog(sStore, {
    action:      'delete',
    entityType:  entity.type,
    entityId:    id,
    entityTitle: entity.title || entity.name || id,
    byAccountId: byAccountId || null,
    at:          now,
  });

  await _txComplete(tx);

  _fireEvent('entity:deleted', { id, entityType: entity.type });
}

// ── Edge CRUD (Blueprint §10.1) ───────────────────────────── //

/**
 * Get a single edge by ID.
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getEdge(id) {
  const db  = await _getDB();
  const tx  = db.transaction(STORES.EDGES, 'readonly');
  return _req(tx.objectStore(STORES.EDGES).get(id));
}

/**
 * Get all edges FROM a given entity, optionally filtered by relation.
 * Blueprint §10.1 — getEdgesFrom(entityId, relation?)
 * @param {string} entityId
 * @param {string} [relation]
 * @returns {Promise<Object[]>}
 */
export async function getEdgesFrom(entityId, relation) {
  const db    = await _getDB();
  const tx    = db.transaction(STORES.EDGES, 'readonly');
  const store = tx.objectStore(STORES.EDGES);

  if (relation) {
    return _req(store.index('fromId_relation').getAll([entityId, relation]));
  }
  return _req(store.index('fromId').getAll(entityId));
}

/**
 * Get all edges TO a given entity, optionally filtered by relation.
 * Blueprint §10.1 — getEdgesTo(entityId, relation?)
 * @param {string} entityId
 * @param {string} [relation]
 * @returns {Promise<Object[]>}
 */
export async function getEdgesTo(entityId, relation) {
  const db    = await _getDB();
  const tx    = db.transaction(STORES.EDGES, 'readonly');
  const store = tx.objectStore(STORES.EDGES);

  if (relation) {
    return _req(store.index('toId_relation').getAll([entityId, relation]));
  }
  return _req(store.index('toId').getAll(entityId));
}

/**
 * Save (create or update) an edge.
 * Blueprint §10.1 — saveEdge(edge)
 *
 * @param {Object} edge - {fromId, fromType, toId, toType, relation, ...meta}
 * @param {string} [byAccountId]
 * @returns {Promise<Object>} The saved edge
 */
export async function saveEdge(edge, byAccountId) {
  if (!edge.fromId || !edge.toId || !edge.relation) {
    throw new Error('[db] saveEdge: fromId, toId, and relation are required');
  }

  const now   = new Date().toISOString();
  const saved = {
    ...edge,
    id:        edge.id || uid(),
    createdAt: edge.createdAt || now,
    createdBy: edge.createdBy || byAccountId || null,
  };

  const db    = await _getDB();
  const tx    = db.transaction([STORES.EDGES, STORES.SETTINGS], 'readwrite');
  const store = tx.objectStore(STORES.EDGES);
  const sett  = tx.objectStore(STORES.SETTINGS);

  await _req(store.put(saved));
  await _addToDirtyQueue(sett, 'dirtyEdges', saved.id);

  await _appendAuditLog(sett, {
    action:     'link',
    entityId:   saved.fromId,
    entityType: saved.fromType,
    field:      saved.relation,
    newValue:   saved.toId,
    byAccountId,
    at:         now,
  });

  await _txComplete(tx);

  _fireEvent('edge:saved', { edge: saved });
  return saved;
}

/**
 * Delete an edge by ID.
 * Blueprint §10.1 — deleteEdge(id)
 * @param {string} id
 * @param {string} [byAccountId]
 * @returns {Promise<void>}
 */
export async function deleteEdge(id, byAccountId) {
  const db   = await _getDB();
  const tx   = db.transaction([STORES.EDGES, STORES.SETTINGS], 'readwrite');
  const store = tx.objectStore(STORES.EDGES);
  const sett  = tx.objectStore(STORES.SETTINGS);

  const edge = await _req(store.get(id));
  if (!edge) return;

  await _req(store.delete(id));
  await _appendAuditLog(sett, {
    action:     'unlink',
    entityId:   edge.fromId,
    entityType: edge.fromType,
    field:      edge.relation,
    oldValue:   edge.toId,
    byAccountId,
    at:         new Date().toISOString(),
  });

  await _txComplete(tx);
  _fireEvent('edge:deleted', { id, edge });
}

// ── Settings Store (Blueprint §10.1) ─────────────────────── //

/**
 * Get a value from the settings store.
 * Returns undefined if the key doesn't exist.
 * Blueprint §10.1 — getSetting(key)
 * @param {string} key
 * @returns {Promise<*>}
 */
export async function getSetting(key) {
  const db   = await _getDB();
  const tx   = db.transaction(STORES.SETTINGS, 'readonly');
  const rec  = await _req(tx.objectStore(STORES.SETTINGS).get(key));
  return rec?.value;
}

/**
 * Save a value to the settings store.
 * Blueprint §10.1 — setSetting(key, value)
 * @param {string} key
 * @param {*} value
 * @returns {Promise<void>}
 */
export async function setSetting(key, value) {
  const db  = await _getDB();
  const tx  = db.transaction(STORES.SETTINGS, 'readwrite');
  await _req(tx.objectStore(STORES.SETTINGS).put({ key, value }));
  await _txComplete(tx);
}

/**
 * Get multiple settings at once.
 * @param {string[]} keys
 * @returns {Promise<Object>} {key: value, ...}
 */
export async function getSettings(keys) {
  const db    = await _getDB();
  const tx    = db.transaction(STORES.SETTINGS, 'readonly');
  const store = tx.objectStore(STORES.SETTINGS);
  const result = {};
  await Promise.all(keys.map(async key => {
    const rec = await _req(store.get(key));
    result[key] = rec?.value;
  }));
  return result;
}

// ── Export / Import (Blueprint §10.1) ────────────────────── //

/**
 * Export all data as a JSON-serialisable object.
 * Blueprint §10.1 — exportAll()
 * @returns {Promise<{entities: Object[], edges: Object[], settings: Object}>}
 */
export async function exportAll() {
  const db        = await _getDB();
  const tx        = db.transaction([STORES.ENTITIES, STORES.EDGES, STORES.SETTINGS], 'readonly');
  const eStore    = tx.objectStore(STORES.ENTITIES);
  const edStore   = tx.objectStore(STORES.EDGES);
  const sStore    = tx.objectStore(STORES.SETTINGS);

  const [entities, edges, settingsArr] = await Promise.all([
    _req(eStore.getAll()),
    _req(edStore.getAll()),
    _req(sStore.getAll()),
  ]);

  // Convert settings array to object — omit sensitive auth data
  const settings = {};
  for (const { key, value } of settingsArr) {
    // Skip auth and session — these are per-device, not portable
    if (key === 'auth' || key === 'session') continue;
    settings[key] = value;
  }

  return {
    exportedAt: new Date().toISOString(),
    appVersion: '2.0.0',
    entities,
    edges,
    settings,
  };
}

/**
 * Import data from an exported JSON object.
 * Merges by ID — does not duplicate existing records.
 * Blueprint §10.1 — importAll(data)
 * @param {{entities: Object[], edges: Object[], settings: Object}} data
 * @returns {Promise<{entitiesImported: number, edgesImported: number}>}
 */
export async function importAll(data) {
  if (!data || !Array.isArray(data.entities)) {
    throw new Error('[db] importAll: invalid data format');
  }

  const db  = await _getDB();
  const tx  = db.transaction([STORES.ENTITIES, STORES.EDGES, STORES.SETTINGS], 'readwrite');
  const eS  = tx.objectStore(STORES.ENTITIES);
  const edS = tx.objectStore(STORES.EDGES);
  const sS  = tx.objectStore(STORES.SETTINGS);

  let entitiesImported = 0;
  let edgesImported    = 0;

  // Merge entities by ID (put = upsert)
  for (const entity of data.entities || []) {
    if (!entity.id || !entity.type) continue;
    await _req(eS.put(entity));
    entitiesImported++;
  }

  // Merge edges by ID
  for (const edge of data.edges || []) {
    if (!edge.id || !edge.fromId || !edge.toId) continue;
    await _req(edS.put(edge));
    edgesImported++;
  }

  // Merge settings (skip auth/session)
  for (const [key, value] of Object.entries(data.settings || {})) {
    if (key === 'auth' || key === 'session') continue;
    await _req(sS.put({ key, value }));
  }

  await _txComplete(tx);

  console.log('[db] Import complete:', entitiesImported, 'entities,', edgesImported, 'edges');
  return { entitiesImported, edgesImported };
}

// ── Utility helpers ───────────────────────────────────────── //

/**
 * Add an ID to a dirty queue array in settings.
 * Creates the array if it doesn't exist. Deduplicates.
 * @param {IDBObjectStore} settingsStore - Open readwrite store
 * @param {string} key - 'dirtyEntities' or 'dirtyEdges'
 * @param {string} id
 */
async function _addToDirtyQueue(settingsStore, key, id) {
  const rec   = await _req(settingsStore.get(key));
  const queue = rec?.value ?? [];
  if (!queue.includes(id)) {
    queue.push(id);
    await _req(settingsStore.put({ key, value: queue }));
  }
}

/**
 * Append an entry to the audit log in settings.
 * Blueprint §9.6 — auditLog stored in settings key 'auditLog'
 * Keeps last 2000 entries (pruned on each write).
 * @param {IDBObjectStore} settingsStore
 * @param {Object} entry
 */
async function _appendAuditLog(settingsStore, entry) {
  const rec = await _req(settingsStore.get('auditLog'));
  const log = rec?.value ?? [];

  log.push({
    id:         uid(),
    action:     entry.action,
    entityType: entry.entityType || null,
    entityId:   entry.entityId   || null,
    entityTitle:entry.entityTitle|| null,
    field:      entry.field      || null,
    oldValue:   entry.oldValue   || null,
    newValue:   entry.newValue   || null,
    byAccountId:entry.byAccountId|| null,
    at:         entry.at         || new Date().toISOString(),
  });

  // Prune to last 2000 entries
  const pruned = log.length > 2000 ? log.slice(log.length - 2000) : log;
  await _req(settingsStore.put({ key: 'auditLog', value: pruned }));
}

/**
 * Wrap a transaction's oncomplete/onerror in a Promise.
 * @param {IDBTransaction} tx
 */
function _txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(new Error('Transaction aborted'));
  });
}

/**
 * Fire an app event without a hard import of events.js
 * to avoid circular dependencies at module load time.
 * Uses dynamic import cached after first call.
 */
let _eventsModule = null;
async function _fireEvent(eventName, data) {
  try {
    if (!_eventsModule) {
      _eventsModule = await import('./events.js');
    }
    _eventsModule.emit(eventName, data);
  } catch (err) {
    console.warn('[db] Could not fire event', eventName, err);
  }
}

// ── v32 Migration Support (Blueprint §11.1) ──────────────── //

/**
 * Read v32 localStorage data and return it for migration.
 * Returns null if no v32 data found.
 * @returns {Object|null}
 */
export function readV32Data() {
  try {
    const raw = localStorage.getItem('familyhub_v6');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Check if migration has already been completed.
 * @returns {Promise<boolean>}
 */
export async function isMigrationComplete() {
  const val = await getSetting('migrationComplete');
  return val === true;
}

/**
 * Mark migration as complete.
 * @returns {Promise<void>}
 */
export async function setMigrationComplete() {
  await setSetting('migrationComplete', true);
}

// ── Diagnostic helpers (development only) ────────────────── //

/**
 * Count all entities by type. Useful for debugging.
 * @returns {Promise<Object>} {typeKey: count, ...}
 */
export async function countByType() {
  const db    = await _getDB();
  const tx    = db.transaction(STORES.ENTITIES, 'readonly');
  const all   = await _req(tx.objectStore(STORES.ENTITIES).getAll());
  const counts = {};
  for (const e of all) {
    if (e.deleted) continue;
    counts[e.type] = (counts[e.type] || 0) + 1;
  }
  return counts;
}

/**
 * Get the total size approximation of the database (in bytes).
 * Uses the StorageManager API if available.
 * @returns {Promise<{used: number, quota: number}|null>}
 */
export async function getStorageUsage() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { used: usage, quota };
  } catch {
    return null;
  }
}
