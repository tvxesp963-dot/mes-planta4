/**
 * Cloud Function - Alertas de Stock Minimo por WhatsApp (IMS Planta 4)
 * -----------------------------------------------------------------------
 * Lee EXACTAMENTE los mismos datos que ve el "Minimum Stock Monitor" en
 * pantalla (ims_config/planta4 + planta4_inventario). No modifica ni toca
 * tu index.html — es un archivo aparte.
 *
 * Reglas replicadas de tu pantalla:
 *  - Config manual: usa la lista stockMinPns (PNs fijos).
 *  - Critico  = actual < 67% del limite
 *  - Alerta   = actual >= 67% y < 100% del limite
 *  - Ambos (Critico + Alerta) disparan el aviso, por prevencion.
 *
 * TODO LO QUE DEBES AJUSTAR esta marcado con "AJUSTAR".
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch"); // npm install node-fetch@2

admin.initializeApp();
const db = admin.firestore();

// ============ CONFIGURACION — AJUSTAR AQUI ============

// WhatsApp via CallMeBot (gratis). Cada persona agrega +34 644 59 71 67 en
// su WhatsApp y le manda: "I allow callmebot to send me messages".
// El bot responde con un apikey personal — cópialo aquí.
const WHATSAPP_RECIPIENTS = [
  { phone: "5216634377870", apiKey: "9610552" },
  // { phone: "521YYYYYYYYYY", apiKey: "APIKEY_PERSONA_2" },
];

// ============ LOGICA PRINCIPAL ============

async function checkLowStockAndNotify() {
  // 1) Leer configuracion guardada por el propio IMS
  const cfgDoc = await db.collection("ims_config").doc("planta4").get();
  if (!cfgDoc.exists) {
    console.log("No existe ims_config/planta4 — nada que revisar.");
    return;
  }
  const cfg = cfgDoc.data();
  const limite = Number(cfg.stockMinLimite) || 0;
  const modo = cfg.stockMinModo || "manual";
  const pnsManual = Array.isArray(cfg.stockMinPns) ? cfg.stockMinPns : [];

  if (!limite) {
    console.log("stockMinLimite no configurado — nada que revisar.");
    return;
  }
  const umbralAlerta = limite * 0.67;

  // 2) Leer inventario actual
  const invSnap = await db.collection("planta4_inventario").get();
  const items = [];
  invSnap.forEach((doc) => items.push(doc.data()));

  // 3) Armar la lista a evaluar (misma logica que renderMonitorStock)
  let lista;
  if (modo === "auto") {
    lista = [...items]
      .sort((a, b) => (Number(a.actual) || 0) - (Number(b.actual) || 0))
      .slice(0, 10)
      .map((i) => ({ pn: i.pn, desc: i.desc, stock: Number(i.actual) || 0 }));
  } else {
    lista = pnsManual.map((p) => {
      const o = typeof p === "string" ? { pn: p, desc: "" } : p;
      const item = o.desc
        ? items.find(
            (i) =>
              (i.pn || "").toUpperCase() === o.pn.toUpperCase() &&
              (i.desc || "").toUpperCase() === o.desc.toUpperCase()
          )
        : items.find((i) => (i.pn || "").toUpperCase() === o.pn.toUpperCase());
      return {
        pn: o.pn,
        desc: item ? item.desc : o.desc || "-",
        stock: item ? Number(item.actual) || 0 : 0,
      };
    });
  }

  // 4) Filtrar Critico + Alerta (todo lo que este bajo el limite)
  const bajoMinimo = lista
    .filter((i) => i.stock < limite)
    .sort((a, b) => a.stock - b.stock)
    .map((i) => ({
      ...i,
      estado: i.stock < umbralAlerta ? "CRITICO" : "ALERTA",
      pct: Math.round((i.stock / limite) * 100),
    }));

  if (bajoMinimo.length === 0) {
    console.log("Todo OK, nada bajo el minimo.");
    return;
  }

  // 5) Construir mensaje
  const lineas = bajoMinimo
    .slice(0, 30)
    .map(
      (i) =>
        `${i.estado === "CRITICO" ? "\u{1F534}" : "\u{1F7E1}"} ${i.pn} - ${i.desc}: ` +
        `${i.stock.toLocaleString()} pzas (${i.pct}%) - ${i.estado}`
    )
    .join("\n");

  const message =
    `ALERTA STOCK MINIMO - Planta 4\n` +
    `${bajoMinimo.length} de ${lista.length} articulos bajo minimo (${limite.toLocaleString()} pzas)\n\n` +
    lineas +
    (bajoMinimo.length > 30 ? `\n...y ${bajoMinimo.length - 30} mas` : "");

  await sendWhatsAppAlerts(message);
}

// ---- WhatsApp via CallMeBot ----
async function sendWhatsAppAlerts(message) {
  for (const r of WHATSAPP_RECIPIENTS) {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${r.phone}&text=${encodeURIComponent(
      message
    )}&apikey=${r.apiKey}`;
    try {
      const res = await fetch(url);
      console.log("WhatsApp enviado a", r.phone, res.status);
    } catch (e) {
      console.error("Error WhatsApp", r.phone, e.message);
    }
  }
}

// ============ TRIGGERS ============

// 1) Programado: revisa cada 6 horas (ajusta el cron si quieres otra frecuencia)
exports.checkStockScheduled = functions.pubsub
  .schedule("every 6 hours")
  .onRun(async () => {
    await checkLowStockAndNotify();
    return null;
  });

// 2) Manual: para probar desde el navegador (abre la URL de esta funcion)
exports.checkStockManual = functions.https.onRequest(async (req, res) => {
  await checkLowStockAndNotify();
  res.send("Revision de stock ejecutada. Revisa los logs de Firebase Functions.");
});
