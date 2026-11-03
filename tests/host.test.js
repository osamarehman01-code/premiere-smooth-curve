// Mock Premiere + run host.jsx logic in Node
const fs = require('fs'), path = require('path'), vm = require('vm');
const E = require('../js/easing.js');
const TPF = 254016000000 / 25; // 25 fps
class Time { constructor(){ this.ticks='0'; } }
function mkParam(name, keys){ // keys: {ticks: value}
  const k = new Map(Object.entries(keys).map(([t,v])=>[Number(t),v]));
  const interp = new Map();
  return { displayName:name, _k:k, _i:interp,
    isTimeVarying(){ return k.size>0; },
    getKeys(){ return [...k.keys()].sort((a,b)=>a-b).map(t=>{const x=new Time(); x.ticks=String(t); return x;}); },
    getValueAtKey(t){ const v=k.get(Number(t.ticks)); return Array.isArray(v)? v.slice(): v; },
    addKey(t){ const n=Number(t.ticks); if(!k.has(n)) k.set(n, 0); },
    setValueAtKey(t,v){ k.set(Number(t.ticks), v); },
    removeKey(t){ k.delete(Number(t.ticks)); },
    setInterpolationTypeAtKey(t,m){ interp.set(Number(t.ticks), m); } };
}
const sec = s => s*254016000000;
const pos = mkParam('Position', {[sec(1)]:[0.5,0.5],[sec(2)]:[0.9,0.1],[sec(3)]:[0.2,0.2]});
const scale = mkParam('Scale', {[sec(1)]:100,[sec(2)]:200});
const opac = mkParam('Opacity', {[sec(0)]:100});
const coll = arr => Object.assign(arr.slice(), {numItems: arr.length});
const item = { name:'Clip A', nodeId:'n1', start:{ticks:'0'}, inPoint:{ticks:'0'},
  components: coll([{displayName:'Motion', properties: coll([pos, scale])},{displayName:'Opacity', properties: coll([opac])}]) };
let playhead = sec(1.5);
const seq = { name:'Seq 1', sequenceID:'s1', timebase:String(TPF), getSelection(){return [item];}, getPlayerPosition(){const t=new Time(); t.ticks=String(playhead); return t;},
  videoTracks: Object.assign([{clips: coll([item])}], {numTracks:1}), audioTracks: Object.assign([], {numTracks:0}) };
const store = path.join(__dirname,'tmp_store'); fs.rmSync(store,{recursive:true,force:true}); fs.mkdirSync(store);
class File { constructor(p){this.p=p; this.fsName=p;} get exists(){return fs.existsSync(this.p);} open(m){this.m=m; return true;} read(){return fs.readFileSync(this.p,'utf8');} write(s){fs.writeFileSync(this.p,s);} close(){} }
class Folder { constructor(p){this.fsName=p;} get exists(){return fs.existsSync(this.fsName);} create(){fs.mkdirSync(this.fsName,{recursive:true});} }
Folder.userData = {fsName: store};
const ctx = { app:{project:{activeSequence:seq}}, Time, File, Folder };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../jsx/host.jsx'),'utf8') + ';this.PS=PS;', ctx);
const call = (fn, arg) => JSON.parse(vm.runInContext(`PS.${fn}(${arg===undefined?'':JSON.stringify(arg)})`, ctx));
let ok = true; const check = (c, m) => { console.log((c?'PASS ':'FAIL ')+m); if(!c) ok=false; };

const st = call('getState');
check(st.ok && st.clips[0].props.length===2, 'getState lists 2 keyframed numeric props (opacity with 1 key excluded): '+JSON.stringify(st.clips[0].props.map(p=>p.name)));
check(Math.round(st.fps)===25, 'fps detected 25');

const curve = {type:'bezier', params:{x1:0.42,y1:0,x2:0.58,y2:1}}, f = E.make(curve);
let r = call('apply', {lut:E.lut(curve), step:1, scope:'all', targets:[]});
check(r.ok && r.pairs===3, 'apply all: 3 pairs '+JSON.stringify(r));
check(scale._k.size === 26, 'scale has 26 keys after 1s bake at 25fps (got '+scale._k.size+')');
const mid = scale._k.get(sec(1)+TPF*5); // x=0.2
check(Math.abs(mid - (100+100*f(0.2))) < 0.01, 'scale value at x=0.2 follows curve: '+mid.toFixed(3)+' vs '+(100+100*f(0.2)).toFixed(3));
const pmid = pos._k.get(sec(2)+TPF*10);
check(Math.abs(pmid[0] - (0.9+(0.2-0.9)*f(0.4))) < 1e-4, 'position array interpolated per axis');
check([...scale._i.values()].every(m=>m===0), 'all keys linear');

// re-apply different curve: anchors preserved, no double baking
const c2 = {type:'bounce', params:{bounces:3,bounciness:0.5}}, f2=E.make(c2);
r = call('apply', {lut:E.lut(c2), step:2, scope:'all', targets:[{ci:0,pi:1}]});
check(r.ok && r.pairs===1, 're-apply on Scale only: 1 pair (anchors remembered) '+JSON.stringify(r));
check(scale._k.size === 14, 'step 2 -> 14 keys (got '+scale._k.size+')');
const v2 = scale._k.get(sec(1)+TPF*10);
check(Math.abs(v2 - (100+100*f2(0.4)))<0.05, 'bounce value correct');
check(pos._k.size === 51, 'position untouched by scale-only apply ('+pos._k.size+')');

r = call('undoLast');
check(r.ok && scale._k.size===26 && Math.abs(scale._k.get(sec(1)+TPF*5)-mid)<1e-9, 'undo restores previous bake');

playhead = sec(2.5);
r = call('apply', {lut:E.lut({type:'bezier',params:{x1:0,y1:0,x2:1,y2:1}}), step:1, scope:'playhead', targets:[{ci:0,pi:0}]});
check(r.ok && r.pairs===1, 'playhead scope: only pair under playhead '+JSON.stringify(r));
check(Math.abs(pos._k.get(sec(1)+TPF*5)[0] - (0.5+0.4*f(0.2)))<1e-4, 'other pair keeps its earlier curve');

r = call('removeSmoothing', {targets:[]});
check(r.ok && scale._k.size===2 && pos._k.size===3, 'remove smoothing -> back to original anchors '+JSON.stringify(r));
check(pos._k.get(sec(2))[0]===0.9 && scale._k.get(sec(2))===200, 'anchor values untouched');

// easing sanity
for (const t of E.TYPES) { const g=E.make({type:t, params:E.DEFAULTS[t]}); check(Math.abs(g(0))<1e-9 && Math.abs(g(1)-1)<1e-9, t+' starts 0 ends 1'); }
const back = E.make({type:'bezier',params:{x1:0.34,y1:1.56,x2:0.64,y2:1}}); check(Math.max(...Array.from({length:101},(_,i)=>back(i/100)))>1.05, 'overshoot handles exceed 1');
fs.rmSync(store,{recursive:true,force:true});
console.log(ok?'ALL PASS':'SOME FAILED'); process.exit(ok?0:1);
