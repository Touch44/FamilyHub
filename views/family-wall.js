/**
 * FamilyHub v2.0 — views/family-wall.js
 * Family Wall — Feed + Timeline, photos, files, lightbox, links
 *
 * Features:
 *   Feed view: all posts, pinned first, newest after
 *   Timeline view: per-member Facebook-style with year groups + photo strip
 *   Post types: Text | Photo (URL or device upload) | File (any type, base64)
 *               | Link (click → opens in browser) | Milestone
 *   Photo lightbox: zoom wheel+pinch, pan drag, keyboard nav, download
 *   File posts: per-file open/download button, images → lightbox
 *   Comments: denormalized author name/color so display never shows Unknown
 *   Reactions: 5-emoji stored as reacts-to edges
 *   Filter bar: member, type, pinned, tag + Feed/Timeline toggle
 *   Compose: separate Photo button (images only) + File button (any type, no restrict = fast)
 */

import { registerView, navigate, VIEW_KEYS } from '../core/router.js';
import { getEntitiesByType, getEntity,
         saveEntity, deleteEntity,
         getEdgesFrom, getEdgesTo,
         saveEdge, deleteEdge,
         getSetting }                 from '../core/db.js';
import { emit, on, EVENTS }          from '../core/events.js';
import { getAccount }                 from '../core/auth.js';

// ── Constants ──────────────────────────────────────────────

const REACTIONS  = ['👍', '❤️', '😂', '😮', '😢'];
const POST_TYPES = ['All', 'Text', 'Photo', 'File', 'Link', 'Milestone'];

const FILE_ICONS = {
  pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊', ppt:'📊', pptx:'📊',
  txt:'📃', csv:'📊', zip:'🗜️', rar:'🗜️', '7z':'🗜️',
  mp4:'🎬', mov:'🎬', avi:'🎬', mkv:'🎬',
  mp3:'🎵', wav:'🎵', flac:'🎵', aac:'🎵',
  jpg:'🖼️', jpeg:'🖼️', png:'🖼️', gif:'🖼️', webp:'🖼️', svg:'🖼️',
};

const PERSON_COLORS = {
  Red:'#EF4444', Orange:'#F97316', Yellow:'#EAB308', Green:'#22C55E',
  Teal:'#14B8A6', Blue:'#3B82F6', Purple:'#8B5CF6', Pink:'#EC4899',
};

// ── State ───────────────────────────────────────────────────

let _filterMemberId   = null;
let _filterPostType   = 'All';
let _filterPinnedOnly = false;
let _filterTag        = null;
let _viewMode         = 'feed';      // 'feed' | 'timeline'
let _timelinePerson   = null;

// ── Helpers ─────────────────────────────────────────────────

const _getInitials = name => {
  if (!name) return '?';
  return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
};
const _getColor = p => PERSON_COLORS[p?.color] || '#64748B';

function _timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dy = Math.floor(h / 24);
  if (dy < 7) return `${dy}d ago`;
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

const _isImgUrl  = url => !url ? false : /\.(jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i.test(url) || url.startsWith('data:image/');
const _isImgData = s   => typeof s === 'string' && s.startsWith('data:image/');
const _ext       = n   => (n || '').split('.').pop().toLowerCase();
const _icon      = n   => FILE_ICONS[_ext(n)] || '📎';
const _bytes     = b   => {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1048576).toFixed(1)} MB`;
};

// ── Data ─────────────────────────────────────────────────────

async function _loadData() {
  const [posts, persons, auth] = await Promise.all([
    getEntitiesByType('post'),
    getEntitiesByType('person'),
    getSetting('auth'),
  ]);
  const pm  = new Map(persons.map(p => [p.id, p]));
  const apm = new Map();
  for (const a of (auth?.accounts || [])) {
    if (a.memberId && pm.has(a.memberId)) apm.set(a.id, pm.get(a.memberId));
  }
  return { posts, persons, pm, apm };
}

async function _loadPostEdges(pid) {
  const [to, from] = await Promise.all([getEdgesTo(pid), getEdgesFrom(pid)]);
  const reactions = [], commentIds = [], attachedIds = [];
  for (const e of to) {
    if (e.relation === 'reacts-to')  reactions.push({ edgeId:e.id, emoji:e.metadata?.emoji, personId:e.fromId });
    if (e.relation === 'comments-on') commentIds.push(e.fromId);
  }
  for (const e of from) {
    if (e.relation === 'attaches') attachedIds.push(e.toId);
  }
  return { reactions, commentIds, attachedIds };
}

async function _loadComments(ids) {
  const arr = [];
  for (const id of ids) { const e = await getEntity(id); if (e && !e.deleted) arr.push(e); }
  return arr.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

// ── Filter & sort ────────────────────────────────────────────

function _filterPosts(posts) {
  let f = [...posts];
  if (_filterMemberId) f = f.filter(p => p._authorPersonId === _filterMemberId || p.createdBy === _filterMemberId);
  if (_filterPostType !== 'All') f = f.filter(p => (p.postType || 'Text') === _filterPostType);
  if (_filterPinnedOnly) f = f.filter(p => p.pinned);
  if (_filterTag) f = f.filter(p => (p.tags || []).includes(_filterTag));
  return f.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
}

// ── Lightbox ─────────────────────────────────────────────────

function _lbClose() {
  const lb = document.getElementById('fw-lb');
  if (lb) { if (lb._kh) document.removeEventListener('keydown', lb._kh); lb.remove(); }
}

function _openLightbox(src, name, imgs, idx0) {
  _lbClose();
  const lb = document.createElement('div');
  lb.id = 'fw-lb';
  lb.className = 'fw-lb';

  let idx = idx0 ?? 0, scale = 1, tx = 0, ty = 0;
  let drag = false, dx0 = 0, dy0 = 0, tx0 = 0, ty0 = 0;

  const img = document.createElement('img');
  img.className = 'fw-lb-img';
  img.src = imgs ? imgs[idx].src : src;
  img.draggable = false;
  const applyT = () => { img.style.transform = `scale(${scale}) translate(${tx}px,${ty}px)`; };

  // toolbar
  const tb = document.createElement('div');
  tb.className = 'fw-lb-tb';
  const fnEl = document.createElement('span');
  fnEl.className = 'fw-lb-fn';
  fnEl.textContent = imgs ? (imgs[idx].name || '') : (name || '');

  const mkBtn = (t, fn) => {
    const b = document.createElement('button');
    b.className = 'fw-lb-btn'; b.textContent = t;
    b.addEventListener('click', e => { e.stopPropagation(); fn(); });
    return b;
  };

  const dl = mkBtn('⬇ Save', () => {
    const a = document.createElement('a');
    a.href = imgs ? imgs[idx].src : src;
    a.download = imgs ? (imgs[idx].name || 'image') : (name || 'image');
    a.click();
  });
  const close = mkBtn('✕', _lbClose);
  close.className += ' fw-lb-close';

  tb.append(
    fnEl,
    mkBtn('🔍+', () => { scale = Math.min(scale*1.25, 10); applyT(); }),
    mkBtn('🔍−', () => { scale = Math.max(scale/1.25, 0.2); applyT(); }),
    mkBtn('⤢',   () => { scale=1; tx=0; ty=0; applyT(); }),
    dl, close
  );
  lb.appendChild(tb);

  // nav
  if (imgs && imgs.length > 1) {
    const nav = (dir, lbl) => {
      const b = document.createElement('button');
      b.className = `fw-lb-nav fw-lb-${dir}`; b.textContent = lbl;
      b.addEventListener('click', () => {
        idx = dir === 'prev'
          ? (idx - 1 + imgs.length) % imgs.length
          : (idx + 1) % imgs.length;
        img.src = imgs[idx].src;
        fnEl.textContent = imgs[idx].name || '';
        scale=1; tx=0; ty=0; applyT();
      });
      lb.appendChild(b);
    };
    nav('prev', '‹'); nav('next', '›');
  }

  // wrap
  const wrap = document.createElement('div');
  wrap.className = 'fw-lb-wrap';
  wrap.appendChild(img);
  lb.appendChild(wrap);

  // wheel zoom
  lb.addEventListener('wheel', e => {
    e.preventDefault();
    scale = Math.max(0.2, Math.min(scale * (e.deltaY < 0 ? 1.15 : 0.87), 10));
    applyT();
  }, { passive: false });

  // drag
  img.addEventListener('mousedown', e => {
    if (scale <= 1) return;
    drag=true; dx0=e.clientX; dy0=e.clientY; tx0=tx; ty0=ty;
    img.style.cursor='grabbing'; e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    tx = tx0 + (e.clientX-dx0)/scale;
    ty = ty0 + (e.clientY-dy0)/scale;
    applyT();
  });
  window.addEventListener('mouseup', () => { drag=false; img.style.cursor = scale>1?'grab':'default'; });

  // double-click toggle zoom
  img.addEventListener('dblclick', () => { scale = scale>1 ? (scale=1,tx=0,ty=0,1) : 2; applyT(); });

  // backdrop close
  lb.addEventListener('click', e => { if (e.target===lb||e.target===wrap) _lbClose(); });

  // keyboard
  lb._kh = e => {
    if (e.key==='Escape') _lbClose();
    if (e.key==='='||e.key==='+') { scale=Math.min(scale*1.2,10); applyT(); }
    if (e.key==='-') { scale=Math.max(scale/1.2,0.2); applyT(); }
    if (e.key==='0') { scale=1; tx=0; ty=0; applyT(); }
    if (imgs?.length>1) {
      if (e.key==='ArrowLeft')  lb.querySelector('.fw-lb-prev')?.click();
      if (e.key==='ArrowRight') lb.querySelector('.fw-lb-next')?.click();
    }
  };
  document.addEventListener('keydown', lb._kh);
  document.body.appendChild(lb);
  requestAnimationFrame(() => lb.classList.add('open'));
}

function _openFile(url, name) {
  if (!url) return;
  if (url.startsWith('data:')) {
    const a = document.createElement('a'); a.href=url; a.download=name||'file'; a.click();
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

// ── File label helper ────────────────────────────────────────

function _mkFileLabel(labelText, accept, onFile) {
  const lbl = document.createElement('label');
  lbl.className = 'btn btn-ghost btn-xs fw-file-lbl';
  const sp = document.createElement('span');
  sp.textContent = labelText;
  const inp = document.createElement('input');
  inp.type = 'file'; inp.style.display = 'none';
  if (accept) inp.accept = accept;
  inp.addEventListener('change', () => { const f=inp.files?.[0]; if(f) onFile(f,sp); inp.value=''; });
  lbl.append(sp, inp);
  return lbl;
}

// ── File-read with progress ──────────────────────────────────

/**
 * Read a file as base64 dataURL with an inline progress bar in the label span.
 * Uses a blob URL for instant preview where possible, then reads in background.
 * @param {File}     file     - the File object
 * @param {Element}  sp       - the <span> label element to show progress in
 * @param {Function} onDone   - callback(dataUrl) when read is complete
 */
/**
 * Read a file for upload with instant visual feedback.
 *
 * Strategy:
 *   Phase 1 (0ms)   — createObjectURL gives instant preview src (no encoding).
 *   Phase 2 (async) — True streaming: File.slice() reads one 96KB chunk at a time.
 *                     Each chunk is read, encoded to base64, then discarded before
 *                     the next chunk is fetched. This keeps peak memory low and
 *                     never blocks the main thread with a full-file read.
 *                     A cancel token lets in-flight reads be abandoned cleanly.
 */
function _readFileWithProgress(file, sp, onDone) {
  // Phase 1: instant preview
  const blobUrl = URL.createObjectURL(file);
  sp.innerHTML = `<span class="fw-prog-wrap"><span class="fw-prog-bar" style="width:2%"></span></span> <span class="fw-prog-txt">0%</span>`;
  const bar = sp.querySelector('.fw-prog-bar');
  const txt = sp.querySelector('.fw-prog-txt');
  onDone({ blobUrl, dataUrl: null, file });

  // Phase 2: stream-read the file in 96 KB slices
  const SLICE = 98304;   // 96 KB — must be divisible by 3 for clean base64 boundaries
  const total  = file.size;
  let   offset = 0;
  let   b64    = '';
  let   cancelled = false;

  // Attach cancel token to the label so the caller can abort
  sp._cancelUpload = () => { cancelled = true; URL.revokeObjectURL(blobUrl); };

  function readNextSlice() {
    if (cancelled) return;
    if (offset >= total) {
      // All slices done
      URL.revokeObjectURL(blobUrl);
      if (bar) bar.style.width = '100%';
      if (txt) txt.textContent = '✅ ' + file.name;
      const mimeType = file.type || 'application/octet-stream';
      onDone({ blobUrl: null, dataUrl: `data:${mimeType};base64,${b64}`, file });
      return;
    }

    const slice  = file.slice(offset, Math.min(offset + SLICE, total));
    const reader = new FileReader();

    reader.onerror = () => {
      if (!cancelled) sp.textContent = '❌ Failed to read';
    };

    reader.onload = (ev) => {
      if (cancelled) return;
      const ab    = ev.target.result;
      const bytes = new Uint8Array(ab);
      // Build binary string using apply() in 8KB sub-chunks — ~7× faster than char loop
      // Sub-chunk limit avoids "Maximum call stack size exceeded" on large slices
      let bin = '';
      const SUB = 8192;
      for (let i = 0; i < bytes.length; i += SUB) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + SUB));
      }
      b64    += btoa(bin);
      offset += bytes.length;

      const pct = Math.round((offset / total) * 100);
      if (bar) bar.style.width = pct + '%';
      if (txt) txt.textContent = pct + '%';

      // Yield to browser, then read next slice
      setTimeout(readNextSlice, 0);
    };

    reader.readAsArrayBuffer(slice);
  }

  readNextSlice();
}

// ── Filter bar ───────────────────────────────────────────────

function _buildFilterBar(el, persons, posts) {
  const bar = document.createElement('div');
  bar.className = 'fw-filter-bar';

  // Feed / Timeline toggle
  const modeRow = document.createElement('div');
  modeRow.className = 'fw-mode-row';
  ['feed','timeline'].forEach(m => {
    const b = document.createElement('button');
    b.className = 'fw-mode-btn' + (_viewMode===m?' active':'');
    b.textContent = m==='feed' ? '📋 Feed' : '📅 Timeline';
    b.addEventListener('click', () => {
      _viewMode = m;
      if (m==='timeline' && !_timelinePerson) _timelinePerson = persons[0] || null;
      renderWall({ _internal:true });
    });
    modeRow.appendChild(b);
  });
  bar.appendChild(modeRow);

  // Member avatars
  const memRow = document.createElement('div');
  memRow.className = 'fw-filter-members';
  const allBtn = document.createElement('button');
  allBtn.className = 'fw-av-btn' + (!_filterMemberId?' active':'');
  allBtn.textContent = 'All';
  allBtn.addEventListener('click', () => { _filterMemberId=null; renderWall({_internal:true}); });
  memRow.appendChild(allBtn);
  for (const p of persons) {
    const b = document.createElement('button');
    b.className = 'fw-av-btn' + (_filterMemberId===p.id?' active':'');
    b.style.cssText = `background:${_getColor(p)};color:white;`;
    b.textContent = _getInitials(p.name);
    b.title = p.name || '';
    b.addEventListener('click', () => {
      if (_viewMode==='timeline') { _timelinePerson=p; renderWall({_internal:true}); return; }
      _filterMemberId = _filterMemberId===p.id ? null : p.id;
      renderWall({_internal:true});
    });
    memRow.appendChild(b);
  }
  bar.appendChild(memRow);

  if (_viewMode==='feed') {
    const tr = document.createElement('div');
    tr.className = 'fw-filter-types';
    for (const t of POST_TYPES) {
      const b = document.createElement('button');
      b.className = 'fw-type-btn' + (_filterPostType===t?' active':'');
      b.textContent = t;
      b.addEventListener('click', () => { _filterPostType=t; renderWall({_internal:true}); });
      tr.appendChild(b);
    }
    const pb = document.createElement('button');
    pb.className = 'fw-type-btn' + (_filterPinnedOnly?' active':'');
    pb.textContent = '📌 Pinned';
    pb.addEventListener('click', () => { _filterPinnedOnly=!_filterPinnedOnly; renderWall({_internal:true}); });
    tr.appendChild(pb);
    bar.appendChild(tr);

    const tags = new Set(posts.flatMap(p => p.tags||[]));
    if (tags.size) {
      const tagRow = document.createElement('div');
      tagRow.className = 'fw-filter-tags';
      for (const t of tags) {
        const c = document.createElement('button');
        c.className = 'fw-tag-chip' + (_filterTag===t?' active':'');
        c.textContent = `#${t}`;
        c.addEventListener('click', () => { _filterTag=_filterTag===t?null:t; renderWall({_internal:true}); });
        tagRow.appendChild(c);
      }
      bar.appendChild(tagRow);
    }
  }
  el.appendChild(bar);
}

// ── Compose box ──────────────────────────────────────────────

function _buildCompose(el, pm, apm) {
  const acct = getAccount();
  if (!acct) return;
  const person = pm.get(acct.memberId);

  const box = document.createElement('div');
  box.className = 'fw-compose';

  const hdr = document.createElement('div'); hdr.className = 'fw-compose-hdr';
  const av = document.createElement('div');
  av.className='fw-avatar'; av.style.background=_getColor(person);
  av.textContent=_getInitials(person?.name||acct.username);
  const nm = document.createElement('span');
  nm.className='fw-compose-name'; nm.textContent=person?.name||acct.username;
  hdr.append(av,nm); box.appendChild(hdr);

  // State
  let selType='Text', photoVal=null;
  const files=[]; // [{ name, size, mimeType, dataUrl }]

  // Textarea
  const ta = document.createElement('textarea');
  ta.className='fw-compose-text';
  ta.placeholder="What's happening in the family?";
  ta.rows=3;

  // Auto-detect pasted links
  ta.addEventListener('paste', () => {
    setTimeout(() => {
      const txt=ta.value.trim();
      const m=txt.match(/^(https?:\/\/[^\s]{4,})$/m);
      if (m && selType==='Text' && txt.replace(/\s/g,'')=== m[0].replace(/\s/g,'')) {
        selType='Link'; urlInp.value=m[0]; showSection('link'); ta.value='';
      }
    },0);
  });
  box.appendChild(ta);

  // Photo section (hidden by default)
  const photoSec = document.createElement('div');
  photoSec.className='fw-compose-media'; photoSec.style.display='none';

  const urlInp = document.createElement('input');
  urlInp.type='text'; urlInp.className='input fw-compose-url';
  urlInp.placeholder='Paste image URL...'; urlInp.style.width='100%';

  const preview = document.createElement('img');
  preview.className='fw-compose-preview'; preview.style.display='none';
  urlInp.addEventListener('input', () => {
    const u=urlInp.value.trim();
    preview.style.display=_isImgUrl(u)?'':'none';
    if(_isImgUrl(u)) preview.src=u;
  });

  // Photo device picker — immediate preview + progress bar
  const photoLbl = _mkFileLabel('📷 Choose photo', 'image/*', (f, sp) => {
    _readFileWithProgress(f, sp, ({ blobUrl, dataUrl }) => {
      if (blobUrl) {
        // Phase 1: instant preview via blob URL
        preview.src = blobUrl;
        preview.style.display = '';
        urlInp.value = '';
      }
      if (dataUrl) {
        // Phase 2: swap to real base64 for storage
        photoVal = dataUrl;
        if (preview.src.startsWith('blob:')) preview.src = dataUrl;
      }
    });
  });

  photoSec.append(urlInp, photoLbl, preview);
  box.appendChild(photoSec);

  // File section (hidden by default) - any type, no accept restriction = fast dialog open
  const fileSec = document.createElement('div');
  fileSec.className='fw-compose-filesec'; fileSec.style.display='none';

  const fileList = document.createElement('div');
  fileList.className='fw-compose-file-list';

  const anyFileLbl = _mkFileLabel('📎 Add any file', '', (f, sp) => {
    if (f.size > 8*1024*1024 && !confirm(`${f.name} is ${_bytes(f.size)}. Store in database?`)) return;
    let _fileIdx = null;  // track pending entry index
    _readFileWithProgress(f, sp, ({ blobUrl, dataUrl }) => {
      if (blobUrl) {
        // Phase 1: add placeholder entry with blobUrl for immediate thumbnail
        _fileIdx = files.length;
        files.push({ name: f.name, size: f.size, mimeType: f.type, dataUrl: blobUrl, _pending: true });
        renderFileList();
      }
      if (dataUrl && _fileIdx !== null) {
        // Phase 2: replace blobUrl with real base64 in the existing entry
        files[_fileIdx].dataUrl = dataUrl;
        files[_fileIdx]._pending = false;
        renderFileList();
      }
    });
  });

  function renderFileList() {
    fileList.innerHTML='';
    files.forEach((f,i) => {
      const row=document.createElement('div');
      row.className='fw-compose-fattach';
      row.innerHTML=`<span>${_icon(f.name)}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(f.name)}</span><span style="color:var(--color-text-muted);font-size:var(--text-xs)">${_bytes(f.size)}</span>`;
      const rm=document.createElement('button');
      rm.className='btn-icon'; rm.textContent='✕'; rm.style.fontSize='10px';
      rm.addEventListener('click',()=>{ files.splice(i,1); renderFileList(); });
      row.appendChild(rm); fileList.appendChild(row);
    });
  }

  fileSec.append(anyFileLbl, fileList);
  box.appendChild(fileSec);

  // Tags
  const tagInp=document.createElement('input');
  tagInp.type='text'; tagInp.className='input fw-compose-tag-inp';
  tagInp.placeholder='Tags (comma-separated)';
  box.appendChild(tagInp);

  // Type buttons
  const typeDefs=[
    { t:'Photo',     icon:'📷 Photo',    sec:'photo' },
    { t:'File',      icon:'📎 File',     sec:'file'  },
    { t:'Link',      icon:'🔗 Link',     sec:'link'  },
    { t:'Milestone', icon:'🏆 Milestone', sec:'none'  },
  ];

  function showSection(which) {
    photoSec.style.display = which==='photo'?'':'none';
    fileSec.style.display  = which==='file'?'':'none';
    if (which==='link') { photoSec.style.display=''; urlInp.placeholder='Paste link URL...'; photoLbl.style.display='none'; preview.style.display='none'; }
    else { photoLbl.style.display=''; if(which==='photo') urlInp.placeholder='Paste image URL...'; }
  }

  const typeGrp=document.createElement('div'); typeGrp.className='fw-compose-type-btns';
  for (const td of typeDefs) {
    const b=document.createElement('button');
    b.className='btn btn-ghost btn-xs fw-compose-type-btn'; b.dataset.type=td.t; b.textContent=td.icon;
    b.addEventListener('click',()=>{
      selType=td.t;
      showSection(td.sec);
      typeGrp.querySelectorAll('.fw-compose-type-btn').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
    });
    typeGrp.appendChild(b);
  }

  const postBtn=document.createElement('button');
  postBtn.className='btn btn-primary btn-sm'; postBtn.textContent='Post';
  postBtn.addEventListener('click', async () => {
    const body=ta.value.trim();
    if (!body && selType==='Text' && !files.length) return;
    if (files.some(f => f._pending)) { alert('Please wait — files are still uploading.'); return; }
    if (selType==='Photo' && !photoVal && !urlInp.value.trim()) { alert('Please wait — photo is still loading.'); return; }
    postBtn.disabled=true; postBtn.textContent='Posting…';
    try {
      const tags=tagInp.value.split(',').map(x=>x.trim()).filter(Boolean);
      const pv=selType==='Photo'?(photoVal||urlInp.value.trim()):null;
      const lv=selType==='Link'?urlInp.value.trim():null;
      const fv=selType==='File'?[...files]:[];

      const saved=await saveEntity({
        type:'post', body, postType:selType,
        photoUrl:pv, linkUrl:lv, _files:fv,
        pinned:false, tags, _authorPersonId:acct.memberId,
      }, acct.id);

      if (acct.memberId) {
        await saveEdge({ fromId:acct.memberId, toId:saved.id, relation:'posted-by' }, acct.id);
      }

      ta.value=''; urlInp.value=''; tagInp.value='';
      photoSec.style.display='none'; fileSec.style.display='none';
      photoVal=null; files.length=0; fileList.innerHTML='';
      preview.src=''; preview.style.display='none';
      selType='Text'; typeGrp.querySelectorAll('.fw-compose-type-btn').forEach(b=>b.classList.remove('active'));
      cancelBtn.style.display='none';
      renderWall({_internal:true});
    } catch(e) { console.error('[fw] post failed',e); }
    finally { postBtn.disabled=false; postBtn.textContent='Post'; }
  });

  const cancelBtn=document.createElement('button');
  cancelBtn.className='btn btn-ghost btn-sm fw-cancel-btn';
  cancelBtn.textContent='Cancel';
  cancelBtn.style.display='none';
  cancelBtn.addEventListener('click', () => {
    ta.value=''; urlInp.value=''; tagInp.value='';
    photoSec.style.display='none'; fileSec.style.display='none';
    photoVal=null; files.length=0; fileList.innerHTML='';
    preview.src=''; preview.style.display='none';
    selType='Text';
    typeGrp.querySelectorAll('.fw-compose-type-btn').forEach(b=>b.classList.remove('active'));
    cancelBtn.style.display='none';
  });

  // Show cancel whenever the user starts composing
  ta.addEventListener('input', () => { if (ta.value.trim()) cancelBtn.style.display=''; });
  typeGrp.querySelectorAll('.fw-compose-type-btn').forEach(b => {
    b.addEventListener('click', () => { cancelBtn.style.display=''; });
  });

  const actRow=document.createElement('div'); actRow.className='fw-compose-actions';
  actRow.append(typeGrp, cancelBtn, postBtn);
  box.appendChild(actRow);
  el.appendChild(box);
}

// ── Post card ────────────────────────────────────────────────

async function _buildCard(post, pm, apm) {
  const card=document.createElement('article');
  card.className='fw-post-card'; card.dataset.postId=post.id;

  const acct=getAccount();
  const author=pm.get(post._authorPersonId)||apm.get(post.createdBy);
  const isOwn=acct&&(post.createdBy===acct.id||post._authorPersonId===acct.memberId);
  const isAdmin=acct?.role==='admin';

  if (post.pinned) {
    const pb=document.createElement('div'); pb.className='fw-pin-badge';
    pb.textContent='📌 Pinned'; card.appendChild(pb);
  }

  // Header
  const hdr=document.createElement('div'); hdr.className='fw-post-hdr';
  const av=document.createElement('div');
  av.className='fw-avatar'; av.style.background=_getColor(author);
  av.textContent=_getInitials(author?.name||'?');
  const meta=document.createElement('div'); meta.className='fw-post-meta';
  const nm=document.createElement('span'); nm.className='fw-post-author'; nm.textContent=author?.name||'Unknown';
  const tm=document.createElement('span'); tm.className='fw-post-time';
  tm.textContent=_timeAgo(post.createdAt);
  tm.title=post.createdAt?new Date(post.createdAt).toLocaleString():'';
  meta.prepend(nm); meta.appendChild(tm);
  hdr.append(av,meta);

  const acts=document.createElement('div'); acts.className='fw-post-acts';
  if (isAdmin||author?.role==='Parent') {
    const pb=document.createElement('button'); pb.className='btn-icon fw-act-btn';
    pb.title=post.pinned?'Unpin':'Pin'; pb.textContent=post.pinned?'📌':'📍';
    pb.addEventListener('click',async e=>{ e.stopPropagation(); post.pinned=!post.pinned; await saveEntity(post,acct?.id); renderWall({_internal:true}); });
    acts.appendChild(pb);
  }
  if (isOwn||isAdmin) {
    const db=document.createElement('button'); db.className='btn-icon fw-act-btn fw-act-del';
    db.title='Delete'; db.textContent='🗑️';
    db.addEventListener('click',async e=>{ e.stopPropagation(); if(confirm('Delete post?')){ await deleteEntity(post.id,acct?.id); renderWall({_internal:true}); } });
    acts.appendChild(db);
  }
  hdr.appendChild(acts); card.appendChild(hdr);

  // Body
  const body=document.createElement('div'); body.className='fw-post-body';

  if (post.body) {
    const t=document.createElement('p'); t.className='fw-post-text'; t.textContent=post.body;
    body.appendChild(t);
  }

  // Photo
  if (post.postType==='Photo'&&post.photoUrl) {
    const wrap=document.createElement('div'); wrap.className='fw-img-wrap';
    const img=document.createElement('img'); img.className='fw-post-img';
    img.src=post.photoUrl; img.loading='lazy'; img.title='Click to view fullscreen';
    img.addEventListener('error',()=>{ wrap.style.display='none'; });
    img.addEventListener('click',e=>{ e.stopPropagation(); _openLightbox(post.photoUrl,post._photoName||'photo',null,0); });

    const toolbar=document.createElement('div'); toolbar.className='fw-img-toolbar';
    const mkTb=(txt,fn)=>{ const b=document.createElement('button'); b.className='fw-img-tbtn'; b.textContent=txt; b.addEventListener('click',e=>{e.stopPropagation();fn();}); return b; };
    toolbar.append(
      mkTb('⬇ Download',()=>{ const a=document.createElement('a'); a.href=post.photoUrl; a.download=post._photoName||'photo'; a.click(); }),
      mkTb('⤢ Fullscreen',()=>_openLightbox(post.photoUrl,post._photoName||'photo',null,0))
    );
    wrap.append(img,toolbar); body.appendChild(wrap);
  }

  // Link — direct open in browser
  if (post.postType==='Link'&&post.linkUrl) {
    const a=document.createElement('a'); a.className='fw-link-card';
    a.href=post.linkUrl; a.target='_blank'; a.rel='noopener noreferrer';
    a.title=`Open: ${post.linkUrl}`;
    a.innerHTML=`<span class="fw-link-ico">🔗</span><span class="fw-link-txt">${_esc(post.linkUrl)}</span><span class="fw-link-arrow">↗ Open</span>`;
    a.addEventListener('click',e=>{ e.stopPropagation(); window.open(post.linkUrl,'_blank','noopener,noreferrer'); });
    body.appendChild(a);
  }

  // Files
  if (post.postType==='File'&&post._files?.length) {
    const fl=document.createElement('div'); fl.className='fw-file-list';
    for (const f of post._files) {
      const isImg=_isImgUrl(f.name)||_isImgData(f.dataUrl);
      const row=document.createElement('div'); row.className='fw-file-row';
      if (isImg) {
        const th=document.createElement('img'); th.className='fw-file-thumb';
        th.src=f.dataUrl; th.alt=f.name; th.title=`View: ${f.name}`;
        th.addEventListener('click',e=>{
          e.stopPropagation();
          const imgs=post._files.filter(x=>_isImgUrl(x.name)||_isImgData(x.dataUrl));
          _openLightbox(f.dataUrl,f.name,imgs.map(x=>({src:x.dataUrl,name:x.name})),imgs.indexOf(f));
        });
        row.appendChild(th);
      } else {
        const ic=document.createElement('span'); ic.className='fw-file-ico'; ic.textContent=_icon(f.name);
        row.appendChild(ic);
      }
      const inf=document.createElement('div'); inf.className='fw-file-inf';
      inf.innerHTML=`<span class="fw-file-name">${_esc(f.name)}</span><span class="fw-file-size">${_bytes(f.size)}</span>`;
      const ob=document.createElement('button'); ob.className='fw-img-tbtn';
      ob.textContent=isImg?'🔍 View':'📂 Open';
      ob.addEventListener('click',e=>{
        e.stopPropagation();
        if(isImg){ const imgs=post._files.filter(x=>_isImgUrl(x.name)||_isImgData(x.dataUrl)); _openLightbox(f.dataUrl,f.name,imgs.map(x=>({src:x.dataUrl,name:x.name})),imgs.indexOf(f)); }
        else _openFile(f.dataUrl,f.name);
      });
      row.append(inf,ob); fl.appendChild(row);
    }
    body.appendChild(fl);
  }

  // Milestone
  if (post.postType==='Milestone') {
    const ms=document.createElement('div'); ms.className='fw-milestone';
    ms.textContent='🏆 Family Milestone'; body.appendChild(ms);
  }

  // Tags
  if (post.tags?.length) {
    const tr=document.createElement('div'); tr.className='fw-post-tags';
    for (const t of post.tags) { const c=document.createElement('span'); c.className='fw-tag-chip'; c.textContent=`#${t}`; tr.appendChild(c); }
    body.appendChild(tr);
  }
  card.appendChild(body);

  // Edges
  const { reactions, commentIds, attachedIds } = await _loadPostEdges(post.id);

  // Attached entities
  if (attachedIds.length) {
    const ar=document.createElement('div'); ar.className='fw-attach-row';
    for (const aid of attachedIds) {
      const ent=await getEntity(aid); if(!ent) continue;
      const c=document.createElement('button'); c.className='fw-attach-chip';
      c.textContent=ent.title||ent.name||ent.label||'Entity';
      c.addEventListener('click',e=>{ e.stopPropagation(); emit(EVENTS.PANEL_OPENED,{entityType:ent.type,entityId:ent.id}); });
      ar.appendChild(c);
    }
    card.appendChild(ar);
  }

  // Reaction bar
  const rb=document.createElement('div'); rb.className='fw-rxn-bar';
  const myPid=acct?.memberId;
  for (const emoji of REACTIONS) {
    const ms=reactions.filter(r=>r.emoji===emoji);
    const my=ms.find(r=>r.personId===myPid);
    const b=document.createElement('button');
    b.className='fw-rxn-btn'+(my?' active':'');
    b.innerHTML=`${emoji}${ms.length?` <span class="fw-rxn-c">${ms.length}</span>`:''}`;
    b.addEventListener('click',async e=>{
      e.stopPropagation();
      if(my) await deleteEdge(my.edgeId,acct?.id);
      else await saveEdge({fromId:myPid,toId:post.id,relation:'reacts-to',metadata:{emoji}},acct?.id);
      renderWall({_internal:true});
    });
    rb.appendChild(b);
  }
  const cmtBtn=document.createElement('button'); cmtBtn.className='fw-cmt-toggle';
  cmtBtn.textContent=`💬 ${commentIds.length}`;
  cmtBtn.addEventListener('click',()=>card.querySelector('.fw-cmt-thread')?.classList.toggle('open'));
  rb.appendChild(cmtBtn);
  card.appendChild(rb);

  // Comment thread
  const thread=document.createElement('div'); thread.className='fw-cmt-thread';
  const comments=await _loadComments(commentIds);
  for (const c of comments) {
    const cp=pm.get(c._authorPersonId)||apm.get(c.createdBy)||null;
    thread.appendChild(_buildCmtEl(c,cp));
  }
  const ci=document.createElement('div'); ci.className='fw-cmt-input';
  const cf=document.createElement('input'); cf.type='text'; cf.className='input fw-cmt-field'; cf.placeholder='Write a comment...';
  const cr=document.createElement('button'); cr.className='btn btn-primary btn-xs'; cr.textContent='Reply';
  cr.addEventListener('click',async()=>{
    const txt=cf.value.trim(); if(!txt) return;
    cr.disabled=true;
    try {
      const a=getAccount();
      const { pm:p2,apm:a2 }=await _loadData().catch(()=>({pm:new Map(),apm:new Map()}));
      const ap=p2.get(a?.memberId)||a2.get(a?.id);
      const saved=await saveEntity({
        type:'comment',title:txt.slice(0,80),body:txt,
        _authorPersonId:a?.memberId||null,
        _authorName:ap?.name||a?.username||'Unknown',
        _authorColor:_getColor(ap),
        _parentPostId:post.id,
      },a?.id);
      await saveEdge({fromId:saved.id,fromType:'comment',toId:post.id,toType:'post',relation:'comments-on'},a?.id);
      cf.value=''; renderWall({_internal:true});
    } catch(e){ console.error(e); } finally{ cr.disabled=false; }
  });
  cf.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();cr.click();} });
  ci.append(cf,cr); thread.appendChild(ci); card.appendChild(thread);
  return card;
}

function _buildCmtEl(c, person) {
  const el=document.createElement('div'); el.className='fw-cmt';
  const name=person?.name||c._authorName||'Unknown';
  const bg=person?_getColor(person):(c._authorColor||'#64748B');
  const av=document.createElement('div');
  av.className='fw-avatar fw-avatar-sm'; av.style.background=bg; av.textContent=_getInitials(name);
  const cnt=document.createElement('div'); cnt.className='fw-cmt-cnt';
  cnt.innerHTML=`<div class="fw-cmt-nm"><strong>${_esc(name)}</strong> <span class="fw-cmt-tm">${_timeAgo(c.createdAt)}</span></div><div class="fw-cmt-bd">${_esc(c.body||c.title||'')}</div>`;
  el.append(av,cnt); return el;
}

// ── Timeline view ────────────────────────────────────────────

async function _buildTimeline(el, posts, persons, pm, apm) {
  const tl=document.createElement('div'); tl.className='fw-tl';

  // Person tabs
  const tabs=document.createElement('div'); tabs.className='fw-tl-tabs';
  for (const p of persons) {
    const t=document.createElement('button');
    t.className='fw-tl-tab'+(p.id===_timelinePerson?.id?' active':'');
    t.style.borderColor=_getColor(p);
    const av=document.createElement('div');
    av.className='fw-avatar fw-avatar-sm'; av.style.background=_getColor(p); av.textContent=_getInitials(p.name);
    const lb=document.createElement('span'); lb.textContent=p.name||'?'; lb.style.fontSize='var(--text-xs)';
    t.append(av,lb);
    t.addEventListener('click',()=>{ _timelinePerson=p; renderWall({_internal:true}); });
    tabs.appendChild(t);
  }
  tl.appendChild(tabs);

  if (!_timelinePerson&&persons.length) _timelinePerson=persons[0];
  if (!_timelinePerson) { const e=document.createElement('div'); e.className='fw-empty'; e.textContent='No members.'; tl.appendChild(e); el.appendChild(tl); return; }

  // Profile header
  const ph=document.createElement('div'); ph.className='fw-tl-profile';
  const bigAv=document.createElement('div'); bigAv.className='fw-tl-big-av';
  bigAv.style.background=_getColor(_timelinePerson); bigAv.textContent=_getInitials(_timelinePerson.name);
  const pi=document.createElement('div'); pi.className='fw-tl-pi';
  pi.innerHTML=`<h2 class="fw-tl-pname">${_esc(_timelinePerson.name||'Unknown')}</h2><span class="fw-tl-prole">${_esc(_timelinePerson.role||'')}</span>`;
  ph.append(bigAv,pi); tl.appendChild(ph);

  const mine=posts.filter(p=>p._authorPersonId===_timelinePerson.id||p.createdBy===_timelinePerson.id)
    .sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));

  if (!mine.length) {
    const e=document.createElement('div'); e.className='fw-empty';
    e.textContent=`${_timelinePerson.name} hasn't posted yet.`; tl.appendChild(e); el.appendChild(tl); return;
  }

  // Stats
  const sb=document.createElement('div'); sb.className='fw-tl-stats';
  const byYear=new Map();
  for (const p of mine) { const y=p.createdAt?new Date(p.createdAt).getFullYear():'?'; if(!byYear.has(y))byYear.set(y,[]); byYear.get(y).push(p); }
  sb.innerHTML=`
    <div class="fw-tl-stat"><span class="fw-tl-sn">${mine.length}</span><span class="fw-tl-sl">Posts</span></div>
    <div class="fw-tl-stat"><span class="fw-tl-sn">${byYear.size}</span><span class="fw-tl-sl">Years</span></div>
    <div class="fw-tl-stat"><span class="fw-tl-sn">${mine.filter(p=>p.postType==='Photo'&&p.photoUrl).length}</span><span class="fw-tl-sl">Photos</span></div>
  `;
  tl.appendChild(sb);

  // Photo strip
  const photos=mine.filter(p=>p.postType==='Photo'&&p.photoUrl).slice(0,10);
  if (photos.length) {
    const strip=document.createElement('div'); strip.className='fw-tl-strip';
    photos.forEach((ph,i)=>{
      const img=document.createElement('img'); img.className='fw-tl-thumb';
      img.src=ph.photoUrl; img.loading='lazy'; img.title=_timeAgo(ph.createdAt);
      img.addEventListener('error',()=>{img.style.display='none';});
      img.addEventListener('click',()=>_openLightbox(ph.photoUrl,ph._photoName||'photo',photos.map(p=>({src:p.photoUrl,name:p._photoName||'photo'})),i));
      strip.appendChild(img);
    });
    tl.appendChild(strip);
  }

  // Year groups
  const years=[...byYear.keys()].sort((a,b)=>b-a);
  for (const year of years) {
    const ys=document.createElement('div'); ys.className='fw-tl-year';
    const yl=document.createElement('div'); yl.className='fw-tl-year-lbl'; yl.textContent=year;
    const yp=document.createElement('div'); yp.className='fw-tl-year-posts';
    for (const post of byYear.get(year)) {
      const card=await _buildCard(post,pm,apm);
      card.classList.add('fw-tl-card'); yp.appendChild(card);
    }
    ys.append(yl,yp); tl.appendChild(ys);
  }
  el.appendChild(tl);
}

// ── Styles ───────────────────────────────────────────────────

function _injectStyles() {
  if (document.getElementById('family-wall-styles')) return;
  const s=document.createElement('style'); s.id='family-wall-styles';
  s.textContent=`
    #view-family-wall.active { display:flex; flex-direction:column; gap:var(--space-4); padding:var(--space-5) var(--space-6); max-width:720px; margin:0 auto; width:100%; }
    @media(max-width:600px){#view-family-wall.active{padding:var(--space-3);}}

    .fw-filter-bar { display:flex; flex-direction:column; gap:var(--space-2); padding:var(--space-3); background:var(--color-surface); border:1px solid var(--color-border); border-radius:var(--radius-md); }
    .fw-mode-row { display:flex; gap:var(--space-1); }
    .fw-mode-btn { padding:var(--space-1-5) var(--space-3); font-size:var(--text-xs); font-family:var(--font-body); font-weight:var(--weight-medium); background:transparent; border:1px solid var(--color-border); border-radius:var(--radius-sm); cursor:pointer; transition:all var(--transition-fast); color:var(--color-text-muted); }
    .fw-mode-btn.active { background:var(--color-accent); color:white; border-color:var(--color-accent); }
    .fw-filter-members { display:flex; gap:var(--space-1-5); flex-wrap:wrap; align-items:center; }
    .fw-av-btn { width:32px; height:32px; border-radius:var(--radius-full); border:2px solid transparent; font-size:11px; font-weight:var(--weight-bold); font-family:var(--font-body); cursor:pointer; display:flex; align-items:center; justify-content:center; background:var(--color-surface-2); color:var(--color-text-muted); transition:all var(--transition-fast); }
    .fw-av-btn.active { border-color:var(--color-accent); box-shadow:0 0 0 2px rgba(10,123,108,0.2); }
    .fw-filter-types { display:flex; gap:var(--space-1); flex-wrap:wrap; }
    .fw-type-btn { padding:var(--space-1) var(--space-2-5); font-size:var(--text-xs); font-family:var(--font-body); font-weight:var(--weight-medium); color:var(--color-text-muted); background:transparent; border:1px solid var(--color-border); border-radius:var(--radius-full); cursor:pointer; transition:all var(--transition-fast); }
    .fw-type-btn:hover { background:var(--color-surface-2); color:var(--color-text); }
    .fw-type-btn.active { background:var(--color-accent); color:white; border-color:var(--color-accent); }
    .fw-filter-tags { display:flex; gap:var(--space-1); flex-wrap:wrap; }
    .fw-tag-chip { padding:2px 8px; font-size:var(--text-xs); font-family:var(--font-body); color:var(--color-text-muted); background:var(--color-surface-2); border:1px solid var(--color-border); border-radius:var(--radius-full); cursor:pointer; transition:all var(--transition-fast); }
    .fw-tag-chip.active { background:var(--color-info-bg); color:var(--color-info-text); border-color:var(--color-info); }

    .fw-compose { display:flex; flex-direction:column; gap:var(--space-3); padding:var(--space-4); background:var(--color-bg); border:1px solid var(--color-border); border-radius:var(--radius-md); box-shadow:var(--shadow-xs); }
    .fw-compose-hdr { display:flex; align-items:center; gap:var(--space-2-5); }
    .fw-compose-name { font-size:var(--text-sm); font-weight:var(--weight-semibold); color:var(--color-text); }
    .fw-compose-text { resize:vertical; min-height:60px; padding:var(--space-2-5); font-family:var(--font-body); font-size:var(--text-sm); border:1px solid var(--color-border); border-radius:var(--radius-sm); background:var(--color-surface); color:var(--color-text); transition:border-color var(--transition-fast); width:100%; box-sizing:border-box; }
    .fw-compose-text:focus { outline:none; border-color:var(--color-accent); box-shadow:var(--shadow-focus); }
    .fw-compose-media { display:flex; flex-direction:column; gap:var(--space-2); }
    .fw-compose-url { font-size:var(--text-sm); padding:var(--space-1-5) var(--space-2-5); width:100%; box-sizing:border-box; }
    .fw-compose-preview { width:100%; max-height:200px; object-fit:cover; border-radius:var(--radius-sm); border:1px solid var(--color-border); }
    .fw-compose-filesec { display:flex; flex-direction:column; gap:var(--space-2); }
    .fw-compose-file-list { display:flex; flex-direction:column; gap:var(--space-1); }
    .fw-compose-fattach { display:flex; align-items:center; gap:var(--space-2); padding:var(--space-1-5) var(--space-2); background:var(--color-surface); border:1px solid var(--color-border); border-radius:var(--radius-sm); font-size:var(--text-xs); }
    .fw-compose-tag-inp { font-size:var(--text-sm); padding:var(--space-1-5) var(--space-2-5); width:100%; box-sizing:border-box; }
    .fw-compose-type-btns { display:flex; gap:var(--space-1); flex-wrap:wrap; }
    .fw-compose-type-btn.active { background:var(--color-accent); color:white; }
    .fw-compose-actions { display:flex; align-items:center; justify-content:space-between; gap:var(--space-2); flex-wrap:wrap; }
    .fw-file-lbl { cursor:pointer; display:inline-flex; align-items:center; gap:var(--space-1); }

    .fw-avatar { width:36px; height:36px; border-radius:var(--radius-full); display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:var(--weight-bold); color:white; flex-shrink:0; font-family:var(--font-body); }
    .fw-avatar-sm { width:26px; height:26px; font-size:10px; }

    .fw-post-card { background:var(--color-bg); border:1px solid var(--color-border); border-radius:var(--radius-md); overflow:hidden; transition:box-shadow var(--transition-base); }
    .fw-post-card:hover { box-shadow:var(--shadow-sm); }
    .fw-pin-badge { padding:var(--space-1-5) var(--space-3); font-size:var(--text-xs); font-weight:var(--weight-semibold); color:var(--color-warning-text); background:var(--color-warning-bg); border-bottom:1px solid var(--color-border); }
    .fw-post-hdr { display:flex; align-items:center; gap:var(--space-2-5); padding:var(--space-3) var(--space-4); position:relative; }
    .fw-post-meta { flex:1; display:flex; flex-direction:column; gap:1px; min-width:0; }
    .fw-post-author { font-size:var(--text-sm); font-weight:var(--weight-semibold); color:var(--color-text); }
    .fw-post-time { font-size:var(--text-xs); color:var(--color-text-muted); }
    .fw-post-acts { display:flex; gap:var(--space-1); opacity:0; transition:opacity var(--transition-fast); }
    .fw-post-card:hover .fw-post-acts { opacity:1; }
    .fw-act-btn { width:28px; height:28px; font-size:14px; }
    .fw-act-del:hover { background:var(--color-danger-bg); }

    .fw-post-body { padding:0 var(--space-4) var(--space-3); }
    .fw-post-text { font-size:var(--text-sm); color:var(--color-text); line-height:var(--leading-relaxed); margin:0; white-space:pre-wrap; word-break:break-word; }
    .fw-img-wrap { position:relative; margin-top:var(--space-2); }
    .fw-post-img { width:100%; max-height:480px; object-fit:cover; border-radius:var(--radius-sm); cursor:zoom-in; display:block; transition:opacity var(--transition-fast); }
    .fw-post-img:hover { opacity:0.92; }
    .fw-img-toolbar { display:flex; gap:var(--space-2); padding:var(--space-1-5) 0; opacity:0; transition:opacity var(--transition-fast); }
    .fw-img-wrap:hover .fw-img-toolbar { opacity:1; }
    .fw-img-tbtn { padding:3px 10px; font-size:var(--text-xs); font-family:var(--font-body); background:var(--color-surface); border:1px solid var(--color-border); border-radius:var(--radius-full); cursor:pointer; transition:background var(--transition-fast); color:var(--color-text); }
    .fw-img-tbtn:hover { background:var(--color-surface-2); }
    .fw-link-card { display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2-5) var(--space-3); margin-top:var(--space-2); background:var(--color-surface); border:1px solid var(--color-border); border-radius:var(--radius-sm); text-decoration:none; color:var(--color-text-link); font-size:var(--text-sm); transition:background var(--transition-fast); cursor:pointer; }
    .fw-link-card:hover { background:var(--color-surface-2); }
    .fw-link-ico { font-size:var(--text-md); flex-shrink:0; }
    .fw-link-txt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
    .fw-link-arrow { font-size:var(--text-xs); color:var(--color-text-muted); flex-shrink:0; }
    .fw-milestone { padding:var(--space-2) var(--space-3); margin-top:var(--space-2); background:linear-gradient(135deg,#fef3c7,#fde68a); border-radius:var(--radius-sm); font-size:var(--text-sm); font-weight:var(--weight-semibold); color:#92400e; text-align:center; }
    .fw-post-tags { display:flex; gap:var(--space-1); flex-wrap:wrap; margin-top:var(--space-2); }
    .fw-file-list { display:flex; flex-direction:column; gap:var(--space-2); margin-top:var(--space-2); }
    .fw-file-row { display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2); background:var(--color-surface); border:1px solid var(--color-border); border-radius:var(--radius-sm); }
    .fw-file-ico { font-size:24px; flex-shrink:0; }
    .fw-file-thumb { width:52px; height:52px; object-fit:cover; border-radius:var(--radius-sm); cursor:zoom-in; flex-shrink:0; }
    .fw-file-inf { flex:1; display:flex; flex-direction:column; gap:2px; min-width:0; }
    .fw-file-name { font-size:var(--text-sm); color:var(--color-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .fw-file-size { font-size:var(--text-xs); color:var(--color-text-muted); }
    .fw-attach-row { display:flex; gap:var(--space-1-5); flex-wrap:wrap; padding:0 var(--space-4) var(--space-2); }
    .fw-attach-chip { display:inline-flex; align-items:center; gap:var(--space-1); padding:3px 10px; font-size:var(--text-xs); font-family:var(--font-body); background:var(--color-surface-2); border:1px solid var(--color-border); border-radius:var(--radius-full); cursor:pointer; transition:background var(--transition-fast); color:var(--color-text); }
    .fw-attach-chip:hover { border-color:var(--color-accent); }

    .fw-rxn-bar { display:flex; align-items:center; gap:var(--space-1); padding:var(--space-2) var(--space-4); border-top:1px solid var(--color-border); flex-wrap:wrap; }
    .fw-rxn-btn { display:inline-flex; align-items:center; gap:3px; padding:var(--space-1) var(--space-2); font-size:14px; font-family:var(--font-body); background:transparent; border:1px solid var(--color-border); border-radius:var(--radius-full); cursor:pointer; transition:all var(--transition-fast); line-height:1; }
    .fw-rxn-btn:hover { background:var(--color-surface); }
    .fw-rxn-btn.active { background:var(--color-info-bg); border-color:var(--color-info); }
    .fw-rxn-c { font-size:11px; font-weight:var(--weight-semibold); color:var(--color-text-muted); }
    .fw-cmt-toggle { display:inline-flex; align-items:center; gap:3px; padding:var(--space-1) var(--space-2); font-size:13px; font-family:var(--font-body); background:transparent; border:1px solid var(--color-border); border-radius:var(--radius-full); cursor:pointer; margin-left:auto; transition:all var(--transition-fast); }
    .fw-cmt-toggle:hover { background:var(--color-surface); }
    .fw-cmt-thread { display:none; flex-direction:column; gap:var(--space-2); padding:var(--space-3) var(--space-4); border-top:1px solid var(--color-border); background:var(--color-surface); }
    .fw-cmt-thread.open { display:flex; }
    .fw-cmt { display:flex; gap:var(--space-2); align-items:flex-start; }
    .fw-cmt-cnt { flex:1; min-width:0; }
    .fw-cmt-nm { font-size:var(--text-xs); color:var(--color-text); }
    .fw-cmt-tm { font-weight:var(--weight-regular); color:var(--color-text-muted); margin-left:var(--space-1); }
    .fw-cmt-bd { font-size:var(--text-sm); color:var(--color-text); line-height:var(--leading-normal); margin-top:2px; }
    .fw-cmt-input { display:flex; gap:var(--space-2); align-items:center; margin-top:var(--space-1); }
    .fw-cmt-field { flex:1; font-size:var(--text-sm); padding:var(--space-1-5) var(--space-2-5); }
    .fw-empty { padding:var(--space-10) var(--space-4); text-align:center; color:var(--color-text-muted); font-size:var(--text-sm); }

    /* Lightbox */
    .fw-lb { position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.93); display:flex; flex-direction:column; opacity:0; transition:opacity 0.15s ease; }
    .fw-lb.open { opacity:1; }
    .fw-lb-tb { display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) var(--space-4); background:rgba(0,0,0,0.75); flex-shrink:0; flex-wrap:wrap; }
    .fw-lb-fn { flex:1; font-size:var(--text-sm); color:#ddd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .fw-lb-btn { padding:var(--space-1-5) var(--space-3); font-size:var(--text-xs); background:rgba(255,255,255,0.12); color:white; border:1px solid rgba(255,255,255,0.25); border-radius:var(--radius-sm); cursor:pointer; transition:background var(--transition-fast); font-family:var(--font-body); }
    .fw-lb-btn:hover { background:rgba(255,255,255,0.22); }
    .fw-lb-close { background:rgba(220,38,38,0.7); border-color:rgba(220,38,38,0.5); }
    .fw-lb-wrap { flex:1; display:flex; align-items:center; justify-content:center; overflow:hidden; }
    .fw-lb-img { max-width:100%; max-height:100%; object-fit:contain; transform-origin:center; transition:transform 0.05s linear; user-select:none; }
    .fw-lb-nav { position:absolute; top:50%; transform:translateY(-50%); background:rgba(255,255,255,0.15); color:white; border:none; font-size:2.5rem; padding:var(--space-2) var(--space-3); cursor:pointer; border-radius:var(--radius-sm); z-index:10; transition:background var(--transition-fast); }
    .fw-lb-nav:hover { background:rgba(255,255,255,0.28); }
    .fw-lb-prev { left:var(--space-3); }
    .fw-lb-next { right:var(--space-3); }

    /* Post highlight (from Daily Review navigation) */
    @keyframes fw-highlight-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(10,123,108,0.5), var(--shadow-sm); }
      50%  { box-shadow: 0 0 0 6px rgba(10,123,108,0.2), var(--shadow-md); }
      100% { box-shadow: 0 0 0 0 rgba(10,123,108,0), var(--shadow-sm); }
    }
    .fw-post-highlight {
      animation: fw-highlight-pulse 0.7s ease-out 2;
      border-color: var(--color-accent) !important;
    }

    /* Upload progress */
    .fw-prog-wrap { display:inline-block; width:80px; height:6px; background:var(--color-border); border-radius:3px; vertical-align:middle; overflow:hidden; }
    .fw-prog-bar  { display:block; height:100%; background:var(--color-accent); border-radius:3px; transition:width 0.1s linear; }
    .fw-prog-txt  { font-size:var(--text-xs); color:var(--color-text-muted); vertical-align:middle; }

    /* Timeline */
    .fw-tl { display:flex; flex-direction:column; gap:var(--space-4); }
    .fw-tl-tabs { display:flex; gap:var(--space-2); flex-wrap:wrap; }
    .fw-tl-tab { display:flex; align-items:center; gap:var(--space-1-5); padding:var(--space-1-5) var(--space-3); border:2px solid var(--color-border); border-radius:var(--radius-full); background:transparent; cursor:pointer; font-family:var(--font-body); transition:all var(--transition-fast); }
    .fw-tl-tab.active { background:var(--color-surface); box-shadow:var(--shadow-xs); }
    .fw-tl-profile { display:flex; align-items:center; gap:var(--space-4); padding:var(--space-5); background:linear-gradient(135deg,var(--color-surface),var(--color-bg)); border:1px solid var(--color-border); border-radius:var(--radius-md); }
    .fw-tl-big-av { width:72px; height:72px; border-radius:var(--radius-full); display:flex; align-items:center; justify-content:center; font-size:28px; font-weight:var(--weight-bold); color:white; flex-shrink:0; }
    .fw-tl-pi { display:flex; flex-direction:column; gap:var(--space-1); }
    .fw-tl-pname { font-family:var(--font-heading); font-size:var(--text-2xl); margin:0; color:var(--color-text); }
    .fw-tl-prole { font-size:var(--text-sm); color:var(--color-text-muted); }
    .fw-tl-stats { display:flex; gap:var(--space-6); padding:var(--space-3) var(--space-4); background:var(--color-surface); border:1px solid var(--color-border); border-radius:var(--radius-md); }
    .fw-tl-stat { display:flex; flex-direction:column; align-items:center; gap:2px; }
    .fw-tl-sn { font-size:var(--text-xl); font-weight:var(--weight-bold); color:var(--color-text); }
    .fw-tl-sl { font-size:var(--text-xs); color:var(--color-text-muted); }
    .fw-tl-strip { display:flex; gap:var(--space-1-5); overflow-x:auto; padding-bottom:var(--space-1); }
    .fw-tl-thumb { width:96px; height:96px; object-fit:cover; border-radius:var(--radius-sm); flex-shrink:0; cursor:zoom-in; transition:opacity var(--transition-fast); }
    .fw-tl-thumb:hover { opacity:0.85; }
    .fw-tl-year { display:flex; flex-direction:column; gap:var(--space-3); }
    .fw-tl-year-lbl { font-family:var(--font-heading); font-size:var(--text-xl); font-weight:var(--weight-bold); color:var(--color-text-muted); padding:var(--space-1) 0; border-bottom:2px solid var(--color-border); }
    .fw-tl-year-posts { display:flex; flex-direction:column; gap:var(--space-3); padding-left:var(--space-4); border-left:3px solid var(--color-border); }
    .fw-tl-card { position:relative; }
    .fw-tl-card::before { content:\'\'; position:absolute; left:calc(-1 * var(--space-4) - 5px); top:18px; width:10px; height:10px; border-radius:var(--radius-full); background:var(--color-accent); }
  `;
  document.head.appendChild(s);
}

// ── Main render ───────────────────────────────────────────────

/** Render guard — prevents concurrent renderWall calls from doubling content */
let _wallRendering = false;

async function renderWall(params={}) {
  const el=document.getElementById('view-family-wall');
  if (!el) return;
  _injectStyles();

  // Cancel any pending debounce — we're about to render fresh
  if (_wallTimer) { clearTimeout(_wallTimer); _wallTimer=null; }

  // Guard: if already rendering, skip (debounce will re-trigger after)
  if (_wallRendering) return;
  _wallRendering = true;

  if (!params?._internal) {
    _filterMemberId=null; _filterPostType='All'; _filterPinnedOnly=false;
    _filterTag=null; _viewMode='feed'; _timelinePerson=null;
  }

  el.innerHTML='<div style="padding:var(--space-8);color:var(--color-text-muted);text-align:center;">Loading Family Wall…</div>';

  const highlightId = params?.highlightId || null;

  try {
    const { posts, persons, pm, apm } = await _loadData();
    el.innerHTML='';
    _buildFilterBar(el, persons, posts);
    _buildCompose(el, pm, apm);

    if (_viewMode==='timeline') {
      await _buildTimeline(el, posts, persons, pm, apm);
    } else {
      const filtered=_filterPosts(posts);
      if (!filtered.length) {
        const empty=document.createElement('div'); empty.className='fw-empty';
        empty.textContent=_filterPinnedOnly||_filterPostType!=='All'||_filterMemberId||_filterTag
          ?'No posts match your filters.'
          :'No posts yet. Be the first to share something!';
        el.appendChild(empty);
      } else {
        for (const post of filtered) el.appendChild(await _buildCard(post,pm,apm));
      }
    }

    // Scroll to + highlight a specific post if navigated from Daily Review
    if (highlightId) {
      requestAnimationFrame(() => {
        const target = el.querySelector(`[data-post-id="${highlightId}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('fw-post-highlight');
          setTimeout(() => target.classList.remove('fw-post-highlight'), 2200);
        }
      });
    }
  } catch(e) {
    console.error('[fw] render failed',e);
    el.innerHTML='<div style="padding:var(--space-8);color:var(--color-danger-text);text-align:center;">Failed to load. Please refresh.</div>';
  } finally {
    _wallRendering = false;
  }
}

// ── Live updates ──────────────────────────────────────────────

let _wallTimer=null;
function _debounce() {
  if (_wallTimer) clearTimeout(_wallTimer);
  _wallTimer=setTimeout(()=>{ _wallTimer=null; const e=document.getElementById('view-family-wall'); if(e?.classList.contains('active')) renderWall({_internal:true}); },200);
}
on(EVENTS.ENTITY_SAVED,   _debounce);
on(EVENTS.ENTITY_DELETED, _debounce);
on(EVENTS.EDGE_SAVED,     _debounce);
on(EVENTS.EDGE_DELETED,   _debounce);

// ── Register ──────────────────────────────────────────────────

registerView('family-wall', renderWall);
export { renderWall };
