// ════════════════════════════════════════════════════════════════
//  ARCHIVO: firebase-config.js
//  PROYECTO: mes-production-esp (compartido con MES)
//  IMS usa colecciones separadas — NO toca: causas_paro,
//  emails_reporte, registros, targets, usuarios
// ════════════════════════════════════════════════════════════════

const firebaseConfig = {
  apiKey: "AIzaSyDbaC1kFX4ERhndtXDyHg8eCcexP5IjAuI",
  authDomain: "mes-production-esp.firebaseapp.com",
  projectId: "mes-production-esp",
  storageBucket: "mes-production-esp.firebasestorage.app",
  messagingSenderId: "165168379582",
  appId: "1:165168379582:web:c4d725d38f1bbc6c8cd0ef",
  measurementId: "G-CV8J5QP1GD"
};

// Inicializa Firebase para el IMS
initFirebase(firebaseConfig);
