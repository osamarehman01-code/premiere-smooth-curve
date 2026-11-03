/* Premiere Smooth Curve - panel UI */
(function () {
  'use strict';
  var E = window.PSEase, H = window.PSHost;
  var $ = function (id) { return document.getElementById(id); };
  var NS = 'http://www.w3.org/2000/svg';

  // ---------- state ----------
  var TYPE_LABEL = { bezier: 'Bezier', elastic: 'Elastic', bounce: 'Bounce', spring: 'Spring' };
  var curve = load('ps.curve', { type: 'bezier', params: clone(E.DEFAULTS.bezier) });
  var paramMemory = load('ps.paramMemory', {}); // last params per type
  var presets = load('ps.presets', []);
  var settings = load('ps.settings', { step: 1, scope: 'all' });
  var view = load('ps.view', { speed: false, indicator: false, mode: 'value' });
  var activePreset = null;
  var host = { clips: [], sequence: null, canUndo: false };
  var targets = {};          // "ci:pi" -> bool
  var selectionSig = '';
  var busy = false;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  function r3(v) { return Math.round(v * 1000) / 1000; }

  // ---------- graph ----------
  var VB = { w: 360, h: 300 }, BOX = { x: 40, y: 40, w: 280, h: 220 };
  var svg = $('graph');
  svg.setAttribute('viewBox', '0 0 ' + VB.w + ' ' + VB.h);
  svg.style.overflow = 'visible';
  function px(x) { return BOX.x + x * BOX.w; }
  function py(y) { return BOX.y + (1 - y) * BOX.h; }
  function el(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    (parent || svg).appendChild(n);
    return n;
  }
  function pathFrom(fn, n) {
    var d = '', i;
    for (i = 0; i <= n; i++) { var x = i / n; d += (i ? 'L' : 'M') + px(x).toFixed(2) + ' ' + py(fn(x)).toFixed(2); }
    return d;
  }

  function draw() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var i, g = el('g', {});
    for (i = 1; i < 4; i++) {
      el('line', { x1: px(i / 4), y1: py(0), x2: px(i / 4), y2: py(1), 'class': 'grid' }, g);
      el('line', { x1: px(0), y1: py(i / 4), x2: px(1), y2: py(i / 4), 'class': 'grid' }, g);
    }
    el('rect', { x: BOX.x, y: BOX.y, width: BOX.w, height: BOX.h, 'class': 'box' }, g);

    var f = E.make(curve), sp = E.speedSamples(curve, 200);
    var speedFn = function (x) { return sp.values[Math.round(x * 200)] / sp.max; };
    var isBez = curve.type === 'bezier';

    if (view.mode === 'speed') {
      el('path', { d: pathFrom(f, 200), 'class': 'curve dim' });
      el('path', { d: pathFrom(speedFn, 200), 'class': 'curve' });
    } else {
      if (view.speed) el('path', { d: pathFrom(speedFn, 200), 'class': 'speed' });
      el('path', { d: pathFrom(f, 300), 'class': 'curve' });
    }
    if (view.indicator) {
      for (i = 0; i <= 20; i++) { var x = i / 20; el('circle', { cx: px(x), cy: py(f(x)), r: 3, 'class': 'ind' }); }
    }
    if (isBez) {
      var p = curve.params;
      el('line', { x1: px(0), y1: py(0), x2: px(p.x1), y2: py(p.y1), 'class': 'handle-line' });
      el('line', { x1: px(1), y1: py(1), x2: px(p.x2), y2: py(p.y2), 'class': 'handle-line' });
      handle(px(p.x1), py(p.y1), 1);
      handle(px(p.x2), py(p.y2), 2);
      $('readout').textContent = 'cubic-bezier(' + r3(p.x1) + ', ' + r3(p.y1) + ', ' + r3(p.x2) + ', ' + r3(p.y2) + ')';
    } else {
      $('readout').textContent = '';
    }
    renderParamBox();
  }
  function handle(cx, cy, idx) {
    var c = el('circle', { cx: cx, cy: cy, r: 7, 'class': 'handle', 'data-h': idx });
    c.addEventListener('pointerdown', startDrag);
  }
  var drag = null;
  function svgPoint(evt) {
    var pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  function startDrag(evt) {
    drag = Number(evt.target.getAttribute('data-h'));
    svg.setPointerCapture(evt.pointerId);
    evt.preventDefault();
  }
  svg.addEventListener('pointermove', function (evt) {
    if (!drag) return;
    var pt = svgPoint(evt);
    var x = E.clamp((pt.x - BOX.x) / BOX.w, 0, 1);
    var y = E.clamp(1 - (pt.y - BOX.y) / BOX.h, -1, 2);
    if (evt.shiftKey) y = drag === 1 ? 0 : 1; // flat handle, like the screenshot
    curve.params['x' + drag] = r3(x);
    curve.params['y' + drag] = r3(y);
    activePreset = null;
    draw();
  });
  function endDrag() { if (drag) { drag = null; persistCurve(); renderPresets(); } }
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  function persistCurve() { save('ps.curve', curve); paramMemory[curve.type] = clone(curve.params); save('ps.paramMemory', paramMemory); }

  // ---------- curve types ----------
  var PARAM_DEF = {
    elastic: [['amplitude', 'Amplitude', 1, 3, 0.05], ['period', 'Period', 0.1, 1, 0.01]],
    bounce: [['bounces', 'Bounces', 1, 6, 1], ['bounciness', 'Bounciness', 0.1, 0.9, 0.05]],
    spring: [['stiffness', 'Stiffness', 20, 600, 5], ['damping', 'Damping', 2, 40, 0.5], ['duration', 'Duration', 0.3, 3, 0.05]]
  };
  function setType(t) {
    if (curve.type === t) return;
    paramMemory[curve.type] = clone(curve.params);
    curve = { type: t, params: clone(paramMemory[t] || E.DEFAULTS[t]) };
    activePreset = null;
    $('typeName').textContent = TYPE_LABEL[t];
    persistCurve(); draw(); renderPresets();
  }
  function cycleType(dir) {
    var i = E.TYPES.indexOf(curve.type);
    setType(E.TYPES[(i + dir + E.TYPES.length) % E.TYPES.length]);
  }
  function renderParamBox() {
    var box = $('paramBox'), defs = PARAM_DEF[curve.type];
    if (!defs) { box.classList.add('hidden'); return; }
    if (box.getAttribute('data-type') === curve.type && !box.classList.contains('hidden')) {
      defs.forEach(function (d) { var b = box.querySelector('b[data-k=' + d[0] + ']'); if (b) b.textContent = curve.params[d[0]]; });
      return;
    }
    box.innerHTML = '';
    box.setAttribute('data-type', curve.type);
    defs.forEach(function (d) {
      var row = document.createElement('div'); row.className = 'prow';
      row.innerHTML = '<span>' + d[1] + ' <b data-k="' + d[0] + '">' + curve.params[d[0]] + '</b></span>';
      var inp = document.createElement('input');
      inp.type = 'range'; inp.min = d[2]; inp.max = d[3]; inp.step = d[4]; inp.value = curve.params[d[0]];
      inp.addEventListener('input', function () { curve.params[d[0]] = Number(inp.value); activePreset = null; draw(); });
      inp.addEventListener('change', function () { persistCurve(); renderPresets(); });
      row.appendChild(inp); box.appendChild(row);
    });
    box.classList.remove('hidden');
  }

  // ---------- presets ----------
  function thumb(c, w, h) {
    var s = document.createElementNS(NS, 'svg'), f = E.make(c), d = '', i;
    s.setAttribute('viewBox', '0 0 ' + w + ' ' + h); s.setAttribute('class', 'thumb');
    for (i = 0; i <= 40; i++) { var x = i / 40; d += (i ? 'L' : 'M') + (3 + x * (w - 6)).toFixed(1) + ' ' + (h - 4 - f(x) * (h - 8)).toFixed(1); }
    var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p);
    return s;
  }
  function renderPresets() {
    var list = $('presetList'), q = $('presetSearch').value.trim().toLowerCase();
    list.innerHTML = '';
    var shown = presets.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) >= 0; });
    if (!shown.length) {
      list.innerHTML = '<div class="empty"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>' +
        (presets.length ? 'No matching presets' : 'No presets yet') + '</div>';
      return;
    }
    shown.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'preset' + (activePreset === p.id ? ' active' : '');
      row.appendChild(thumb(p, 34, 26));
      var name = document.createElement('span'); name.className = 'pname'; name.textContent = p.name; row.appendChild(name);
      var ex = document.createElement('button'); ex.className = 'del'; ex.title = 'Export'; ex.textContent = '\u2913';
      ex.addEventListener('click', function (e) { e.stopPropagation(); exportPreset(p); });
      var del = document.createElement('button'); del.className = 'del'; del.title = 'Delete preset'; del.textContent = '\u00d7';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        confirmBox('Delete preset "' + p.name + '"?', function () {
          presets = presets.filter(function (x) { return x.id !== p.id; }); save('ps.presets', presets); renderPresets();
        });
      });
      row.appendChild(ex); row.appendChild(del);
      row.addEventListener('click', function () { loadCurve(p); activePreset = p.id; renderPresets(); });
      row.addEventListener('dblclick', function () { doApply(); });
      list.appendChild(row);
    });
  }
  function loadCurve(p) {
    curve = { type: p.type, params: clone(p.params) };
    $('typeName').textContent = TYPE_LABEL[curve.type];
    $('paramBox').removeAttribute('data-type');
    persistCurve(); draw();
  }
  function addPreset(p) {
    var item = { id: 'p' + Date.now() + Math.floor(Math.random() * 1000), name: p.name, type: p.type, params: clone(p.params) };
    presets.unshift(item); save('ps.presets', presets);
    return item;
  }
  function normalizeImported(obj) {
    var out = [];
    function one(o) {
      if (!o) return;
      if (typeof o === 'string') {
        var m = o.match(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/i);
        if (m) out.push({ name: 'Imported bezier', type: 'bezier', params: { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] } });
        return;
      }
      if (o.presets) { o.presets.forEach(one); return; }
      var type = (o.type || 'bezier').toLowerCase(), params = o.params || o;
      if (E.TYPES.indexOf(type) < 0) return;
      if (type === 'bezier' && [params.x1, params.y1, params.x2, params.y2].some(function (v) { return typeof v !== 'number'; })) return;
      out.push({ name: o.name || 'Imported preset', type: type, params: params });
    }
    if (Array.isArray(obj)) obj.forEach(one); else one(obj);
    return out;
  }
  function importPreset() {
    var path = H.openDialog('Import Premiere Smooth Curve preset', ['json', 'txt']);
    if (!path) return;
    var txt = H.readFile(path), got = [];
    try { got = normalizeImported(JSON.parse(txt)); } catch (e) { got = normalizeImported(String(txt)); }
    if (!got.length) return toast('No presets found in that file.', 'err');
    got.forEach(addPreset); renderPresets(); toast('Imported ' + got.length + ' preset' + (got.length > 1 ? 's' : '') + '.', 'ok');
  }
  function exportPreset(p) {
    var path = H.saveDialog('Export preset', p.name.replace(/[^\w\- ]+/g, '') + '.json');
    if (!path) return;
    if (!/\.json$/i.test(path)) path += '.json';
    var ok = H.writeFile(path, JSON.stringify({ app: 'Premiere Smooth Curve', version: 1, name: p.name, type: p.type, params: p.params }, null, 2));
    toast(ok ? 'Preset exported.' : 'Could not write the file.', ok ? 'ok' : 'err');
  }

  // ---------- modals ----------
  function modal(title, build) {
    $('modalTitle').textContent = title;
    var body = $('modalBody'); body.innerHTML = '';
    build(body);
    $('modal').classList.remove('hidden');
  }
  function closeModal() { $('modal').classList.add('hidden'); }
  function confirmBox(msg, yes) {
    modal('Confirm', function (b) {
      b.innerHTML = '<p></p><div class="row"><button class="btn-link" id="mNo">Cancel</button><button class="btn-apply" id="mYes">Yes</button></div>';
      b.querySelector('p').textContent = msg;
      $('mNo').onclick = closeModal; $('mYes').onclick = function () { closeModal(); yes(); };
    });
  }
  function savePresetDialog() {
    modal('Save as preset', function (b) {
      b.innerHTML = '<input type="text" id="mName" placeholder="Preset name" /><div class="row"><button class="btn-link" id="mNo">Cancel</button><button class="btn-apply" id="mYes">Save</button></div>';
      var inp = $('mName'); inp.value = TYPE_LABEL[curve.type] + ' ' + (presets.length + 1); setTimeout(function () { inp.select(); }, 30);
      function go() { var n = inp.value.trim(); if (!n) return; var p = addPreset({ name: n, type: curve.type, params: curve.params }); activePreset = p.id; closeModal(); renderPresets(); toast('Preset saved.', 'ok'); }
      $('mYes').onclick = go; $('mNo').onclick = closeModal;
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    });
  }
  function libraryDialog() {
    modal('Presets library', function (b) {
      var grid = document.createElement('div'); grid.className = 'lib';
      E.BUILTIN.forEach(function (p) {
        var row = document.createElement('div'); row.className = 'preset';
        row.appendChild(thumb(p, 120, 60));
        var n = document.createElement('span'); n.className = 'pname'; n.textContent = p.name; row.appendChild(n);
        row.title = 'Click: load curve. Double-click: add to my presets.';
        row.onclick = function () { loadCurve(p); activePreset = null; renderPresets(); };
        row.ondblclick = function () { addPreset(p); renderPresets(); toast('Added "' + p.name + '" to your presets.', 'ok'); };
        grid.appendChild(row);
      });
      var tip = document.createElement('p'); tip.textContent = 'Click to load a curve, double-click to add it to your presets.';
      b.appendChild(tip); b.appendChild(grid);
    });
  }
  function settingsDialog() {
    modal('Settings', function (b) {
      b.innerHTML =
        '<div class="opt"><span>Keyframe density</span><select id="sStep"><option value="1">Every frame (smoothest)</option><option value="2">Every 2 frames</option><option value="3">Every 3 frames</option><option value="4">Every 4 frames</option></select></div>' +
        '<div class="opt"><span>Apply to</span><select id="sScope"><option value="all">All keyframe pairs</option><option value="playhead">Only the pair under the playhead</option></select></div>' +
        '<p>The curve is baked into keyframes between each pair of your keyframes. Your original keyframes stay as anchors, so you can re-apply a new curve, undo, or remove the smoothing at any time.</p>';
      $('sStep').value = String(settings.step); $('sScope').value = settings.scope;
      $('sStep').onchange = function () { settings.step = Number(this.value); save('ps.settings', settings); };
      $('sScope').onchange = function () { settings.scope = this.value; save('ps.settings', settings); };
    });
  }
  function helpDialog() {
    modal('How Premiere Smooth Curve works', function (b) {
      b.innerHTML = '<p>1. Add two or more keyframes to a clip property (Position, Scale, Rotation, Opacity, any effect).</p>' +
        '<p>2. Select the clip in the timeline. Pick which keyframed properties to smooth from the menu at the top right.</p>' +
        '<p>3. Shape the curve (drag the green handles, hold Shift to flatten a handle) or pick a preset, then press Apply.</p>' +
        '<p>Re-apply as often as you like: Premiere Smooth Curve remembers your original keyframes. The bin icon removes the smoothing, the arrow undoes the last apply.</p>';
    });
  }
  var toastTimer;
  function toast(msg, kind) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast ' + (kind || '');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 3200);
    if (kind === 'err') { $('btnWarn').classList.remove('hidden'); $('btnWarn').title = msg; }
  }

  // ---------- host / selection ----------
  function propKey(p) { return p.ci + ':' + p.pi; }
  function refresh() {
    if (busy) return Promise.resolve();
    return H.call('getState').then(function (st) {
      $('hostPill').classList.toggle('on', !!(st && st.ok));
      if (!st || !st.ok) { host = { clips: [] }; renderSelection(); return; }
      host = st;
      var sig = st.clips.map(function (c) { return c.nodeId + '[' + c.props.map(propKey).join(',') + ']'; }).join('|');
      if (sig !== selectionSig) {
        selectionSig = sig; targets = {};
        st.clips.forEach(function (c) { c.props.forEach(function (p) { targets[propKey(p)] = true; }); });
      }
      renderSelection();
    });
  }
  function chosenTargets() {
    var out = [], seen = {};
    host.clips.forEach(function (c) { c.props.forEach(function (p) { var k = propKey(p); if (targets[k] && !seen[k]) { seen[k] = 1; out.push({ ci: p.ci, pi: p.pi }); } }); });
    return out;
  }
  function renderSelection() {
    var clips = host.clips || [], nProps = chosenTargets().length;
    var label, status;
    if (!H.available) { label = 'Open in Premiere'; status = 'Not connected to Premiere'; }
    else if (!host.sequence) { label = 'Select a clip'; status = 'No sequence open'; }
    else if (!clips.length) { label = 'Select a clip'; status = 'No clip selected'; }
    else {
      label = clips.length === 1 ? clips[0].name : clips.length + ' clips';
      var total = 0; clips.forEach(function (c) { total += c.props.length; });
      status = total ? (nProps + ' of ' + total + ' keyframed propert' + (total === 1 ? 'y' : 'ies')) : 'Selected clip has no keyframe pairs';
    }
    $('clipLabel').textContent = label;
    $('clipRing').classList.toggle('ok', nProps > 0);
    $('statusText').textContent = status;
    $('statusInfo').title = host.sequence ? ('Sequence: ' + host.sequence + (host.fps ? ' (' + Math.round(host.fps * 100) / 100 + ' fps)' : '')) : '';
    $('btnApply').disabled = busy || nProps === 0;
    if (!$('clipMenu').classList.contains('hidden')) renderClipMenu();
  }
  function renderClipMenu() {
    var m = $('clipMenu'); m.innerHTML = '';
    if (!host.clips || !host.clips.length) { m.innerHTML = '<div class="none">Select a clip with two or more keyframes in the timeline.</div>'; return; }
    host.clips.forEach(function (c) {
      var g = document.createElement('div'); g.className = 'grp'; g.textContent = c.name; m.appendChild(g);
      if (!c.props.length) { var n = document.createElement('div'); n.className = 'none'; n.textContent = 'No keyframe pairs'; m.appendChild(n); }
      c.props.forEach(function (p) {
        var l = document.createElement('label'), cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = !!targets[propKey(p)];
        cb.onchange = function () { targets[propKey(p)] = cb.checked; renderSelection(); };
        l.appendChild(cb);
        l.appendChild(document.createTextNode(p.comp + ' \u203a ' + p.name + ' (' + p.keys + ')'));
        if (p.smoothed) { var t = document.createElement('span'); t.className = 'tag'; t.textContent = 'smoothed'; l.appendChild(t); }
        m.appendChild(l);
      });
    });
  }

  function setBusy(b) { busy = b; $('btnApply').classList.toggle('busy', b); $('btnApply').textContent = b ? 'Applying\u2026' : 'Apply'; $('btnApply').disabled = b || chosenTargets().length === 0; }
  function doApply() {
    if (busy || !chosenTargets().length) return;
    setBusy(true);
    H.call('apply', { lut: E.lut(curve, 1000), step: settings.step, scope: settings.scope, targets: chosenTargets() }).then(function (r) {
      setBusy(false);
      if (r.ok) toast('Smoothed ' + r.pairs + ' keyframe pair' + (r.pairs === 1 ? '' : 's') + ' (' + r.keys + ' keys).', 'ok');
      else toast(r.error || 'Apply failed.', 'err');
      selectionSig = selectionSig + '*'; // keep user choices: restore below
      var keep = clone(targets);
      refresh().then(function () { targets = keep; renderSelection(); });
    });
  }
  function doUndo() {
    if (busy) return;
    H.call('undoLast').then(function (r) { toast(r.ok ? 'Last apply undone.' : (r.error || 'Undo failed.'), r.ok ? 'ok' : 'err'); refresh(); });
  }
  function doRemove() {
    if (busy) return;
    confirmBox('Remove the smoothing from the chosen properties? Your original keyframes stay.', function () {
      H.call('removeSmoothing', { targets: chosenTargets() }).then(function (r) {
        toast(r.ok ? ('Removed smoothing from ' + r.props + ' propert' + (r.props === 1 ? 'y' : 'ies') + '.') : (r.error || 'Failed.'), r.ok ? 'ok' : 'err');
        refresh();
      });
    });
  }

  // ---------- wiring ----------
  $('typePrev').onclick = function () { cycleType(-1); };
  $('typeNext').onclick = function () { cycleType(1); };
  $('btnReset').onclick = function () { curve.params = clone(E.DEFAULTS[curve.type]); activePreset = null; $('paramBox').removeAttribute('data-type'); persistCurve(); draw(); renderPresets(); };
  $('btnHome').onclick = function () { paramMemory = {}; curve = { type: 'bezier', params: clone(E.DEFAULTS.bezier) }; $('typeName').textContent = 'Bezier'; activePreset = null; persistCurve(); draw(); renderPresets(); };
  $('btnApply').onclick = doApply;
  $('btnUndo').onclick = doUndo;
  $('btnRemove').onclick = doRemove;
  $('btnRefresh').onclick = function () { refresh().then(function () { toast('Selection refreshed.'); }); };
  $('btnSettings').onclick = settingsDialog;
  $('btnHelp').onclick = helpDialog;
  $('btnWarn').onclick = function () { toast(this.title, 'err'); this.classList.add('hidden'); };
  $('btnSavePreset').onclick = savePresetDialog;
  $('btnImport').onclick = importPreset;
  $('btnLibrary').onclick = libraryDialog;
  $('modalClose').onclick = closeModal;
  $('modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  $('presetSearch').addEventListener('input', renderPresets);
  $('btnCollapse').onclick = function () {
    var c = $('sidebar').classList.toggle('collapsed');
    document.querySelector('.bottombar').classList.toggle('wide', c);
    this.classList.toggle('flip', c);
  };
  $('clipBtn').onclick = function (e) { e.stopPropagation(); var m = $('clipMenu'); m.classList.toggle('hidden'); if (!m.classList.contains('hidden')) { renderClipMenu(); refresh(); } };
  document.addEventListener('click', function (e) { if (!$('clipSelect').contains(e.target)) $('clipMenu').classList.add('hidden'); });
  $('chkSpeed').checked = view.speed; $('chkIndicator').checked = view.indicator; $('viewMode').value = view.mode;
  $('chkSpeed').onchange = function () { view.speed = this.checked; save('ps.view', view); draw(); };
  $('chkIndicator').onchange = function () { view.indicator = this.checked; save('ps.view', view); draw(); };
  $('viewMode').onchange = function () { view.mode = this.value; save('ps.view', view); draw(); };
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doApply();
  });

  $('typeName').textContent = TYPE_LABEL[curve.type];
  draw();
  renderPresets();
  renderSelection();
  refresh();
  setInterval(function () { if (!document.hidden && $('modal').classList.contains('hidden')) refresh(); }, 1500);
})();
