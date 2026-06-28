/* ingenue demo-mode shim — installs a fake device behind the same UI.
   Loaded only when window.__INGENUE_DEMO__ is truthy (set by an inline
   <script> in index.html based on hostname / ?demo). Replaces window.fetch
   for /api/* paths and window.WebSocket for the matron port 5555. Everything
   else (catalog JSONs, GitHub API, CDN) goes through unmolested. */
(function(){
  if (!window.__INGENUE_DEMO__) return;

  // ---------- top-level branding ----------
  const DEMO_TITLE = 'ingenue (demo)';
  document.title = DEMO_TITLE;
  // Brute-but-reliable title lock: the page force-corrects the title once
  // during load (line ~916 in index.html). Setter-override is racy at
  // that point in startup, so poll for a short window and snap it back.
  let _lockTries = 0;
  const _lockIv = setInterval(() => {
    if (document.title !== DEMO_TITLE) document.title = DEMO_TITLE;
    if (++_lockTries > 30) clearInterval(_lockIv);   // ~6s, more than the page needs
  }, 200);
  // After load, watch for any further changes (cheap)
  try {
    const obs = () => {
      const tEl = document.querySelector('title');
      if (!tEl) { setTimeout(obs, 50); return; }
      new MutationObserver(() => {
        if (document.title !== DEMO_TITLE) document.title = DEMO_TITLE;
      }).observe(tEl, { childList:true, characterData:true, subtree:true });
    };
    obs();
  } catch(_){}
  try { document.documentElement.classList.add('demo-mode'); } catch(_) {}

  // Native-feeling chrome: the app already has a 5px gradient strip
  // (.app-header). We thicken it slightly, drop the demo text inside it,
  // and add a corner badge as the always-visible reminder. Nothing
  // floats over content; layout shifts only by the strip-height delta.
  function injectBranding(){
    if (document.getElementById('demo-strip')) return;
    const css = document.createElement('style');
    css.textContent = `
      html.demo-mode .app-header{
        height:22px !important; cursor:pointer;
        display:flex; align-items:center; justify-content:center;
        padding:0 10px; gap:8px; overflow:hidden;
      }
      #demo-strip{
        font:700 10px/1 system-ui,-apple-system,sans-serif;
        letter-spacing:.18em; color:#0d0d12; text-transform:uppercase;
        display:flex; align-items:center; gap:8px; white-space:nowrap;
        text-shadow:0 1px 1px rgba(255,255,255,.35);
      }
      #demo-strip .sep{opacity:.45; font-weight:400}
      #demo-strip a{color:#0d0d12; text-decoration:underline; font-weight:800}
      #demo-badge{
        position:fixed; right:10px; bottom:10px; z-index:9999;
        background:#ff66c4; color:#0d0d12;
        font:800 11px/1 system-ui,sans-serif; letter-spacing:.08em;
        padding:6px 9px; border-radius:6px;
        box-shadow:0 2px 8px rgba(0,0,0,.4); pointer-events:none;
      }
      /* on narrow viewports keep the strip readable but unobtrusive */
      @media (max-width:480px){
        html.demo-mode .app-header{height:20px !important}
        #demo-strip{font-size:9px; letter-spacing:.14em; gap:6px}
        #demo-strip .long{display:none}
      }
    `;
    document.head.appendChild(css);

    const header = document.querySelector('.app-header');
    if (!header) { setTimeout(injectBranding, 100); return; }

    const strip = document.createElement('div');
    strip.id = 'demo-strip';
    const mkSep = () => {
      const s = document.createElement('span');
      s.className = 'sep';
      s.textContent = '·';
      return s;
    };
    const mkLong = (text) => {
      const s = document.createElement('span');
      s.className = 'long';
      s.textContent = text;
      return s;
    };
    const link = document.createElement('a');
    link.href = 'https://github.com/seajaysec/ingenue';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'install on your norns ↗';
    strip.append(
      'demo mode',
      mkSep(),
      mkLong('static site — nothing here talks to a real norns'),
      mkLong(' '),
      mkSep(),
      ' ',
      link
    );
    // Tapping the strip opens the repo — feels native, no extra UI to dismiss
    header.style.cursor = 'pointer';
    header.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      window.open('https://github.com/seajaysec/ingenue', '_blank', 'noopener');
    });
    header.appendChild(strip);

    const badge = document.createElement('div');
    badge.id = 'demo-badge';
    badge.textContent = 'DEMO';
    document.body.appendChild(badge);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectBranding);
  } else {
    injectBranding();
  }

  // First-write toast so it's obvious actions don't persist
  let toastShown = false;
  function demoToast(msg){
    if (toastShown) return;
    toastShown = true;
    const t = document.createElement('div');
    t.textContent = msg || 'demo mode — your change is not saved to any device';
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);'+
      'background:#222a;color:#fff;font:600 13px/1.4 system-ui;padding:10px 16px;'+
      'border-radius:8px;z-index:9998;box-shadow:0 4px 16px rgba(0,0,0,.5);'+
      'border:1px solid #ff66c466;backdrop-filter:blur(6px)';
    document.body.appendChild(t);
    setTimeout(()=>{ t.style.transition='opacity .5s'; t.style.opacity='0'; }, 3500);
    setTimeout(()=>{ t.remove(); toastShown=false; }, 4200);
  }

  // ---------- fixtures (lazy-loaded) ----------
  const FIXTURES = {};
  let paramsAwake = null, paramsAtsea = null, awakeSrc = null, halfsecSrc = null;
  async function getJSON(path){
    if (FIXTURES[path] !== undefined) return FIXTURES[path];
    try { FIXTURES[path] = await (await origFetch(path,{cache:'force-cache'})).json(); }
    catch(e){ FIXTURES[path] = null; }
    return FIXTURES[path];
  }
  async function getText(path){
    if (FIXTURES[path] !== undefined) return FIXTURES[path];
    try { FIXTURES[path] = await (await origFetch(path,{cache:'force-cache'})).text(); }
    catch(e){ FIXTURES[path] = null; }
    return FIXTURES[path];
  }

  // installed-script list (real list pulled from a 64-bit panicos device).
  // 'at_sea' is first in the list so the screenshots line up.
  const INSTALLED = [
    "16-harmony","KoiBoi2","acid-test","amenbreak","anima","at_sea","avonlea","awake",
    "barycenter","benjolis","bline","blippoo","breakthrough","demoncore","dronecaster",
    "dronedrone","dunes","euclidigons","graintopia","grd","gridtest","hachi","haze",
    "hs010","icarus","jala","lamellae","lifestrings","lissadron","luck","molly_the_poly",
    "moln","mx.samples","mx.synths","nameless-nightmare","nb_drumcrow","nb_mxsynths",
    "nb_odashodasho","nb_plyprc","nb_polyperc","nb_smpKit","noizeop","o-o-o","oilcan",
    "ong","overwintering","padtest","passersby","pixels","qfwfq","r","raindrops",
    "reich-phase","rudiments","scryingstone","spore","squid","stratum","supertonic",
    "synth-quest","synthy","tapedeck","taweeet","teem","tetrabobo","time-rhythm",
    "tulpamancer","twine"
  ];

  // mods — same shape as the device returns
  const MODS_INITIAL = {
    mods: [
      {name:"hs010", enabled:true},
      {name:"nb_drumcrow", enabled:true},
      {name:"nb_mxsynths", enabled:true},
      {name:"nb_odashodasho", enabled:true},
      {name:"nb_plyprc", enabled:true},
      {name:"nb_polyperc", enabled:true},
      {name:"nb_smpKit", enabled:true},
      {name:"oilcan", enabled:true}
    ],
    enabled: ["hs010","nb_drumcrow","nb_mxsynths","nb_odashodasho","nb_plyprc",
              "nb_polyperc","nb_smpKit","oilcan"],
    state_file: "data/system.mods"
  };
  const modState = JSON.parse(JSON.stringify(MODS_INITIAL));

  const SYSINFO = {
    hostname:"demo-norns", ip:"demo.local", arch:"aarch64",
    system:"static demo (no device)", port:7777,
    dust:"(in-memory)", python:"demo"
  };
  const AUDIO = {
    procs:{jackd:1,crone:1,scsynth:1,sclang:1,matron:1},
    core_up:true, recent_device_race:false, recent_jack_quit:false,
    ok:true, log:"(demo)", hint:"demo: audio server simulated as healthy"
  };
  const SCPLUGINS = {
    host_arch:"aarch64", is_64bit:true, scsynth_wants:"aarch64",
    ugen_so_total:68, ugen_so_correct_arch:68, ugen_so_wrong_arch:0,
    wrong_arch_machines:[], bundled_total:68, missing_count:0,
    missing_sample:[], half_implemented:false,
    bundle:{ present:true, path:"(demo)", version:"v0.1.0",
            elf:"aarch64", so_count:68 },
    status:"ok", can_heal:false, reboot_required:false
  };
  const VERSION = { sha:"demo-build", repo:"seajaysec/ingenue", branch:"main" };

  // a sparse but realistic dust tree. Folders shown match a real device.
  const FS = {
    "audio":         { type:"dir", kids:{ "tape":{type:"dir",kids:{}}, "mx.samples":{type:"dir",kids:{}}, "amenbreak":{type:"dir",kids:{}}, "graintopia":{type:"dir",kids:{}}, "o-o-o":{type:"dir",kids:{}} } },
    "code":          { type:"dir", kids:Object.fromEntries(INSTALLED.map(n => [n, {type:"dir", kids:{}}])) },
    "data":          { type:"dir", kids:Object.fromEntries(INSTALLED.slice(0,12).map(n => [n, {type:"dir", kids:{}}])) }
  };
  // give awake some real contents so opening it in the editor works
  FS.code.kids.awake = { type:"dir", kids:{
    "awake.lua":  { type:"file", size:18073, mod:"2026-06-02" },
    "lib":        { type:"dir", kids:{ "halfsecond.lua":{type:"file",size:1466,mod:"2026-06-02"} } }
  }};
  FS.code.kids.at_sea = { type:"dir", kids:{
    "at_sea.lua": { type:"file", size:42810, mod:"2026-05-12" },
    "lib":        { type:"dir", kids:{} },
    "README.md":  { type:"file", size:1820, mod:"2026-05-12" }
  }};

  function fsNode(rel){
    if (!rel || rel === "" || rel === "/") return { type:"dir", kids: FS };
    const parts = rel.split("/").filter(Boolean);
    let cur = { type:"dir", kids: FS };
    for (const p of parts){
      if (!cur || cur.type !== "dir" || !cur.kids[p]) return null;
      cur = cur.kids[p];
    }
    return cur;
  }
  function fsListing(rel){
    const n = fsNode(rel);
    if (!n || n.type !== "dir") return [];
    return Object.entries(n.kids).map(([name, v]) => {
      if (v.type === "dir") return { name, type:"dir", size:1024, mod:"2026-05-01" };
      return { name, type:"file", size:v.size || 0, mod:v.mod || "2026-05-01" };
    });
  }
  async function fsRead(rel){
    if (rel === "code/awake/awake.lua")           return (awakeSrc   ??= await getText("demo/data/awake.lua")) || "-- demo\n";
    if (rel === "code/awake/lib/halfsecond.lua")  return (halfsecSrc ??= await getText("demo/data/halfsecond.lua")) || "-- demo lib\n";
    // generic placeholder for everything else
    return `-- demo: ${rel}\n-- this file isn't bundled in the static demo.\n-- install ingenue on a norns to see real script source.\n`;
  }

  // ---------- fake matron WebSocket ----------
  // The real device speaks nng-over-WebSocket with subprotocol
  // 'bus.sp.nanomsg.org'. The browser handles the subprotocol; the app sends
  // raw UTF-8 Lua. Our mock just keeps it in JS-land.
  class MockMatronWS {
    constructor(url, protocols){
      this.url = url;
      this.protocol = (Array.isArray(protocols) ? protocols[0] : protocols) || '';
      this.readyState = 0;
      this.binaryType = 'arraybuffer';
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      this._queue = [];
      this._currentScript = 'awake';   // initial demo script
      setTimeout(() => {
        this.readyState = 1;
        try { this.onopen && this.onopen({ target: this }); } catch(_){}
        this._send('# connecting to matron...\n');
        this._send('# (demo) simulated link, no real device\n<ok>\n');
      }, 60);
    }
    _send(text){
      if (this.readyState !== 1) return;
      const data = new TextEncoder().encode(text);
      try { this.onmessage && this.onmessage({ target:this, data:data.buffer }); } catch(_){}
    }
    close(){ this.readyState = 3; try{ this.onclose && this.onclose({}); }catch(_){} }
    addEventListener(ev, cb){ this['on'+ev] = cb; }
    removeEventListener(ev){ this['on'+ev] = null; }

    // The app sends Lua snippets. We recognize the marker patterns and answer
    // with the same marker shapes a real matron would print.
    async send(payload){
      let lua = '';
      if (typeof payload === 'string') lua = payload;
      else if (payload instanceof ArrayBuffer) lua = new TextDecoder().decode(payload);
      else if (payload && payload.buffer) lua = new TextDecoder().decode(payload.buffer);
      else lua = String(payload);

      // PARAMS dump request -> emit @@ING_SCRIPT@@, @@ING_P_BEGIN@@, rows, @@ING_P_END@@
      if (/@@ING_SCRIPT@@.*@@ING_P_BEGIN@@/s.test(lua) || /print\('@@ING_SCRIPT@@/.test(lua)) {
        await this._emitDump();
        return;
      }
      // Single-param formatted-value refresh
      let m = lua.match(/print\('@@ING_PV@@'\.\.\(([-\d]+)\)/);
      if (m){
        const i = +m[1];
        const p = await this._getCurrentParams();
        const row = p.params.find(x => x.i === i);
        const s = row ? (row.s || row.val || '') : '';
        this._send(`@@ING_PV@@${i}\t${s}\n`);
        return;
      }
      // Per-value labels (range scan) — we don't have these baked, fall back
      m = lua.match(/print\('@@ING_PM@@'\.\.\(([-\d]+)\)/);
      if (m){ /* not supported in demo; just no-op */ return; }
      // params:set(...) — best-effort: update value in our cached dump, no echo
      m = lua.match(/params:set\(['"]?([^,'"]+)['"]?,\s*([-\d.]+)\)/);
      if (m){ /* the UI handles its own optimistic display */ return; }
      // params:write / params:read / params:bang / generic
      if (/params:write\(/.test(lua)) { this._send('# (demo) PSET saved locally only\n'); return; }
      if (/params:read\(/.test(lua))  { this._send('# (demo) no PSET on disk in demo mode\n'); return; }
      if (/params:bang\(/.test(lua))  { return; }
      if (/^\s*$/.test(lua)) return;

      // Anything else = REPL echo. Recognize a few friendly commands; everything
      // else replies with the "no real device" canned line.
      const cmd = lua.trim().replace(/\n+$/,'');
      this._send(`>> ${cmd}\n`);
      if (/^print\s*\(/.test(cmd))            this._send('(demo) print: output suppressed in demo\n<ok>\n');
      else if (/^params\b/.test(cmd))         this._send('# (demo) params bridged via the panel above\n<ok>\n');
      else if (/^screen\./.test(cmd))         this._send('# (demo) no screen surface in browser demo\n<ok>\n');
      else if (/^clock\./.test(cmd))          this._send('# (demo) clock is paused in the demo\n<ok>\n');
      else if (/^norns\.script\.load/.test(cmd)) {
        const sm = cmd.match(/code\/([^/]+)\//);
        if (sm){ this._currentScript = sm[1]; this._send(`# (demo) loaded ${sm[1]}\n<ok>\n`); }
        else this._send('<ok>\n');
      }
      else                                    this._send('# (demo) the live REPL needs a real norns. try `params`, `clock`, `screen`.\n<ok>\n');
    }

    async _getCurrentParams(){
      if (this._currentScript === 'at_sea'){
        paramsAtsea ??= await getJSON('demo/data/params_atsea.json');
        return paramsAtsea || { script:'at_sea', params:[] };
      }
      paramsAwake ??= await getJSON('demo/data/params_awake.json');
      return paramsAwake || { script:'awake', params:[] };
    }

    async _emitDump(){
      const data = await this._getCurrentParams();
      let out = '@@ING_SCRIPT@@' + (data.script || this._currentScript) + '\n@@ING_P_BEGIN@@\n';
      for (const p of (data.params||[])){
        const opts = (p.opts || []).join('\x1f');
        out += `@@ING_P@@${p.i}\t${p.t}\t${p.nm}\t${p.mn}\t${p.mx}\t${p.val}\t${p.s}\t${opts}\t${p.df}\t${p.nn}\t${p.id}\n`;
      }
      out += '@@ING_P_END@@\n';
      // chunk to mimic streaming
      const CHUNK = 8000;
      for (let i=0; i<out.length; i+=CHUNK){
        this._send(out.slice(i, i+CHUNK));
        await new Promise(r => setTimeout(r, 4));
      }
    }
  }
  MockMatronWS.CONNECTING = 0;
  MockMatronWS.OPEN = 1;
  MockMatronWS.CLOSING = 2;
  MockMatronWS.CLOSED = 3;

  const NativeWS = window.WebSocket;
  window.WebSocket = function(url, protocols){
    try {
      if (/:5555(\/|$)/.test(url)) return new MockMatronWS(url, protocols);
    } catch(_){}
    return new NativeWS(url, protocols);
  };
  window.WebSocket.prototype = NativeWS.prototype;
  Object.assign(window.WebSocket, { CONNECTING:0, OPEN:1, CLOSING:2, CLOSED:3 });

  // ---------- fetch interceptor ----------
  const origFetch = window.fetch.bind(window);
  function jsonResp(obj, status){
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { 'Content-Type':'application/json' }
    });
  }
  function textResp(txt, status){
    return new Response(txt || '', {
      status: status || 200,
      headers: { 'Content-Type':'text/plain; charset=utf-8' }
    });
  }
  function parseQuery(u){
    const i = u.indexOf('?');
    if (i < 0) return {};
    const out = {};
    new URLSearchParams(u.slice(i+1)).forEach((v,k) => { out[k] = v; });
    return out;
  }
  async function bodyJSON(init){
    if (!init || !init.body) return {};
    if (typeof init.body === 'string'){ try { return JSON.parse(init.body); } catch(_){ return {}; } }
    if (init.body instanceof ArrayBuffer) return {};
    return {};
  }

  // Track demo state for install/remove/mod-toggle so the UI feels alive
  const installedSet = new Set(INSTALLED);

  window.fetch = async function(input, init){
    let url = (typeof input === 'string') ? input : (input && input.url) || String(input);
    // normalize: leading ./ or / both possible
    const cleanUrl = url.replace(/^\/+/, '').replace(/^\.\/+/, '');
    if (!cleanUrl.startsWith('api/')){
      return origFetch(input, init);
    }
    const method = (init && init.method) || 'GET';
    const path = cleanUrl.split('?')[0];
    const q = parseQuery(cleanUrl);

    // GET endpoints
    if (method === 'GET'){
      if (path === 'api/installed')      return jsonResp(Array.from(installedSet).sort());
      if (path === 'api/mods')           return jsonResp({ ...modState, enabled: modState.mods.filter(m=>m.enabled).map(m=>m.name) });
      if (path === 'api/sysinfo')        return jsonResp(SYSINFO);
      if (path === 'api/audio')          return jsonResp(AUDIO);
      if (path === 'api/scplugins')      return jsonResp(q.online ? { ...SCPLUGINS, online:{ ok:true, version:'v0.1.0', note:'demo' }} : SCPLUGINS);
      if (path === 'api/version')        return jsonResp(VERSION);
      if (path === 'api/community')      return jsonResp({ ok:true, html:'<p><em>demo: community.norns.community fetch is disabled in the static demo. install ingenue on a norns to load discussion threads inline.</em></p>' });
      if (path === 'api/readme')         return jsonResp({ ok:true, html:'<p><em>demo readme unavailable here</em></p>' });
      if (path === 'api/ls'){
        const rel = q.path || '';
        return jsonResp(fsListing(rel));
      }
      if (path === 'api/read'){
        const rel = q.path || '';
        return textResp(await fsRead(rel));
      }
      if (path === 'api/deps')           return jsonResp({ ok:true, deps:[], note:'demo: no dep tree' });
    }

    // PUT (save file)
    if (method === 'PUT' && path === 'api/write'){
      demoToast('demo: edits aren’t saved to a device');
      return jsonResp({ ok:true, bytes: 0 });
    }

    // POST endpoints
    if (method === 'POST'){
      const body = await bodyJSON(init);
      if (path === 'api/install'){
        const nm = body.name || 'script';
        installedSet.add(nm);
        demoToast(`demo: “${nm}” isn’t really installed`);
        await new Promise(r=>setTimeout(r,300));
        return jsonResp({ ok:true, installed:nm, log:`(demo) git clone simulated for ${body.url||'<no url>'}\n` });
      }
      if (path === 'api/remove'){
        const nm = body.name || '';
        installedSet.delete(nm);
        demoToast('demo: nothing was actually removed');
        return jsonResp({ ok:true, removed:nm });
      }
      if (path === 'api/heal'){
        await new Promise(r=>setTimeout(r,400));
        return jsonResp({ ok:true, name:body.name||'', log:'(demo) install.sh simulated\n' });
      }
      if (path === 'api/mods/toggle'){
        const m = modState.mods.find(x => x.name === body.name);
        if (m){ m.enabled = !!body.on; }
        else  { modState.mods.push({ name:body.name, enabled:!!body.on }); }
        demoToast('demo: mod state isn’t persisted');
        return jsonResp({ ok:true, name:body.name, on:!!body.on });
      }
      if (path === 'api/audio/restart'){
        return jsonResp({ ok:true, note:'(demo) audio restart simulated' });
      }
      if (path === 'api/self-update'){
        demoToast('demo: there’s no device to update');
        return jsonResp({ ok:false, error:'(demo) cannot self-update a static site' });
      }
      if (path === 'api/scplugins/heal'){
        return jsonResp({ ok:true, note:'(demo) 64-bit UGen install simulated' });
      }
      if (path === 'api/mkdir' || path === 'api/rename' || path === 'api/rm'){
        demoToast('demo: file-tree changes aren’t saved');
        return jsonResp({ ok:true });
      }
    }

    // anything else: surface as 404 so the UI's catch paths kick in
    return jsonResp({ error:'(demo) endpoint not mocked: '+path }, 404);
  };

  console.info('[ingenue demo] mock layer installed');
})();
