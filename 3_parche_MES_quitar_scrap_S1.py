# -*- coding: utf-8 -*-
# PARCHE MES P4 (3): quita del Cierre de Jornada el descuento de Sheet/Chip Board por scrap/defectos de S1-S5/Zhongke.
# Ese material ya se descuenta con las salidas manuales del almacen, asi que descontarlo aqui seria doble.
# Correr desde la raiz del MES (donde existe public\index.html):  python 3_parche_MES_quitar_scrap_S1.py
import re, sys
RUTA = 'public/index.html'
with open(RUTA, encoding='utf-8', newline='') as f:
    txt = f.read()
crlf = '\r\n' in txt
def fx(s): return s.replace('\n', '\r\n') if crlf else s

# 1) bloque 5b completo (desde su comentario hasta justo antes de "// 6. Render preview")
patron_bloque = re.compile(r"    // 5b\. Scrap/defectos de S1-S5/Zhongke.*?\r?\n\r?\n(?=    // 6\. Render preview)", re.S)

CAMBIOS = [
    ("quitar lista de registros semiautomaticos",
     fx("const assy1Regs = [];\n    const semiRegs = [];"),
     "const assy1Regs = [];"),
    ("quitar lectura de registros S1-S5/Zhongke",
     fx("\n      else if (fechaReg === fecha && ['S1','S2','S3','S4','S5','ZHONGKE'].includes(String(r.maquina||r.maqNombre||'').trim().toUpperCase())) semiRegs.push({id:d.id,...r});"),
     ""),
    ("volver a la condicion original",
     "if (!assy1Regs.length && !semiRegs.length) {",
     "if (!assy1Regs.length) {"),
    ("quitar aviso en la vista previa",
     fx("let conFaltante = 0;\n    if (semiAvisos.length) html += '<div style=\"margin-bottom:.5rem;padding:.5rem .75rem;background:rgba(255,186,0,.08);border:1px solid rgba(255,186,0,.3);border-radius:8px;color:var(--amber);font-size:12px\">⚠️ ' + semiAvisos.join('<br>⚠️ ') + '</div>';"),
     "let conFaltante = 0;"),
    ("texto de la vista previa del envio",
     "NO SE TOCA (ya se descontaron al recibir el medio proceso):",
     "NO SE TOCA (ya salieron del inventario al entregarse a las líneas):"),
]
for nombre, viejo, nuevo in CAMBIOS:
    n = txt.count(viejo)
    if n != 1:
        print('NO ENCONTRADO (%d veces): %s  -> no se modifico nada' % (n, nombre)); sys.exit(1)
    txt = txt.replace(viejo, nuevo)
    print('OK: ' + nombre)
m = patron_bloque.findall(txt)
if len(m) != 1:
    print('NO ENCONTRADO (%d veces): bloque 5b  -> no se modifico nada' % len(m)); sys.exit(1)
txt = patron_bloque.sub('', txt)
print('OK: quitar bloque de scrap de medio proceso')
with open(RUTA, 'w', encoding='utf-8', newline='') as f:
    f.write(txt)
print('Listo. public/index.html del MES actualizado.')
