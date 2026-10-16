# -*- coding: utf-8 -*-
# PARCHE MES P4 v2:
#  1) El envio a ShipQR y el cierre de jornada ya NO descuentan Sheet ni Chip Board (se descuentan al recibir el medio proceso en IMS).
#  3) El Cierre de Jornada tambien descuenta Sheet y Chip Board del scrap/defectos de S1-S5/Zhongke (medio proceso).
#  2) Antes de enviar a ShipQR se MUESTRA que se va a descontar y que no; si algo no se puede descontar, lo avisa (ya no falla en silencio).
# Correr desde la raiz del MES (donde existe public\index.html):  python parche_MES_P4_sin_doble_descuento.py
import re, sys

RUTA = 'public/index.html'
LISTA = "['STRIP','GIFT BOX (TOP)','LOWER BOX (BOTTOM)','BUNDLE','PULP TRAY','SET PAD','BACK STICKER','GALLETA']"

FUNC_PLAN = r"""
/* Vista previa del descuento del envio a ShipQR (no modifica nada). */
async function planDescuentoEnvio(modelo, cantidad) {
  const r = {lineas: [], intactos: [], problemas: []};
  const nU = x => String(x || '').trim().toUpperCase();
  const bomDoc = await getDoc(doc(db, 'bom_simulator_p4', 'bom_activo'));
  if (!bomDoc.exists()) { r.problemas.push('No hay BOM activo: NO se descontará ningún material.'); return r; }
  const BOM = JSON.parse(bomDoc.data().bom || '[]');
  const filas = BOM.filter(b => b.pn && b.sm && String(b.sm).trim() === modelo);
  const comps = filas.filter(b => DESC_DESCUENTO_ENVIO.includes(nU(b.desc)));
  r.intactos = filas.filter(b => ['SHEET TOP BOX','CHIP BOARD TOP (RANURADO)','SHEET LOWER BOX (BOTTOM)','CHIP BOARD BOTTOM (RANURADO)'].includes(nU(b.desc)));
  if (!comps.length) { r.problemas.push('El BOM del modelo ' + modelo + ' no tiene materiales a descontar.'); return r; }
  const snap = await getDocs(collection(db, 'planta4_inventario'));
  const porClave = {}, porPn = {};
  snap.forEach(d => {
    const x = d.data(); if (!x.pn) return;
    const p = nU(x.pn), ds = nU(x.desc || x.descripcion || x.nombre);
    const k = p + '|||' + ds, prev = porClave[k];
    if (!prev || esAlmacenIMS(x) || !esAlmacenIMS(prev)) porClave[k] = x;
    (porPn[p] = porPn[p] || []).push(x);
  });
  comps.forEach(c => {
    const p = nU(c.pn), ds = nU(c.desc);
    const x = porClave[p + '|||' + ds] || (porPn[p] && porPn[p].length === 1 ? porPn[p][0] : null);
    if (!x) { r.problemas.push(c.pn + ' · ' + c.desc + ': no existe (o está duplicado) en el IMS, NO se descontará.'); return; }
    const a = Number(x.actual) || 0;
    r.lineas.push({pn: c.pn, desc: c.desc, antes: a, despues: Math.max(0, a - cantidad)});
    if (a < cantidad) r.problemas.push(c.pn + ' · ' + c.desc + ': solo hay ' + a.toLocaleString() + ' y se necesitan ' + cantidad.toLocaleString() + ' (quedará en 0).');
  });
  return r;
}
function textoPlanEnvio(modelo, cantidad, r) {
  let t = '🚚 ENVÍO A SHIPQR · ' + modelo + ' · ' + cantidad.toLocaleString() + ' pzas\n\n➖ SE DESCUENTA DEL IMS:\n';
  if (!r.lineas.length) t += '   (nada)\n';
  r.lineas.forEach(l => { t += '   ' + l.pn + ' · ' + l.desc + '   -' + cantidad.toLocaleString() + '   (' + l.antes.toLocaleString() + ' → ' + l.despues.toLocaleString() + ')\n'; });
  if (r.intactos.length) t += '\n✋ NO SE TOCA (ya se descontaron al recibir el medio proceso):\n' + r.intactos.map(b => '   ' + b.pn + ' · ' + b.desc).join('\n') + '\n';
  if (r.problemas.length) t += '\n⚠️ AVISOS:\n - ' + r.problemas.join('\n - ') + '\n';
  t += '\n¿Confirmar el envío?';
  return t;
}
"""

CAMBIOS_REGEX = [
    ("lista del envio a ShipQR", r"const DESC_DESCUENTO_ENVIO = \[[^\]]*\];", "const DESC_DESCUENTO_ENVIO = " + LISTA + ";"),
    ("lista del cierre de jornada", r"const DESC_DESCUENTO = \[[^\]]*\];", "const DESC_DESCUENTO = " + LISTA + ";"),
]

CAMBIOS_TXT = [

    ("cierre: juntar registros de lineas semiautomaticas",
     "const assy1Regs = [];",
     "const assy1Regs = [];\n    const semiRegs = [];"),
    ("cierre: leer registros S1-S5/Zhongke",
     "if (fechaReg === fecha && esASSY1) assy1Regs.push({id:d.id,...r});",
     "if (fechaReg === fecha && esASSY1) assy1Regs.push({id:d.id,...r});\n      else if (fechaReg === fecha && ['S1','S2','S3','S4','S5','ZHONGKE'].includes(String(r.maquina||r.maqNombre||'').trim().toUpperCase())) semiRegs.push({id:d.id,...r});"),
    ("cierre: no salir si solo hay S1-S5/Zhongke",
     "if (!assy1Regs.length) {",
     "if (!assy1Regs.length && !semiRegs.length) {"),
    ("cierre: scrap/defectos de medio proceso",
     "// 6. Render preview",
     """// 5b. Scrap/defectos de S1-S5/Zhongke: se perdio Sheet + Chip Board (el medio proceso nunca llego a un pallet)
    const COMP_SEMI = {'GIFT BOX (TOP)':['SHEET TOP BOX','CHIP BOARD TOP (RANURADO)'], 'LOWER BOX (BOTTOM)':['SHEET LOWER BOX (BOTTOM)','CHIP BOARD BOTTOM (RANURADO)']};
    const semiAvisos = [];
    const nUs = x => String(x||'').trim().toUpperCase();
    semiRegs.forEach(r => {
      const modelo = (r.modelo||'').trim();
      const defectos = Number(r.defectos ?? r.def)||0;
      const scrap = Number(r.scrap)||0;
      const consumo = defectos + scrap;
      if (!consumo) return;
      const maq = r.maquina || r.maqNombre || '';
      const medio = BOM.find(b => b.pn && b.sm && b.sm.trim() === modelo && nUs(b.pn) === nUs(r.parte) && COMP_SEMI[nUs(b.desc)]);
      if (!medio) { semiAvisos.push(maq + ' · ' + modelo + ' · parte ' + (r.parte||'—') + ': ' + consumo.toLocaleString() + ' pzas de scrap/defecto NO se descuentan (no se identificó Gift Box/Lower Box en el BOM).'); return; }
      totalPiezasConsumo += consumo;
      const comps = COMP_SEMI[nUs(medio.desc)];
      comps.forEach(dsc => {
        const c = BOM.find(b => b.pn && b.sm && b.sm.trim() === modelo && nUs(b.desc) === dsc);
        if (!c) { semiAvisos.push(maq + ' · ' + modelo + ': ' + dsc + ' no está en el BOM, NO se descuenta.'); return; }
        const key = nUs(c.pn) + '|||' + nUs(c.desc);
        if (!descuentos[key]) descuentos[key] = {pn:c.pn, desc:c.desc||'', familia:c.familia||'', total:0, detalle:[]};
        descuentos[key].total += consumo;
        descuentos[key].detalle.push({modelo: modelo + ' (' + maq + ' · medio proceso)', qty: 0, defectos, scrap, consumo});
      });
    });

    // 6. Render preview"""),
    ("cierre: avisos en la vista previa",
     "let conFaltante = 0;",
     "let conFaltante = 0;\n    if (semiAvisos.length) html += '<div style=\"margin-bottom:.5rem;padding:.5rem .75rem;background:rgba(255,186,0,.08);border:1px solid rgba(255,186,0,.3);border-radius:8px;color:var(--amber);font-size:12px\">⚠️ ' + semiAvisos.join('<br>⚠️ ') + '</div>';"),
    ("funcion de vista previa",
     "async function descontarMaterialEnvioShipqr(modelo, cantidad, refDocId, usuario) {",
     FUNC_PLAN + "\nasync function descontarMaterialEnvioShipqr(modelo, cantidad, refDocId, usuario) {"),
    ("aviso: sin BOM",
     "console.error('Sin BOM activo, no se pudo descontar material del envío'); return;",
     "console.error('Sin BOM activo'); alert('⚠️ El envío se registró pero NO se descontó material (no hay BOM activo). Corrige con un AJUSTE en IMS.'); return;"),
    ("aviso: sin registro IMS",
     "console.error(`Sin registro IMS único para ${c.pn} (${c.desc}), no se descontó`); continue;",
     "console.error(`Sin registro IMS único para ${c.pn} (${c.desc}), no se descontó`); alert(`⚠️ NO se descontó ${c.pn} · ${c.desc} (no existe o está duplicado en el IMS). Corrige con un AJUSTE en IMS.`); continue;"),
    ("aviso: error general",
     "console.error('Error descontando material por envío a ShipQR:', e);",
     "console.error('Error descontando material por envío a ShipQR:', e); alert('⚠️ El envío se registró pero el descuento de material FALLÓ: ' + e.message + '\\nCorrige con un AJUSTE en IMS.');"),
    ("vista previa antes de enviar",
     "const docId=key+'||'+Date.now();",
     """let _planEnv = null;
  try { _planEnv = await planDescuentoEnvio(modelo, cantidad); } catch(e) { _planEnv = {lineas:[], intactos:[], problemas:['No se pudo calcular la vista previa: ' + e.message]}; }
  if (!confirm(textoPlanEnvio(modelo, cantidad, _planEnv))) {
    if (shipqrWin && !shipqrWin.closed) shipqrWin.close();
    return;
  }
  const docId=key+'||'+Date.now();"""),
]

with open(RUTA, encoding='utf-8', newline='') as f:
    txt = f.read()
for nombre, patron, nuevo in CAMBIOS_REGEX:
    n = len(re.findall(patron, txt))
    if n != 1:
        print('NO ENCONTRADO (%d veces): %s  -> no se modifico nada' % (n, nombre)); sys.exit(1)
    txt = re.sub(patron, lambda m: nuevo, txt)
    print('OK: ' + nombre)
for nombre, viejo, nuevo in CAMBIOS_TXT:
    n = txt.count(viejo)
    if n != 1:
        print('NO ENCONTRADO (%d veces): %s  -> no se modifico nada' % (n, nombre)); sys.exit(1)
    txt = txt.replace(viejo, nuevo)
    print('OK: ' + nombre)
with open(RUTA, 'w', encoding='utf-8', newline='') as f:
    f.write(txt)
print('Listo. public/index.html del MES actualizado.')
