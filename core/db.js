/**
 * FamilyHub v2.0 — core/db.js
 * Complete IndexedDB data layer using the idb library
 * Blueprint §2.1 (schema), §2.2 (settings keys), §10.1 (public API)
 *
 * Public API (all named exports):
 *   initDB, uid,
 *   getEntity, getEntitiesByType, queryEntities, saveEntity, deleteEntity,
 *   getEdge, getEdgesFrom, getEdgesTo, saveEdge, deleteEdge,
 *   getSetting, setSetting, getSettings,
 *   exportAll, importAll,
 *   readV32Data, isMigrationComplete, setMigrationComplete,
 *   countByType, getStorageUsage
 */

// ── idb library (UMD build loaded via dynamic import from CDN) ── //
// We load idb once and cache it. Using dynamic import keeps this file
// a standard ES module with no build step required.
const IDB_CDN = 'https://cdn.jsdelivr.net/npm/idb@8/build/umd.js';

/** @type {Promise<object>|null} — singleton idb load promise */
let _idbPromise = null;

/**
 * Load the idb library from CDN (once only).
 * Falls back gracefully to raw IndexedDB wrapper if CDN is unavailable.
 * @returns {Promise<{openDB: Function}>}
 */
async function _loadIdb() {
  if (_idbPromise) return _idbPromise;

  _idbPromise = (async () => {
    try {
      // idb UMD build attaches to globalThis.idb when loaded as a script.
      // Dynamic import of a UMD module via CDN requires a small shim:
      // we fetch the source and evaluate it using a Blob URL so it runs
      // in module scope without a <script> tag.
      if (globalThis.idb?.openDB) return globalThis.idb;

      const res  = await fetch(IDB_CDN);
      if (!res.ok) throw new Error(`idb CDN fetch failed: ${res.status}`);
      const text = await res.text();
      const blob = new Blob([text], { type: 'application/javascript' });
      const url  = URL.createObjectURL(blob);

      // Import the blob URL — UMD attaches to globalThis.idb
      await import(/* @vite-ignore */ url);
      URL.revokeObjectURL(url);

      if (globalThis.idb?.openDB) return globalThis.idb;
      throw new Error('idb did not attach to globalThis after load');

    } catch (err) {
      console.warn('[db] idb CDN load failed, using raw IDB fallback:', err.message);
      // Return a minimal openDB shim so the rest of the module works
      return { openDB: _rawOpenDB };
    }
  })();

  return _idbPromise;
}

// ── Constants ────────────────────────────────────────────── //

/** Blueprint §1.1 */
export const DB_NAME    = 'familyhub_v2';
/** Blueprint §14.3 — increment ONLY on schema changes */
export const DB_VERSION = 1;

export const STORES = Object.freeze({
  ENTITIES: 'entities',
  EDGES:    'edges',
  SETTINGS: 'settings',
});

// ── DB instance ──────────────────────────────────────────── //

/** @type {object|null} — idb DB instance */
let _db = null;

// ── Schema upgrade callback ───────────────────────────────── //

/**
 * Called by idb's openDB when the DB version is new.
 * Blueprint §2.1 — three stores, all indexes.
 */
function _upgrade(db, oldVersion, newVersion, transaction) {
  console.log(`[db] Upgrading schema v${oldVersion} → v${newVersion}`);

  // ── entities ─────────────────────────────────────────────
  if (!db.objectStoreNames.contains(STORES.ENTITIES)) {
    const es = db.createObjectStore(STORES.ENTITIES, { keyPath: 'id' });
    es.createIndex('type',      'type',      { unique: false });
    es.createIndex('createdAt', 'createdAt', { unique: false });
    es.createIndex('updatedAt', 'updatedAt', { unique: false });
    es.createIndex('createdBy', 'createdBy', { unique: false });
  }

  // ── edges ─────────────────────────────────────────────────
  if (!db.objectStoreNames.contains(STORES.EDGES)) {
    const eds = db.createObjectStore(STORES.EDGES, { keyPath: 'id' });
    eds.createIndex('fromId',          'fromId',              { unique: false });
    eds.createIndex('toId',            'toId',                { unique: false });
    eds.createIndex('relation',        'relation',            { unique: false });
    eds.createIndex('fromId_relation', ['fromId', 'relation'],{ unique: false });
    eds.createIndex('toId_relation',   ['toId',   'relation'],{ unique: false });
  }

  // ── settings ──────────────────────────────────────────────
  if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
    db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
  }
}

// ── Initialisation (Blueprint §10.1) ─────────────────────── //

/**
 * Open (or return the cached) idb database instance.
 * Must be called before any other db function.
 * @returns {Promise<object>} idb DB instance
 */
export async function initDB() {
  if (_db) return _db;

  try {
    const { openDB } = await _loadIdb();

    _db = await openDB(DB_NAME, DB_VERSION, {
      upgrade: _upgrade,
      blocked() {
        console.warn('[db] DB upgrade blocked by another tab. Please close other tabs and reload.');
      },
      blocking() {
        // Another tab wants a newer version — close our connection gracefully
        console.warn('[db] This tab is blocking a DB upgrade. Closing connection.');
        _db?.close();
        _db = null;
      },
      terminated() {
        console.warn('[db] DB connection terminated unexpectedly.');
        _db = null;
      },
    });

    console.log(`[db] IndexedDB opened: ${DB_NAME} v${DB_VERSION}`);
    return _db;

  } catch (err) {
    console.error('[db] initDB failed:', err);
    throw err;
  }
}

/**
 * Return the cached DB, opening it if needed.
 * Internal helper used by all CRUD functions.
 */
async function _getDB() {
  if (_db) return _db;
  return initDB();
}

// ── ID generation ─────────────────────────────────────────── //

/**
 * Generate a unique ID.
 * Uses crypto.randomUUID() when available; falls back to a
 * timestamp + random hex string.
 * @returns {string}
 */
export function uid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: 8-char base36 timestamp + 12-char random hex
  const ts  = Date.now().toString(36);
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(6)))
                   .map(b => b.toString(16).padStart(2, '0')).join('');
  return `${ts}-${rnd}`;
}

// ── Events helper ─────────────────────────────────────────── //

/**
 * Fire an app event via events.js.
 * Dynamic import avoids circular dependency at module load time.
 * Errors are swallowed so a missing event bus never breaks a save.
 * @param {string} name
 * @param {*} data
 */
async function _emit(name, data) {
  try {
    const { emit } = await import('./events.js');
    emit(name, data);
  } catch (err) {
    console.warn('[db] Could not emit event', name, err);
  }
}

// ── Dirty queue helper ────────────────────────────────────── //

/**
 * Append an ID to a dirty queue array in the settings store.
 * Deduplicates. Uses the provided idb transaction to stay atomic.
 * @param {object} tx     - idb transaction
 * @param {string} key    - 'dirtyEntities' | 'dirtyEdges'
 * @param {string} id
 */
async function _addToDirtyQueue(tx, key, id) {
  try {
    const rec   = await tx.objectStore(STORES.SETTINGS).get(key);
    const queue = rec?.value ?? [];
    if (!queue.includes(id)) {
      queue.push(id);
      await tx.objectStore(STORES.SETTINGS).put({ key, value: queue });
    }
  } catch (err) {
    console.error(`[db] _addToDirtyQueue(${key}) failed:`, err);
  }
}

// ── Audit log helper ──────────────────────────────────────── //

/**
 * Append one entry to the auditLog array in settings.
 * Caps at 2000 entries. Blueprint §9.6.
 * @param {object} tx
 * @param {object} entry
 */
async function _appendAuditLog(tx, entry) {
  try {
    const rec = await tx.objectStore(STORES.SETTINGS).get('auditLog');
    const log = rec?.value ?? [];
    log.push({
      id:          uid(),
      action:      entry.action      ?? null,
      entityType:  entry.entityType  ?? null,
      entityId:    entry.entityId    ?? null,
      entityTitle: entry.entityTitle ?? null,
      field:       entry.field       ?? null,
      oldValue:    entry.oldValue    ?? null,
      newValue:    entry.newValue    ?? null,
      byAccountId: entry.byAccountId ?? null,
      at:          entry.at          ?? new Date().toISOString(),
    });
    const pruned = log.length > 2000 ? log.slice(-2000) : log;
    await tx.objectStore(STORES.SETTINGS).put({ key: 'auditLog', value: pruned });
  } catch (err) {
    console.error('[db] _appendAuditLog failed:', err);
  }
}

// ════════════════════════════════════════════════════════════
// ENTITY CRUD  (Blueprint §10.1)
// ════════════════════════════════════════════════════════════

/**
 * Get a single entity by ID.
 * Returns null if not found or soft-deleted.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getEntity(id) {
  try {
    const db     = await _getDB();
    const entity = await db.get(STORES.ENTITIES, id);
    if (!entity || entity.deleted) return null;
    return entity;
  } catch (err) {
    console.error('[db] getEntity failed:', err);
    return null;
  }
}

/**
 * Get all non-deleted entities of a given type.
 * Blueprint §10.1 — getEntitiesByType(type)
 * @param {string} type
 * @returns {Promise<object[]>}
 */
export async function getEntitiesByType(type) {
  try {
    const db  = await _getDB();
    const all = await db.getAllFromIndex(STORES.ENTITIES, 'type', type);
    return all.filter(e => !e.deleted);
  } catch (err) {
    console.error('[db] getEntitiesByType failed:', err);
    return [];
  }
}

/**
 * Query entities with optional filters.
 * Blueprint §10.1 — queryEntities(filter)
 *
 * @param {object}   [filter={}]
 * @param {string}   [filter.type]             Entity type key
 * @param {string}   [filter.createdBy]         Account/member ID
 * @param {object}   [filter.dateRange]         { field, from, to } ISO strings
 * @param {boolean}  [filter.includeDeleted]    Default false
 * @returns {Promise<object[]>}
 */
export async function queryEntities(filter = {}) {
  try {
    const db = await _getDB();
    let results;

    if (filter.type) {
      // Use type index — much faster than full scan
      results = await db.getAllFromIndex(STORES.ENTITIES, 'type', filter.type);
    } else {
      results = await db.getAll(STORES.ENTITIES);
    }

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
  } catch (err) {
    console.error('[db] queryEntities failed:', err);
    return [];
  }
}

/**
 * Save (create or update) an entity.
 * - Generates id if missing
 * - Sets createdAt (new) and updatedAt (always)
 * - Adds id to dirtyEntities queue
 * - Fires 'entity:saved' event
 * Blueprint §10.1 — saveEntity(entity)
 *
 * @param {object} entity        Must have .type
 * @param {string} [byAccountId]
 * @returns {Promise<object>} The saved entity
 */
export async function saveEntity(entity, byAccountId) {
  try {
    if (!entity?.type) throw new Error('saveEntity: entity.type is required');

    const now   = new Date().toISOString();
    const isNew = !entity.id;
    const saved = {
      ...entity,
      id:        entity.id || uid(),
      createdAt: entity.createdAt || now,
      updatedAt: now,
      createdBy: entity.createdBy || byAccountId || null,
    };

    const db = await _getDB();
    const tx = db.transaction([STORES.ENTITIES, STORES.SETTINGS], 'readwrite');

    await tx.objectStore(STORES.ENTITIES).put(saved);
    await _addToDirtyQueue(tx, 'dirtyEntities', saved.id);
    await _appendAuditLog(tx, {
      action:      isNew ? 'create' : 'update',
      entityType:  saved.type,
      entityId:    saved.id,
      entityTitle: saved.title || saved.name || (saved.body ? saved.body.slice(0,60) : null) || saved.id,
      byAccountId,
      at:          now,
    });

    await tx.done;

    await _emit('entity:saved', { entity: saved, isNew });
    return saved;

  } catch (err) {
    console.error('[db] saveEntity failed:', err);
    throw err;
  }
}

/**
 * Soft-delete an entity.
 * Sets deleted:true, removes all edges from/to this entity.
 * Fires 'entity:deleted' event.
 * Blueprint §10.1 — deleteEntity(id)
 *
 * @param {string} id
 * @param {string} [byAccountId]
 * @returns {Promise<void>}
 */
export async function deleteEntity(id, byAccountId) {
  try {
    const db = await _getDB();

    // Read current entity for audit log title
    const entity = await db.get(STORES.ENTITIES, id);
    if (!entity) return;

    const now = new Date().toISOString();
    const tx  = db.transaction([STORES.ENTITIES, STORES.EDGES, STORES.SETTINGS], 'readwrite');

    // Soft delete
    await tx.objectStore(STORES.ENTITIES).put({
      ...entity,
      deleted:   true,
      updatedAt: now,
    });

    // Remove all edges where this entity is fromId or toId
    const fromEdges = await tx.objectStore(STORES.EDGES).index('fromId').getAll(id);
    const toEdges   = await tx.objectStore(STORES.EDGES).index('toId').getAll(id);
    for (const edge of [...fromEdges, ...toEdges]) {
      await tx.objectStore(STORES.EDGES).delete(edge.id);
    }

    await _addToDirtyQueue(tx, 'dirtyEntities', id);
    await _appendAuditLog(tx, {
      action:      'delete',
      entityType:  entity.type,
      entityId:    id,
      entityTitle: entity.title || entity.name || (entity.body ? entity.body.slice(0,60) : null) || id,
      byAccountId,
      at:          now,
    });

    await tx.done;

    await _emit('entity:deleted', { id, entityType: entity.type });

  } catch (err) {
    console.error('[db] deleteEntity failed:', err);
    throw err;
  }
}

// ════════════════════════════════════════════════════════════
// EDGE CRUD  (Blueprint §10.1)
// ════════════════════════════════════════════════════════════

/**
 * Get a single edge by ID.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getEdge(id) {
  try {
    const db = await _getDB();
    return await db.get(STORES.EDGES, id) ?? null;
  } catch (err) {
    console.error('[db] getEdge failed:', err);
    return null;
  }
}

/**
 * Get all edges FROM a given entity, optionally filtered by relation.
 * Blueprint §10.1 — getEdgesFrom(entityId, relation?)
 * @param {string} entityId
 * @param {string} [relation]
 * @returns {Promise<object[]>}
 */
export async function getEdgesFrom(entityId, relation) {
  try {
    const db = await _getDB();
    if (relation) {
      return await db.getAllFromIndex(STORES.EDGES, 'fromId_relation', [entityId, relation]);
    }
    return await db.getAllFromIndex(STORES.EDGES, 'fromId', entityId);
  } catch (err) {
    console.error('[db] getEdgesFrom failed:', err);
    return [];
  }
}

/**
 * Get all edges TO a given entity, optionally filtered by relation.
 * Blueprint §10.1 — getEdgesTo(entityId, relation?)
 * @param {string} entityId
 * @param {string} [relation]
 * @returns {Promise<object[]>}
 */
export async function getEdgesTo(entityId, relation) {
  try {
    const db = await _getDB();
    if (relation) {
      return await db.getAllFromIndex(STORES.EDGES, 'toId_relation', [entityId, relation]);
    }
    return await db.getAllFromIndex(STORES.EDGES, 'toId', entityId);
  } catch (err) {
    console.error('[db] getEdgesTo failed:', err);
    return [];
  }
}

/**
 * Save (create or update) an edge.
 * - Adds id to dirtyEdges queue
 * - Fires 'edge:saved' event
 * Blueprint §10.1 — saveEdge(edge)
 *
 * @param {object} edge   Must have fromId, toId, relation
 * @param {string} [byAccountId]
 * @returns {Promise<object>} The saved edge
 */
export async function saveEdge(edge, byAccountId) {
  try {
    if (!edge?.fromId || !edge?.toId || !edge?.relation) {
      throw new Error('saveEdge: fromId, toId, and relation are required');
    }

    const now   = new Date().toISOString();
    const saved = {
      ...edge,
      id:        edge.id || uid(),
      createdAt: edge.createdAt || now,
      createdBy: edge.createdBy || byAccountId || null,
    };

    const db = await _getDB();
    const tx = db.transaction([STORES.EDGES, STORES.SETTINGS], 'readwrite');

    await tx.objectStore(STORES.EDGES).put(saved);
    await _addToDirtyQueue(tx, 'dirtyEdges', saved.id);
    // Fetch fromEntity title for audit log readability
    let _linkTitle = null;
    try {
      const _fe = await db.get(STORES.ENTITIES, saved.fromId);
      if (_fe) _linkTitle = _fe.title || _fe.name || (_fe.body ? _fe.body.slice(0,60) : null) || saved.fromId;
    } catch {}

    await _appendAuditLog(tx, {
      action:      'link',
      entityType:  saved.fromType  || null,
      entityId:    saved.fromId,
      entityTitle: _linkTitle,
      field:       saved.relation,
      newValue:    saved.toId,
      byAccountId,
      at:          now,
    });

    await tx.done;

    await _emit('edge:saved', { edge: saved });
    return saved;

  } catch (err) {
    console.error('[db] saveEdge failed:', err);
    throw err;
  }
}

/**
 * Delete an edge by ID.
 * Fires 'edge:deleted' event.
 * Blueprint §10.1 — deleteEdge(id)
 * @param {string} id
 * @param {string} [byAccountId]
 * @returns {Promise<void>}
 */
export async function deleteEdge(id, byAccountId) {
  try {
    const db   = await _getDB();
    const edge = await db.get(STORES.EDGES, id);
    if (!edge) return;

    const now = new Date().toISOString();
    const tx  = db.transaction([STORES.EDGES, STORES.SETTINGS], 'readwrite');

    await tx.objectStore(STORES.EDGES).delete(id);
    // Fetch fromEntity title for audit log readability
    let _ulTitle = null;
    try {
      const _ufe = await db.get(STORES.ENTITIES, edge.fromId);
      if (_ufe) _ulTitle = _ufe.title || _ufe.name || (_ufe.body ? _ufe.body.slice(0,60) : null) || edge.fromId;
    } catch {}

    await _appendAuditLog(tx, {
      action:      'unlink',
      entityType:  edge.fromType || null,
      entityId:    edge.fromId,
      entityTitle: _ulTitle,
      field:       edge.relation,
      oldValue:    edge.toId,
      byAccountId,
      at:          now,
    });

    await tx.done;

    await _emit('edge:deleted', { id, edge });

  } catch (err) {
    console.error('[db] deleteEdge failed:', err);
    throw err;
  }
}

// ════════════════════════════════════════════════════════════
// SETTINGS  (Blueprint §10.1)
// ════════════════════════════════════════════════════════════

/**
 * Get a value from the settings store.
 * Returns undefined if key doesn't exist.
 * @param {string} key
 * @returns {Promise<*>}
 */
export async function getSetting(key) {
  try {
    const db  = await _getDB();
    const rec = await db.get(STORES.SETTINGS, key);
    return rec?.value;
  } catch (err) {
    console.error(`[db] getSetting(${key}) failed:`, err);
    return undefined;
  }
}

/**
 * Save a value to the settings store.
 * @param {string} key
 * @param {*} value
 * @returns {Promise<void>}
 */
export async function setSetting(key, value) {
  try {
    const db = await _getDB();
    await db.put(STORES.SETTINGS, { key, value });
  } catch (err) {
    console.error(`[db] setSetting(${key}) failed:`, err);
    throw err;
  }
}

/**
 * Get multiple settings at once.
 * @param {string[]} keys
 * @returns {Promise<object>} { key: value, ... }
 */
export async function getSettings(keys) {
  try {
    const db     = await _getDB();
    const tx     = db.transaction(STORES.SETTINGS, 'readonly');
    const result = {};
    await Promise.all(keys.map(async key => {
      const rec     = await tx.objectStore(STORES.SETTINGS).get(key);
      result[key]   = rec?.value;
    }));
    await tx.done;
    return result;
  } catch (err) {
    console.error('[db] getSettings failed:', err);
    return {};
  }
}

// ════════════════════════════════════════════════════════════
// EXPORT / IMPORT  (Blueprint §10.1)
// ════════════════════════════════════════════════════════════

/**
 * Export all data as a JSON-serialisable object.
 * Strips auth and session from the settings export (per-device, not portable).
 * Blueprint §10.1 — exportAll()
 * @returns {Promise<{entities: object[], edges: object[], settings: object}>}
 */
export async function exportAll() {
  try {
    const db = await _getDB();

    const [entities, edges, settingsArr] = await Promise.all([
      db.getAll(STORES.ENTITIES),
      db.getAll(STORES.EDGES),
      db.getAll(STORES.SETTINGS),
    ]);

    const settings = {};
    for (const { key, value } of settingsArr) {
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

  } catch (err) {
    console.error('[db] exportAll failed:', err);
    throw err;
  }
}

/**
 * Import data from an exported JSON object.
 * Merges by ID — does not duplicate existing records.
 * Blueprint §10.1 — importAll(data)
 *
 * @param {{entities: object[], edges: object[], settings: object}} data
 * @returns {Promise<{entitiesImported: number, edgesImported: number}>}
 */
export async function importAll(data) {
  try {
    if (!data || !Array.isArray(data.entities)) {
      throw new Error('importAll: invalid data format — expected { entities[], edges[], settings{} }');
    }

    const db = await _getDB();
    const tx = db.transaction([STORES.ENTITIES, STORES.EDGES, STORES.SETTINGS], 'readwrite');

    let entitiesImported = 0;
    let edgesImported    = 0;

    for (const entity of data.entities ?? []) {
      if (!entity.id || !entity.type) continue;
      await tx.objectStore(STORES.ENTITIES).put(entity);
      entitiesImported++;
    }

    for (const edge of data.edges ?? []) {
      if (!edge.id || !edge.fromId || !edge.toId) continue;
      await tx.objectStore(STORES.EDGES).put(edge);
      edgesImported++;
    }

    for (const [key, value] of Object.entries(data.settings ?? {})) {
      if (key === 'auth' || key === 'session') continue;
      await tx.objectStore(STORES.SETTINGS).put({ key, value });
    }

    await tx.done;

    console.log(`[db] Import complete: ${entitiesImported} entities, ${edgesImported} edges`);
    return { entitiesImported, edgesImported };

  } catch (err) {
    console.error('[db] importAll failed:', err);
    throw err;
  }
}

// ════════════════════════════════════════════════════════════
// v32 MIGRATION SUPPORT  (Blueprint §11.1)
// ════════════════════════════════════════════════════════════

/**
 * Read v32 localStorage data. Returns null if not found.
 * @returns {object|null}
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
 * Check whether v32 → v2.0 migration has already run.
 * @returns {Promise<boolean>}
 */
export async function isMigrationComplete() {
  return (await getSetting('migrationComplete')) === true;
}

/**
 * Mark migration as complete.
 * @returns {Promise<void>}
 */
export async function setMigrationComplete() {
  await setSetting('migrationComplete', true);
}

// ════════════════════════════════════════════════════════════
// DIAGNOSTICS
// ════════════════════════════════════════════════════════════

/**
 * Count all non-deleted entities grouped by type.
 * @returns {Promise<object>} { typeKey: count }
 */
export async function countByType() {
  try {
    const db    = await _getDB();
    const all   = await db.getAll(STORES.ENTITIES);
    const counts = {};
    for (const e of all) {
      if (e.deleted) continue;
      counts[e.type] = (counts[e.type] || 0) + 1;
    }
    return counts;
  } catch (err) {
    console.error('[db] countByType failed:', err);
    return {};
  }
}

/**
 * Return storage usage estimate via StorageManager API.
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

// ════════════════════════════════════════════════════════════
// RAW IDB FALLBACK
// Used when the idb CDN is unreachable (e.g. full offline first load).
// Implements the same openDB interface that idb exposes.
// ════════════════════════════════════════════════════════════

/**
 * Minimal openDB shim matching the idb API surface used above.
 * Supports: db.get, db.getAll, db.getAllFromIndex, db.put,
 *           db.transaction → objectStore → {get, getAll, put, delete, index}
 *           tx.done
 * @param {string} name
 * @param {number} version
 * @param {object} callbacks  { upgrade, blocked, blocking, terminated }
 * @returns {Promise<object>}
 */
function _rawOpenDB(name, version, callbacks = {}) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);

    req.onerror   = () => reject(req.error);
    req.onblocked = () => callbacks.blocked?.();

    req.onupgradeneeded = (event) => {
      callbacks.upgrade?.(
        req.result,
        event.oldVersion,
        event.newVersion,
        req.transaction
      );
    };

    req.onsuccess = () => {
      const idbDB = req.result;

      idbDB.onclose       = () => callbacks.terminated?.();
      idbDB.onversionchange = () => {
        callbacks.blocking?.();
        idbDB.close();
      };

      // Wrap idbDB in the idb-compatible API
      resolve(_wrapDB(idbDB));
    };
  });
}

/** Wrap a raw IDBDatabase so it looks like an idb DB object. */
function _wrapDB(idbDB) {
  const wrap = {
    close: () => idbDB.close(),

    get: (store, key) => _idbReq(idbDB
      .transaction(store, 'readonly')
      .objectStore(store)
      .get(key)),

    getAll: (store, query) => _idbReq(idbDB
      .transaction(store, 'readonly')
      .objectStore(store)
      .getAll(query)),

    getAllFromIndex: (store, indexName, query) => _idbReq(idbDB
      .transaction(store, 'readonly')
      .objectStore(store)
      .index(indexName)
      .getAll(query)),

    put: (store, value) => _idbReq(idbDB
      .transaction(store, 'readwrite')
      .objectStore(store)
      .put(value)),

    delete: (store, key) => _idbReq(idbDB
      .transaction(store, 'readwrite')
      .objectStore(store)
      .delete(key)),

    transaction: (stores, mode) => {
      const tx    = idbDB.transaction(stores, mode);
      const txWrap = {
        done: new Promise((res, rej) => {
          tx.oncomplete = () => res();
          tx.onerror    = () => rej(tx.error);
          tx.onabort    = () => rej(new Error('Transaction aborted'));
        }),
        objectStore: (name) => {
          const store = tx.objectStore(name);
          return {
            put:    (value) => _idbReq(store.put(value)),
            get:    (key)   => _idbReq(store.get(key)),
            getAll: (query) => _idbReq(store.getAll(query)),
            delete: (key)   => _idbReq(store.delete(key)),
            index:  (idx)   => ({
              getAll: (query) => _idbReq(store.index(idx).getAll(query)),
              get:    (query) => _idbReq(store.index(idx).get(query)),
            }),
          };
        },
      };
      return txWrap;
    },
  };
  return wrap;
}

/** Promisify a raw IDBRequest. */
function _idbReq(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}
