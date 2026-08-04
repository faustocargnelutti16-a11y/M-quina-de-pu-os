/* ============================================================
   BEERPUNCH — SISTEMA DE ACTIVACIONES (Fase 1: cupón impreso)
   ------------------------------------------------------------
   Módulo autocontenido. Se monta desde server.js así:

     const activaciones = require('./activaciones');
     app.use(activaciones({ agregarFichas }));

   Endpoints que expone:
     GET  /c/:codigo          -> escanea + QUEMA + página con botón ACTIVAR
     GET  /canjear/:codigo    -> alias de /c/:codigo
     POST /activar/:codigo    -> encola la ficha (paso 2, frente a la máquina)
     GET  /activaciones       -> panel de métricas (protegido por token)
     GET  /activaciones/json  -> mismas métricas en JSON

   REGLAS DE NEGOCIO IMPLEMENTADAS
     - Un solo escaneo por código. Se quema en el primer escaneo real.
     - Doble paso: escanear NO acredita. Hay que apretar ACTIVAR.
     - Ventana horaria como NOCHE (jue/vie/sáb 22:00 -> 03:00 AR), no como día.
     - Fuera de la ventana NO se quema el código (se puede usar otra noche).
     - Previews de WhatsApp/IG/Telegram NO queman el código.
     - Persistencia en /data para sobrevivir reinicios de Railway.
   ============================================================ */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------
   CONFIGURACIÓN
   ------------------------------------------------------------ */
const CONFIG = {
  // Minutos que dura la pantalla de ACTIVAR después de escanear.
  MINUTOS_PARA_ACTIVAR: 10,

  FICHAS_POR_CUPON: 1,

  /* ---- VENTANA ----
     Por defecto: TODOS los días, en horario de bar (17:00 -> 05:00).
     Para el cliente y para la carta esto es "sin límite": el bar está
     cerrado el resto del tiempo. No es un filtro comercial, es una
     protección: si alguien activa un cupón un martes a las 15:00, la
     ficha queda encolada y se dispara cuando el Shelly reconecte,
     regalándole un crédito a quien esté parado ahí.

     Se puede cambiar desde Railway sin tocar código:
       ACT_DIAS=0,1,2,3,4,5,6   (0=Dom ... 6=Sáb)
       ACT_HORA_INICIO=17
       ACT_HORA_FIN=5           (del día siguiente)                    */
  DIAS_VALIDOS: String(process.env.ACT_DIAS || '0,1,2,3,4,5,6')
    .split(',').map(function (d) { return parseInt(d.trim(), 10); })
    .filter(function (d) { return !isNaN(d); }),

  HORA_INICIO: parseInt(process.env.ACT_HORA_INICIO || '17', 10),
  HORA_FIN: parseInt(process.env.ACT_HORA_FIN || '5', 10),

  // Argentina no tiene horario de verano: UTC-3 fijo.
  OFFSET_AR: -3,

  ALERTA_STOCK: 10,

  // Misma clave que ya usás en /pausa, /gratis, /reanudar.
  TOKEN_PANEL: process.env.ACTIVACIONES_TOKEN || process.env.BPK_CLAVE || 'bpk2026',

  MODO_PRUEBA: String(process.env.ACTIVACIONES_TEST || '').toLowerCase() === 'true',

  IG: '@beerpunch.mdz',
};

/* ------------------------------------------------------------
   ALMACENAMIENTO PERSISTENTE
   Vive en /data (volumen de Railway). Si no existe, cae a ./data
   para poder correrlo local sin romper nada.
   ------------------------------------------------------------ */
const DIR_DATOS = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const ARCHIVO = path.join(DIR_DATOS, 'activaciones.json');

let db = { lote: null, generadoEn: null, codigos: {} };

function cargarDB() {
  try {
    if (!fs.existsSync(DIR_DATOS)) fs.mkdirSync(DIR_DATOS, { recursive: true });
    if (fs.existsSync(ARCHIVO)) {
      db = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
      if (!db.codigos) db.codigos = {};
      console.log('[ACT] Base cargada:', Object.keys(db.codigos).length, 'códigos — lote', db.lote);
    } else {
      console.log('[ACT] No hay base todavía. Subí codigos.json y llamá a /activaciones/importar');
    }
  } catch (e) {
    console.error('[ACT] Error leyendo la base:', e.message);
    db = { lote: null, generadoEn: null, codigos: {} };
  }
}

// Escritura atómica: archivo temporal + rename. Si el server muere a mitad
// de la escritura, el archivo viejo queda intacto (no se corrompe la base).
//
// Es SINCRÓNICO a propósito. Diferirlo (setImmediate/debounce) abre una
// ventana en la que el cupón ya se marcó como quemado en memoria pero
// todavía no está en disco: si Railway reinicia justo ahí, el código
// revive y se puede volver a usar. Son ~20 KB y unas pocas escrituras
// por noche — el costo es nulo y el modo de falla desaparece.
function guardarDB() {
  try {
    if (!fs.existsSync(DIR_DATOS)) fs.mkdirSync(DIR_DATOS, { recursive: true });
    const tmp = ARCHIVO + '.tmp';
    fs.writeFileSync(tmp
