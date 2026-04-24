/**
 * FamilyHub v2.0 — Service Worker (sw.js)
 * Blueprint §8.2 — Cache shell, background sync, offline fallback
 *
 * Strategy summary:
 *   - App shell (HTML/CSS/JS): Cache First — update in background
 *   - Notion API calls:        Network Only — never cached
 *   - Offline fallback:        Serve cached index.html
 *   - Background Sync:         Register "notion-sync" for offline queue retry
 */

'use strict';

// ── Cache Names ───────────────────────────────────────────── //
const APP_VERSION   = '2.2.0';
const CACHE_SHELL   = `fh-shell-v${APP_VERSION}`;
const CACHE_DYNAMIC = `fh-dynamic-v${APP_VERSION}`;

// All caches managed by this SW
const ALL_CACHES = [CACHE_SHELL, CACHE_DYNAMIC];

// ── Shell Files to Pre-Cache ──────────────────────────────── //
// These are fetched and cached during install.
// Must match actual file paths on server.
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './styles/tokens.css?v=2.2.0',
  './styles/layout.css?v=2.2.0',
  './styles/components.css?v=2.2.0',
  './styles/dark.css?v=2.2.0',
  './core/events.js',
  './core/router.js',
  './core/db.js',
  './core/auth.js',
  './core/graph-engine.js',
  './components/entity-panel.js',
  './components/entity-form.js',
  './components/fab.js',
  './components/search.js',
  // View modules
  './views/daily.js',
  './views/kanban.js',
  // Icons (all sizes + maskable variants for PWA installability)
  './icons/icon-192.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  // Shortcut icons (used by OS home screen shortcuts)
  './icons/shortcut-daily.png',
  './icons/shortcut-task.png',
  // Screenshots (used by PWA install UI in supporting browsers)
  './screenshots/daily-desktop.png',
  './screenshots/kanban-mobile.png',
];

// ── Patterns: Never Cache ─────────────────────────────────── //
// Notion API calls always go to network.
const NETWORK_ONLY_PATTERNS = [
  /api\.notion\.com/,
  /\/sync\/notion-proxy\.php/,
  /\/sync\/notion-cron\.php/,
  /\/sync\/save-data\.php/,
];

// ── INSTALL ───────────────────────────────────────────────── //
self.addEventListener('install', (event) => {
  console.log('[SW] Installing FamilyHub', APP_VERSION);

  event.waitUntil(
    caches.open(CACHE_SHELL)
      .then(cache => {
        console.log('[SW] Pre-caching shell files');
        // addAll fails atomically — if one file 404s, install fails.
        // Use individual adds to be resilient during dev.
        return Promise.allSettled(
          SHELL_FILES.map(url =>
            cache.add(url).catch(err =>
              console.warn(`[SW] Failed to cache ${url}:`, err)
            )
          )
        );
      })
      .then(() => {
        // Skip waiting — activate immediately on install.
        // The update banner in index.html handles the UX.
        return self.skipWaiting();
      })
  );
});

// ── ACTIVATE ──────────────────────────────────────────────── //
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating FamilyHub', APP_VERSION);

  event.waitUntil(
    Promise.all([
      // Delete old caches from previous versions
      caches.keys().then(keys =>
        Promise.all(
          keys
            .filter(key => !ALL_CACHES.includes(key))
            .map(key => {
              console.log('[SW] Deleting old cache:', key);
              return caches.delete(key);
            })
        )
      ),
      // Claim all open clients immediately
      self.clients.claim(),
    ])
  );
});

// ── FETCH ─────────────────────────────────────────────────── //
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle same-origin GET requests
  if (request.method !== 'GET') return;

  // Network-only: Notion API and PHP sync endpoints
  if (NETWORK_ONLY_PATTERNS.some(pattern => pattern.test(request.url))) {
    event.respondWith(fetch(request));
    return;
  }

  // ── Network First for everything ──────────────────────────
  // Always fetch fresh from network when online; cache for offline only.
  // This prevents stale JS/CSS/HTML being served after a deployment.
  event.respondWith(
    fetch(request, { cache: 'no-cache' })
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_SHELL)
            .then(cache => cache.put(request, clone))
            .catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        // Offline fallback
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
        }
        return new Response(
          'FamilyHub is offline. Please reconnect.',
          { status: 503, headers: { 'Content-Type': 'text/plain' } }
        );
      })
  );
});

// ── BACKGROUND SYNC ───────────────────────────────────────── //
// Blueprint §8.2 — "Register sync event 'notion-sync' — retries when online"
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync event:', event.tag);

  if (event.tag === 'notion-sync') {
    event.waitUntil(
      // Notify all open clients to run sync
      self.clients.matchAll({ type: 'window' })
        .then(clients => {
          clients.forEach(client => {
            client.postMessage({ type: 'BG_SYNC_NOTION' });
          });
        })
    );
  }
});

// ── PUSH NOTIFICATIONS ────────────────────────────────────── //
// Placeholder for Phase 7 — Firebase Cloud Messaging
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'FamilyHub', body: event.data.text() };
  }

  const options = {
    body:    data.body || '',
    icon:    './icons/icon-192.png',
    badge:   './icons/icon-192.png',
    tag:     data.tag || 'familyhub-general',
    data:    data.url || '/',
    actions: data.actions || [],
    vibrate: [100, 50, 100],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'FamilyHub', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // Focus existing window if open
        const existing = clients.find(c => c.url.includes(self.location.origin));
        if (existing) {
          existing.focus();
          existing.navigate(targetUrl);
          return;
        }
        // Otherwise open a new window
        return self.clients.openWindow(targetUrl);
      })
  );
});

// ── MESSAGE HANDLER ───────────────────────────────────────── //
self.addEventListener('message', (event) => {
  if (!event.data) return;

  switch (event.data.type) {
    case 'SKIP_WAITING':
      // Triggered by update banner "Reload" button
      self.skipWaiting();
      break;

    case 'CACHE_URLS':
      // Dynamically cache additional URLs (for offline media, etc.)
      if (Array.isArray(event.data.urls)) {
        caches.open(CACHE_DYNAMIC)
          .then(cache => cache.addAll(event.data.urls))
          .catch(err => console.warn('[SW] Dynamic cache error:', err));
      }
      break;

    default:
      console.log('[SW] Unknown message:', event.data.type);
  }
});
