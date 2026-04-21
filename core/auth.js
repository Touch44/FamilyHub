/**
 * FamilyHub v2.0 — core/auth.js
 * PBKDF2 authentication, sessions, permissions, invite codes
 * Blueprint §3.1 – §3.5
 *
 * Public API:
 *   initAuth()            — Check for existing session or first-run, show correct UI
 *   doLogin(user, pass)   — Attempt login, returns {ok, error}
 *   doFirstRun(data)      — Create family + admin account, returns {ok, error}
 *   doInviteJoin(data)    — Join via invite code, returns {ok, error}
 *   doLogout()            — Clear session, broadcast, reload
 *   getSession()          — Returns current session object or null
 *   getAccount()          — Returns current account object or null
 *   hasPerm(section, op)  — Check permission for current user
 *   generateInviteCode()  — Generate 8-char invite code (admin only)
 */

'use strict';

import {
  getSetting, setSetting, uid
} from './db.js';
import { emit, EVENTS } from './events.js';

// ── Constants (Blueprint §3.1) ────────────────────────────── //

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH       = 'SHA-256';
const PBKDF2_KEYLEN     = 256; // bits
const SALT_BYTES        = 16;
const SESSION_TTL_MS    = 30 * 60 * 1000;   // 30 minutes
const SESSION_SID_BYTES = 32;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const INVITE_EXPIRY_DAYS  = 7;
const IDLE_DEBOUNCE_MS    = 5_000;

/** BroadcastChannel name (Blueprint §3.1) */
const AUTH_CHANNEL = 'familyhub-auth';

// ── Module state ─────────────────────────────────────────── //

/** @type {Object|null} — current authenticated account */
let _account = null;

/** @type {Object|null} — current session */
let _session = null;

/** @type {BroadcastChannel|null} */
let _channel = null;

/** @type {number|null} — debounce timer ID */
let _idleTimer = null;

/** @type {number|null} — activity listener debounce */
let _activityDebounce = null;

// ── Initialisation ───────────────────────────────────────── //

/**
 * Called by index.html after DB is ready.
 * Determines which auth screen to show, or resumes an existing session.
 * Blueprint §3.5
 * @returns {Promise<void>}
 */
export async function initAuth() {
  // Set up BroadcastChannel for cross-tab logout
  if (typeof BroadcastChannel !== 'undefined') {
    _channel = new BroadcastChannel(AUTH_CHANNEL);
    _channel.onmessage = (e) => {
      if (e.data?.type === 'LOGOUT') {
        _clearLocalSession();
        _showAuthScreen();
      }
    };
  }

  // Check for existing valid session
  const savedSession = await getSetting('session');
  if (savedSession) {
    const auth = await getSetting('auth');
    if (_isSessionValid(savedSession, auth)) {
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

  // No valid session — check if first run
  const auth = await getSetting('auth');
  const hasAccounts = auth?.accounts?.length > 0;

  if (!hasAccounts) {
    _showFirstRunForm();
  } else {
    _showLoginForm();
  }

  // Wire auth form event handlers
  _wireAuthForms();
}

// ── Login (Blueprint §3.5 Login flow) ───────────────────── //

/**
 * Attempt to log in with username/email and password.
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

  // Find account by username or email
  const account = auth.accounts.find(a =>
    a.username.toLowerCase() === usernameOrEmail.toLowerCase() ||
    (a.email && a.email.toLowerCase() === usernameOrEmail.toLowerCase())
  );

  if (!account) {
    return { ok: false, error: 'Username or password is incorrect.' };
  }

  // Check lockout
  if (account.lockedUntil && Date.now() < account.lockedUntil) {
    const remaining = Math.ceil((account.lockedUntil - Date.now()) / 60_000);
    return { ok: false, error: `Account locked. Try again in ${remaining} minute${remaining !== 1 ? 's' : ''}.` };
  }

  // Verify password
  const valid = await _verifyPass(password, account.passHash);

  if (!valid) {
    // Increment attempts, lock if threshold reached
    account.loginAttempts = (account.loginAttempts || 0) + 1;
    if (account.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
      account.lockedUntil   = Date.now() + LOCKOUT_DURATION_MS;
      account.loginAttempts = 0;
      await setSetting('auth', auth);
      return { ok: false, error: `Too many attempts. Account locked for 15 minutes.` };
    }
    await setSetting('auth', auth);
    const remaining = MAX_LOGIN_ATTEMPTS - account.loginAttempts;
    return { ok: false, error: `Incorrect password. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` };
  }

  // Success
  account.loginAttempts = 0;
  account.lockedUntil   = null;
  account.lastLogin     = new Date().toISOString();
  await setSetting('auth', auth);

  await _createSession(account);
  _startIdleTimer();
  _showApp(auth);

  emit(EVENTS.AUTH_LOGIN, { accountId: account.id });
  return { ok: true };
}

// ── First Run (Blueprint §3.5 First Run flow) ─────────────── //

/**
 * Create the family and the first admin account.
 * @param {Object} data
 * @param {string} data.familyName
 * @param {string} data.displayName
 * @param {string} data.username
 * @param {string} data.password
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function doFirstRun({ familyName, displayName, username, password }) {
  // Validation
  if (!familyName?.trim())  return { ok: false, error: 'Family name is required.' };
  if (!displayName?.trim()) return { ok: false, error: 'Display name is required.' };
  if (!username?.trim())    return { ok: false, error: 'Username is required.' };
  if (!password)            return { ok: false, error: 'Password is required.' };
  if (password.length < 8)  return { ok: false, error: 'Password must be at least 8 characters.' };
  if (!/^[a-z0-9_.-]+$/i.test(username)) {
    return { ok: false, error: 'Username may only contain letters, numbers, dots, dashes, underscores.' };
  }

  const passHash = await _hashPass(password);
  const memberId = uid();
  const accountId = uid();
  const now = new Date().toISOString();

  // Create person entity for the admin member
  // (We import saveEntity lazily to avoid circular deps with db.js)
  const { saveEntity } = await import('./db.js');
  await saveEntity({
    id:          memberId,
    type:        'person',
    title:       displayName.trim(),
    name:        displayName.trim(),
    role:        'admin',
    createdAt:   now,
    updatedAt:   now,
  }, accountId);

  // Build auth structure
  const auth = {
    accounts: [
      {
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
      }
    ],
    invites:  [],
    auditLog: [],
  };

  await setSetting('auth', auth);
  await setSetting('familyName', familyName.trim());
  await setSetting('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  await setSetting('theme', 'light');
  await setSetting('appVersion', '2.0.0');

  await _createSession(auth.accounts[0]);
  _startIdleTimer();
  _showApp(auth);

  emit(EVENTS.AUTH_LOGIN, { accountId });
  return { ok: true };
}

// ── Invite Code Join (Blueprint §3.5 Invite Code Join) ────── //

/**
 * Join using an invite code.
 * @param {Object} data
 * @param {string} data.code
 * @param {string} data.username
 * @param {string} data.password
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function doInviteJoin({ code, username, password }) {
  if (!code?.trim())     return { ok: false, error: 'Invite code is required.' };
  if (!username?.trim()) return { ok: false, error: 'Username is required.' };
  if (!password)         return { ok: false, error: 'Password is required.' };
  if (password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };

  const auth = await getSetting('auth');
  if (!auth) return { ok: false, error: 'No FamilyHub data found. Contact your admin.' };

  const normalised = code.trim().toUpperCase();
  const invite = auth.invites?.find(i => i.code === normalised);

  if (!invite) {
    return { ok: false, error: 'Invalid invite code.' };
  }
  if (invite.usedAt) {
    return { ok: false, error: 'This invite code has already been used.' };
  }
  if (Date.now() > invite.expiresAt) {
    return { ok: false, error: 'This invite code has expired.' };
  }

  // Check username not already taken
  const taken = auth.accounts.some(
    a => a.username.toLowerCase() === username.trim().toLowerCase()
  );
  if (taken) {
    return { ok: false, error: 'That username is already taken.' };
  }

  const passHash  = await _hashPass(password);
  const memberId  = uid();
  const accountId = uid();
  const now       = new Date().toISOString();

  // Create person entity
  const { saveEntity } = await import('./db.js');
  await saveEntity({
    id:        memberId,
    type:      'person',
    title:     username.trim(),
    name:      username.trim(),
    role:      invite.role || 'member',
    createdAt: now,
    updatedAt: now,
  }, accountId);

  // Create account
  const newAccount = {
    id:            accountId,
    username:      username.trim().toLowerCase(),
    passHash,
    memberId,
    role:          invite.role || 'member',
    perms:         invite.perms || _defaultPerms(invite.role || 'member'),
    email:         null,
    createdAt:     now,
    lastLogin:     now,
    loginAttempts: 0,
    lockedUntil:   null,
  };

  auth.accounts.push(newAccount);

  // Mark invite used
  invite.usedAt     = now;
  invite.usedBy     = accountId;

  await setSetting('auth', auth);

  await _createSession(newAccount);
  _startIdleTimer();
  _showApp(auth);

  emit(EVENTS.AUTH_LOGIN, { accountId });
  return { ok: true };
}

// ── Logout (Blueprint §3.5 Session) ──────────────────────── //

/**
 * Log out: clear session, broadcast to all tabs, reload.
 * Blueprint §3.5 — doLogout()
 */
export async function doLogout() {
  _clearLocalSession();

  // Broadcast to all tabs
  _channel?.postMessage({ type: 'LOGOUT' });

  emit(EVENTS.AUTH_LOGOUT);

  // Reload to show auth screen cleanly
  window.location.reload();
}

// ── Session helpers ───────────────────────────────────────── //

/**
 * Returns the current session or null.
 * @returns {Object|null}
 */
export function getSession() { return _session; }

/**
 * Returns the current account or null.
 * @returns {Object|null}
 */
export function getAccount() { return _account; }

/**
 * Check permission for current user.
 * Admins always return true.
 * Blueprint §3.4
 * @param {string} section  - e.g. 'kanban', 'budget'
 * @param {'view'|'add'|'edit'|'delete'} op
 * @returns {boolean}
 */
export function hasPerm(section, op) {
  if (!_account) return false;
  if (_account.role === 'admin') return true;
  return _account.perms?.[section]?.[op] === true;
}

// ── Invite Code Generation (Blueprint §3.1) ──────────────── //

/**
 * Generate an 8-character invite code (XXXX-XXXX format).
 * Saves to auth settings. Admin only.
 * @param {Object} options
 * @param {string} [options.role='member']
 * @param {Object} [options.perms]
 * @returns {Promise<{ok: boolean, code?: string, error?: string}>}
 */
export async function generateInviteCode({ role = 'member', perms } = {}) {
  if (_account?.role !== 'admin') {
    return { ok: false, error: 'Only admins can generate invite codes.' };
  }

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // excludes ambiguous I,O,1,0
  const rand  = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)))
                             .map(b => chars[b % chars.length]).join('');

  const code       = rand(4) + '-' + rand(4);
  const expiresAt  = Date.now() + (INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const auth = await getSetting('auth');
  auth.invites = auth.invites || [];
  auth.invites.push({
    code,
    role,
    perms: perms || _defaultPerms(role),
    createdBy: _account.id,
    createdAt: new Date().toISOString(),
    expiresAt,
    usedAt: null,
    usedBy: null,
  });

  await setSetting('auth', auth);
  return { ok: true, code };
}

/**
 * Get all invite codes. Admin only.
 * @returns {Promise<Object[]>}
 */
export async function getInviteCodes() {
  if (_account?.role !== 'admin') return [];
  const auth = await getSetting('auth');
  return auth?.invites || [];
}

/**
 * Revoke an invite code by code string. Admin only.
 * @param {string} code
 * @returns {Promise<{ok: boolean}>}
 */
export async function revokeInviteCode(code) {
  if (_account?.role !== 'admin') return { ok: false };
  const auth = await getSetting('auth');
  auth.invites = (auth.invites || []).filter(i => i.code !== code);
  await setSetting('auth', auth);
  return { ok: true };
}

// ── Account management ────────────────────────────────────── //

/**
 * Get all accounts. Admin only.
 * Strips passHash from returned objects.
 * @returns {Promise<Object[]>}
 */
export async function getAllAccounts() {
  if (_account?.role !== 'admin') return [];
  const auth = await getSetting('auth');
  return (auth?.accounts || []).map(({ passHash, ...safe }) => safe);
}

/**
 * Update display name, email, or password for the current account.
 * @param {Object} changes - {displayName?, email?, newPassword?, currentPassword?}
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function updateAccount(changes) {
  if (!_account) return { ok: false, error: 'Not logged in.' };

  const auth    = await getSetting('auth');
  const account = auth.accounts.find(a => a.id === _account.id);
  if (!account) return { ok: false, error: 'Account not found.' };

  // If changing password, verify current password first
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

  if (changes.email !== undefined) account.email = changes.email || null;

  // Update person entity display name if changed
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
  _account = account; // Refresh in-memory account
  return { ok: true };
}

// ── PBKDF2 crypto (Blueprint §3.1) ────────────────────────── //

/**
 * Hash a password using PBKDF2-SHA256.
 * Returns a base64-encoded string: "salt:hash"
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
 * Verify a password against a stored PBKDF2 hash.
 * @param {string} password
 * @param {string} storedHash - "salt:hash" base64 string
 * @returns {Promise<boolean>}
 */
async function _verifyPass(password, storedHash) {
  try {
    const [saltB64, expectedB64] = storedHash.split(':');
    const saltBytes = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));

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
    return actualB64 === expectedB64;
  } catch {
    return false;
  }
}

// ── Session management ────────────────────────────────────── //

/**
 * Create and persist a new session for the given account.
 * Blueprint §3.5 — genSid()
 * @param {Object} account
 */
async function _createSession(account) {
  const sidBytes = crypto.getRandomValues(new Uint8Array(SESSION_SID_BYTES));
  const sid      = Array.from(sidBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  _session = {
    sid,
    accountId:  account.id,
    expiresAt:  Date.now() + SESSION_TTL_MS,
  };
  _account = account;

  // Mirror to sessionStorage for tab isolation (Blueprint §3.1)
  sessionStorage.setItem('fh_session', JSON.stringify(_session));
  await setSetting('session', _session);
}

/**
 * Check if a session is still valid.
 * @param {Object} session
 * @param {Object} auth
 * @returns {boolean}
 */
function _isSessionValid(session, auth) {
  if (!session?.sid || !session?.accountId || !session?.expiresAt) return false;
  if (Date.now() > session.expiresAt) return false;

  // Also validate via sessionStorage (tab isolation — different tab has different session)
  const ssSession = sessionStorage.getItem('fh_session');
  if (!ssSession) return false;
  try {
    const ss = JSON.parse(ssSession);
    return ss.sid === session.sid;
  } catch {
    return false;
  }
}

/**
 * Find an account by ID in the auth object.
 */
function _findAccount(auth, accountId) {
  return auth?.accounts?.find(a => a.id === accountId) || null;
}

/**
 * Clear session from memory and storage (without reloading).
 */
function _clearLocalSession() {
  _account = null;
  _session = null;
  sessionStorage.removeItem('fh_session');
  setSetting('session', null).catch(() => {});
  _stopIdleTimer();
}

// ── Idle timer (Blueprint §3.1 — 30 min TTL, reset on activity) ─ //

function _startIdleTimer() {
  _stopIdleTimer();

  // Reset session expiry on user activity (debounced 5s)
  const resetIdle = () => {
    clearTimeout(_activityDebounce);
    _activityDebounce = setTimeout(() => {
      if (_session) {
        _session.expiresAt = Date.now() + SESSION_TTL_MS;
        sessionStorage.setItem('fh_session', JSON.stringify(_session));
        setSetting('session', _session).catch(() => {});
      }
    }, IDLE_DEBOUNCE_MS);
  };

  document.addEventListener('click',   resetIdle, { passive: true });
  document.addEventListener('keydown',  resetIdle, { passive: true });
  document.addEventListener('scroll',   resetIdle, { passive: true });
  document.addEventListener('touchstart', resetIdle, { passive: true });

  // Poll every minute to check for expiry
  _idleTimer = setInterval(() => {
    if (_session && Date.now() > _session.expiresAt) {
      console.log('[auth] Session expired — logging out');
      doLogout();
    }
  }, 60_000);
}

function _stopIdleTimer() {
  if (_idleTimer) { clearInterval(_idleTimer); _idleTimer = null; }
  clearTimeout(_activityDebounce);
}

// ── Permissions helpers ──────────────────────────────────── //

/** All 16 sections × 4 ops = all true (Blueprint §3.4) */
function _allPermsTrue() {
  const sections = [
    'daily','kanban','calendar','familyWall','familyMatters',
    'notes','projects','budget','recipes','documents',
    'contacts','gallery','graph','settings','entityTypes','members'
  ];
  const perms = {};
  for (const s of sections) {
    perms[s] = { view: true, add: true, edit: true, delete: true };
  }
  return perms;
}

/**
 * Default permissions by role.
 * Blueprint §3.3 — admin=all, parent=all, member=standard, guest=read-only
 * @param {string} role
 * @returns {Object}
 */
function _defaultPerms(role) {
  if (role === 'admin' || role === 'parent') return _allPermsTrue();

  const sections = [
    'daily','kanban','calendar','familyWall','familyMatters',
    'notes','projects','budget','recipes','documents',
    'contacts','gallery','graph'
  ];

  const perms = { settings: { view: false, add: false, edit: false, delete: false },
                  entityTypes: { view: false, add: false, edit: false, delete: false },
                  members: { view: false, add: false, edit: false, delete: false } };

  for (const s of sections) {
    if (role === 'member') {
      perms[s] = { view: true, add: true, edit: true, delete: false };
    } else {
      // guest — read-only
      perms[s] = { view: true, add: false, edit: false, delete: false };
    }
  }
  return perms;
}

// ── UI helpers ───────────────────────────────────────────── //

/** Show the auth screen, hide the app. */
function _showAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  const app        = document.getElementById('app');
  const fab        = document.getElementById('fab');
  const toasts     = document.getElementById('toast-container');

  if (authScreen) { authScreen.classList.remove('hidden'); }
  if (app)        { app.setAttribute('aria-hidden', 'true'); }
  if (fab)        { fab.style.display = 'none'; }
  if (toasts)     { toasts.style.display = 'none'; }
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

/** Update topbar avatar and user name. */
function _updateTopbarUser() {
  if (!_account) return;

  const avatar   = document.getElementById('topbar-avatar');
  const userName = document.getElementById('topbar-user-name');

  // Fetch display name from person entity
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
  const tabsEl    = document.querySelector('.auth-tabs');
  const loginForm = document.getElementById('auth-form-login');
  const inviteForm= document.getElementById('auth-form-invite');
  const firstRun  = document.getElementById('auth-form-firstrun');
  const subtitle  = document.getElementById('auth-subtitle');

  if (tabsEl)     tabsEl.style.display     = 'none';
  if (loginForm)  loginForm.classList.add('hidden');
  if (inviteForm) inviteForm.classList.add('hidden');
  if (firstRun)   firstRun.classList.remove('hidden');
  if (subtitle)   subtitle.textContent = 'Welcome! Let\'s set up your family.';

  // Auto-focus first field
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
 * Wire all auth form submit buttons.
 * Called once by initAuth().
 */
function _wireAuthForms() {

  // ── Login form ────────────────────────────────────────
  const loginBtn = document.getElementById('login-btn');
  const loginErr = document.getElementById('login-error');

  async function handleLogin() {
    const username = document.getElementById('login-username')?.value?.trim();
    const password = document.getElementById('login-password')?.value;

    if (loginErr) loginErr.classList.add('hidden');
    if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = 'Signing in…'; }

    const result = await doLogin(username, password);

    if (!result.ok) {
      if (loginErr) {
        loginErr.textContent = result.error;
        loginErr.classList.remove('hidden');
      }
      if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Sign In'; }
    }
  }

  if (loginBtn) {
    loginBtn.addEventListener('click', handleLogin);
  }

  // Allow Enter key in password field
  document.getElementById('login-password')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
  });
  document.getElementById('login-username')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('login-password')?.focus();
  });

  // ── Invite join form ──────────────────────────────────
  const inviteJoinBtn = document.getElementById('invite-join-btn');
  const inviteErr     = document.getElementById('invite-error');

  async function handleInviteJoin() {
    const code     = document.getElementById('invite-code')?.value?.trim();
    const username = document.getElementById('invite-username')?.value?.trim();
    const password = document.getElementById('invite-password')?.value;

    if (inviteErr) inviteErr.classList.add('hidden');
    if (inviteJoinBtn) { inviteJoinBtn.disabled = true; inviteJoinBtn.textContent = 'Joining…'; }

    const result = await doInviteJoin({ code, username, password });

    if (!result.ok) {
      if (inviteErr) {
        inviteErr.textContent = result.error;
        inviteErr.classList.remove('hidden');
      }
      if (inviteJoinBtn) { inviteJoinBtn.disabled = false; inviteJoinBtn.textContent = 'Join FamilyHub'; }
    }
  }

  if (inviteJoinBtn) {
    inviteJoinBtn.addEventListener('click', handleInviteJoin);
  }

  // ── First run form ─────────────────────────────────────
  const firstRunBtn = document.getElementById('firstrun-btn');
  const firstRunErr = document.getElementById('firstrun-error');

  async function handleFirstRun() {
    const familyName   = document.getElementById('firstrun-family')?.value?.trim();
    const displayName  = document.getElementById('firstrun-displayname')?.value?.trim();
    const username     = document.getElementById('firstrun-username')?.value?.trim();
    const password     = document.getElementById('firstrun-password')?.value;

    if (firstRunErr) firstRunErr.classList.add('hidden');
    if (firstRunBtn) { firstRunBtn.disabled = true; firstRunBtn.textContent = 'Setting up…'; }

    const result = await doFirstRun({ familyName, displayName, username, password });

    if (!result.ok) {
      if (firstRunErr) {
        firstRunErr.textContent = result.error;
        firstRunErr.classList.remove('hidden');
      }
      if (firstRunBtn) { firstRunBtn.disabled = false; firstRunBtn.textContent = 'Create Family & Sign In'; }
    }
  }

  if (firstRunBtn) {
    firstRunBtn.addEventListener('click', handleFirstRun);
  }

  // Enter key on last field triggers submit
  document.getElementById('firstrun-password')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleFirstRun();
  });

  // ── Logout (sidebar) ──────────────────────────────────
  document.getElementById('sidebar-logout-btn')?.addEventListener('click', () => {
    doLogout();
  });

  // ── Topbar user button → could open user menu (Phase 1) ──
  // For now just wire a logout shortcut for dev convenience
  document.getElementById('topbar-user-btn')?.addEventListener('click', () => {
    // Will be replaced by user dropdown in Phase 1
    // For now, navigate to settings
    import('./router.js').then(({ navigate, VIEW_KEYS }) => {
      navigate(VIEW_KEYS.SETTINGS);
    });
  });

  // ── Migration buttons ─────────────────────────────────
  document.getElementById('migration-yes-btn')?.addEventListener('click', () => {
    import('./migrate.js').then(m => m.migrateFromV32()).catch(err => {
      console.error('[auth] Migration error:', err);
    });
  });
}
