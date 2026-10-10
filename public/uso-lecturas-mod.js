/* uso-lecturas-mod.js — cuenta las lecturas de Firestore (SDK modular 10.12.0) y las suma por día.
 *
 * En la app, en vez de importar getDoc, getDocs y onSnapshot de firebase-firestore.js, se importan de aquí:
 *   import { getDoc, getDocs, onSnapshot, usoApp } from "./uso-lecturas-mod.js";
 *   usoApp("MES");
 * Cuenta igual que la factura de Firestore (1 por documento leído; lo que sale de la caché no cuenta; onSnapshot
 * cuenta la carga inicial completa y después solo los documentos que cambian) y guarda en uso_lecturas/<día>
 * (día = hora del Pacífico) una vez cada 5 minutos como máximo, y solo si hubo lecturas nuevas.
 */
import * as FS from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const COLECCION = "uso_lecturas", CADA_MS = 5 * 60 * 1000;
let APP = (location.pathname.split("/").pop() || "app").replace(/\.html$/, "") || "app";
let buf = { total: 0, colls: {} }, fsRef = null;

export function usoApp(nombre) { if (nombre) APP = nombre; }

const limpia = (s) => String(s).replace(/[.\/\[\]*`~]/g, "_").slice(0, 80) || "_";
function dia() {
  try { return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}
function suma(coll, n) {
  if (!(n > 0)) return;
  coll = limpia(coll || "_");
  if (coll === COLECCION) return;
  buf.total += n; buf.colls[coll] = (buf.colls[coll] || 0) + n;
}
const padre = (d) => (d && d.ref && d.ref.parent ? d.ref.parent.id : "_");
function cuentaDocs(snap) {
  const docs = snap && snap.docs;
  if (!docs) return;
  if (!docs.length) { suma("(vacía)", 1); return; }
  const por = {};
  for (const d of docs) { const k = padre(d); por[k] = (por[k] || 0) + 1; }
  for (const k in por) suma(k, por[k]);
}
function cuentaCambios(snap) {
  const ch = snap.docChanges ? snap.docChanges() : [];
  for (const c of ch) suma(padre(c.doc), 1);
}
const desdeCache = (snap) => !!(snap && snap.metadata && snap.metadata.fromCache);

export function getDocs(q) {
  fsRef = fsRef || q.firestore;
  return FS.getDocs(q).then((snap) => { try { if (!desdeCache(snap)) cuentaDocs(snap); } catch (e) {} return snap; });
}
export function getDoc(ref) {
  fsRef = fsRef || ref.firestore;
  return FS.getDoc(ref).then((snap) => { try { if (!desdeCache(snap)) suma(ref.parent && ref.parent.id, 1); } catch (e) {} return snap; });
}
export function onSnapshot(ref, ...args) {
  fsRef = fsRef || ref.firestore;
  const esDoc = ref.type === "document";
  let primera = true;
  const wrap = (fn) => function (snap) {
    try {
      if (!desdeCache(snap)) {
        if (esDoc) suma(ref.parent && ref.parent.id, 1);
        else if (primera) cuentaDocs(snap);
        else cuentaCambios(snap);
      }
      primera = false;
    } catch (e) {}
    return fn.apply(this, arguments);
  };
  let i = 0;
  if (args[0] && typeof args[0] === "object" && typeof args[0].next !== "function") i = 1; // opciones
  if (typeof args[i] === "function") args[i] = wrap(args[i]);
  else if (args[i] && typeof args[i].next === "function") { const o = args[i]; args[i] = { next: wrap(o.next), error: o.error, complete: o.complete }; }
  return FS.onSnapshot(ref, ...args);
}

function vuelca() {
  if (!buf.total || !fsRef) return;
  const total = buf.total, colls = buf.colls;
  buf = { total: 0, colls: {} };
  try {
    const app = limpia(APP);
    const data = { total: FS.increment(total), apps: { [app]: FS.increment(total) }, colls: {}, ac: {}, actualizado: Date.now() };
    for (const c in colls) { data.colls[c] = FS.increment(colls[c]); data.ac[app + " › " + c] = FS.increment(colls[c]); }
    FS.setDoc(FS.doc(fsRef, COLECCION, dia()), data, { merge: true }).catch(() => {
      buf.total += total; for (const k in colls) buf.colls[k] = (buf.colls[k] || 0) + colls[k];
    });
  } catch (e) {}
}
setInterval(vuelca, CADA_MS);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") vuelca(); });
window.addEventListener("pagehide", vuelca);
