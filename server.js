const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json({
  limit: '3mb',   // las fotos de las pinas viajan en el cuerpo; el default de 100kb las rebotaba
  verify: function (req, res, buf) { req.rawBody = buf.toString('utf8'); }
}));
app.use(express.urlencoded({ extended: true, limit: '3mb' }));

// Si la foto viene muy grande, que el celular reciba un JSON que entiende
// y no el HTML de error de Express.
app.use(function (err, req, res, next) {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'la foto es muy pesada' });
  }
  next(err);
});

// ============================================================
//  BPK / BeerPunch - servidor de creditos
//  v6: corta el QR si el Shelly esta caido, panel para el bar,
//      caja del dia, avisos por horario, resumen semanal, cupones QR.
// ============================================================

const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_SECRET = process.env.MP_WEBHOOK_SECRET || '';
const MP_ENFORCE = String(process.env.MP_WEBHOOK_ENFORCE || '').trim().toLowerCase() === 'true';
const USER_ID = 458533297;
const STORE_ID = 73977333;

const CLAVE = process.env.BPK_CLAVE || null;

const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : '';

const H = { headers: { Authorization: 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json' } };

// ===== COMBOS =====
const COMBOS = [
  { match: 'beerlin',  monto: 20
