/* Premiere Smooth Curve - Premiere Pro ExtendScript host (ES3).
   Premiere scripting cannot set Bezier handles, so each pair of anchor keyframes is
   replaced by keyframes baked from the curve, linear between them. Anchor ticks are remembered so
   the curve can be re-applied, undone, or removed later. */
var PS = (function () {
  var STORE_NAME = 'baked.json';
  var undoStack = [];

  // ---------- tiny JSON (ExtendScript has no reliable JSON object) ----------
  function q(s) {
    s = String(s);
    var out = '"', i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      if (c === '"' || c === '\\') out += '\\' + c;
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (s.charCodeAt(i) < 32) out += ' ';
      else out += c;
    }
    return out + '"';
  }
  function enc(v) {
    var i, parts, k;
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return q(v);
    if (v instanceof Array) {
      parts = [];
      for (i = 0; i < v.length; i++) parts.push(enc(v[i]));
      return '[' + parts.join(',') + ']';
    }
    parts = [];
    for (k in v) if (v.hasOwnProperty(k)) parts.push(q(k) + ':' + enc(v[k]));
    return '{' + parts.join(',') + '}';
  }
  function dec(s) { return eval('(' + s + ')'); }

  // ---------- persistence of anchor records ----------
  function storeFile() {
    var dir = new Folder(Folder.userData.fsName + '/PronkSmooth');
    if (!dir.exists) dir.create();
    return new File(dir.fsName + '/' + STORE_NAME);
  }
  function loadStore() {
    try {
      var f = storeFile();
      if (!f.exists) return {};
      f.encoding = 'UTF-8';
      f.open('r');
      var s = f.read();
      f.close();
      return s ? dec(s) : {};
    } catch (e) { return {}; }
  }
  function saveStore(st) {
    var f = storeFile();
    f.encoding = 'UTF-8';
    f.open('w');
    f.write(enc(st));
    f.close();
  }

  // ---------- helpers ----------
  function seq() { return app.project ? app.project.activeSequence : null; }
  function mkTime(ticks) { var t = new Time(); t.ticks = String(Math.round(ticks)); return t; }
  function numTicks(t) { return Number(t.ticks); }
  function isNumeric(v) {
    if (typeof v === 'number') return isFinite(v);
    if (v && v.length !== undefined && typeof v !== 'string') {
      if (!v.length) return false;
      for (var i = 0; i < v.length; i++) if (typeof v[i] !== 'number') return false;
      return true;
    }
    return false;
  }
  function lerp(a, b, p) {
    if (typeof a === 'number') return a + (b - a) * p;
    var out = [], i;
    for (i = 0; i < a.length; i++) out.push(a[i] + (b[i] - a[i]) * p);
    return out;
  }
  function sampleLut(lut, x) {
    var n = lut.length - 1;
    if (x <= 0) return lut[0];
    if (x >= 1) return lut[n];
    var f = x * n, i = Math.floor(f), r = f - i;
    return lut[i] + (lut[i + 1] - lut[i]) * r;
  }
  function selectedItems(s) {
    var out = [], sel, i;
    try { sel = s.getSelection(); } catch (e) { sel = null; }
    if (!sel) return out;
    for (i = 0; i < sel.length; i++) if (sel[i] && sel[i].components) out.push(sel[i]);
    return out;
  }
  function recKey(s, item, ci, pi) {
    return (s.sequenceID || s.name) + '|' + item.nodeId + '|' + ci + ':' + pi;
  }
  function keyTicks(param) {
    var ks = param.getKeys(), out = [], i;
    if (!ks) return out;
    for (i = 0; i < ks.length; i++) out.push(numTicks(ks[i]));
    out.sort(function (a, b) { return a - b; });
    return out;
  }
  function keyedNumericProps(item) {
    var out = [], ci, pi, comp, prop, ks, v;
    for (ci = 0; ci < item.components.numItems; ci++) {
      comp = item.components[ci];
      for (pi = 0; pi < comp.properties.numItems; pi++) {
        prop = comp.properties[pi];
        try {
          if (!prop.isTimeVarying()) continue;
          ks = prop.getKeys();
          if (!ks || ks.length < 2) continue;
          v = prop.getValueAtKey(ks[0]);
          if (!isNumeric(v)) continue;
          out.push({ ci: ci, pi: pi, comp: comp.displayName, name: prop.displayName, keys: ks.length, prop: prop });
        } catch (e) { }
      }
    }
    return out;
  }
  function anchorsFor(store, rk, ticks) {
    var rec = store[rk], i, a = [], set = {};
    if (!rec) return ticks.slice(0);
    for (i = 0; i < ticks.length; i++) set[ticks[i]] = true;
    for (i = 0; i < rec.length; i++) if (set[rec[i]]) a.push(rec[i]);
    // keys the user added by hand after baking that are not generated? cannot be told apart; keep anchors only
    return a.length >= 2 ? a : ticks.slice(0);
  }
  function wanted(targets, ci, pi) {
    if (!targets || !targets.length) return true;
    for (var i = 0; i < targets.length; i++) if (targets[i].ci === ci && targets[i].pi === pi) return true;
    return false;
  }

  // ---------- public API ----------
  function getState() {
    try {
      var s = seq();
      if (!s) return enc({ ok: true, sequence: null, clips: [] });
      var items = selectedItems(s), clips = [], i, j, props, store = loadStore();
      for (i = 0; i < items.length && i < 20; i++) {
        props = keyedNumericProps(items[i]);
        var plist = [];
        for (j = 0; j < props.length; j++) {
          plist.push({ ci: props[j].ci, pi: props[j].pi, comp: props[j].comp, name: props[j].name, keys: props[j].keys,
            smoothed: !!store[recKey(s, items[i], props[j].ci, props[j].pi)] });
        }
        clips.push({ name: items[i].name, nodeId: items[i].nodeId, props: plist });
      }
      return enc({ ok: true, sequence: s.name, fps: 254016000000 / Number(s.timebase), clips: clips, canUndo: undoStack.length > 0 });
    } catch (e) {
      return enc({ ok: false, error: String(e) });
    }
  }

  // opts: {lut:[...], step:1, scope:'all'|'playhead', targets:[{ci,pi}]}
  function apply(opts) {
    try {
      var s = seq();
      if (!s) return enc({ ok: false, error: 'No active sequence.' });
      var items = selectedItems(s);
      if (!items.length) return enc({ ok: false, error: 'Select a clip with keyframes first.' });
      var frameTicks = Number(s.timebase) * Math.max(1, opts.step || 1);
      var playhead = numTicks(s.getPlayerPosition());
      var store = loadStore(), undo = [], pairsDone = 0, keysAdded = 0, propsDone = 0;
      var i, j, k, n, props, p, prop, ticks, anchors, rk, clipT, a, b, va, vb, snap, did;

      for (i = 0; i < items.length; i++) {
        props = keyedNumericProps(items[i]);
        clipT = playhead - numTicks(items[i].start) + numTicks(items[i].inPoint);
        for (j = 0; j < props.length; j++) {
          p = props[j];
          if (!wanted(opts.targets, p.ci, p.pi)) continue;
          prop = p.prop;
          rk = recKey(s, items[i], p.ci, p.pi);
          ticks = keyTicks(prop);
          anchors = anchorsFor(store, rk, ticks);
          // snapshot every key for undo
          snap = [];
          for (k = 0; k < ticks.length; k++) snap.push({ t: ticks[k], v: prop.getValueAtKey(mkTime(ticks[k])) });
          did = false;
          for (k = 0; k + 1 < anchors.length; k++) {
            a = anchors[k]; b = anchors[k + 1];
            if (opts.scope === 'playhead' && !(clipT >= a && clipT <= b)) continue;
            va = prop.getValueAtKey(mkTime(a)); vb = prop.getValueAtKey(mkTime(b));
            if (!isNumeric(va) || !isNumeric(vb)) continue;
            // remove everything strictly between the anchors
            for (n = 0; n < ticks.length; n++) if (ticks[n] > a && ticks[n] < b) prop.removeKey(mkTime(ticks[n]));
            // bake
            var t = a + frameTicks;
            while (t < b - frameTicks * 0.25) {
              var x = (t - a) / (b - a);
              var tm = mkTime(t);
              prop.addKey(tm);
              prop.setValueAtKey(tm, lerp(va, vb, sampleLut(opts.lut, x)), 0);
              try { prop.setInterpolationTypeAtKey(tm, 0, 0); } catch (e1) { }
              keysAdded++;
              t += frameTicks;
            }
            try { prop.setInterpolationTypeAtKey(mkTime(a), 0, 0); prop.setInterpolationTypeAtKey(mkTime(b), 0, 1); } catch (e2) { }
            pairsDone++;
            did = true;
          }
          if (did) {
            undo.push({ rk: rk, ci: p.ci, pi: p.pi, nodeId: items[i].nodeId, snap: snap, prevRec: store[rk] || null });
            store[rk] = anchors;
            propsDone++;
          }
        }
      }
      if (!pairsDone) return enc({ ok: false, error: opts.scope === 'playhead' ? 'Playhead is not between two keyframes of the chosen properties.' : 'No keyframe pairs found on the chosen properties.' });
      saveStore(store);
      undoStack.push({ seqId: s.sequenceID, entries: undo });
      if (undoStack.length > 20) undoStack.shift();
      return enc({ ok: true, pairs: pairsDone, keys: keysAdded, props: propsDone });
    } catch (e) {
      return enc({ ok: false, error: String(e) + (e.line ? ' (line ' + e.line + ')' : '') });
    }
  }

  function findItem(s, nodeId) {
    var tr, i, j, tracks = [s.videoTracks, s.audioTracks], c;
    for (tr = 0; tr < 2; tr++) {
      for (i = 0; i < tracks[tr].numTracks; i++) {
        c = tracks[tr][i].clips;
        for (j = 0; j < c.numItems; j++) if (c[j].nodeId === nodeId) return c[j];
      }
    }
    return null;
  }
  function restoreSnapshot(prop, snap) {
    var cur = keyTicks(prop), i, keep = {};
    for (i = 0; i < snap.length; i++) keep[snap[i].t] = true;
    for (i = 0; i < cur.length; i++) if (!keep[cur[i]]) prop.removeKey(mkTime(cur[i]));
    for (i = 0; i < snap.length; i++) {
      var tm = mkTime(snap[i].t);
      prop.addKey(tm);
      prop.setValueAtKey(tm, snap[i].v, i === snap.length - 1 ? 1 : 0);
    }
  }

  function undoLast() {
    try {
      var s = seq();
      if (!s || !undoStack.length) return enc({ ok: false, error: 'Nothing to undo.' });
      var last = undoStack.pop(), store = loadStore(), i, e, item, prop, n = 0;
      for (i = 0; i < last.entries.length; i++) {
        e = last.entries[i];
        item = findItem(s, e.nodeId);
        if (!item) continue;
        prop = item.components[e.ci].properties[e.pi];
        restoreSnapshot(prop, e.snap);
        if (e.prevRec) store[e.rk] = e.prevRec; else delete store[e.rk];
        n++;
      }
      saveStore(store);
      return enc({ ok: true, props: n });
    } catch (err) { return enc({ ok: false, error: String(err) }); }
  }

  // Remove baked keys: back to plain anchors (linear) on the chosen properties of the selected clips
  function removeSmoothing(opts) {
    try {
      var s = seq();
      if (!s) return enc({ ok: false, error: 'No active sequence.' });
      var items = selectedItems(s), store = loadStore(), i, j, k, props, p, rk, ticks, rec, set, n = 0, removed = 0;
      if (!items.length) return enc({ ok: false, error: 'Select a clip first.' });
      for (i = 0; i < items.length; i++) {
        props = keyedNumericProps(items[i]);
        for (j = 0; j < props.length; j++) {
          p = props[j];
          if (!wanted(opts && opts.targets, p.ci, p.pi)) continue;
          rk = recKey(s, items[i], p.ci, p.pi);
          rec = store[rk];
          if (!rec) continue;
          set = {};
          for (k = 0; k < rec.length; k++) set[rec[k]] = true;
          ticks = keyTicks(p.prop);
          for (k = 0; k < ticks.length; k++) if (!set[ticks[k]]) { p.prop.removeKey(mkTime(ticks[k])); removed++; }
          delete store[rk];
          n++;
        }
      }
      saveStore(store);
      if (!n) return enc({ ok: false, error: 'No smoothed properties on the selection.' });
      return enc({ ok: true, props: n, removed: removed });
    } catch (err) { return enc({ ok: false, error: String(err) }); }
  }

  return { getState: getState, apply: apply, undoLast: undoLast, removeSmoothing: removeSmoothing, _enc: enc };
})();
