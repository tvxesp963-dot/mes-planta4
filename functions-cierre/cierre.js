'use strict';
/**
 * CIERRE DE JORNADA AUTOMÁTICO — SCRAP + DEFECTOS de ASSY1 → IMS Planta 4
 *
 * Regla: el único descuento de producción buena es el envío a ShipQR (lo hace el MES).
 * Este cierre solo descuenta lo que NUNCA llega a ShipQR: scrap y defectos de ASSY1.
 *
 * Seguridad contra descuentos dobles:
 *  - Cada registro de ASSY1 guarda cuánto ya se descontó (imsConsumoDescontado).
 *    Si la función corre otra vez (o un registro se edita), solo se descuenta la DIFERENCIA.
 *  - Cada lote se escribe en UNA transacción: stock del IMS + movimientos + marcas de los registros.
 *    O se guarda todo, o no se guarda nada.
 *  - Los días que ya se cerraron a mano (cierres_jornada/<fecha> sin "auto") NUNCA se tocan.
 */

const ZONA = 'America/Tijuana';
const USUARIO = 'Sistema (cierre automático)';
const DESC_DESCUENTO = ['STRIP', 'GIFT BOX (TOP)', 'LOWER BOX (BOTTOM)', 'BUNDLE',
  'CHIP BOARD TOP (RANURADO)', 'CHIP BOARD BOTTOM (RANURADO)', 'PULP TRAY', 'SET PAD',
  'BACK STICKER', 'SHEET TOP BOX', 'SHEET LOWER BOX (BOTTOM)'];
const REGS_POR_LOTE = 20;
const MAX_ESCRITURAS = 450;   // Firestore permite 500 por transacción

const U = s => String(s == null ? '' : s).trim().toUpperCase();
const num = v => Number(v) || 0;

function hoyTijuana(ahora) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(ahora || new Date());
}
function diaAnterior(fecha) {
  const d = new Date(fecha + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function esAssy1(r) {
  return r.maquina === 'ASSY1' || r.tipo === 'ASSY' || r.maqNombre === 'ASSY1' || r.maqTipo === 'ASSY';
}
function consumoDe(r) {
  return num(r.defectos ?? r.def) + num(r.scrap);
}

/* Busca el artículo del IMS por PN + descripción EXACTA (sin importar mayúsculas).
   Mismo PN con otra descripción es OTRO material, así que solo se acepta el PN solo
   cuando no hay ambigüedad: un único renglón en el IMS Y una única fila de ese PN en el BOM del modelo. */
function esAlmacen(x) {
  const u = U(x && x.ubicacion);
  return u === '' || u === 'ALMACEN' || u === 'ALMACÉN';
}
function indexarIMS(docs) {
  // El descuento siempre sale del registro de ALMACÉN. Si un PN+descripción tiene también
  // registros en otra ubicación (ej. Línea S1), esos se ignoran. Solo si NO existe registro
  // en Almacén se usa el otro (para no dejar de descontar).
  const exacto = new Map(), porPn = new Map();
  for (const d of docs) {
    const x = d.data;
    if (!x || !x.pn) continue;
    const pn = U(x.pn), desc = U(x.desc || x.descripcion || x.nombre);
    const k = pn + '|||' + desc, alm = esAlmacen(x);
    const prev = exacto.get(k);
    if (!prev || alm || !prev.alm) exacto.set(k, { id: d.id, alm });
    if (!porPn.has(pn)) porPn.set(pn, []);
    porPn.get(pn).push({ id: d.id, alm });
  }
  return function buscar(pn, desc, permitirSoloPn) {
    const e = exacto.get(U(pn) + '|||' + U(desc));
    if (e) return e.id;
    if (!permitirSoloPn) return null;
    let c = porPn.get(U(pn)) || [];
    const enAlm = c.filter(z => z.alm);
    if (enAlm.length) c = enAlm;
    return c.length === 1 ? c[0].id : null;
  };
}

/* regs: [{id, ref, data, consumo, delta}]  →  qué descontar y a qué artículos */
function planear(regs, BOM, buscar) {
  const descuentos = new Map();   // idIMS → {id, pn, desc, familia, total, porModelo:Map}
  const sinIMS = new Map();       // "PN · desc" → cantidad
  const sinBOM = new Set();       // modelos sin componentes en el BOM activo
  const marcar = [];              // registros que quedan "descontados"
  const cache = new Map();
  for (const r of regs) {
    const modelo = String(r.data.modelo || '').trim();
    if (!modelo || !r.delta) continue;
    let comps = cache.get(modelo);
    if (!comps) {
      comps = BOM.filter(b => b && b.pn && b.sm && String(b.sm).trim() === modelo && DESC_DESCUENTO.includes(U(b.desc)));
      cache.set(modelo, comps);
    }
    if (!comps.length) { sinBOM.add(modelo); continue; }
    const filasPorPn = {};
    comps.forEach(c => { const k = U(c.pn); filasPorPn[k] = (filasPorPn[k] || 0) + 1; });
    for (const c of comps) {
      const id = buscar(c.pn, c.desc, filasPorPn[U(c.pn)] === 1);
      if (!id) {
        const k = c.pn + ' · ' + (c.desc || '');
        sinIMS.set(k, (sinIMS.get(k) || 0) + r.delta);
        continue;
      }
      let d = descuentos.get(id);
      if (!d) { d = { id, pn: c.pn, desc: c.desc || '', familia: c.familia || '', total: 0, porModelo: new Map() }; descuentos.set(id, d); }
      d.total += r.delta;
      d.porModelo.set(modelo, (d.porModelo.get(modelo) || 0) + r.delta);
    }
    marcar.push(r);
  }
  return { descuentos, sinIMS, sinBOM, marcar };
}

/* Un lote = una transacción. Devuelve lo que pasó. */
async function aplicarLote(db, FV, lote, ctx) {
  const plan = planear(lote, ctx.BOM, ctx.buscar);
  if (plan.descuentos.size * 2 + plan.marcar.length > MAX_ESCRITURAS && lote.length > 1) {
    const mitad = Math.ceil(lote.length / 2);
    const a = await aplicarLote(db, FV, lote.slice(0, mitad), ctx);
    const b = await aplicarLote(db, FV, lote.slice(mitad), ctx);
    return {
      actualizados: a.actualizados + b.actualizados, movimientos: a.movimientos + b.movimientos,
      faltantes: a.faltantes.concat(b.faltantes), conflictos: a.conflictos + b.conflictos,
      marcados: a.marcados + b.marcados, aplicado: a.aplicado + b.aplicado,
      sinIMS: [...a.sinIMS, ...b.sinIMS], sinBOM: [...a.sinBOM, ...b.sinBOM]
    };
  }
  const res = {
    actualizados: 0, movimientos: 0, faltantes: [], conflictos: 0, marcados: 0, aplicado: 0,
    sinIMS: [...plan.sinIMS.entries()], sinBOM: [...plan.sinBOM]
  };
  if (!plan.marcar.length) return res;

  const iso = new Date().toISOString();
  const ids = [...plan.descuentos.keys()];
  await db.runTransaction(async tx => {
    // (la transacción puede reintentarse: se reinician los contadores)
    res.actualizados = 0; res.movimientos = 0; res.faltantes = []; res.conflictos = 0; res.marcados = 0; res.aplicado = 0;
    const refsIMS = ids.map(id => db.collection('planta4_inventario').doc(id));
    const refsReg = plan.marcar.map(r => r.ref);
    const snaps = await tx.getAll(...refsIMS, ...refsReg);
    const snapsIMS = snaps.slice(0, refsIMS.length), snapsReg = snaps.slice(refsIMS.length);

    // ¿Alguien más ya procesó/modificó estos registros? Entonces NO se toca nada (evita doble descuento)
    for (let i = 0; i < plan.marcar.length; i++) {
      const s = snapsReg[i];
      if (!s.exists || num(s.data().imsConsumoDescontado) !== plan.marcar[i].yaDescontado) { res.conflictos++; }
    }
    if (res.conflictos) return;

    snapsIMS.forEach((snap, i) => {
      const d = plan.descuentos.get(ids[i]);
      if (!snap.exists || !d.total) return;
      const x = snap.data();
      const inv = num(x.actual), sal = num(x.salidas);
      const crudo = inv - d.total;
      const faltante = crudo < 0 ? -crudo : 0;
      const loc = x.ubicacion || 'Almacén';
      const esSalida = d.total > 0;
      tx.update(snap.ref, {
        actual: Math.max(0, crudo),
        salidas: Math.max(0, sal + d.total),
        historial: FV.arrayUnion({ tipo: esSalida ? 'S' : 'E', fecha: iso, qty: Math.abs(d.total), loc, user: USUARIO, ref: ctx.refTxt }),
        ultimoMovimiento: ctx.fecha,
        ultimaModificacion: iso
      });
      tx.set(db.collection('planta4_movimientos').doc(), {
        tipo: esSalida ? 'OUT' : 'IN', pn: d.pn, desc: d.desc, familia: d.familia,
        cantidad: Math.abs(d.total), faltante, fecha: iso, fechaProduccion: ctx.fecha, ubicacion: loc,
        usuario: USUARIO, referencia: esSalida ? ctx.refTxt : ctx.refTxt + ' (corrección)', origen: 'CIERRE_JORNADA_AUTO'
      });
      res.actualizados++; res.movimientos++; res.aplicado += d.total;
      if (faltante > 0) res.faltantes.push(d.pn + ' (' + d.desc + '): faltan ' + faltante + ', quedó en 0');
    });
    plan.marcar.forEach(r => {
      tx.update(r.ref, { imsConsumoDescontado: r.consumo, imsDescontadoEn: iso });
      res.marcados++;
    });
  });
  return res;
}

async function ejecutar(db, FV, opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  const ahora = opts.ahora || new Date();
  const fecha = opts.fecha || hoyTijuana(ahora);
  const iso = new Date().toISOString();

  // 0. Modo (se cambia desde el panel del MES). Si no existe, arranca en SIMULACIÓN para no tocar nada por sorpresa.
  const cfg = await db.doc('cierres_jornada/_config').get();
  const modo = (cfg.exists && cfg.data().modo) || 'simulacion';
  if (modo === 'apagado') { log('Cierre automático APAGADO'); return { estado: 'apagado' }; }

  // 1. Días a procesar: hoy, y ayer SOLO si el automático ya lo cerró (captura tardía). Nunca días cerrados a mano.
  const hoyDoc = await db.doc('cierres_jornada/' + fecha).get();
  if (hoyDoc.exists && hoyDoc.data().auto !== true) { log('Hoy ya se cerró a mano'); return { estado: 'omitido', motivo: 'cierre manual existente' }; }
  const fechas = [fecha];
  const ayer = diaAnterior(fecha);
  const ayerDoc = await db.doc('cierres_jornada/' + ayer).get();
  if (ayerDoc.exists && ayerDoc.data().auto === true) fechas.push(ayer);

  // 2. BOM activo
  const bomDoc = await db.doc('bom_simulator_p4/bom_activo').get();
  if (!bomDoc.exists) throw new Error('No hay BOM activo en bom_simulator_p4/bom_activo');
  let BOM;
  try { BOM = JSON.parse(bomDoc.data().bom || '[]'); } catch (e) { throw new Error('El BOM activo no se pudo leer'); }
  const semanaRef = bomDoc.data().semana || '';

  // 3. Inventario IMS
  const imsSnap = await db.collection('planta4_inventario').get();
  const imsDocs = imsSnap.docs.map(d => ({ id: d.id, data: d.data() }));
  const imsPorId = new Map(imsDocs.map(d => [d.id, d.data]));
  const buscar = indexarIMS(imsDocs);

  // 4. Registros de ASSY1
  const regs = [];
  for (const f of fechas) {
    const s = await db.collection('registros').where('fecha', '==', f).get();
    s.docs.forEach(d => {
      const data = d.data();
      if (!esAssy1(data)) return;
      const consumo = consumoDe(data), yaDescontado = num(data.imsConsumoDescontado);
      regs.push({ id: d.id, ref: d.ref, data, fecha: f, consumo, yaDescontado, delta: consumo - yaDescontado });
    });
  }
  log('Registros ASSY1', { fechas, total: regs.length });

  // ───────── SIMULACIÓN: calcula y deja el resultado a la vista, sin tocar el IMS ─────────
  if (modo !== 'real') {
    const plan = planear(regs.filter(r => r.delta), BOM, buscar);
    const lineas = [...plan.descuentos.values()].sort((a, b) => a.pn.localeCompare(b.pn)).slice(0, 300).map(d => {
      const inv = num((imsPorId.get(d.id) || {}).actual);
      return d.pn + ' (' + d.desc + '): ' + inv + ' − ' + d.total + ' = ' + Math.max(0, inv - d.total) + (inv - d.total < 0 ? ' ⚠️ faltan ' + (d.total - inv) : '');
    });
    const out = {
      simulacion: true, fecha, ejecutadoEn: iso, semanaRef, registrosAssy1: regs.length,
      totalConsumo: plan.marcar.reduce((s, r) => s + r.delta, 0),
      componentes: plan.descuentos.size, lineas,
      sinIMS: [...plan.sinIMS.entries()].slice(0, 50).map(([k, v]) => k + ': ' + v),
      sinBOM: [...plan.sinBOM].slice(0, 50)
    };
    await db.doc('cierres_jornada/sim_' + fecha).set(out);
    return { estado: 'simulacion', ...out, lineas: undefined };
  }

  // ───────── REAL ─────────
  const resumen = [];
  for (const f of fechas) {
    const delDia = regs.filter(r => r.fecha === f);
    const ctx = { BOM, buscar, fecha: f, refTxt: 'Descuento automático scrap/defecto ' + f + ' (' + (semanaRef || 'BOM') + ')' };
    const total = { actualizados: 0, movimientos: 0, faltantes: [], conflictos: 0, marcados: 0, aplicado: 0, sinIMS: [], sinBOM: [] };
    const pendientes = delDia.filter(r => r.delta);
    for (let i = 0; i < pendientes.length; i += REGS_POR_LOTE) {
      const r = await aplicarLote(db, FV, pendientes.slice(i, i + REGS_POR_LOTE), ctx);
      total.actualizados += r.actualizados; total.movimientos += r.movimientos; total.conflictos += r.conflictos;
      total.marcados += r.marcados; total.aplicado += r.aplicado;
      total.faltantes.push(...r.faltantes); total.sinIMS.push(...r.sinIMS); total.sinBOM.push(...r.sinBOM);
    }
    const sinIMSTxt = [...new Map(total.sinIMS).entries()].slice(0, 50).map(([k, v]) => k + ': ' + v);
    await db.doc('cierres_jornada/' + f).set({
      fecha: f, auto: true, fechaCierre: iso, ultimaEjecucion: iso, usuario: USUARIO, semanaRef,
      totalRegistros: delDia.length,
      totalQty: delDia.reduce((s, r) => s + num(r.data.qty ?? r.data.prod), 0),
      totalDef: delDia.reduce((s, r) => s + num(r.data.defectos ?? r.data.def), 0),
      totalScr: delDia.reduce((s, r) => s + num(r.data.scrap), 0),
      totalConsumo: delDia.reduce((s, r) => s + r.consumo, 0),
      componentesDescontados: FV.increment(total.actualizados),
      movimientosCreados: FV.increment(total.movimientos),
      conflictos: total.conflictos,
      // Los avisos solo se reemplazan si esta corrida procesó algo (una corrida vacía no borra los avisos anteriores)
      ...(total.marcados ? {
        faltantes: total.faltantes.length,
        detalleFaltantes: total.faltantes.slice(0, 50),
        sinIMS: sinIMSTxt
      } : {}),
      ...(total.sinBOM.length ? { sinBOM: [...new Set(total.sinBOM)].slice(0, 50) } : {})
    }, { merge: true });
    resumen.push({ fecha: f, registros: delDia.length, ...total, faltantes: total.faltantes.length, sinIMS: sinIMSTxt.length, sinBOM: total.sinBOM.length });
  }
  return { estado: 'real', resumen };
}

module.exports = { ejecutar, planear, aplicarLote, indexarIMS, consumoDe, esAssy1, hoyTijuana, diaAnterior, DESC_DESCUENTO };
