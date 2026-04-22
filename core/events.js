/**
 * FamilyHub v2.0 — core/events.js
 * App-wide pub/sub event bus (Blueprint §10.3)
 *
 * Usage:
 *   import { on, off, emit } from './events.js';
 *   on('entity:saved', handler);
 *   emit('entity:saved', { id: '...', type: 'task' });
 *   off('entity:saved', handler);
 */

/** @type {Map<string, Set<Function>>} */
const _listeners = new Map();

/**
 * Subscribe to an event.
 * @param {string} event
 * @param {Function} handler
 * @returns {Function} Unsubscribe function
 */
export function on(event, handler) {
  if (typeof handler !== 'function') {
    throw new TypeError(`[events] handler for "${event}" must be a function`);
  }
  if (!_listeners.has(event)) {
    _listeners.set(event, new Set());
  }
  _listeners.get(event).add(handler);

  // Return unsubscribe function for convenience
  return () => off(event, handler);
}

/**
 * Subscribe to an event once — auto-unsubscribes after first call.
 * @param {string} event
 * @param {Function} handler
 * @returns {Function} Unsubscribe function
 */
export function once(event, handler) {
  const wrapper = (data) => {
    handler(data);
    off(event, wrapper);
  };
  return on(event, wrapper);
}

/**
 * Unsubscribe from an event.
 * @param {string} event
 * @param {Function} handler
 */
export function off(event, handler) {
  const set = _listeners.get(event);
  if (set) {
    set.delete(handler);
    if (set.size === 0) {
      _listeners.delete(event);
    }
  }
}

/**
 * Emit an event with optional data payload.
 * All handlers are called synchronously in subscription order.
 * Errors in handlers are caught and logged — one bad handler won't
 * block the others.
 * @param {string} event
 * @param {*} [data]
 */
export function emit(event, data) {
  const set = _listeners.get(event);
  if (!set || set.size === 0) return;

  for (const handler of set) {
    try {
      handler(data);
    } catch (err) {
      console.error(`[events] Error in handler for "${event}":`, err);
    }
  }
}

/**
 * Remove all listeners for a given event, or all events if none specified.
 * @param {string} [event]
 */
export function clear(event) {
  if (event) {
    _listeners.delete(event);
  } else {
    _listeners.clear();
  }
}

/**
 * Return the number of active listeners for a given event.
 * Useful for debugging.
 * @param {string} event
 * @returns {number}
 */
export function listenerCount(event) {
  return _listeners.get(event)?.size ?? 0;
}

// ── Catalogue of all application events (Blueprint §10.3) ──
// Imported by other modules for consistency — avoids magic strings.

/** @readonly */
export const EVENTS = Object.freeze({
  // Entity lifecycle
  ENTITY_SAVED:       'entity:saved',
  ENTITY_DELETED:     'entity:deleted',

  // Edge lifecycle
  EDGE_SAVED:         'edge:saved',
  EDGE_DELETED:       'edge:deleted',

  // Navigation
  VIEW_CHANGED:       'view:changed',

  // Entity panel
  PANEL_OPENED:       'panel:opened',
  PANEL_CLOSED:       'panel:closed',

  // Notion sync
  SYNC_TRIGGER:       'sync:trigger',
  SYNC_STARTED:       'sync:started',
  SYNC_COMPLETE:      'sync:complete',
  SYNC_ERROR:         'sync:error',

  // Auth
  AUTH_LOGIN:         'auth:login',
  AUTH_LOGOUT:        'auth:logout',

  // Theme
  THEME_CHANGED:      'theme:changed',

  // Entity type management
  TYPE_CREATED:       'type:created',
  TYPE_FIELD_ADDED:   'type:fieldAdded',
  TYPE_FIELD_REMOVED: 'type:fieldRemoved',

  // FAB / quick-create
  FAB_CREATE:         'fab:create',
});
