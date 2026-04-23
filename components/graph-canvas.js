/**
 * FamilyHub v2.0 — components/graph-canvas.js
 * Force-directed physics canvas — reusable in graph view AND entity panel mini-graph
 * Blueprint §9.2 (graph canvas), §6.5 (relation edge colors)
 *
 * Public API (all named exports):
 *   initGraph(canvasEl, options)   — mount graph on a canvas element
 *   setFocusId(id)                — enter/change focus mode
 *   setActiveTypes(typesSet)      — filter visible node types
 *   refreshGraph()                — rebuild nodes/edges from DB and re-layout
 *   destroyGraph()                — tear down RAF loop, listeners, state
 *
 * [minor] Initial implementation of graph-canvas component
 */

import { getEntitiesByType, getEntity, getEdgesFrom, getEdgesTo } from '../core/db.js';
import { getAllEntityTypes, getEntityTypeConfig, getRelationLabel } from '../core/graph-engine.js';
import { emit, on, off, EVENTS } from '../core/events.js';

// ══════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════

/** @type {HTMLCanvasElement|null} */
let _canvas = null;
/** @type {CanvasRenderingContext2D|null} */
let _ctx = null;

/** @type {{ id:string, type:string, label:string, icon:string, color:string, x:number, y:number, vx:number, vy:number }[]} */
let _nodes = [];
/** @type {{ fromId:string, toId:string, relation:string, color:string }[]} */
let _edges = [];

let _offset   = { x: 0, y: 0 };
let _scale     = 1.0;
let _hoverId   = null;
let _selectedId = null;
let _focusId   = null;
/** @type {{ id:string, type:string, label:string }[]} */
let _focusTrail = [];

let _isDragging  = false;
let _dragNode    = null;
let _dragVx      = 0;
let _dragVy      = 0;
let _wPh         = 0;

let _panStart    = null;   // { mx, my, ox, oy } for background pan
let _rafId       = null;
let _frameCount  = 0;
let _physicsRunning = false;

/** @type {Set<string>} — which entity type keys are shown */
let _activeTypes = new Set();

/** @type {{ mini?: boolean, focusEntityId?: string }} */
let _options = {};

// ── Relation edge color map (Blueprint §6.5) ────────────── //
const EDGE_COLORS = {
  'assigned to':    '#4f8ef7',
  'part of':        '#10b981',
  'blocked by':     '#ef4444',
  'attended by':    '#a855f7',
  'belongs to':     '#f97316',
  'paid by':        '#059669',
  'for project':    '#10b981',
  'owned by':       '#7c3aed',
  'practised by':   '#0d9488',
  'uses recipe':    '#f97316',
  'prescribed to':  '#06b6d4',
  'added by':       '#f59e0b',
  'traveller':      '#0891b2',
  'related to':     '#94a3b8',
};

// ── Physics constants (exact — do not change) ────────────── //
const REPULSION_K     = 4500;
const SPRING_STIFFNESS = 0.04;
const SPRING_REST_LEN  = 130;
const DAMPING          = 0.88;
const CENTER_GRAVITY   = 0.004;
const BOUNCE_FACTOR    = -0.55;
const EDGE_PADDING     = 44;
const STOP_VEL_SUM     = 0.08;
const MAX_FRAMES       = 300;
const STATIC_ITERS     = 200;

// ── Node rendering constants ─────────────────────────────── //
const NODE_RADIUS      = 20;
const HOVER_EXTRA      = 3;
const SELECTED_RING    = 3;
const LABEL_FONT       = '11px -apple-system, BlinkMacSystemFont, sans-serif';
const EDGE_FONT        = '9px -apple-system, BlinkMacSystemFont, sans-serif';
const TOOLTIP_FONT     = '12px -apple-system, BlinkMacSystemFont, sans-serif';

// ══════════════════════════════════════════════════════════════
// INIT / DESTROY
// ══════════════════════════════════════════════════════════════

/**
 * Mount the force-directed graph on a <canvas> element.
 *
 * @param {HTMLCanvasElement} canvasEl
 * @param {object} [options]
 * @param {boolean} [options.mini]          — true = mini-graph in entity panel
 * @param {string}  [options.focusEntityId] — if set, start in focus mode on this entity
 * @param {Set<string>} [options.activeTypes] — initial type filter (all if omitted)
 */
export async function initGraph(canvasEl, options = {}) {
  if (!canvasEl || !(canvasEl instanceof HTMLCanvasElement)) {
    console.error('[graph-canvas] initGraph requires a <canvas> element.');
    return;
  }

  _canvas  = canvasEl;
  _ctx     = canvasEl.getContext('2d');
  _options = { ...options };

  // Default activeTypes = all graphVisible types
  if (options.activeTypes instanceof Set && options.activeTypes.size > 0) {
    _activeTypes = new Set(options.activeTypes);
  } else {
    const allTypes = getAllEntityTypes();
    _activeTypes = new Set(allTypes.filter(t => t.graphVisible).map(t => t.key));
  }

  // Reset state
  _offset     = { x: 0, y: 0 };
  _scale      = options.mini ? 0.8 : 1.0;
  _hoverId    = null;
  _selectedId = null;
  _focusId    = options.focusEntityId || null;
  _focusTrail = [];
  _isDragging = false;
  _dragNode   = null;
  _dragVx     = 0;
  _dragVy     = 0;
  _wPh        = 0;

  // Size canvas to container
  _resizeCanvas();

  // Wire event listeners
  _wireListeners();

  // Build and render
  await _buildGraph();

  console.log('[graph-canvas] [minor] initGraph: mounted with', _nodes.length, 'nodes,', _edges.length, 'edges');
}

/**
 * Tear down everything — RAF, listeners, state.
 */
export function destroyGraph() {
  _stopPhysics();
  _unwireListeners();

  _canvas     = null;
  _ctx        = null;
  _nodes      = [];
  _edges      = [];
  _offset     = { x: 0, y: 0 };
  _scale      = 1.0;
  _hoverId    = null;
  _selectedId = null;
  _focusId    = null;
  _focusTrail = [];
  _isDragging = false;
  _dragNode   = null;
  _options    = {};
  _activeTypes.clear();
}

// ══════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════

/**
 * Enter or change focus mode — show only focusId + direct neighbors.
 * @param {string|null} id — null to exit focus mode
 */
export async function setFocusId(id) {
  if (id) {
    const entity = await getEntity(id);
    if (entity) {
      _focusTrail.push({
        id:    entity.id,
        type:  entity.type,
        label: _getDisplayTitle(entity),
      });
    }
    _focusId = id;
  } else {
    _focusId    = null;
    _focusTrail = [];
  }
  await _buildGraph();
}

/**
 * Update which entity types are visible.
 * @param {Set<string>} typesSet
 */
export async function setActiveTypes(typesSet) {
  _activeTypes = new Set(typesSet);
  await _buildGraph();
}

/**
 * Rebuild nodes + edges from DB, re-layout, re-render.
 */
export async function refreshGraph() {
  await _buildGraph();
}

/**
 * Return the Set of entity type keys currently rendered as nodes in the graph.
 * Used by entity-panel to build accurate filter chips (only types in graph).
 * @returns {Set<string>}
 */
export function getActiveNodeTypes() {
  const types = new Set();
  for (const node of _nodes) {
    if (node.type) types.add(node.type);
  }
  return types;
}

// ══════════════════════════════════════════════════════════════
// BUILD PIPELINE
// ══════════════════════════════════════════════════════════════

/**
 * Full build pipeline:
 * 1. Filter nodes by activeTypes
 * 2. If focusId: keep only focusId + direct neighbors
 * 3. Assign random initial positions (or preserve existing)
 * 4. Run static layout (200 iterations)
 * 5. Start RAF physics loop
 */
async function _buildGraph() {
  _stopPhysics();

  if (!_canvas || !_ctx) return;

  const w = _canvas.width;
  const h = _canvas.height;

  // ── Step 1: Gather all entities matching activeTypes ─────
  const allTypes = getAllEntityTypes();
  const visibleTypes = allTypes.filter(t => _activeTypes.has(t.key));

  /** @type {Map<string, object>} id → entity */
  const entityMap = new Map();

  for (const typeConfig of visibleTypes) {
    try {
      const entities = await getEntitiesByType(typeConfig.key);
      for (const ent of entities) {
        if (ent.deleted) continue;
        entityMap.set(ent.id, ent);
      }
    } catch (err) {
      console.warn('[graph-canvas] Failed to load type', typeConfig.key, err);
    }
  }

  // ── Step 2: Gather edges ────────────────────────────────
  const rawEdges = [];
  for (const [id] of entityMap) {
    try {
      const outgoing = await getEdgesFrom(id);
      for (const edge of outgoing) {
        if (entityMap.has(edge.toId)) {
          rawEdges.push(edge);
        }
      }
    } catch { /* skip */ }
  }

  // ── Step 2b: Focus mode — keep only focusId + neighbors ─
  let visibleIds;
  if (_focusId && entityMap.has(_focusId)) {
    visibleIds = new Set([_focusId]);
    for (const edge of rawEdges) {
      if (edge.fromId === _focusId) visibleIds.add(edge.toId);
      if (edge.toId === _focusId)   visibleIds.add(edge.fromId);
    }
    // Also check incoming edges to focusId that we might not have
    try {
      const incoming = await getEdgesTo(_focusId);
      for (const edge of incoming) {
        if (entityMap.has(edge.fromId)) visibleIds.add(edge.fromId);
      }
    } catch { /* skip */ }
  } else {
    visibleIds = new Set(entityMap.keys());
  }

  // ── Step 3: Build node objects, preserve positions ──────
  const prevPositions = new Map(_nodes.map(n => [n.id, { x: n.x, y: n.y }]));

  _nodes = [];
  for (const id of visibleIds) {
    const ent = entityMap.get(id);
    if (!ent) continue;
    const cfg = getEntityTypeConfig(ent.type);
    if (!cfg) continue;

    const prev     = prevPositions.get(id);

    _nodes.push({
      id:    ent.id,
      type:  ent.type,
      label: _getDisplayTitle(ent).slice(0, 24),
      icon:  cfg.icon,
      color: cfg.color,
      x:     prev ? prev.x : (w / 2) + (Math.random() - 0.5) * w * 0.6,
      y:     prev ? prev.y : (h / 2) + (Math.random() - 0.5) * h * 0.6,
      vx:    0,
      vy:    0,
    });
  }

  // Build node id set for edge filtering
  const nodeIdSet = new Set(_nodes.map(n => n.id));

  // ── Step 4: Build edge objects ──────────────────────────
  _edges = [];
  for (const edge of rawEdges) {
    if (!nodeIdSet.has(edge.fromId) || !nodeIdSet.has(edge.toId)) continue;

    const fromEnt = entityMap.get(edge.fromId);
    const relation = edge.relation || getRelationLabel(fromEnt?.type, entityMap.get(edge.toId)?.type);
    const color    = EDGE_COLORS[relation] || EDGE_COLORS['related to'];

    _edges.push({
      fromId:   edge.fromId,
      toId:     edge.toId,
      relation: relation,
      color:    color,
    });
  }

  // ── Step 5: Static layout — 200 iterations ──────────────
  for (let i = 0; i < STATIC_ITERS; i++) {
    _physicsTick();
  }

  // ── Step 6: Start RAF physics loop ──────────────────────
  _frameCount = 0;
  _physicsRunning = true;
  _rafLoop();
}

// ══════════════════════════════════════════════════════════════
// PHYSICS
// ══════════════════════════════════════════════════════════════

/**
 * Single physics tick — repulsion, springs, damping, center gravity, boundary bounce.
 */
function _physicsTick() {
  const n = _nodes.length;
  if (n === 0) return;

  const w = _canvas?.width  || 800;
  const h = _canvas?.height || 600;
  const cx = w / 2;
  const cy = h / 2;

  // ── Repulsion: 4500 / dist² between all pairs ──────────
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a  = _nodes[i];
      const b  = _nodes[j];
      let dx   = a.x - b.x;
      let dy   = a.y - b.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) {
        // Coincident nodes: add tiny random jitter so force has a direction
        dx   = (Math.random() - 0.5) * 2;
        dy   = (Math.random() - 0.5) * 2;
        dist = 1;
      }

      const force = REPULSION_K / (dist * dist);
      const fx    = (dx / dist) * force;
      const fy    = (dy / dist) * force;

      // Skip dragged node — don't apply forces to it
      if (a !== _dragNode) { a.vx += fx; a.vy += fy; }
      if (b !== _dragNode) { b.vx -= fx; b.vy -= fy; }
    }
  }

  // ── Springs: stiffness 0.04, rest length 130px ─────────
  for (const edge of _edges) {
    const a = _nodes.find(nd => nd.id === edge.fromId);
    const b = _nodes.find(nd => nd.id === edge.toId);
    if (!a || !b) continue;

    let dx   = b.x - a.x;
    let dy   = b.y - a.y;
    let dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) dist = 1;

    const displacement = dist - SPRING_REST_LEN;
    const force        = SPRING_STIFFNESS * displacement;
    const fx           = (dx / dist) * force;
    const fy           = (dy / dist) * force;

    if (a !== _dragNode) { a.vx += fx; a.vy += fy; }
    if (b !== _dragNode) { b.vx -= fx; b.vy -= fy; }
  }

  // ── Center gravity: nudge 0.004 × dist to center ───────
  for (const node of _nodes) {
    if (node === _dragNode) continue;
    const dx = cx - node.x;
    const dy = cy - node.y;
    node.vx += dx * CENTER_GRAVITY;
    node.vy += dy * CENTER_GRAVITY;
  }

  // ── Damping + position update ──────────────────────────
  for (const node of _nodes) {
    if (node === _dragNode) continue;
    node.vx *= DAMPING;
    node.vy *= DAMPING;
    node.x  += node.vx;
    node.y  += node.vy;
  }

  // ── Boundary bounce: velocity × -0.55 at edges (44px padding) ──
  for (const node of _nodes) {
    if (node === _dragNode) continue;

    if (node.x < EDGE_PADDING) {
      node.x  = EDGE_PADDING;
      node.vx = node.vx * BOUNCE_FACTOR;  // BOUNCE_FACTOR is -0.55
    } else if (node.x > w - EDGE_PADDING) {
      node.x  = w - EDGE_PADDING;
      node.vx = node.vx * BOUNCE_FACTOR;
    }

    if (node.y < EDGE_PADDING) {
      node.y  = EDGE_PADDING;
      node.vy = node.vy * BOUNCE_FACTOR;
    } else if (node.y > h - EDGE_PADDING) {
      node.y  = h - EDGE_PADDING;
      node.vy = node.vy * BOUNCE_FACTOR;
    }
  }
}

/**
 * RAF render + physics loop.
 */
function _rafLoop() {
  if (!_physicsRunning || !_canvas || !_ctx) return;

  _physicsTick();
  _render();

  _frameCount++;

  // ── Stop condition: sum |vx|+|vy| < 0.08 OR 300 frames ──
  let totalVel = 0;
  for (const node of _nodes) {
    totalVel += Math.abs(node.vx) + Math.abs(node.vy);
  }

  if (totalVel < STOP_VEL_SUM && _frameCount > 10 && !_dragNode) {
    _physicsRunning = false;
    _render(); // final frame
    return;
  }
  if (_frameCount >= MAX_FRAMES && !_dragNode) {
    _physicsRunning = false;
    _render();
    return;
  }

  _rafId = requestAnimationFrame(_rafLoop);
}

function _stopPhysics() {
  _physicsRunning = false;
  if (_rafId) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
}

function _startPhysics() {
  if (_physicsRunning) return;
  _frameCount     = 0;
  _physicsRunning = true;
  _rafLoop();
}

// ══════════════════════════════════════════════════════════════
// RENDERING
// ══════════════════════════════════════════════════════════════

function _render() {
  if (!_ctx || !_canvas) return;

  const ctx = _ctx;
  const w   = _canvas.width;
  const h   = _canvas.height;
  const dpr = window.devicePixelRatio || 1;

  ctx.clearRect(0, 0, w, h);
  ctx.save();

  // Apply DPR scaling first, then pan + zoom in CSS-pixel space
  // This keeps _offset and _scale in CSS-pixel units, consistent with _screenToGraph
  ctx.scale(dpr, dpr);
  ctx.translate(_offset.x, _offset.y);
  ctx.scale(_scale, _scale);

  const isFocusMode = !!_focusId;
  const focusNeighborIds = new Set();

  if (isFocusMode) {
    for (const edge of _edges) {
      if (edge.fromId === _focusId) focusNeighborIds.add(edge.toId);
      if (edge.toId === _focusId)   focusNeighborIds.add(edge.fromId);
    }
    focusNeighborIds.add(_focusId);
  }

  // ── Draw edges ─────────────────────────────────────────
  for (const edge of _edges) {
    const from = _nodes.find(n => n.id === edge.fromId);
    const to   = _nodes.find(n => n.id === edge.toId);
    if (!from || !to) continue;

    const dimmed = isFocusMode &&
      !focusNeighborIds.has(edge.fromId) &&
      !focusNeighborIds.has(edge.toId);

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = edge.color;
    ctx.globalAlpha = dimmed ? 0.3 : 0.6;
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Edge label at midpoint
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    ctx.font      = EDGE_FONT;
    ctx.fillStyle = edge.color;
    ctx.globalAlpha = dimmed ? 0.15 : 0.55;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(edge.relation, mx, my - 6);

    ctx.globalAlpha = 1;
  }

  // ── Draw nodes ─────────────────────────────────────────
  for (const node of _nodes) {
    const isHovered  = node.id === _hoverId;
    const isSelected = node.id === _selectedId;
    const dimmed     = isFocusMode && !focusNeighborIds.has(node.id);
    const r          = NODE_RADIUS + (isHovered ? HOVER_EXTRA : 0);

    ctx.globalAlpha = dimmed ? 0.3 : 1;

    // Selected ring
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + SELECTED_RING, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }

    // White border (2px)
    ctx.beginPath();
    ctx.arc(node.x, node.y, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Filled circle (type color)
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = node.color;
    ctx.fill();

    // Emoji icon centered
    ctx.font         = `${r}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.icon, node.x, node.y + 1);

    // Label below
    ctx.font         = LABEL_FONT;
    ctx.fillStyle    = dimmed ? 'rgba(100,116,139,0.4)' : '#334155';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(node.label, node.x, node.y + r + 6);

    ctx.globalAlpha = 1;
  }

  // ── Tooltip for hovered node ───────────────────────────
  if (_hoverId) {
    const hovNode = _nodes.find(n => n.id === _hoverId);
    if (hovNode) {
      const tooltipText = hovNode.label;
      ctx.font = TOOLTIP_FONT;
      const tm   = ctx.measureText(tooltipText);
      const tpx  = hovNode.x - tm.width / 2 - 6;
      const tpy  = hovNode.y - NODE_RADIUS - HOVER_EXTRA - 28;
      const tpw  = tm.width + 12;
      const tph  = 22;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      _roundRect(ctx, tpx, tpy, tpw, tph, 4);
      ctx.fill();

      ctx.fillStyle    = '#f8fafc';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tooltipText, hovNode.x, tpy + tph / 2);
    }
  }

  ctx.restore();

  // ── Focus mode buttons (drawn outside transform) ───────
  if (isFocusMode) {
    _drawFocusButtons(ctx, dpr);
  }
}

/**
 * Draw "← Back" and "Exit Focus" overlay buttons.
 */
function _drawFocusButtons(ctx, dpr) {
  const btnY  = 12 * dpr;
  const btnH  = 26 * dpr;
  const fontSize = 11 * dpr;

  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;

  // "← Back" button (only if trail > 1)
  if (_focusTrail.length > 1) {
    const backText = '← Back';
    const tw = ctx.measureText(backText).width;
    const bx = 10 * dpr;
    const bw = tw + 16 * dpr;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
    _roundRect(ctx, bx, btnY, bw, btnH, 4 * dpr);
    ctx.fill();

    ctx.fillStyle    = '#f8fafc';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(backText, bx + 8 * dpr, btnY + btnH / 2);

    // Store hit area
    _focusBackBtn = { x: bx / dpr, y: btnY / dpr, w: bw / dpr, h: btnH / dpr };
  } else {
    _focusBackBtn = null;
  }

  // "Exit Focus" button
  const exitText = 'Exit Focus';
  const tw2 = ctx.measureText(exitText).width;
  const ex  = _canvas.width - tw2 - 26 * dpr;
  const ew  = tw2 + 16 * dpr;

  ctx.fillStyle = 'rgba(239, 68, 68, 0.75)';
  _roundRect(ctx, ex, btnY, ew, btnH, 4 * dpr);
  ctx.fill();

  ctx.fillStyle    = '#f8fafc';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(exitText, ex + 8 * dpr, btnY + btnH / 2);

  _focusExitBtn = { x: ex / dpr, y: btnY / dpr, w: ew / dpr, h: btnH / dpr };
}

/** @type {{ x:number, y:number, w:number, h:number }|null} */
let _focusBackBtn = null;
/** @type {{ x:number, y:number, w:number, h:number }|null} */
let _focusExitBtn = null;

/**
 * Canvas 2D rounded-rect helper (no Path2D for broader compat).
 */
function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ══════════════════════════════════════════════════════════════
// INTERACTIONS
// ══════════════════════════════════════════════════════════════

let _lastClickTime = 0;
let _lastClickId   = null;

// Bound listener references for cleanup
let _onMouseDown, _onMouseMove, _onMouseUp, _onWheel, _onClick, _onDblClick;
let _onTouchStart, _onTouchMove, _onTouchEnd;
let _onResize;
let _unsubEntitySaved, _unsubEntityDeleted, _unsubEdgeSaved, _unsubEdgeDeleted;

function _wireListeners() {
  if (!_canvas) return;

  _onMouseDown  = _handleMouseDown.bind(null);
  _onMouseMove  = _handleMouseMove.bind(null);
  _onMouseUp    = _handleMouseUp.bind(null);
  _onWheel      = _handleWheel.bind(null);
  _onTouchStart = _handleTouchStart.bind(null);
  _onTouchMove  = _handleTouchMove.bind(null);
  _onTouchEnd   = _handleTouchEnd.bind(null);
  _onResize     = _resizeCanvas.bind(null);

  _canvas.addEventListener('mousedown',  _onMouseDown);
  _canvas.addEventListener('mousemove',  _onMouseMove);
  _canvas.addEventListener('mouseup',    _onMouseUp);
  _canvas.addEventListener('wheel',      _onWheel, { passive: false });
  _canvas.addEventListener('touchstart', _onTouchStart, { passive: false });
  _canvas.addEventListener('touchmove',  _onTouchMove,  { passive: false });
  _canvas.addEventListener('touchend',   _onTouchEnd);

  window.addEventListener('resize', _onResize);

  // Listen for data changes to auto-refresh
  _unsubEntitySaved   = on(EVENTS.ENTITY_SAVED,   () => refreshGraph());
  _unsubEntityDeleted = on(EVENTS.ENTITY_DELETED,  () => refreshGraph());
  _unsubEdgeSaved     = on(EVENTS.EDGE_SAVED,      () => refreshGraph());
  _unsubEdgeDeleted   = on(EVENTS.EDGE_DELETED,    () => refreshGraph());
}

function _unwireListeners() {
  if (_canvas) {
    _canvas.removeEventListener('mousedown',  _onMouseDown);
    _canvas.removeEventListener('mousemove',  _onMouseMove);
    _canvas.removeEventListener('mouseup',    _onMouseUp);
    _canvas.removeEventListener('wheel',      _onWheel);
    _canvas.removeEventListener('touchstart', _onTouchStart);
    _canvas.removeEventListener('touchmove',  _onTouchMove);
    _canvas.removeEventListener('touchend',   _onTouchEnd);
  }

  window.removeEventListener('resize', _onResize);

  if (_unsubEntitySaved)   _unsubEntitySaved();
  if (_unsubEntityDeleted) _unsubEntityDeleted();
  if (_unsubEdgeSaved)     _unsubEdgeSaved();
  if (_unsubEdgeDeleted)   _unsubEdgeDeleted();
}

/**
 * Convert mouse/touch coordinates to graph-space coordinates.
 */
function _screenToGraph(clientX, clientY) {
  const rect = _canvas.getBoundingClientRect();
  const sx   = (clientX - rect.left);
  const sy   = (clientY - rect.top);
  return {
    x: (sx - _offset.x) / _scale,
    y: (sy - _offset.y) / _scale,
    screenX: sx,
    screenY: sy,
  };
}

/**
 * Find the node under a graph-space point.
 */
function _nodeAt(gx, gy) {
  // Iterate in reverse so top-rendered nodes are hit first
  for (let i = _nodes.length - 1; i >= 0; i--) {
    const n  = _nodes[i];
    const dx = gx - n.x;
    const dy = gy - n.y;
    if (dx * dx + dy * dy <= (NODE_RADIUS + HOVER_EXTRA) * (NODE_RADIUS + HOVER_EXTRA)) {
      return n;
    }
  }
  return null;
}

/**
 * Check if screen-space point hits a focus mode button.
 * @returns {'back'|'exit'|null}
 */
function _hitFocusBtn(sx, sy) {
  if (_focusBackBtn) {
    const b = _focusBackBtn;
    if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) return 'back';
  }
  if (_focusExitBtn) {
    const b = _focusExitBtn;
    if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) return 'exit';
  }
  return null;
}

// ── Mouse handlers ───────────────────────────────────────── //

function _handleMouseDown(e) {
  if (!_canvas) return;
  e.preventDefault();

  const { x, y, screenX, screenY } = _screenToGraph(e.clientX, e.clientY);

  // Check focus mode buttons first
  const btn = _hitFocusBtn(screenX, screenY);
  if (btn === 'back') {
    _focusBack();
    return;
  }
  if (btn === 'exit') {
    _focusExit();
    return;
  }

  const node = _nodeAt(x, y);

  if (node) {
    // Start dragging a node
    _isDragging = true;
    _dragNode   = node;
    _dragVx     = 0;
    _dragVy     = 0;
    _wPh        = 0;
    _canvas.style.cursor = 'grabbing';
  } else {
    // Start panning background
    _panStart = { mx: e.clientX, my: e.clientY, ox: _offset.x, oy: _offset.y };
    _canvas.style.cursor = 'move';
  }
}

function _handleMouseMove(e) {
  if (!_canvas) return;

  const { x, y } = _screenToGraph(e.clientX, e.clientY);

  if (_panStart) {
    // Background pan
    _offset.x = _panStart.ox + (e.clientX - _panStart.mx);
    _offset.y = _panStart.oy + (e.clientY - _panStart.my);
    _render();
    return;
  }

  if (_isDragging && _dragNode) {
    const prevX = _dragNode.x;
    const prevY = _dragNode.y;
    const dx    = x - prevX;
    const dy    = y - prevY;
    const dist  = Math.sqrt(dx * dx + dy * dy);

    // Move node to cursor
    _dragNode.x = x;
    _dragNode.y = y;

    // ── Elliptical wobble: perpendicular × sin(wPh×0.4) × 0.15 ──
    if (dist > 0.5) {
      // Perpendicular direction
      const perpX = -dy / dist;
      const perpY =  dx / dist;
      const wobble = Math.sin(_wPh * 0.4) * 0.15;
      _dragNode.x += perpX * wobble * dist;
      _dragNode.y += perpY * wobble * dist;
      _wPh += dist;
    }

    // ── Velocity EMA: _dragVx = (_dragVx×0.5) + (dx×0.5) ──
    _dragVx = (_dragVx * 0.5) + (dx * 0.5);
    _dragVy = (_dragVy * 0.5) + (dy * 0.5);

    // ── Neighbor ripple: connected nodes get spring nudge ──
    for (const edge of _edges) {
      let neighbor = null;
      if (edge.fromId === _dragNode.id) {
        neighbor = _nodes.find(n => n.id === edge.toId);
      } else if (edge.toId === _dragNode.id) {
        neighbor = _nodes.find(n => n.id === edge.fromId);
      }
      if (neighbor && neighbor !== _dragNode) {
        const ndx   = _dragNode.x - neighbor.x;
        const ndy   = _dragNode.y - neighbor.y;
        const ndist = Math.sqrt(ndx * ndx + ndy * ndy);
        if (ndist > 1) {
          const displacement = ndist - SPRING_REST_LEN;
          const nudge        = SPRING_STIFFNESS * displacement * 0.3;
          neighbor.vx += (ndx / ndist) * nudge;
          neighbor.vy += (ndy / ndist) * nudge;
        }
      }
    }

    // Keep physics running during drag
    if (!_physicsRunning) _startPhysics();
    _render();
    return;
  }

  // Hover detection
  const node = _nodeAt(x, y);
  const newHoverId = node ? node.id : null;
  if (newHoverId !== _hoverId) {
    _hoverId = newHoverId;
    _canvas.style.cursor = newHoverId ? 'pointer' : 'default';
    _render();
  }
}

function _handleMouseUp(e) {
  if (!_canvas) return;

  if (_isDragging && _dragNode) {
    // ── On mouseup: dragNode.vx = _dragVx × 4.5 → restart physics ──
    _dragNode.vx = _dragVx * 4.5;
    _dragNode.vy = _dragVy * 4.5;
    _dragNode    = null;
    _isDragging  = false;
    _startPhysics();
  }

  if (_panStart) {
    _panStart = null;
  }

  _canvas.style.cursor = 'default';

  // Handle click (select) and double-click (focus)
  const { x, y } = _screenToGraph(e.clientX, e.clientY);
  const node = _nodeAt(x, y);

  if (node) {
    const now = Date.now();

    // Double-click detection (< 350ms, same node)
    if (_lastClickId === node.id && (now - _lastClickTime) < 350) {
      // Double-click → focus mode + notify listeners
      setFocusId(node.id);
      emit('graph:nodeFocused', { id: node.id, type: node.type });
      _lastClickId   = null;
      _lastClickTime = 0;
      return;
    }

    // Single click → select
    _selectedId  = node.id;
    _lastClickId = node.id;
    _lastClickTime = now;
    emit('graph:nodeSelected', { id: node.id, type: node.type });
    _render();
  } else {
    // Clicked empty space — deselect
    if (_selectedId) {
      _selectedId = null;
      _render();
    }
    _lastClickId   = null;
    _lastClickTime = 0;
  }
}

// ── Wheel / Pinch zoom ───────────────────────────────────── //

function _handleWheel(e) {
  if (!_canvas) return;
  e.preventDefault();

  const rect = _canvas.getBoundingClientRect();
  const mx   = e.clientX - rect.left;
  const my   = e.clientY - rect.top;

  const delta    = e.deltaY > 0 ? 0.92 : 1.08;
  const newScale = Math.max(0.2, Math.min(5.0, _scale * delta));

  // Zoom toward cursor position
  const ratio = newScale / _scale;
  _offset.x = mx - (mx - _offset.x) * ratio;
  _offset.y = my - (my - _offset.y) * ratio;
  _scale    = newScale;

  _render();
}

// ── Touch handlers (mobile drag) ─────────────────────────── //

let _touchId = null;
let _pinchDist = null;

function _handleTouchStart(e) {
  if (!_canvas) return;

  if (e.touches.length === 2) {
    // Start pinch zoom
    e.preventDefault();
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    _pinchDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    return;
  }

  if (e.touches.length !== 1) return;
  e.preventDefault();

  const touch = e.touches[0];
  _touchId = touch.identifier;

  const { x, y, screenX, screenY } = _screenToGraph(touch.clientX, touch.clientY);

  // Focus buttons
  const btn = _hitFocusBtn(screenX, screenY);
  if (btn === 'back')  { _focusBack(); return; }
  if (btn === 'exit')  { _focusExit(); return; }

  const node = _nodeAt(x, y);
  if (node) {
    _isDragging = true;
    _dragNode   = node;
    _dragVx     = 0;
    _dragVy     = 0;
    _wPh        = 0;
  } else {
    _panStart = { mx: touch.clientX, my: touch.clientY, ox: _offset.x, oy: _offset.y };
  }
}

function _handleTouchMove(e) {
  if (!_canvas) return;

  if (e.touches.length === 2 && _pinchDist !== null) {
    e.preventDefault();
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    const newDist  = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    const midX     = (t0.clientX + t1.clientX) / 2;
    const midY     = (t0.clientY + t1.clientY) / 2;
    const rect     = _canvas.getBoundingClientRect();
    const mx       = midX - rect.left;
    const my       = midY - rect.top;

    const delta    = newDist / _pinchDist;
    const newScale = Math.max(0.2, Math.min(5.0, _scale * delta));
    const ratio    = newScale / _scale;
    _offset.x = mx - (mx - _offset.x) * ratio;
    _offset.y = my - (my - _offset.y) * ratio;
    _scale    = newScale;
    _pinchDist = newDist;
    _render();
    return;
  }

  const touch = _findTouch(e.changedTouches, _touchId);
  if (!touch) return;
  e.preventDefault();

  const { x, y } = _screenToGraph(touch.clientX, touch.clientY);

  if (_panStart) {
    _offset.x = _panStart.ox + (touch.clientX - _panStart.mx);
    _offset.y = _panStart.oy + (touch.clientY - _panStart.my);
    _render();
    return;
  }

  if (_isDragging && _dragNode) {
    const prevX = _dragNode.x;
    const prevY = _dragNode.y;
    const dx    = x - prevX;
    const dy    = y - prevY;
    const dist  = Math.sqrt(dx * dx + dy * dy);

    _dragNode.x = x;
    _dragNode.y = y;

    if (dist > 0.5) {
      const perpX = -dy / dist;
      const perpY =  dx / dist;
      const wobble = Math.sin(_wPh * 0.4) * 0.15;
      _dragNode.x += perpX * wobble * dist;
      _dragNode.y += perpY * wobble * dist;
      _wPh += dist;
    }

    _dragVx = (_dragVx * 0.5) + (dx * 0.5);
    _dragVy = (_dragVy * 0.5) + (dy * 0.5);

    // Neighbor ripple
    for (const edge of _edges) {
      let neighbor = null;
      if (edge.fromId === _dragNode.id) neighbor = _nodes.find(n => n.id === edge.toId);
      else if (edge.toId === _dragNode.id) neighbor = _nodes.find(n => n.id === edge.fromId);
      if (neighbor && neighbor !== _dragNode) {
        const ndx = _dragNode.x - neighbor.x;
        const ndy = _dragNode.y - neighbor.y;
        const ndist = Math.sqrt(ndx * ndx + ndy * ndy);
        if (ndist > 1) {
          const displacement = ndist - SPRING_REST_LEN;
          const nudge = SPRING_STIFFNESS * displacement * 0.3;
          neighbor.vx += (ndx / ndist) * nudge;
          neighbor.vy += (ndy / ndist) * nudge;
        }
      }
    }

    if (!_physicsRunning) _startPhysics();
    _render();
  }
}

function _handleTouchEnd(e) {
  if (!_canvas) return;

  if (e.touches.length < 2) _pinchDist = null;

  const touch = _findTouch(e.changedTouches, _touchId);
  if (!touch) return;

  if (_isDragging && _dragNode) {
    _dragNode.vx = _dragVx * 4.5;
    _dragNode.vy = _dragVy * 4.5;
    _dragNode    = null;
    _isDragging  = false;
    _startPhysics();
  }

  if (_panStart) {
    _panStart = null;
  }

  // Touch-tap → select / double-tap → focus
  const { x, y } = _screenToGraph(touch.clientX, touch.clientY);
  const node = _nodeAt(x, y);
  if (node) {
    const now = Date.now();
    if (_lastClickId === node.id && (now - _lastClickTime) < 350) {
      setFocusId(node.id);
      emit('graph:nodeFocused', { id: node.id, type: node.type });
      _lastClickId   = null;
      _lastClickTime = 0;
    } else {
      _selectedId    = node.id;
      _lastClickId   = node.id;
      _lastClickTime = now;
      emit('graph:nodeSelected', { id: node.id, type: node.type });
      _render();
    }
  }

  _touchId = null;
}

function _findTouch(touchList, id) {
  for (let i = 0; i < touchList.length; i++) {
    if (touchList[i].identifier === id) return touchList[i];
  }
  return null;
}

// ── Focus mode navigation ────────────────────────────────── //

async function _focusBack() {
  if (_focusTrail.length > 1) {
    _focusTrail.pop(); // remove current
    const prev = _focusTrail[_focusTrail.length - 1];
    _focusId = prev.id;
    // Don't re-push to trail since prev is already there
    await _buildGraph();
  } else {
    _focusExit();
  }
}

async function _focusExit() {
  _focusId    = null;
  _focusTrail = [];
  await _buildGraph();
}

// ══════════════════════════════════════════════════════════════
// RESIZE
// ══════════════════════════════════════════════════════════════

function _resizeCanvas() {
  if (!_canvas) return;

  const parent = _canvas.parentElement;
  if (!parent) return;

  const dpr = window.devicePixelRatio || 1;
  const w   = parent.clientWidth;
  const h   = parent.clientHeight || 400;

  _canvas.width  = w * dpr;
  _canvas.height = h * dpr;
  _canvas.style.width  = w + 'px';
  _canvas.style.height = h + 'px';

  _render();
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * Get the title field key for a given entity type.
 */
function _getTitleKey(typeKey) {
  const cfg = getEntityTypeConfig(typeKey);
  if (!cfg) return 'title';
  const titleField = cfg.fields.find(f => f.isTitle);
  return titleField ? titleField.key : 'title';
}

/**
 * Get display title for any entity (derives from body for types without isTitle).
 */
function _getDisplayTitle(entity) {
  if (!entity) return 'Untitled';
  const cfg = getEntityTypeConfig(entity.type);
  if (!cfg) return entity.title || entity.name || 'Untitled';
  const tf = cfg.fields.find(f => f.isTitle);
  if (tf) return entity[tf.key] || 'Untitled';
  const bodyField = cfg.fields.find(f => f.type === 'richtext' || f.type === 'text');
  if (bodyField && entity[bodyField.key]) {
    const plain = String(entity[bodyField.key]).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (plain.length > 40) return plain.slice(0, 40) + '…';
    if (plain) return plain;
  }
  return entity.title || entity.name || 'Untitled';
}

// ══════════════════════════════════════════════════════════════
// NODE LOOKUP CACHE (perf optimization for large graphs)
// ══════════════════════════════════════════════════════════════

/**
 * Build a Map<id, node> for O(1) lookups in physics & render.
 * Called after _nodes is rebuilt.
 *
 * NOTE: Currently using Array.find() for clarity in the physics code.
 * If performance becomes an issue with >200 nodes, replace the find()
 * calls in _physicsTick and _render with this map.
 */
// function _buildNodeMap() {
//   _nodeMap = new Map(_nodes.map(n => [n.id, n]));
// }
