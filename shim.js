// Capa de guardado para la versión web (fuera de claude.ai): implementa el subconjunto de
// window.claude.use("db" | "user" | "assets") que usa la app, sobre la API REST de Supabase.
// Configuración en config.js: window.OPO_CONFIG = {supabaseUrl, anonKey, adminHash}.
(() => {
  "use strict";
  const CFG = window.OPO_CONFIG || {};
  const ok = CFG.supabaseUrl && CFG.anonKey && !/PON_AQUI/.test(CFG.supabaseUrl + CFG.anonKey);
  const H = {apikey: CFG.anonKey, Authorization: "Bearer " + CFG.anonKey, "Content-Type": "application/json"};
  const REST = (CFG.supabaseUrl || "").replace(/\/$/, "") + "/rest/v1/docs";
  window.BLOB_BASE = (CFG.supabaseUrl || "").replace(/\/$/, "") + "/storage/v1/object/public/stickers/";

  // admin: abrir una vez la web con ?admin=<adminKey> deja este navegador como "dueño"
  // (config.js solo guarda la huella SHA-256 de la clave, nunca la clave)
  const adminReady = (async () => {
    try {
      const k = new URLSearchParams(location.search).get("admin");
      if (!k || !CFG.adminHash) return;
      const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(k)))].map(b => b.toString(16).padStart(2, "0")).join("");
      if (h === CFG.adminHash) localStorage.setItem("opo_admin", "1");
      history.replaceState(null, "", location.pathname + location.hash);
    } catch {}
  })();
  const isAdmin = () => { try { return localStorage.getItem("opo_admin") === "1"; } catch { return false; } };

  const err = (code, message) => Object.assign(new Error(message || code), {code});
  async function req(url, opts = {}) {
    let r;
    try { r = await fetch(url, {...opts, headers: {...H, ...(opts.headers || {})}}); }
    catch { throw err("unavailable", "sin conexión"); }
    if (!r.ok) throw err(r.status === 400 ? "invalid_argument" : "unavailable", await r.text());
    return r.status === 204 ? null : r.json().catch(() => null);
  }
  const split = path => { const i = path.lastIndexOf("/"); return {col: path.slice(0, i), id: path.slice(i + 1)}; };
  const snap = row => ({id: split(row.path).id, exists: true, data: () => row.data, metadata: {fromCache: false, hasPendingWrites: false}});

  // suscripciones por colección: sondeo cada 15 s con la página visible y refresco inmediato tras cada escritura
  const subs = {};
  async function refresh(col) {
    const s = subs[col]; if (!s) return;
    try {
      const rows = await req(`${REST}?col=eq.${encodeURIComponent(col)}&select=path,data,updated_at`);
      const key = JSON.stringify(rows);
      if (key === s.last) return; s.last = key;
      s.fns.forEach(f => { try { f(rows); } catch {} });
    } catch (e) { s.errs.forEach(f => { try { f(e); } catch {} }); }
  }
  function subscribe(col, fn, onErr) {
    const s = subs[col] ||= {fns: new Set(), errs: new Set(), last: null};
    s.fns.add(fn); if (onErr) s.errs.add(onErr);
    s.last = null; refresh(col);
    return () => { s.fns.delete(fn); if (onErr) s.errs.delete(onErr); };
  }
  setInterval(() => { if (document.visibilityState === "visible") Object.keys(subs).forEach(refresh); }, 15000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") Object.keys(subs).forEach(refresh); });

  function docRef(path) {
    const {col, id} = split(path);
    return {
      id, path,
      async get() { const rows = await req(`${REST}?path=eq.${encodeURIComponent(path)}&select=path,data`); return rows && rows[0] ? snap(rows[0]) : {id, exists: false, data: () => undefined}; },
      async set(data) {
        await req(REST, {method: "POST", headers: {Prefer: "resolution=merge-duplicates,return=minimal"}, body: JSON.stringify({path, col, data, updated_at: new Date().toISOString()})});
        refresh(col);
      },
      async update(data) { const cur = await this.get(); if (!cur.exists) throw err("invalid_argument", "no existe"); await this.set({...cur.data(), ...data}); },
      async delete() { await req(`${REST}?path=eq.${encodeURIComponent(path)}`, {method: "DELETE"}); refresh(col); },
      onSnapshot(next, onErr) {
        return subscribe(col, rows => { const r = rows.find(x => x.path === path); next(r ? snap(r) : {id, exists: false, data: () => undefined, metadata: {}}); }, onErr);
      },
    };
  }
  function colRef(col) {
    return {
      path: col,
      doc: id => docRef(col + "/" + (id || crypto.randomUUID().replace(/-/g, "").slice(0, 20))),
      async add(data) { const d = this.doc(); await d.set(data); return d; },
      onSnapshot(next, onErr) {
        return subscribe(col, rows => { const docs = rows.map(snap); next({docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {}}); }, onErr);
      },
    };
  }
  const db = {doc: docRef, collection: colRef};
  const user = {isOwner: async () => { await adminReady; return isAdmin(); }, canEdit: async () => isAdmin(), can: async () => true, id: async () => null};
  const assets = {
    async upload(file) {
      const ext = (file.name.match(/\.[a-z0-9]+$/i) || [".png"])[0].toLowerCase();
      const name = crypto.randomUUID() + ext;
      const r = await fetch((CFG.supabaseUrl || "").replace(/\/$/, "") + "/storage/v1/object/stickers/" + name,
        {method: "POST", headers: {apikey: CFG.anonKey, Authorization: "Bearer " + CFG.anonKey, "Content-Type": file.type || "application/octet-stream"}, body: file});
      if (!r.ok) throw err("unavailable", await r.text());
      return {id: name, url: window.BLOB_BASE + name, sizeBytes: file.size, contentType: file.type};
    },
  };
  window.claude = {use: async name => (!ok ? null : name === "db" ? db : name === "user" ? user : name === "assets" ? (await adminReady, isAdmin() ? assets : null) : null)};
})();
