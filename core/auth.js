/**
 * FamilyHub v2.0 — core/auth.js
 * PBKDF2 authentication, sessions, permissions, invite codes, audit log
 * Blueprint §3.1 – §3.5
 *
 * Public API (all named exports):
 *   initAuth()                              — Resume session or show auth screen
 *   isFirstRun()                            — true if no accounts exist yet
 *   doFirstRun(familyName, displayName, username, password) — Create family + admin
 *   doLogin(username, password)             — Attempt login → {ok, error?}
 *   doLogout()                              — Clear session, broadcast, reload
 *   getSession()                            — Current session object or null
 *   isLoggedIn()                            — Boolean shorthand
 *   getAccount()                            — Current account object or null
 *   hasPermission(section, operation)       — Permission check (admin = always true)
 *   generateInvite(role, createdBy)         — Create XXXX-XXXX invite code
 *   redeemInvite(code, username, password)  — Join via invite code
 *   revokeInvite(code)                      — Delete an invite code
 *   resetIdle()                             — Manually reset session idle timer
 *   addAuditEntry(action, entityType, entityId, entityTitle, details)
 *
 * Also exported (convenience for settings/admin views):
 *   getInviteCodes()                        — All invite codes (admin only)
 *   getAllAccounts()                         — All accounts sans passHash (admin only)
 *   updateAccount(changes)                  — Update current user's profile/password
 *   hasPerm(section, op)                    — Alias for hasPermission
 */

'use strict';

import {
  getSetting, setSetting, uid
} from './db.js';
import { emit, EVENTS } from './events.js';

// ── Constants (Blueprint §3.1) ────────────────────────────── //

const PBKDF2_ITERATIONS  = 100_000;
const PBKDF2_HASH        = 'SHA-256';
const PBKDF2_KEYLEN      = 256;           // bits
const SALT_BYTES          = 16;
const SESSION_TTL_MS      = 30 * 60 * 1000;   // 30 minutes
const SESSION_SID_BYTES   = 32;
const MAX_LOGIN_ATTEMPTS  = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;   // 15 minutes
const INVITE_EXPIRY_DAYS  = 7;
const IDLE_DEBOUNCE_MS    = 5_000;
const AUDIT_MAX_ENTRIES   = 5_000;        // cap to prevent unbounded growth

/** Default admin account — created on first run only (Blueprint §3.1) */
const DEFAULT_ADMIN_USERNAME = 'dot';
const DEFAULT_ADMIN_PASSWORD = 'retracy';
const DEFAULT_ADMIN_DISPLAY  = 'Dot';
const DEFAULT_FAMILY_NAME    = 'My Family';

/** BroadcastChannel name (Blueprint §3.1) */
const AUTH_CHANNEL = 'familyhub-auth';

/** All 16 permission sections (Blueprint §3.4) */
const PERM_SECTIONS = Object.freeze([
  'daily', 'kanban', 'calendar', 'familyWall', 'familyMatters',
  'notes', 'projects', 'budget', 'recipes', 'documents',
  'contacts', 'gallery', 'graph', 'settings', 'entityTypes', 'members'
]);

/** 4 CRUD-style operations per section */
const PERM_OPS = Object.freeze(['view', 'add', 'edit', 'delete']);

// ── Module state ─────────────────────────────────────────── //

/** @type {Object|null} — current authenticated account */
let _account = null;

/** @type {Object|null} — current session */
let _session = null;

/** @type {BroadcastChannel|null} */
let _channel = null;

/** @type {number|null} — session-expiry polling interval */
let _expiryPollTimer = null;

/** @type {number|null} — activity debounce timer */
let _activityDebounce = null;

/** @type {Array<{evt:string,handler:Function}>} — stored refs for cleanup */
let _activityHandlers = [];


// ══════════════════════════════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════════════════════════════

// ── Initialisation (Blueprint §3.5) ──────────────────────── //

/**
 * Called by index.html after DB is ready.
 * 1. Opens BroadcastChannel for cross-tab logout
 * 2. Attempts to resume an existing valid session
 * 3. Falls through to first-run or login screen
 */
export async function initAuth() {
  // 1. BroadcastChannel for cross-tab logout
  _setupBroadcastChannel();

  // 2. Try to resume session
  const savedSession = _getSessionStorageSession();
  if (savedSession) {
    const dbSession = await getSetting('session');
    const auth = await getSetting('auth');

    // Both sessionStorage and IndexedDB must agree, and session must not be expired
    if (dbSession && _isSessionValid(savedSession, dbSession, auth)) {
      const account = _findAccount(auth, savedSession.accountId);
      if (account) {
        _account = account;
        _session = savedSession;
        _startIdleTimer();
        _showApp(auth);
        return;
      }
    }
  }

  // 3. No valid session — check if first run or returning user
  const auth = await getSetting('auth');
  if (!auth?.accounts?.length) {
    // Genuine first run: no accounts exist — show setup form so the family
    // can choose their own name, username and password.
    // (The default-admin seed path is removed; doFirstRun() creates the account.)
    _showFirstRunForm();
  } else {
    _showLoginForm();
  }

  // Wire form event handlers (submit buttons, enter keys, tabs)
  _wireAuthForms();
}


// ── First-run check ──────────────────────────────────────── //

/**
 * Returns true if no accounts exist yet (DB has no auth record,
 * or auth.accounts is empty). Useful for external callers that
 * need to know before initAuth() runs.
 * @returns {Promise<boolean>}
 */
export async function isFirstRun() {
  const auth = await getSetting('auth');
  return !auth?.accounts?.length;
}


// ── First Run Setup (Blueprint §3.5) ────────────────────── //

/**
 * Create the family and the initial admin account.
 * Called only when no accounts exist.
 *
 * @param {string} familyName
 * @param {string} displayName
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function doFirstRun(familyName, displayName, username, password) {
  // ── Input validation ──
  if (!familyName?.trim())  return { ok: false, error: 'Family name is required.' };
  if (!displayName?.trim()) return { ok: false, error: 'Display name is required.' };
  if (!username?.trim())    return { ok: false, error: 'Username is required.' };
  if (!password)            return { ok: false, error: 'Password is required.' };
  if (password.length < 8)  return { ok: false, error: 'Password must be at least 8 characters.' };
  if (!/^[a-z0-9_.\-]+$/i.test(username.trim())) {
    return { ok: false, error: 'Username may only contain letters, numbers, dots, dashes, underscores.' };
  }

  // ── Guard: ensure truly first run ──
  const existing = await getSetting('auth');
  if (existing?.accounts?.length) {
    return { ok: false, error: 'FamilyHub is already set up.' };
  }

  const passHash  = await _hashPass(password);
  const memberId  = uid();
  const accountId = uid();
  const now       = new Date().toISOString();

  // Create person entity for the admin (lazy import to avoid circular deps)
  const { saveEntity } = await import('./db.js');
  await saveEntity({
    id:        memberId,
    type:      'person',
    title:     displayName.trim(),
    name:      displayName.trim(),
    role:      'admin',
    createdAt: now,
    updatedAt: now,
  }, accountId);

  // Build auth structure
  const auth = {
    accounts: [{
      id:            accountId,
      username:      username.trim().toLowerCase(),
      passHash,
      memberId,
      role:          'admin',
      perms:         _allPermsTrue(),
      email:         null,
      createdAt:     now,
      lastLogin:     now,
      loginAttempts: 0,
      lockedUntil:   null,
    }],
    invites:  [],
    auditLog: [],
  };

  await setSetting('auth', auth);
  await setSetting('familyName', familyName.trim());
  await setSetting('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  await setSetting('theme', 'light');
  await setSetting('appVersion', '2.0.0');

  // Log the first audit entry
  await _writeAuditEntry(auth, 'FIRST_RUN', 'family', null, familyName.trim(), {
    admin: username.trim().toLowerCase(),
  }, accountId);

  // Create session and show app
  await _createSession(auth.accounts[0]);
  _startIdleTimer();
  _showApp(auth);

  emit(EVENTS.AUTH_LOGIN, { accountId });
  return { ok: true };
}


// ── Login (Blueprint §3.5) ───────────────────────────────── //

/**
 * Attempt to log in with username (or email) and password.
 * Enforces brute-force lockout: 5 failed attempts → 15 min lock.
 *
 * @param {string} usernameOrEmail
 * @param {string} password
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function doLogin(usernameOrEmail, password) {
  if (!usernameOrEmail || !password) {
    return { ok: false, error: 'Please enter your username and password.' };
  }

  const auth = await getSetting('auth');
  if (!auth?.accounts?.length) {
    return { ok: false, error: 'No accounts found. Please set up FamilyHub first.' };
  }

  // Find account by username or email (case-insensitive)
  const needle = usernameOrEmail.trim().toLowerCase();
  const account = auth.accounts.find(a =>
    a.username === needle ||
    (a.email && a.email.toLowerCase() === needle)
  );

  if (!account) {
    // Deliberately vague to avoid username enumeration
    return { ok: false, error: 'Username or password is incorrect.' };
  }

  // ── Check brute-force lockout ──
  if (account.lockedUntil && Date.now() < account.lockedUntil) {
    const remaining = Math.ceil((account.lockedUntil - Date.now()) / 60_000);
    return {
      ok: false,
      error: `Account locked. Try again in ${remaining} minute${remaining !== 1 ? 's' : ''}.`
    };
  }

  // ── Verify password (PBKDF2) ──
  const valid = await _verifyPass(password, account.passHash);

  if (!valid) {
    account.loginAttempts = (account.loginAttempts || 0) + 1;

    if (account.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
      account.lockedUntil   = Date.now() + LOCKOUT_DURATION_MS;
      account.loginAttempts = 0;           // reset counter on lock
      await setSetting('auth', auth);

      await _writeAuditEntry(auth, 'ACCOUNT_LOCKED', 'account', account.id, account.username, {
        reason: 'Too many failed login attempts',
      }, account.id);

      return { ok: false, error: 'Too many attempts. Account locked for 15 minutes.' };
    }

    await setSetting('auth', auth);
    const remaining = MAX_LOGIN_ATTEMPTS - account.loginAttempts;
    return {
      ok: false,
      error: `Incorrect password. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
    };
  }

  // ── Success ──
  account.loginAttempts = 0;
  account.lockedUntil   = null;
  account.lastLogin     = new Date().toISOString();
  await setSetting('auth', auth);

  await _createSession(account);
  _startIdleTimer();
  _showApp(auth);

  await _writeAuditEntry(auth, 'LOGIN', 'account', account.id, account.username, null, account.id);

  emit(EVENTS.AUTH_LOGIN, { accountId: account.id });
  return { ok: true };
}


// ── Logout (Blueprint §3.5) ─────────────────────────────── //

/**
 * Log out: clear session locally, broadcast to all tabs, reload.
 */
export async function doLogout() {
  const accountId = _account?.id;
  const username  = _account?.username;

  // Write audit entry before clearing state
  if (_account) {
    const auth = await getSetting('auth');
    if (auth) {
      await _writeAuditEntry(auth, 'LOGOUT', 'account', accountId, username, null, accountId);
    }
  }

  _clearLocalSession();

  // Broadcast to other tabs
  try { _channel?.postMessage({ type: 'LOGOUT' }); } catch { /* channel may be closed */ }

  emit(EVENTS.AUTH_LOGOUT);

  // Reload to show auth screen cleanly
  window.location.reload();
}


// ── Session accessors ────────────────────────────────────── //

/**
 * Returns the current session object or null.
 * @returns {Object|null}
 */
export function getSession() { return _session; }

/**
 * Returns true if a valid session is active.
 * @returns {boolean}
 */
export function isLoggedIn() {
  return _session !== null && _account !== null;
}

/**
 * Returns the current account object or null.
 * @returns {Object|null}
 */
export function getAccount() { return _account; }


// ── Permissions (Blueprint §3.4) ─────────────────────────── //

/**
 * Check if the current user has permission for [section].[operation].
 * Admin role bypasses all checks — always returns true.
 *
 * @param {string} section  - e.g. 'kanban', 'budget', 'members'
 * @param {'view'|'add'|'edit'|'delete'} operation
 * @returns {boolean}
 */
export function hasPermission(section, operation) {
  if (!_account) return false;
  if (_account.role === 'admin') return true;
  return _account.perms?.[section]?.[operation] === true;
}

/** Alias — shorter name used in templates / quick checks */
export const hasPerm = hasPermission;


// ── Invite Codes (Blueprint §3.1) ────────────────────────── //

/**
 * Generate an 8-character invite code in XXXX-XXXX format.
 * Uses crypto.getRandomValues for unguessable codes.
 * Characters exclude ambiguous glyphs (I, O, 1, 0).
 *
 * @param {string} [role='member'] — role the invitee will receive
 * @param {string} [createdBy]     — accountId of creator (defaults to current)
 * @returns {Promise<{ok: boolean, code?: string, error?: string}>}
 */
export async function generateInvite(role = 'member', createdBy) {
  const creatorId = createdBy || _account?.id;
  if (!creatorId) return { ok: false, error: 'Not logged in.' };

  // Only admins and parents can generate invites
  if (_account && _account.role !== 'admin' && _account.role !== 'parent') {
    return { ok: false, error: 'You do not have permission to generate invite codes.' };
  }

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand  = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)))
                             .map(b => chars[b % chars.length]).join('');

  const code      = rand(4) + '-' + rand(4);
  const expiresAt = Date.now() + (INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const auth = await getSetting('auth');
  if (!auth) return { ok: false, error: 'Auth data not found.' };

  auth.invites = auth.invites || [];
  auth.invites.push({
    code,
    role,
    perms:     _defaultPerms(role),
    createdBy: creatorId,
    createdAt: new Date().toISOString(),
    expiresAt,
    usedAt:    null,
    usedBy:    null,
  });

  await setSetting('auth', auth);

  await _writeAuditEntry(auth, 'INVITE_CREATED', 'invite', code, code, {
    role, expiresAt: new Date(expiresAt).toISOString(),
  }, creatorId);

  return { ok: true, code };
}

/**
 * Join FamilyHub using an invite code.
 * Creates a new account and person entity.
 *
 * @param {string} code     — XXXX-XXXX invite code
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function redeemInvite(code, username, password) {
  if (!code?.trim())     return { ok: false, error: 'Invite code is required.' };
  if (!username?.trim()) return { ok: false, error: 'Username is required.' };
  if (!password)         return { ok: false, error: 'Password is required.' };
  if (password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  if (!/^[a-z0-9_.\-]+$/i.test(username.trim())) {
    return { ok: false, error: 'Username may only contain letters, numbers, dots, dashes, underscores.' };
  }

  const auth = await getSetting('auth');
  if (!auth) return { ok: false, error: 'No FamilyHub data found. Contact your admin.' };

  const normalised = code.trim().toUpperCase();
  const invite = auth.invites?.find(i => i.code === normalised);

  if (!invite)       return { ok: false, error: 'Invalid invite code.' };
  if (invite.usedAt) return { ok: false, error: 'This invite code has already been used.' };
  if (Date.now() > invite.expiresAt) return { ok: false, error: 'This invite code has expired.' };

  // Ensure username isn't taken
  const taken = auth.accounts.some(
    a => a.username === username.trim().toLowerCase()
  );
  if (taken) return { ok: false, error: 'That username is already taken.' };

  const passHash  = await _hashPass(password);
  const memberId  = uid();
  const accountId = uid();
  const now       = new Date().toISOString();
  const role      = invite.role || 'member';

  // Create person entity
  const { saveEntity } = await import('./db.js');
  await saveEntity({
    id:        memberId,
    type:      'person',
    title:     username.trim(),
    name:      username.trim(),
    role,
    createdAt: now,
    updatedAt: now,
  }, accountId);

  // Create account
  const newAccount = {
    id:            accountId,
    username:      username.trim().toLowerCase(),
    passHash,
    memberId,
    role,
    perms:         invite.perms || _defaultPerms(role),
    email:         null,
    createdAt:     now,
    lastLogin:     now,
    loginAttempts: 0,
    lockedUntil:   null,
  };

  auth.accounts.push(newAccount);

  // Mark invite as used
  invite.usedAt = now;
  invite.usedBy = accountId;

  await setSetting('auth', auth);

  await _writeAuditEntry(auth, 'INVITE_REDEEMED', 'account', accountId, username.trim(), {
    inviteCode: normalised, role,
  }, accountId);

  // Log them in immediately
  await _createSession(newAccount);
  _startIdleTimer();
  _showApp(auth);

  emit(EVENTS.AUTH_LOGIN, { accountId });
  return { ok: true };
}

/**
 * Revoke (delete) an invite code. Admin only.
 * @param {string} code
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function revokeInvite(code) {
  if (_account?.role !== 'admin') {
    return { ok: false, error: 'Only admins can revoke invite codes.' };
  }

  const auth = await getSetting('auth');
  if (!auth) return { ok: false, error: 'Auth data not found.' };

  const before = auth.invites?.length || 0;
  auth.invites = (auth.invites || []).filter(i => i.code !== code);
  const removed = before - (auth.invites.length || 0);

  if (removed === 0) return { ok: false, error: 'Invite code not found.' };

  await setSetting('auth', auth);

  await _writeAuditEntry(auth, 'INVITE_REVOKED', 'invite', code, code, null, _account.id);

  return { ok: true };
}


// ── Idle / activity reset ────────────────────────────────── //

/**
 * Manually reset the session idle timer.
 * This is also called automatically by the activity listeners
 * (click, keydown, scroll, touchstart) that are wired on DOMContentLoaded.
 */
export function resetIdle() {
  if (!_session) return;

  clearTimeout(_activityDebounce);
  _activityDebounce = setTimeout(() => {
    if (!_session) return;
    _session.expiresAt = Date.now() + SESSION_TTL_MS;
    sessionStorage.setItem('fh_session', JSON.stringify(_session));
    setSetting('session', _session).catch(() => {});
  }, IDLE_DEBOUNCE_MS);
}


// ── Audit log (Blueprint §3.5) ───────────────────────────── //

/**
 * Append an entry to the audit log.
 * Public API — called by other modules (e.g. entity saves, deletes).
 *
 * @param {string} action       — e.g. 'CREATE', 'UPDATE', 'DELETE', 'LOGIN'
 * @param {string} entityType   — e.g. 'task', 'note', 'account', 'invite'
 * @param {string} entityId     — ID of the affected entity (or null)
 * @param {string} entityTitle  — human-readable label
 * @param {Object} [details]    — arbitrary metadata
 * @returns {Promise<void>}
 */
export async function addAuditEntry(action, entityType, entityId, entityTitle, details) {
  const auth = await getSetting('auth');
  if (!auth) return;

  await _writeAuditEntry(
    auth, action, entityType, entityId, entityTitle,
    details, _account?.id || 'system'
  );
}


// ── Convenience exports for settings/admin views ─────────── //

/**
 * Get all invite codes (admin only).
 * @returns {Promise<Object[]>}
 */
export async function getInviteCodes() {
  if (_account?.role !== 'admin') return [];
  const auth = await getSetting('auth');
  return auth?.invites || [];
}

/**
 * Get all accounts with passHash stripped (admin only).
 * @returns {Promise<Object[]>}
 */
export async function getAllAccounts() {
  if (_account?.role !== 'admin') return [];
  const auth = await getSetting('auth');
  return (auth?.accounts || []).map(({ passHash, ...safe }) => safe);
}

/**
 * Update display name, email, or password for the current account.
 * @param {Object} changes - { displayName?, email?, newPassword?, currentPassword? }
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function updateAccount(changes) {
  if (!_account) return { ok: false, error: 'Not logged in.' };

  const auth    = await getSetting('auth');
  const account = auth.accounts.find(a => a.id === _account.id);
  if (!account) return { ok: false, error: 'Account not found.' };

  // Password change requires current password verification
  if (changes.newPassword) {
    if (!changes.currentPassword) {
      return { ok: false, error: 'Current password is required to change your password.' };
    }
    const valid = await _verifyPass(changes.currentPassword, account.passHash);
    if (!valid) return { ok: false, error: 'Current password is incorrect.' };
    if (changes.newPassword.length < 8) {
      return { ok: false, error: 'New password must be at least 8 characters.' };
    }
    account.passHash = await _hashPass(changes.newPassword);
  }

  if (changes.email !== undefined) {
    account.email = changes.email || null;
  }

  // Update person entity display name
  if (changes.displayName?.trim()) {
    const { saveEntity } = await import('./db.js');
    await saveEntity({
      id:    account.memberId,
      type:  'person',
      title: changes.displayName.trim(),
      name:  changes.displayName.trim(),
    }, account.id);
  }

  await setSetting('auth', auth);
  _account = account;    // refresh in-memory reference

  await _writeAuditEntry(auth, 'ACCOUNT_UPDATED', 'account', account.id, account.username, {
    fields: Object.keys(changes).filter(k => k !== 'currentPassword' && k !== 'newPassword'),
  }, account.id);

  return { ok: true };
}


// ══════════════════════════════════════════════════════════════
//  PRIVATE INTERNALS
// ══════════════════════════════════════════════════════════════

// ── Default admin seeding (Blueprint §3.1) ───────────────── //

/**
 * Seed the hardcoded default admin account on first run.
 * Username: "dot", password: "retracy".
 * Only runs when auth.accounts is empty — safe to call multiple times.
 */
async function _seedDefaultAdmin() {
  const existing = await getSetting('auth');
  if (existing?.accounts?.length) return; // already seeded

  const passHash  = await _hashPass(DEFAULT_ADMIN_PASSWORD);
  const memberId  = uid();
  const accountId = uid();
  const now       = new Date().toISOString();

  // Create person entity for the default admin
  const { saveEntity } = await import('./db.js');
  await saveEntity({
    id:        memberId,
    type:      'person',
    title:     DEFAULT_ADMIN_DISPLAY,
    name:      DEFAULT_ADMIN_DISPLAY,
    role:      'admin',
    createdAt: now,
    updatedAt: now,
  }, accountId);

  // Build auth structure with default admin
  const auth = {
    accounts: [{
      id:            accountId,
      username:      DEFAULT_ADMIN_USERNAME,
      passHash,
      memberId,
      role:          'admin',
      perms:         _allPermsTrue(),
      email:         null,
      createdAt:     now,
      lastLogin:     null,
      loginAttempts: 0,
      lockedUntil:   null,
    }],
    invites:  [],
    auditLog: [],
  };

  await setSetting('auth', auth);
  await setSetting('familyName', DEFAULT_FAMILY_NAME);
  await setSetting('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  await setSetting('theme', 'light');
  await setSetting('appVersion', '2.0.0');

  // Log the seed event
  await _writeAuditEntry(auth, 'DEFAULT_ADMIN_SEEDED', 'account', accountId, DEFAULT_ADMIN_USERNAME, {
    note: 'Default admin created on first run',
  }, accountId);

  console.log('[auth] Default admin seeded — username: dot');
}

// ── PBKDF2 crypto (Blueprint §3.1) ──────────────────────── //

/**
 * Hash a password using PBKDF2-SHA256.
 * Returns: "base64(salt):base64(hash)"
 * @param {string} password
 * @returns {Promise<string>}
 */
async function _hashPass(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const saltB64   = btoa(String.fromCharCode(...saltBytes));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name:       'PBKDF2',
      salt:       saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash:       PBKDF2_HASH,
    },
    keyMaterial,
    PBKDF2_KEYLEN
  );

  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return `${saltB64}:${hashB64}`;
}

/**
 * Verify a password against a stored "salt:hash" string.
 * Uses constant-time comparison to mitigate timing attacks.
 * @param {string} password
 * @param {string} storedHash — "base64(salt):base64(hash)"
 * @returns {Promise<boolean>}
 */
async function _verifyPass(password, storedHash) {
  try {
    const colonIdx = storedHash.indexOf(':');
    if (colonIdx < 0) return false;

    const saltB64     = storedHash.substring(0, colonIdx);
    const expectedB64 = storedHash.substring(colonIdx + 1);
    const saltBytes   = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name:       'PBKDF2',
        salt:       saltBytes,
        iterations: PBKDF2_ITERATIONS,
        hash:       PBKDF2_HASH,
      },
      keyMaterial,
      PBKDF2_KEYLEN
    );

    const actualB64 = btoa(String.fromCharCode(...new Uint8Array(bits)));

    // Constant-time comparison (mitigates timing attacks on the hash)
    return _timingSafeEqual(actualB64, expectedB64);
  } catch {
    return false;
  }
}

/**
 * Constant-time string comparison.
 * Prevents timing-based side-channel attacks on password hash comparison.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function _timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}


// ── Session management ───────────────────────────────────── //

/**
 * Create and persist a new session for the given account.
 * Written to both IndexedDB (settings store, key "session") AND
 * sessionStorage (for tab isolation per Blueprint §3.1).
 * @param {Object} account
 */
async function _createSession(account) {
  const sidBytes = crypto.getRandomValues(new Uint8Array(SESSION_SID_BYTES));
  const sid = Array.from(sidBytes)
    .map(b => b.toString(16).padStart(2, '0')).join('');

  _session = {
    sid,
    accountId: account.id,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  _account = account;

  // Dual-write: sessionStorage (tab isolation) + IndexedDB (persistence)
  sessionStorage.setItem('fh_session', JSON.stringify(_session));
  await setSetting('session', _session);
}

/**
 * Validate a session against IndexedDB and sessionStorage.
 * Both must agree on SID, and expiry must be in the future.
 *
 * @param {Object} ssSession  — from sessionStorage
 * @param {Object} dbSession  — from IndexedDB settings store
 * @param {Object} auth       — full auth record (to verify account exists)
 * @returns {boolean}
 */
function _isSessionValid(ssSession, dbSession, auth) {
  // Basic structure check
  if (!ssSession?.sid || !ssSession?.accountId || !ssSession?.expiresAt) return false;
  if (!dbSession?.sid || !dbSession?.accountId) return false;

  // SID must match between sessionStorage and IndexedDB
  if (ssSession.sid !== dbSession.sid) return false;

  // Account IDs must match
  if (ssSession.accountId !== dbSession.accountId) return false;

  // Not expired (use the more recent expiresAt between the two)
  const expiresAt = Math.max(ssSession.expiresAt || 0, dbSession.expiresAt || 0);
  if (Date.now() > expiresAt) return false;

  // Account must still exist in auth
  if (!_findAccount(auth, ssSession.accountId)) return false;

  return true;
}

/**
 * Read session from sessionStorage (returns parsed object or null).
 */
function _getSessionStorageSession() {
  try {
    const raw = sessionStorage.getItem('fh_session');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Find an account by ID in the auth object.
 * @param {Object} auth
 * @param {string} accountId
 * @returns {Object|null}
 */
function _findAccount(auth, accountId) {
  return auth?.accounts?.find(a => a.id === accountId) || null;
}

/**
 * Clear session from memory, sessionStorage, and IndexedDB (without reloading).
 */
function _clearLocalSession() {
  _account = null;
  _session = null;
  sessionStorage.removeItem('fh_session');
  setSetting('session', null).catch(() => {});
  _stopIdleTimer();
}


// ── BroadcastChannel ─────────────────────────────────────── //

/**
 * Set up BroadcastChannel for cross-tab logout synchronisation.
 * If one tab logs out, all other tabs clear their sessions and
 * show the auth screen.
 */
function _setupBroadcastChannel() {
  if (typeof BroadcastChannel === 'undefined') return;

  try {
    _channel = new BroadcastChannel(AUTH_CHANNEL);
    _channel.onmessage = (e) => {
      if (e.data?.type === 'LOGOUT') {
        _clearLocalSession();
        _showAuthScreen();
      }
    };
  } catch (err) {
    console.warn('[auth] BroadcastChannel setup failed:', err.message);
  }
}


// ── Idle timer (Blueprint §3.1) ──────────────────────────── //

/**
 * Start the idle timer system:
 * 1. Wire activity listeners (click, keydown, scroll, touchstart) → resetIdle()
 * 2. Poll every 60s to check if session has expired
 */
function _startIdleTimer() {
  _stopIdleTimer();

  // Wire activity listeners to the exported resetIdle function
  const events = ['click', 'keydown', 'scroll', 'touchstart'];
  _activityHandlers = [];

  for (const evt of events) {
    const handler = () => resetIdle();
    document.addEventListener(evt, handler, { passive: true });
    _activityHandlers.push({ evt, handler });
  }

  // Poll every 60 seconds to check for expiry
  _expiryPollTimer = setInterval(() => {
    if (_session && Date.now() > _session.expiresAt) {
      console.log('[auth] Session expired — logging out');
      doLogout();
    }
  }, 60_000);
}

/**
 * Stop idle timer and remove activity listeners.
 */
function _stopIdleTimer() {
  if (_expiryPollTimer) {
    clearInterval(_expiryPollTimer);
    _expiryPollTimer = null;
  }
  clearTimeout(_activityDebounce);

  // Remove activity listeners
  for (const { evt, handler } of _activityHandlers) {
    document.removeEventListener(evt, handler);
  }
  _activityHandlers = [];
}


// ── Permissions helpers ──────────────────────────────────── //

/**
 * All 16 sections × 4 ops = all true (for admin / parent roles).
 * @returns {Object}
 */
function _allPermsTrue() {
  const perms = {};
  for (const s of PERM_SECTIONS) {
    perms[s] = {};
    for (const op of PERM_OPS) { perms[s][op] = true; }
  }
  return perms;
}

/**
 * Default permissions by role (Blueprint §3.3):
 *   admin  → all true
 *   parent → all true
 *   member → view+add+edit on content sections; no settings/entityTypes/members
 *   guest  → view-only on content sections; no settings/entityTypes/members
 *
 * @param {string} role
 * @returns {Object}
 */
function _defaultPerms(role) {
  if (role === 'admin' || role === 'parent') return _allPermsTrue();

  const adminSections = ['settings', 'entityTypes', 'members'];
  const perms = {};

  for (const s of PERM_SECTIONS) {
    if (adminSections.includes(s)) {
      // Admin-only sections: no access for member/guest
      perms[s] = { view: false, add: false, edit: false, delete: false };
    } else if (role === 'member') {
      // Members: view, add, edit — but not delete
      perms[s] = { view: true, add: true, edit: true, delete: false };
    } else {
      // Guest: view only
      perms[s] = { view: true, add: false, edit: false, delete: false };
    }
  }

  return perms;
}


// ── Audit log internal ───────────────────────────────────── //

/**
 * Internal: write an audit log entry and persist auth.
 * Caps at AUDIT_MAX_ENTRIES to prevent unbounded growth.
 *
 * @param {Object} auth        — auth object (will be saved after mutation)
 * @param {string} action
 * @param {string} entityType
 * @param {string|null} entityId
 * @param {string|null} entityTitle
 * @param {Object|null} details
 * @param {string} byAccountId
 */
async function _writeAuditEntry(auth, action, entityType, entityId, entityTitle, details, byAccountId) {
  if (!auth) return;

  auth.auditLog = auth.auditLog || [];

  auth.auditLog.push({
    id:          uid(),
    action,
    entityType,
    entityId:    entityId || null,
    entityTitle: entityTitle || null,
    details:     details || null,
    byAccountId: byAccountId || null,
    timestamp:   new Date().toISOString(),
  });

  // Trim oldest entries if over cap
  if (auth.auditLog.length > AUDIT_MAX_ENTRIES) {
    auth.auditLog = auth.auditLog.slice(-AUDIT_MAX_ENTRIES);
  }

  await setSetting('auth', auth);
}


// ── UI helpers ───────────────────────────────────────────── //

/** Show the auth screen, hide the app. */
function _showAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  const app        = document.getElementById('app');
  const fab        = document.getElementById('fab');
  const toasts     = document.getElementById('toast-container');

  if (authScreen) authScreen.classList.remove('hidden');
  if (app)        app.setAttribute('aria-hidden', 'true');
  if (fab)        fab.style.display = 'none';
  if (toasts)     toasts.style.display = 'none';
}

/** Show the app, hide the auth screen. Update topbar with user info. */
function _showApp(auth) {
  const authScreen = document.getElementById('auth-screen');
  const app        = document.getElementById('app');
  const fab        = document.getElementById('fab');
  const toasts     = document.getElementById('toast-container');

  if (authScreen) authScreen.classList.add('hidden');
  if (app)        app.removeAttribute('aria-hidden');
  if (fab)        fab.style.display = '';
  if (toasts)     toasts.style.display = '';

  // Update topbar user info
  _updateTopbarUser();

  // Update sidebar family name
  const familyNameEl = document.getElementById('sidebar-family-name');
  getSetting('familyName').then(name => {
    if (familyNameEl && name) familyNameEl.textContent = name;
  });

  // Apply saved theme
  getSetting('theme').then(theme => {
    if (theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('fh_theme', theme);
    }
  });

  // Import and start router
  import('./router.js').then(({ navigate, handleInitialHash, wireNavItems, VIEW_KEYS }) => {
    wireNavItems();
    if (!handleInitialHash()) {
      navigate(VIEW_KEYS.DAILY);
    }
  });
}

/** Update topbar avatar and user name from the person entity. */
function _updateTopbarUser() {
  if (!_account) return;

  const avatar   = document.getElementById('topbar-avatar');
  const userName = document.getElementById('topbar-user-name');

  import('./db.js').then(({ getEntity }) => {
    if (_account.memberId) {
      getEntity(_account.memberId).then(person => {
        const displayName = person?.name || person?.title || _account.username;
        if (avatar)   avatar.textContent  = displayName.charAt(0).toUpperCase();
        if (userName) userName.textContent = displayName;
      });
    } else {
      if (avatar)   avatar.textContent  = _account.username.charAt(0).toUpperCase();
      if (userName) userName.textContent = _account.username;
    }
  });
}

/** Show the first-run form, hide login/invite tabs. */
function _showFirstRunForm() {
  const tabsEl     = document.querySelector('.auth-tabs');
  const loginForm  = document.getElementById('auth-form-login');
  const inviteForm = document.getElementById('auth-form-invite');
  const firstRun   = document.getElementById('auth-form-firstrun');
  const subtitle   = document.getElementById('auth-subtitle');

  if (tabsEl)     tabsEl.style.display = 'none';
  if (loginForm)  loginForm.classList.add('hidden');
  if (inviteForm) inviteForm.classList.add('hidden');
  if (firstRun)   firstRun.classList.remove('hidden');
  if (subtitle)   subtitle.textContent = "Welcome! Let's set up your family.";

  setTimeout(() => {
    document.getElementById('firstrun-family')?.focus();
  }, 100);
}

/** Show the standard login form. */
function _showLoginForm() {
  const subtitle = document.getElementById('auth-subtitle');
  if (subtitle) subtitle.textContent = 'Welcome back';

  setTimeout(() => {
    document.getElementById('login-username')?.focus();
  }, 100);
}


// ── Auth form wiring ─────────────────────────────────────── //

/**
 * Wire all auth form submit buttons and keyboard shortcuts.
 * Called once by initAuth().
 */
function _wireAuthForms() {

  // ── Login form ──────────────────────────────────────────
  const loginBtn = document.getElementById('login-btn');
  const loginErr = document.getElementById('login-error');

  async function handleLogin() {
    const username = document.getElementById('login-username')?.value?.trim();
    const password = document.getElementById('login-password')?.value;

    if (loginErr) loginErr.classList.add('hidden');
    if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = 'Signing in\u2026'; }

    const result = await doLogin(username, password);

    if (!result.ok) {
      if (loginErr) {
        loginErr.textContent = result.error;
        loginErr.classList.remove('hidden');
      }
      if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Sign In'; }
    }
  }

  if (loginBtn) loginBtn.addEventListener('click', handleLogin);

  // Enter key navigation
  document.getElementById('login-username')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('login-password')?.focus();
  });
  document.getElementById('login-password')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
  });

  // ── Invite join form ────────────────────────────────────
  const inviteJoinBtn = document.getElementById('invite-join-btn');
  const inviteErr     = document.getElementById('invite-error');

  async function handleInviteJoin() {
    const code     = document.getElementById('invite-code')?.value?.trim();
    const username = document.getElementById('invite-username')?.value?.trim();
    const password = document.getElementById('invite-password')?.value;

    if (inviteErr) inviteErr.classList.add('hidden');
    if (inviteJoinBtn) { inviteJoinBtn.disabled = true; inviteJoinBtn.textContent = 'Joining\u2026'; }

    const result = await redeemInvite(code, username, password);

    if (!result.ok) {
      if (inviteErr) {
        inviteErr.textContent = result.error;
        inviteErr.classList.remove('hidden');
      }
      if (inviteJoinBtn) { inviteJoinBtn.disabled = false; inviteJoinBtn.textContent = 'Join FamilyHub'; }
    }
  }

  if (inviteJoinBtn) inviteJoinBtn.addEventListener('click', handleInviteJoin);

  // ── First run form ──────────────────────────────────────
  const firstRunBtn = document.getElementById('firstrun-btn');
  const firstRunErr = document.getElementById('firstrun-error');

  async function handleFirstRun() {
    const familyName  = document.getElementById('firstrun-family')?.value?.trim();
    const displayName = document.getElementById('firstrun-displayname')?.value?.trim();
    const username    = document.getElementById('firstrun-username')?.value?.trim();
    const password    = document.getElementById('firstrun-password')?.value;

    if (firstRunErr) firstRunErr.classList.add('hidden');
    if (firstRunBtn) { firstRunBtn.disabled = true; firstRunBtn.textContent = 'Setting up\u2026'; }

    const result = await doFirstRun(familyName, displayName, username, password);

    if (!result.ok) {
      if (firstRunErr) {
        firstRunErr.textContent = result.error;
        firstRunErr.classList.remove('hidden');
      }
      if (firstRunBtn) { firstRunBtn.disabled = false; firstRunBtn.textContent = 'Create Family & Sign In'; }
    }
  }

  if (firstRunBtn) firstRunBtn.addEventListener('click', handleFirstRun);

  document.getElementById('firstrun-password')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleFirstRun();
  });

  // ── Sidebar logout ──────────────────────────────────────
  document.getElementById('sidebar-logout-btn')?.addEventListener('click', () => {
    doLogout();
  });

  // ── Topbar user button → settings ───────────────────────
  document.getElementById('topbar-user-btn')?.addEventListener('click', () => {
    import('./router.js').then(({ navigate, VIEW_KEYS }) => {
      navigate(VIEW_KEYS.SETTINGS);
    });
  });

  // ── Migration buttons ───────────────────────────────────
  document.getElementById('migration-yes-btn')?.addEventListener('click', () => {
    import('./migrate.js').then(m => m.migrateFromV32()).catch(err => {
      console.error('[auth] Migration error:', err);
    });
  });
}


// ── DOMContentLoaded: wire global activity listeners ─────── //
// Ensures resetIdle fires even before initAuth completes.
// The listeners are harmless when no session exists — resetIdle
// checks for _session before doing anything.

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const events = ['click', 'keydown', 'scroll', 'touchstart'];
    for (const evt of events) {
      document.addEventListener(evt, resetIdle, { passive: true });
    }
  });
}
