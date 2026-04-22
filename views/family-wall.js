/**
 * FamilyHub v2.0 — views/family-wall.js
 * Family Wall social feed — renders into #view-family-wall
 *
 * Features:
 *   - Post cards: avatar, name, timestamp, content, photos, links, milestones
 *   - Pinned posts (📌) always first, then newest-first
 *   - Reactions: 👍❤️😂😮😢 stored as edges (reacts-to)
 *   - Inline comments: stored as note entities with "comments-on" edge
 *   - Attached entities: chips linking to entity panel
 *   - Filter bar: by member, post type, pinned-only, tags
 *   - Compose box: text, photo URL, link URL, milestone, tags, attach entity
 *
 * Registration: registerView('family-wall', renderWall) at module init.
 */

import { registerView }                from '../core/router.js';
import { getEntitiesByType, getEntity,
         saveEntity, deleteEntity, uid,
         getEdgesFrom, getEdgesTo,
         saveEdge, deleteEdge,
         getSetting }                   from '../core/db.js';
import { emit, on, EVENTS }            from '../core/events.js';
import { getAccount }                   from '../core/auth.js';

// ── Constants ─────────────────────────────────────────────── //

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢'];

const POST_TYPES = ['All', 'Text', 'Photo', 'Link', 'Milestone'];

const PERSON_COLOR_MAP = {
  Red: '#EF4444', Orange: '#F97316', Yellow: '#EAB308', Green: '#22C55E',
  Teal: '#14B8A6', Blue: '#3B82F6', Purple: '#8B5CF6', Pink: '#EC4899',
};

// ── Module state ──────────────────────────────────────────── //

let _filterMemberId  = null;   // null = all members
let _filterPostType  = 'All';
let _filterPinnedOnly = false;
let _filterTag       = null;

// ── Helpers ───────────────────────────────────────────────── //

function _getInitials(name) {
  if (!name) return '?';
  return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function _getPersonColor(person) {
  const c = person?.color;
  return PERSON_COLOR_MAP[c] || '#64748B';
}

function _timeAgo(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function _escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function _isImageUrl(url) {
  if (!url) return false;
  return /\.(jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i.test(url);
}

// ── Data loading ──────────────────────────────────────────── //

async function _loadData() {
  const [posts, persons, authData, allEdges] = await Promise.all([
    getEntitiesByType('post'),
    getEntitiesByType('person'),
    getSetting('auth'),
    _loadAllEdges(),
  ]);

  const personMap = new Map(persons.map(p => [p.id, p]));
  const accountMap = new Map();
  const accounts = authData?.accounts || [];
  for (const acct of accounts) {
    accountMap.set(acct.id, acct);
  }

  return { posts, persons, personMap, accountMap, allEdges };
}

async function _loadAllEdges() {
  // Load edges relevant to family wall: reacts-to, comments-on, attaches
  // We need all edges to/from posts — load post IDs first then query
  // Since we can't query by relation globally, load all edges and filter
  const { queryEntities } = await import('../core/db.js');
  const db = await import('../core/db.js');
  // Use a broad approach: get all edges from the edges store
  // db.js doesn't have a "getAll edges" — we'll load them per-post in render
  return null; // We'll load per-post instead
}

/**
 * Load reactions, comments, and attachments for a single post.
 */
async function _loadPostEdges(postId) {
  const [edgesTo, edgesFrom] = await Promise.all([
    getEdgesTo(postId),     // reactions, comments pointing TO this post
    getEdgesFrom(postId),   // attachments FROM this post
  ]);

  const reactions = [];   // { edgeId, emoji, personId }
  const commentIds = [];  // note entity IDs
  const attachedIds = []; // entity IDs attached to this post

  for (const e of edgesTo) {
    if (e.relation === 'reacts-to') {
      reactions.push({ edgeId: e.id, emoji: e.metadata?.emoji, personId: e.fromId });
    } else if (e.relation === 'comments-on') {
      commentIds.push(e.fromId);
    }
  }

  for (const e of edgesFrom) {
    if (e.relation === 'attaches') {
      attachedIds.push(e.toId);
    }
  }

  return { reactions, commentIds, attachedIds };
}

/**
 * Load comment entities by IDs.
 */
async function _loadComments(commentIds) {
  const comments = [];
  for (const cid of commentIds) {
    const entity = await getEntity(cid);
    if (entity && !entity.deleted) comments.push(entity);
  }
  comments.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return comments;
}

// ── Filtering ─────────────────────────────────────────────── //

function _filterPosts(posts, personMap) {
  let filtered = [...posts];

  // Member filter
  if (_filterMemberId) {
    filtered = filtered.filter(p => p.createdBy === _filterMemberId || p._authorPersonId === _filterMemberId);
  }

  // Post type filter
  if (_filterPostType && _filterPostType !== 'All') {
    filtered = filtered.filter(p => (p.postType || 'Text') === _filterPostType);
  }

  // Pinned-only
  if (_filterPinnedOnly) {
    filtered = filtered.filter(p => p.pinned);
  }

  // Tag filter
  if (_filterTag) {
    filtered = filtered.filter(p => {
      const tags = p.tags || [];
      return tags.includes(_filterTag);
    });
  }

  // Sort: pinned first, then newest first
  filtered.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });

  return filtered;
}

// ── DOM: Filter Bar ───────────────────────────────────────── //

function _buildFilterBar(container, persons, posts) {
  const bar = document.createElement('div');
  bar.className = 'fw-filter-bar';

  // Member avatars
  const memberRow = document.createElement('div');
  memberRow.className = 'fw-filter-members';

  // "All" button
  const allBtn = document.createElement('button');
  allBtn.className = 'fw-avatar-btn' + (!_filterMemberId ? ' active' : '');
  allBtn.textContent = 'All';
  allBtn.title = 'All members';
  allBtn.addEventListener('click', () => { _filterMemberId = null; renderWall({ _internal: true }); });
  memberRow.appendChild(allBtn);

  for (const p of persons) {
    const btn = document.createElement('button');
    btn.className = 'fw-avatar-btn' + (_filterMemberId === p.id ? ' active' : '');
    btn.style.cssText = `background: ${_getPersonColor(p)}; color: white;`;
    btn.textContent = _getInitials(p.name);
    btn.title = p.name || 'Member';
    btn.addEventListener('click', () => {
      _filterMemberId = _filterMemberId === p.id ? null : p.id;
      renderWall({ _internal: true });
    });
    memberRow.appendChild(btn);
  }
  bar.appendChild(memberRow);

  // Type filter + pinned toggle
  const typeRow = document.createElement('div');
  typeRow.className = 'fw-filter-types';

  for (const t of POST_TYPES) {
    const btn = document.createElement('button');
    btn.className = 'fw-type-btn' + (_filterPostType === t ? ' active' : '');
    btn.textContent = t;
    btn.addEventListener('click', () => { _filterPostType = t; renderWall({ _internal: true }); });
    typeRow.appendChild(btn);
  }

  const pinBtn = document.createElement('button');
  pinBtn.className = 'fw-type-btn' + (_filterPinnedOnly ? ' active' : '');
  pinBtn.textContent = '📌 Pinned';
  pinBtn.addEventListener('click', () => { _filterPinnedOnly = !_filterPinnedOnly; renderWall({ _internal: true }); });
  typeRow.appendChild(pinBtn);

  bar.appendChild(typeRow);

  // Tag filter (collect all tags from posts)
  const allTags = new Set();
  for (const p of posts) {
    for (const t of (p.tags || [])) allTags.add(t);
  }
  if (allTags.size > 0) {
    const tagRow = document.createElement('div');
    tagRow.className = 'fw-filter-tags';
    for (const tag of allTags) {
      const chip = document.createElement('button');
      chip.className = 'fw-tag-chip' + (_filterTag === tag ? ' active' : '');
      chip.textContent = `#${tag}`;
      chip.addEventListener('click', () => {
        _filterTag = _filterTag === tag ? null : tag;
        renderWall({ _internal: true });
      });
      tagRow.appendChild(chip);
    }
    bar.appendChild(tagRow);
  }

  container.appendChild(bar);
}

// ── DOM: Compose Box ──────────────────────────────────────── //

function _buildComposeBox(container, personMap) {
  const account = getAccount();
  if (!account) return;
  const person = personMap.get(account.memberId);

  const compose = document.createElement('div');
  compose.className = 'fw-compose';

  // Header row: avatar + type selector
  const header = document.createElement('div');
  header.className = 'fw-compose-header';

  const avatar = document.createElement('div');
  avatar.className = 'fw-avatar';
  avatar.style.background = _getPersonColor(person);
  avatar.textContent = _getInitials(person?.name || account.username);
  header.appendChild(avatar);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'fw-compose-name';
  nameSpan.textContent = person?.name || account.username;
  header.appendChild(nameSpan);

  compose.appendChild(header);

  // Text area
  const textarea = document.createElement('textarea');
  textarea.className = 'fw-compose-text';
  textarea.placeholder = "What's happening in the family?";
  textarea.rows = 3;
  compose.appendChild(textarea);

  // Options row
  const optRow = document.createElement('div');
  optRow.className = 'fw-compose-options';

  // Post type buttons
  let selectedType = 'Text';
  const typeGroup = document.createElement('div');
  typeGroup.className = 'fw-compose-type-btns';

  const typeButtons = [
    { label: '📷 Photo', type: 'Photo' },
    { label: '🔗 Link', type: 'Link' },
    { label: '🏆 Milestone', type: 'Milestone' },
  ];

  for (const tb of typeButtons) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-xs fw-compose-type-btn';
    btn.textContent = tb.label;
    btn.addEventListener('click', () => {
      selectedType = tb.type;
      urlInput.placeholder = tb.type === 'Photo' ? 'Paste image URL...' : 'Paste link URL...';
      urlInput.style.display = (tb.type === 'Photo' || tb.type === 'Link') ? '' : 'none';
      // Highlight active
      typeGroup.querySelectorAll('.fw-compose-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    typeGroup.appendChild(btn);
  }
  optRow.appendChild(typeGroup);

  // URL input (hidden by default)
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'input fw-compose-url';
  urlInput.placeholder = 'Paste image URL...';
  urlInput.style.display = 'none';
  compose.appendChild(urlInput);

  // Tag input
  const tagInput = document.createElement('input');
  tagInput.type = 'text';
  tagInput.className = 'input fw-compose-tag-input';
  tagInput.placeholder = 'Tags (comma-separated)';
  compose.appendChild(tagInput);

  // Action row
  const actionRow = document.createElement('div');
  actionRow.className = 'fw-compose-actions';
  actionRow.appendChild(optRow);

  const postBtn = document.createElement('button');
  postBtn.className = 'btn btn-primary btn-sm';
  postBtn.textContent = 'Post';
  postBtn.addEventListener('click', async () => {
    const body = textarea.value.trim();
    if (!body && selectedType === 'Text') return;

    postBtn.disabled = true;
    postBtn.textContent = 'Posting…';

    try {
      const tags = tagInput.value.split(',').map(t => t.trim()).filter(Boolean);
      const url = urlInput.value.trim();

      const postEntity = {
        type:     'post',
        body,
        postType: selectedType,
        photoUrl: selectedType === 'Photo' ? url : null,
        linkUrl:  selectedType === 'Link' ? url : null,
        pinned:   false,
        tags,
        _authorPersonId: account.memberId,
      };

      const saved = await saveEntity(postEntity, account.id);

      // Create author edge
      if (account.memberId) {
        await saveEdge({
          fromId: account.memberId,
          toId: saved.id,
          relation: 'posted-by',
        }, account.id);
      }

      // Reset compose
      textarea.value = '';
      urlInput.value = '';
      tagInput.value = '';
      urlInput.style.display = 'none';
      selectedType = 'Text';
      typeGroup.querySelectorAll('.fw-compose-type-btn').forEach(b => b.classList.remove('active'));

      renderWall({ _internal: true });
    } catch (err) {
      console.error('[family-wall] Post creation failed:', err);
    } finally {
      postBtn.disabled = false;
      postBtn.textContent = 'Post';
    }
  });

  actionRow.appendChild(postBtn);
  compose.appendChild(actionRow);
  container.appendChild(compose);
}

// ── DOM: Post Card ────────────────────────────────────────── //

async function _buildPostCard(post, personMap) {
  const card = document.createElement('article');
  card.className = 'fw-post-card';
  card.dataset.postId = post.id;

  const account = getAccount();
  const authorPerson = personMap.get(post._authorPersonId || post.createdBy);
  const isOwn = account && (post.createdBy === account.id || post._authorPersonId === account.memberId);
  const isAdmin = account?.role === 'admin';
  const isParent = authorPerson?.role === 'Parent' || isAdmin;

  // ── Pinned indicator ──
  if (post.pinned) {
    const pinBadge = document.createElement('div');
    pinBadge.className = 'fw-pin-badge';
    pinBadge.textContent = '📌 Pinned';
    card.appendChild(pinBadge);
  }

  // ── Header: avatar + name + time ──
  const hdr = document.createElement('div');
  hdr.className = 'fw-post-header';

  const avatar = document.createElement('div');
  avatar.className = 'fw-avatar';
  avatar.style.background = _getPersonColor(authorPerson);
  avatar.textContent = _getInitials(authorPerson?.name || 'Unknown');

  const meta = document.createElement('div');
  meta.className = 'fw-post-meta';

  const nameEl = document.createElement('span');
  nameEl.className = 'fw-post-author';
  nameEl.textContent = authorPerson?.name || 'Unknown';

  const timeEl = document.createElement('span');
  timeEl.className = 'fw-post-time';
  timeEl.textContent = _timeAgo(post.createdAt);
  timeEl.title = post.createdAt ? new Date(post.createdAt).toLocaleString() : '';

  // Post type badge
  if (post.postType && post.postType !== 'Text') {
    const typeBadge = document.createElement('span');
    typeBadge.className = 'fw-post-type-badge';
    const icons = { Photo: '📷', Link: '🔗', Milestone: '🏆' };
    typeBadge.textContent = icons[post.postType] || '';
    meta.appendChild(typeBadge);
  }

  meta.prepend(nameEl);
  meta.appendChild(timeEl);
  hdr.append(avatar, meta);

  // Action menu (hover)
  const actions = document.createElement('div');
  actions.className = 'fw-post-actions';

  if (isAdmin || isParent) {
    const pinBtn = document.createElement('button');
    pinBtn.className = 'btn-icon fw-action-btn';
    pinBtn.title = post.pinned ? 'Unpin' : 'Pin';
    pinBtn.textContent = post.pinned ? '📌' : '📍';
    pinBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      post.pinned = !post.pinned;
      await saveEntity(post, account?.id);
      renderWall({ _internal: true });
    });
    actions.appendChild(pinBtn);
  }

  if (isOwn || isAdmin) {
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-icon fw-action-btn fw-action-danger';
    delBtn.title = 'Delete post';
    delBtn.textContent = '🗑️';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('Delete this post?')) {
        await deleteEntity(post.id, account?.id);
        renderWall({ _internal: true });
      }
    });
    actions.appendChild(delBtn);
  }

  hdr.appendChild(actions);
  card.appendChild(hdr);

  // ── Body content ──
  const body = document.createElement('div');
  body.className = 'fw-post-body';

  if (post.body) {
    const textEl = document.createElement('p');
    textEl.className = 'fw-post-text';
    textEl.textContent = post.body;
    body.appendChild(textEl);
  }

  // Photo
  if (post.postType === 'Photo' && post.photoUrl) {
    const img = document.createElement('img');
    img.className = 'fw-post-image';
    img.src = post.photoUrl;
    img.alt = 'Post image';
    img.loading = 'lazy';
    img.addEventListener('error', () => { img.style.display = 'none'; });
    body.appendChild(img);
  }

  // Link preview
  if (post.postType === 'Link' && post.linkUrl) {
    const linkCard = document.createElement('a');
    linkCard.className = 'fw-link-preview';
    linkCard.href = post.linkUrl;
    linkCard.target = '_blank';
    linkCard.rel = 'noopener noreferrer';
    linkCard.innerHTML = `
      <span class="fw-link-icon">🔗</span>
      <span class="fw-link-url">${_escHtml(post.linkUrl)}</span>
    `;
    body.appendChild(linkCard);
  }

  // Milestone badge
  if (post.postType === 'Milestone') {
    const milestone = document.createElement('div');
    milestone.className = 'fw-milestone-badge';
    milestone.textContent = '🏆 Family Milestone';
    body.appendChild(milestone);
  }

  // Tags
  if (post.tags?.length > 0) {
    const tagRow = document.createElement('div');
    tagRow.className = 'fw-post-tags';
    for (const t of post.tags) {
      const chip = document.createElement('span');
      chip.className = 'fw-tag-chip';
      chip.textContent = `#${t}`;
      tagRow.appendChild(chip);
    }
    body.appendChild(tagRow);
  }

  card.appendChild(body);

  // ── Load edges for reactions, comments, attachments ──
  const { reactions, commentIds, attachedIds } = await _loadPostEdges(post.id);

  // ── Attached entities ──
  if (attachedIds.length > 0) {
    const attachRow = document.createElement('div');
    attachRow.className = 'fw-attach-row';
    for (const aid of attachedIds) {
      const entity = await getEntity(aid);
      if (!entity) continue;
      const chip = document.createElement('button');
      chip.className = 'fw-attach-chip';
      chip.textContent = `${entity.title || entity.name || entity.label || 'Entity'}`;
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        emit(EVENTS.PANEL_OPENED, { entityType: entity.type, entityId: entity.id });
      });
      attachRow.appendChild(chip);
    }
    card.appendChild(attachRow);
  }

  // ── Reaction bar ──
  const reactionBar = document.createElement('div');
  reactionBar.className = 'fw-reaction-bar';

  const currentPersonId = account?.memberId;

  for (const emoji of REACTIONS) {
    const matching = reactions.filter(r => r.emoji === emoji);
    const count = matching.length;
    const myReaction = matching.find(r => r.personId === currentPersonId);

    const btn = document.createElement('button');
    btn.className = 'fw-reaction-btn' + (myReaction ? ' active' : '');
    btn.innerHTML = `${emoji}${count > 0 ? ` <span class="fw-reaction-count">${count}</span>` : ''}`;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (myReaction) {
        // Toggle off: delete the edge
        await deleteEdge(myReaction.edgeId, account?.id);
      } else {
        // Toggle on: create reaction edge
        await saveEdge({
          fromId: currentPersonId,
          toId: post.id,
          relation: 'reacts-to',
          metadata: { emoji },
        }, account?.id);
      }
      // Re-render just this card's reactions
      renderWall({ _internal: true });
    });
    reactionBar.appendChild(btn);
  }

  // Comment count button
  const commentBtn = document.createElement('button');
  commentBtn.className = 'fw-comment-toggle';
  commentBtn.textContent = `💬 ${commentIds.length}`;
  commentBtn.addEventListener('click', () => {
    const thread = card.querySelector('.fw-comment-thread');
    if (thread) thread.classList.toggle('open');
  });
  reactionBar.appendChild(commentBtn);

  // Attach button
  const attachBtn = document.createElement('button');
  attachBtn.className = 'fw-reaction-btn';
  attachBtn.textContent = '📎';
  attachBtn.title = 'Attach entity';
  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Use FAB search to attach
    emit(EVENTS.FAB_CREATE, {
      entityType: 'note', // opens entity search
      prefill: { _attachToPost: post.id },
    });
  });
  reactionBar.appendChild(attachBtn);

  card.appendChild(reactionBar);

  // ── Comment thread (initially collapsed) ──
  const thread = document.createElement('div');
  thread.className = 'fw-comment-thread';

  // Existing comments
  const comments = await _loadComments(commentIds);
  for (const comment of comments) {
    const commentPerson = personMap.get(comment.createdBy);
    const commentEl = _buildCommentEl(comment, commentPerson);
    thread.appendChild(commentEl);
  }

  // New comment input
  const commentInput = document.createElement('div');
  commentInput.className = 'fw-comment-input';

  const commentText = document.createElement('input');
  commentText.type = 'text';
  commentText.className = 'input fw-comment-field';
  commentText.placeholder = 'Write a comment...';

  const commentPostBtn = document.createElement('button');
  commentPostBtn.className = 'btn btn-primary btn-xs';
  commentPostBtn.textContent = 'Reply';
  commentPostBtn.addEventListener('click', async () => {
    const text = commentText.value.trim();
    if (!text) return;

    commentPostBtn.disabled = true;
    try {
      // Save comment as a note entity
      const commentEntity = await saveEntity({
        type: 'note',
        title: text.slice(0, 80),
        body: text,
        category: 'Comment',
      }, account?.id);

      // Create edge: comment → post
      await saveEdge({
        fromId: commentEntity.id,
        toId: post.id,
        relation: 'comments-on',
      }, account?.id);

      commentText.value = '';
      renderWall({ _internal: true });
    } catch (err) {
      console.error('[family-wall] Comment failed:', err);
    } finally {
      commentPostBtn.disabled = false;
    }
  });

  // Enter key submits
  commentText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commentPostBtn.click();
    }
  });

  commentInput.append(commentText, commentPostBtn);
  thread.appendChild(commentInput);
  card.appendChild(thread);

  return card;
}

function _buildCommentEl(comment, person) {
  const el = document.createElement('div');
  el.className = 'fw-comment';

  const avatar = document.createElement('div');
  avatar.className = 'fw-avatar fw-avatar-sm';
  avatar.style.background = _getPersonColor(person);
  avatar.textContent = _getInitials(person?.name || '?');

  const content = document.createElement('div');
  content.className = 'fw-comment-content';

  const nameLine = document.createElement('div');
  nameLine.className = 'fw-comment-name';
  nameLine.innerHTML = `<strong>${_escHtml(person?.name || 'Unknown')}</strong> <span class="fw-comment-time">${_timeAgo(comment.createdAt)}</span>`;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'fw-comment-body';
  bodyEl.textContent = comment.body || comment.title || '';

  content.append(nameLine, bodyEl);
  el.append(avatar, content);
  return el;
}

// ── Style injection ───────────────────────────────────────── //

function _injectStyles() {
  if (document.getElementById('family-wall-styles')) return;
  const style = document.createElement('style');
  style.id = 'family-wall-styles';
  style.textContent = `
    /* ── Wall Layout ──────────────────────────────────── */
    #view-family-wall {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      padding: var(--space-5) var(--space-6);
      max-width: 680px;
      margin: 0 auto;
      width: 100%;
    }
    @media (max-width: 600px) {
      #view-family-wall { padding: var(--space-3); }
    }

    /* ── Filter Bar ──────────────────────────────────── */
    .fw-filter-bar {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding: var(--space-3);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .fw-filter-members {
      display: flex;
      gap: var(--space-1-5);
      flex-wrap: wrap;
      align-items: center;
    }
    .fw-avatar-btn {
      width: 32px;
      height: 32px;
      border-radius: var(--radius-full);
      border: 2px solid transparent;
      font-size: 11px;
      font-weight: var(--weight-bold);
      font-family: var(--font-body);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all var(--transition-fast);
      background: var(--color-surface-2);
      color: var(--color-text-muted);
    }
    .fw-avatar-btn.active {
      border-color: var(--color-accent);
      box-shadow: 0 0 0 2px rgba(10, 123, 108, 0.2);
    }
    .fw-avatar-btn:hover { opacity: 0.85; }
    .fw-filter-types {
      display: flex;
      gap: var(--space-1);
      flex-wrap: wrap;
    }
    .fw-type-btn {
      padding: var(--space-1) var(--space-2-5);
      font-size: var(--text-xs);
      font-family: var(--font-body);
      font-weight: var(--weight-medium);
      color: var(--color-text-muted);
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-full);
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .fw-type-btn:hover { background: var(--color-surface-2); color: var(--color-text); }
    .fw-type-btn.active {
      background: var(--color-accent);
      color: white;
      border-color: var(--color-accent);
    }
    .fw-filter-tags {
      display: flex;
      gap: var(--space-1);
      flex-wrap: wrap;
    }
    .fw-tag-chip {
      padding: 2px 8px;
      font-size: var(--text-xs);
      font-family: var(--font-body);
      color: var(--color-text-muted);
      background: var(--color-surface-2);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-full);
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .fw-tag-chip:hover { color: var(--color-text); }
    .fw-tag-chip.active {
      background: var(--color-info-bg);
      color: var(--color-info-text);
      border-color: var(--color-info);
    }

    /* ── Compose Box ─────────────────────────────────── */
    .fw-compose {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-4);
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-xs);
    }
    .fw-compose-header {
      display: flex;
      align-items: center;
      gap: var(--space-2-5);
    }
    .fw-compose-name {
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-text);
    }
    .fw-compose-text {
      resize: vertical;
      min-height: 60px;
      padding: var(--space-2-5);
      font-family: var(--font-body);
      font-size: var(--text-sm);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
      color: var(--color-text);
      transition: border-color var(--transition-fast);
    }
    .fw-compose-text:focus {
      outline: none;
      border-color: var(--color-accent);
      box-shadow: var(--shadow-focus);
    }
    .fw-compose-url, .fw-compose-tag-input {
      font-size: var(--text-sm);
      padding: var(--space-1-5) var(--space-2-5);
    }
    .fw-compose-options {
      display: flex;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .fw-compose-type-btns {
      display: flex;
      gap: var(--space-1);
    }
    .fw-compose-type-btn.active {
      background: var(--color-accent);
      color: white;
    }
    .fw-compose-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }

    /* ── Avatar ───────────────────────────────────────── */
    .fw-avatar {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-full);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: var(--weight-bold);
      color: white;
      flex-shrink: 0;
      font-family: var(--font-body);
    }
    .fw-avatar-sm { width: 26px; height: 26px; font-size: 10px; }

    /* ── Post Card ────────────────────────────────────── */
    .fw-post-card {
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      overflow: hidden;
      transition: box-shadow var(--transition-base);
    }
    .fw-post-card:hover { box-shadow: var(--shadow-sm); }
    .fw-pin-badge {
      padding: var(--space-1-5) var(--space-3);
      font-size: var(--text-xs);
      font-weight: var(--weight-semibold);
      color: var(--color-warning-text);
      background: var(--color-warning-bg);
      border-bottom: 1px solid var(--color-border);
    }
    .fw-post-header {
      display: flex;
      align-items: center;
      gap: var(--space-2-5);
      padding: var(--space-3) var(--space-4);
      position: relative;
    }
    .fw-post-meta {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    .fw-post-author {
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-text);
    }
    .fw-post-time {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
    }
    .fw-post-type-badge {
      font-size: var(--text-xs);
      margin-left: var(--space-1);
    }
    .fw-post-actions {
      display: flex;
      gap: var(--space-1);
      opacity: 0;
      transition: opacity var(--transition-fast);
    }
    .fw-post-card:hover .fw-post-actions { opacity: 1; }
    .fw-action-btn { width: 28px; height: 28px; font-size: 14px; }
    .fw-action-danger:hover { background: var(--color-danger-bg); }

    /* ── Post Body ────────────────────────────────────── */
    .fw-post-body {
      padding: 0 var(--space-4) var(--space-3);
    }
    .fw-post-text {
      font-size: var(--text-sm);
      color: var(--color-text);
      line-height: var(--leading-relaxed);
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .fw-post-image {
      width: 100%;
      max-height: 400px;
      object-fit: cover;
      border-radius: var(--radius-sm);
      margin-top: var(--space-2);
    }
    .fw-link-preview {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2-5) var(--space-3);
      margin-top: var(--space-2);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      text-decoration: none;
      color: var(--color-text-link);
      font-size: var(--text-sm);
      transition: background var(--transition-fast);
    }
    .fw-link-preview:hover { background: var(--color-surface-2); }
    .fw-link-icon { font-size: var(--text-md); flex-shrink: 0; }
    .fw-link-url {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fw-milestone-badge {
      padding: var(--space-2) var(--space-3);
      margin-top: var(--space-2);
      background: linear-gradient(135deg, #fef3c7, #fde68a);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: #92400e;
      text-align: center;
    }
    .fw-post-tags {
      display: flex;
      gap: var(--space-1);
      flex-wrap: wrap;
      margin-top: var(--space-2);
    }

    /* ── Attached entities ────────────────────────────── */
    .fw-attach-row {
      display: flex;
      gap: var(--space-1-5);
      flex-wrap: wrap;
      padding: 0 var(--space-4) var(--space-2);
    }
    .fw-attach-chip {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      padding: 3px 10px;
      font-size: var(--text-xs);
      font-family: var(--font-body);
      background: var(--color-surface-2);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-full);
      cursor: pointer;
      transition: background var(--transition-fast);
      color: var(--color-text);
    }
    .fw-attach-chip:hover { background: var(--color-surface); border-color: var(--color-accent); }

    /* ── Reaction bar ─────────────────────────────────── */
    .fw-reaction-bar {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      padding: var(--space-2) var(--space-4);
      border-top: 1px solid var(--color-border);
      flex-wrap: wrap;
    }
    .fw-reaction-btn {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: var(--space-1) var(--space-2);
      font-size: 14px;
      font-family: var(--font-body);
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-full);
      cursor: pointer;
      transition: all var(--transition-fast);
      line-height: 1;
    }
    .fw-reaction-btn:hover {
      background: var(--color-surface);
      border-color: var(--color-text-muted);
    }
    .fw-reaction-btn.active {
      background: var(--color-info-bg);
      border-color: var(--color-info);
    }
    .fw-reaction-count {
      font-size: 11px;
      font-weight: var(--weight-semibold);
      color: var(--color-text-muted);
    }
    .fw-comment-toggle {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: var(--space-1) var(--space-2);
      font-size: 13px;
      font-family: var(--font-body);
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-full);
      cursor: pointer;
      margin-left: auto;
      transition: all var(--transition-fast);
    }
    .fw-comment-toggle:hover { background: var(--color-surface); }

    /* ── Comment thread ───────────────────────────────── */
    .fw-comment-thread {
      display: none;
      flex-direction: column;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-4);
      border-top: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    .fw-comment-thread.open { display: flex; }
    .fw-comment {
      display: flex;
      gap: var(--space-2);
      align-items: flex-start;
    }
    .fw-comment-content { flex: 1; min-width: 0; }
    .fw-comment-name {
      font-size: var(--text-xs);
      color: var(--color-text);
    }
    .fw-comment-time {
      font-weight: var(--weight-regular);
      color: var(--color-text-muted);
      margin-left: var(--space-1);
    }
    .fw-comment-body {
      font-size: var(--text-sm);
      color: var(--color-text);
      line-height: var(--leading-normal);
      margin-top: 2px;
    }
    .fw-comment-input {
      display: flex;
      gap: var(--space-2);
      align-items: center;
      margin-top: var(--space-1);
    }
    .fw-comment-field {
      flex: 1;
      font-size: var(--text-sm);
      padding: var(--space-1-5) var(--space-2-5);
    }

    /* ── Empty state ──────────────────────────────────── */
    .fw-empty {
      padding: var(--space-10) var(--space-4);
      text-align: center;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }
  `;
  document.head.appendChild(style);
}

// ── Main render ───────────────────────────────────────────── //

async function renderWall(params = {}) {
  const viewEl = document.getElementById('view-family-wall');
  if (!viewEl) return;

  _injectStyles();

  if (!params?._internal) {
    // Fresh navigation — reset filters
    _filterMemberId   = null;
    _filterPostType   = 'All';
    _filterPinnedOnly = false;
    _filterTag        = null;
  }

  viewEl.innerHTML = `
    <div style="padding: var(--space-8); color: var(--color-text-muted); text-align: center;">
      Loading Family Wall…
    </div>
  `;

  try {
    const { posts, persons, personMap, accountMap } = await _loadData();
    const filtered = _filterPosts(posts, personMap);

    viewEl.innerHTML = '';

    // Filter bar
    _buildFilterBar(viewEl, persons, posts);

    // Compose box
    _buildComposeBox(viewEl, personMap);

    // Posts
    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'fw-empty';
      empty.textContent = _filterPinnedOnly || _filterPostType !== 'All' || _filterMemberId || _filterTag
        ? 'No posts match your filters.'
        : 'No posts yet. Be the first to share something!';
      viewEl.appendChild(empty);
    } else {
      for (const post of filtered) {
        const card = await _buildPostCard(post, personMap);
        viewEl.appendChild(card);
      }
    }

  } catch (err) {
    console.error('[family-wall] Render failed:', err);
    viewEl.innerHTML = `
      <div style="padding: var(--space-8); color: var(--color-danger-text); text-align: center;">
        Failed to load Family Wall. Please try refreshing.
      </div>
    `;
  }
}

// ── Live update listeners ─────────────────────────────────── //

let _wallRenderTimer = null;
function _debouncedWallRender() {
  if (_wallRenderTimer) clearTimeout(_wallRenderTimer);
  _wallRenderTimer = setTimeout(() => {
    _wallRenderTimer = null;
    const viewEl = document.getElementById('view-family-wall');
    if (viewEl && viewEl.classList.contains('active')) {
      renderWall({ _internal: true });
    }
  }, 200);
}

on(EVENTS.ENTITY_SAVED,   _debouncedWallRender);
on(EVENTS.ENTITY_DELETED, _debouncedWallRender);
on(EVENTS.EDGE_SAVED,     _debouncedWallRender);
on(EVENTS.EDGE_DELETED,   _debouncedWallRender);

// ── Registration ──────────────────────────────────────────── //

registerView('family-wall', renderWall);

export { renderWall };
