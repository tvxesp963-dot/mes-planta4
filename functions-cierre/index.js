'use strict';
/**
 * Cloud Function: Cierre de Jornada AUTOMÁTICO (scrap + defectos de ASSY1 → IMS Planta 4)
 * Toda la lógica está en cierre.js. Aquí solo se programa la hora.
 */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { ejecutar, hoyTijuana } = require('./cierre');

initializeApp();

// ⏰ HORA DEL CIERRE: 8:00 pm hora Tijuana (misma hora del reporte del MES).
//    Formato: 'minuto hora * * *'   →  8:30 pm sería '30 20 * * *'
exports.cierreJornadaAutomatico = onSchedule(
  { schedule: '0 20 * * *', timeZone: 'America/Tijuana', region: 'us-central1', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const db = getFirestore();
    const fecha = hoyTijuana();
    try {
      const res = await ejecutar(db, FieldValue, { log: (m, d) => logger.info(m, d) });
      logger.info('Cierre de jornada automático terminado', res);
      await db.doc('cierres_jornada/error_' + fecha).delete().catch(() => {});
    } catch (e) {
      logger.error('Cierre de jornada automático FALLÓ', e);
      // Queda a la vista en el panel del MES
      await db.doc('cierres_jornada/error_' + fecha).set({ error: String(e && e.message || e), fecha, ejecutadoEn: new Date().toISOString() }).catch(() => {});
      throw e;
    }
  }
);
