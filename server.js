const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json({
  verify: function (req, res, buf) { req.rawBody = buf.toString('utf8'); }
}));
app.use(express.urlencoded({ extended: true }));

// ============================================================
//  BPK / BeerPunch - servidor de creditos
//  v6: corta el QR si el Shelly esta caido, panel para el bar,
//      caja del dia, ventas en efectivo, log limpio.
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
  { match: 'beerlin',  monto: 2000,  fichas: 1 },
  { match: '3 tiros',  monto: 5500,  fichas: 3 },
  { match: '8 tiros',  monto: 10000, fichas: 8 },
  { match: '20 tiros', monto: 20000, fichas: 20 },
];

// ===== TOPES DE SEGURIDAD =====
const MAX_FICHAS_POR_EVENTO = 20;
const MAX_PENDING = 45;
const VENTANA_MIN = 10;
const MAX_FICHAS_VENTANA = 100;
const EDAD_MAX_PAGO_MIN = 10;
const COOLDOWN_GRATIS_MS = 8000;
const REINTENTO_ENTREGA_MS = 30000;

// ===== VIGILANCIA DEL SHELLY =====
// Si el Shelly deja de consultar, la maquina NO puede entregar creditos.
// A los 3 minutos de silencio se borran las ordenes de Mercado Pago para que
// nadie pueda pagar algo que no vamos a poder darle. Cuando vuelve, se recrean.
const SHELLY_CAIDO_MS = 3 * 60 * 1000;
const PORCENTAJE_BAR = 20;  // lo que le toca a Andres sobre el neto

const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
let alertaShellyActiva = false;
let qrCortado = false;

// ===== ALMACENAMIENTO PERSISTENTE =====
const DATA_DIR = '/data';
const F_PAGOS = path.join(DATA_DIR, 'pagos.json');
const F_LOG = path.join(DATA_DIR, 'log.json');
const F_VENTAS = path.join(DATA_DIR, 'ventas.json');
let persistenciaOk = false;

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
  persistenciaOk = true;
} catch (e) {
  persistenciaOk = false;
}

function leerJSON(archivo, porDefecto) {
  if (!persistenciaOk) return porDefecto;
  try {
    if (!fs.existsSync(archivo)) return porDefecto;
    return JSON.parse(fs.readFileSync(archivo, 'utf8'));
  } catch (e) {
    return porDefecto;
  }
}

let guardadoPendiente = false;
function guardarTodo() {
  if (!persistenciaOk) return;
  if (guardadoPendiente) return;
  guardadoPendiente = true;
  setTimeout(function () {
    guardadoPendiente = false;
    try {
      fs.writeFileSync(F_PAGOS, JSON.stringify(pagosProcesados));
      fs.writeFileSync(F_LOG, JSON.stringify(eventos));
      fs.writeFileSync(F_VENTAS, JSON.stringify(ventas));
    } catch (e) {
      console.log('error guardando en /data: ' + e.message);
    }
  }, 2000);
}

// ===== ESTADO =====
let pendingActivation = 0;
let entregaEnVuelo = null;
let cajas = [];
let bloqueado = false;
let motivoBloqueo = '';
let historialFichas = [];
let eventos = leerJSON(F_LOG, []);
let ventas = leerJSON(F_VENTAS, []);
let ultimoGratis = 0;
let ultimoPoll = 0;
let pagosProcesados = leerJSON(F_PAGOS, {});
let cantidadProcesados = Object.keys(pagosProcesados).length;
let ultimoArranqueShelly = 0;
let desconexionesHoy = 0;
const arranque = Date.now();

function hora() {
  return new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour12: false
  });
}

function horaCorta(ts) {
  return new Date(ts).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Solo los eventos que importan van al historial. Las tareas de rutina
// (refrescar ordenes cada 3 min) ensuciaban el /log y borraban lo util:
// eran 480 lineas por dia y el historial guarda 200.
function log(tipo, msg) {
  const linea = hora() + ' | ' + tipo + ' | ' + msg;
  eventos.push(linea);
  if (eventos.length > 200) eventos.shift();
  console.log(linea);
  guardarTodo();
}

function rutina(tipo, msg) {
  console.log(hora() + ' | ' + tipo + ' | ' + msg);
}

function claveOk(req) {
  if (!CLAVE) return true;
  return String(req.query.clave || '') === CLAVE;
}

function horaArg() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return now.getHours();
}

function enHorarioDeBar() {
  const h = horaArg();
  return (h >= 17 || h < 5);
}

// ===== AVISOS AL CELULAR =====
function avisar(titulo, texto, urgente) {
  if (!NTFY_TOPIC) return;
  axios.post('https://ntfy.sh/' + NTFY_TOPIC, texto, {
    headers: {
      'Title': titulo,
      'Priority': urgente ? 'urgent' : 'default',
      'Tags': urgente ? 'rotating_light' : 'white_check_mark'
    },
    timeout: 10000
  }).catch(function (e) {
    rutina('ERROR AVISO', e.message);
  });
}

// ===== VENTAS (para la caja del dia) =====
// La "jornada" arranca al mediodia: asi una noche que cruza las 00:00
// cuenta como una sola jornada y no como dos dias distintos.
function inicioJornada() {
  const ahora = new Date();
  const arg = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const desfase = ahora.getTime() - arg.getTime();
  arg.setHours(12, 0, 0, 0);
  let inicio = arg.getTime() + desfase;
  if (inicio > Date.now()) inicio -= 24 * 60 * 60 * 1000;
  return inicio;
}

function registrarVenta(monto, fichas, tipo, id) {
  ventas.push({ ts: Date.now(), monto: monto, fichas: fichas, tipo: tipo, id: id || '' });
  const limite = Date.now() - 60 * 24 * 60 * 60 * 1000; // guardamos 60 dias
  ventas = ventas.filter(function (v) { return v.ts > limite; });
  guardarTodo();
}

function resumenJornada() {
  const desde = inicioJornada();
  const delDia = ventas.filter(function (v) { return v.ts >= desde; });
  const total = delDia.reduce(function (a, v) { return a + v.monto; }, 0);
  const fichas = delDia.reduce(function (a, v) { return a + v.fichas; }, 0);
  const efectivo = delDia.filter(function (v) { return v.tipo === 'efectivo'; });
  const qr = delDia.filter(function (v) { return v.tipo === 'qr'; });

  const porCombo = {};
  delDia.forEach(function (v) {
    const k = '$' + v.monto;
    if (!porCombo[k]) porCombo[k] = { cantidad: 0, total: 0 };
    porCombo[k].cantidad++;
    porCombo[k].total += v.monto;
  });

  return {
    desde: desde,
    operaciones: delDia.length,
    total: total,
    fichas: fichas,
    totalQR: qr.reduce(function (a, v) { return a + v.monto; }, 0),
    cantidadQR: qr.length,
    totalEfectivo: efectivo.reduce(function (a, v) { return a + v.monto; }, 0),
    cantidadEfectivo: efectivo.length,
    porCombo: porCombo,
    paraBar: Math.round(total * PORCENTAJE_BAR / 100),
    ventas: delDia
  };
}

// ===== ALTA DE FICHAS CON CORTE AUTOMATICO =====
function agregarFichas(n, origen) {
  if (bloqueado) {
    log('BLOQUEADO', 'se intento sumar ' + n + ' fichas (' + origen + ') con el sistema frenado');
    return false;
  }
  const nSeguro = Math.max(0, Math.min(Math.floor(Number(n) || 0), MAX_FICHAS_POR_EVENTO));
  if (nSeguro <= 0) return false;

  const ahora = Date.now();
  const desde = ahora - VENTANA_MIN * 60 * 1000;
  historialFichas = historialFichas.filter(function (t) { return t > desde; });

  if (historialFichas.length + nSeguro > MAX_FICHAS_VENTANA) {
    bloqueado = true;
    motivoBloqueo = 'Mas de ' + MAX_FICHAS_VENTANA + ' fichas en ' + VENTANA_MIN + ' minutos';
    pendingActivation = 0;
    entregaEnVuelo = null;
    log('CORTE', motivoBloqueo + '. Entrega detenida. Reactivar con /reanudar');
    avisar('BPK - Corte automatico', 'El sistema se freno solo: ' + motivoBloqueo + '. Revisa el log.', true);
    return false;
  }

  for (let i = 0; i < nSeguro; i++) historialFichas.push(ahora);
  pendingActivation = Math.min(pendingActivation + nSeguro, MAX_PENDING);
  log('FICHAS', '+' + nSeguro + ' (' + origen + ') -> cola=' + pendingActivation);
  return true;
}

function fichasPorMonto(monto) {
  const combo = COMBOS.find(function (c) { return c.monto === monto; });
  let fichas = combo ? combo.fichas : 0;
  const h = horaArg();
  if (monto === 2000 && h >= 17 && h < 21) fichas = 2; // happy hour, solo QR
  return fichas;
}

// ===== FIRMA DE MERCADO PAGO =====
function firmaValida(req, idBody) {
  if (!MP_SECRET) return null;
  try {
    const sig = String(req.headers['x-signature'] || '');
    const reqId = String(req.headers['x-request-id'] || '');
    if (!sig) return false;  // el aviso viejo de las cajas QR no trae firma

    let ts = '';
    let v1 = '';
    sig.split(',').forEach(function (parte) {
      const kv = parte.split('=');
      if (kv.length !== 2) return;
      const k = kv[0].trim();
      const v = kv[1].trim();
      if (k === 'ts') ts = v;
      if (k === 'v1') v1 = v;
    });
    if (!ts || !v1) return false;

    const idQuery = req.query['data.id'] ? String(req.query['data.id']) : null;
    const candidatos = [];
    if (idQuery) candidatos.push({ etiqueta: 'query', id: idQuery.toLowerCase() });
    candidatos.push({ etiqueta: 'body', id: String(idBody).toLowerCase() });

    for (let i = 0; i < candidatos.length; i++) {
      const manifest = 'id:' + candidatos[i].id + ';request-id:' + reqId + ';ts:' + ts + ';';
      const esperado = crypto.createHmac('sha256', MP_SECRET).update(manifest).digest('hex');
      if (esperado === v1) return true;
    }

    rutina('DIAG FIRMA', 'idBody=' + idBody + ' idQuery=' + (idQuery || 'no vino') +
        ' reqId=' + (reqId || 'no vino') + ' ts=' + ts + ' v1=' + v1.slice(0, 12) + '...');
    return false;
  } catch (e) {
    rutina('ERROR FIRMA', e.message);
    return false;
  }
}

// ===== MERCADO PAGO =====
async function descubrirCajas() {
  try {
    const r = await axios.get('https://api.mercadopago.com/pos?store_id=' + STORE_ID, H);
    cajas = [];
    (r.data.results || []).forEach(function (pos) {
      const nombre = (pos.name || '').toLowerCase();
      const combo = COMBOS.find(function (c) { return nombre.indexOf(c.match) !== -1; });
      if (combo) cajas.push({ external_id: pos.external_id, monto: combo.monto, fichas: combo.fichas, nombre: pos.name });
    });
    rutina('CAJAS', cajas.map(function (c) { return c.nombre + ' $' + c.monto; }).join(' | '));
    return cajas;
  } catch (e) {
    log('ERROR', 'descubriendo cajas: ' + e.message);
    return [];
  }
}

async function crearOrden(caja) {
  if (!BASE_URL) { log('ERROR', 'sin BASE_URL: no se crean ordenes'); return false; }
  try {
    await axios.put(
      'https://api.mercadopago.com/instore/qr/seller/collectors/' + USER_ID + '/pos/' + caja.external_id + '/orders',
      {
        external_reference: 'BPK-' + caja.external_id + '-' + Date.now(),
        title: caja.nombre,
        description: 'Maquina BeerPunch',
        notification_url: BASE_URL + '/webhook',
        total_amount: caja.monto,
        items: [{
          sku_number: 'BPK',
          category: 'entretenimiento',
          title: caja.nombre,
          description: 'Tiros en la maquina',
          unit_price: caja.monto,
          quantity: 1,
          unit_measure: 'unit',
          total_amount: caja.monto,
          currency_id: 'ARS'
        }]
      },
      H
    );
    return true;
  } catch (e) {
    log('ERROR', 'orden ' + caja.nombre + ': ' + (e.response ? JSON.stringify(e.response.data) : e.message));
    return false;
  }
}

async function borrarOrden(caja) {
  try {
    await axios.delete(
      'https://api.mercadopago.com/instore/qr/seller/collectors/' + USER_ID + '/pos/' + caja.external_id + '/orders',
      H
    );
    return true;
  } catch (e) {
    rutina('ERROR', 'borrando orden ' + caja.nombre + ': ' + e.message);
    return false;
  }
}

async function crearTodasLasOrdenes() {
  if (cajas.length === 0) await descubrirCajas();
  for (let i = 0; i < cajas.length; i++) await crearOrden(cajas[i]);
  rutina('ORDENES', 'activas en ' + cajas.length + ' cajas');
}

async function borrarTodasLasOrdenes() {
  if (cajas.length === 0) await descubrirCajas();
  for (let i = 0; i < cajas.length; i++) await borrarOrden(cajas[i]);
}

// El keep-alive: las ordenes de MP vencen a los 10 min, se refrescan cada 3.
// Si el Shelly esta caido NO se recrean: el QR queda muerto a proposito.
setInterval(function () {
  if (qrCortado) return;
  crearTodasLasOrdenes();
}, 3 * 60 * 1000);

// ===== VIGILANTE DEL SHELLY =====
function shellyVivo() {
  if (!ultimoPoll) return false;
  return (Date.now() - ultimoPoll) < SHELLY_CAIDO_MS;
}

async function vigilarShelly() {
  // Al arrancar el servidor damos margen antes de juzgar nada.
  if (!ultimoPoll && (Date.now() - arranque) < SHELLY_CAIDO_MS) return;

  const silencioMs = ultimoPoll ? (Date.now() - ultimoPoll) : (Date.now() - arranque);
  const silencioMin = Math.round(silencioMs / 60000);
  const caido = silencioMs > SHELLY_CAIDO_MS;

  if (caido && !qrCortado) {
    qrCortado = true;
    desconexionesHoy++;
    log('QR CORTADO', 'Shelly mudo hace ' + silencioMin + ' min -> se borran las ordenes de MP');
    await borrarTodasLasOrdenes();
  }

  if (!caido && qrCortado) {
    qrCortado = false;
    log('QR ACTIVO', 'el Shelly volvio -> ordenes de MP recreadas');
    await crearTodasLasOrdenes();
  }

  if (caido && !alertaShellyActiva) {
    alertaShellyActiva = true;
    avisar(
      'BPK - QR caido',
      'El Shelly no responde hace ' + silencioMin + ' min.\n' +
      'Ya corte el QR para que nadie pague algo que no podemos entregar.\n' +
      'Fichas en cola esperando: ' + pendingActivation + '\n\n' +
      'EL BILLETERO SIGUE ANDANDO: que cobren ahi mientras tanto.\n\n' +
      'Para arreglarlo: mira la app de Shelly.\n' +
      '- Si dice sin conexion -> cortar la luz de la maquina 10 seg\n' +
      '- Si dice online -> Scripts, Stop y Start\n\n' +
      'Panel: ' + (BASE_URL || '') + '/panel',
      enHorarioDeBar()
    );
  }

  if (!caido && alertaShellyActiva) {
    alertaShellyActiva = false;
    avisar('BPK - Maquina OK', 'El Shelly volvio y el QR esta activo de nuevo.', false);
  }
}

setInterval(vigilarShelly, 30 * 1000);

// ===== ENDPOINTS =====

app.get('/', function (req, res) { res.redirect('/panel'); });

app.get('/cajas', async function (req, res) {
  await descubrirCajas();
  res.json(cajas);
});

app.get('/setup', async function (req, res) {
  await descubrirCajas();
  await crearTodasLasOrdenes();
  qrCortado = false;
  res.json({ ok: true, cajas: cajas, base_url: BASE_URL });
});

app.get('/orden', async function (req, res) {
  await crearTodasLasOrdenes();
  res.send('Ordenes creadas en ' + cajas.length + ' cajas');
});

app.get('/estado', function (req, res) {
  const desde = Date.now() - VENTANA_MIN * 60 * 1000;
  const ultimas = historialFichas.filter(function (t) { return t > desde; }).length;
  const segDesdePoll = ultimoPoll ? Math.round((Date.now() - ultimoPoll) / 1000) : -1;
  res.type('text/plain').send(
    'pendingActivation = ' + pendingActivation + '\n' +
    'en vuelo (sin confirmar) = ' + (entregaEnVuelo ? entregaEnVuelo.n + ' fichas, hace ' + Math.round((Date.now() - entregaEnVuelo.ts) / 1000) + ' s' : 'ninguna') + '\n' +
    'bloqueado = ' + (bloqueado ? 'SI -> ' + motivoBloqueo : 'no') + '\n' +
    'QR de Mercado Pago = ' + (qrCortado ? 'CORTADO (Shelly caido)' : 'activo') + '\n' +
    'fichas ultimos ' + VENTANA_MIN + ' min = ' + ultimas + ' (tope ' + MAX_FICHAS_VENTANA + ')\n' +
    'ultimo poll del Shelly = ' + (segDesdePoll < 0 ? 'nunca' : 'hace ' + segDesdePoll + ' s') + '\n' +
    'ultimo arranque del Shelly = ' + (ultimoArranqueShelly ? new Date(ultimoArranqueShelly).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false }) : 'sin avisos desde que arranco el server') + '\n' +
    'desconexiones desde el arranque = ' + desconexionesHoy + '\n' +
    'base_url = ' + (BASE_URL || '*** FALTA RAILWAY_PUBLIC_DOMAIN ***') + '\n' +
    'token MP = ' + (MP_TOKEN ? 'cargado' : '*** FALTA MP_ACCESS_TOKEN ***') + '\n' +
    'firma MP = ' + (!MP_SECRET ? 'sin secreto' : (MP_ENFORCE ? 'ENFORCE (bloquea)' : 'modo prueba (solo loguea)')) + '\n' +
    'memoria persistente = ' + (persistenciaOk ? 'SI (volumen /data)' : 'NO -> se pierde todo al reiniciar') + '\n' +
    'avisos al celular = ' + (NTFY_TOPIC ? 'activados' : '*** FALTA NTFY_TOPIC ***') + '\n' +
    'arranque server = ' + new Date(arranque).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false }) + '\n' +
    'hora servidor = ' + hora()
  );
});

app.get('/log', function (req, res) {
  res.type('text/plain').send(eventos.length ? eventos.slice().reverse().join('\n') : 'sin eventos todavia');
});

app.get('/probar-aviso', function (req, res) {
  if (!NTFY_TOPIC) return res.send('No hay NTFY_TOPIC configurado en Railway');
  avisar('BPK - Prueba', 'Si estas leyendo esto, los avisos funcionan.', false);
  res.send('Aviso de prueba enviado. Revisa el celular.');
});

// ===== ENTREGA CON CONFIRMACION =====
app.get('/shelly-poll', function (req, res) {
  ultimoPoll = Date.now();
  if (bloqueado) { res.type('text/plain').send('0'); return; }

  if (entregaEnVuelo) {
    const edad = Date.now() - entregaEnVuelo.ts;
    if (edad > REINTENTO_ENTREGA_MS) {
      entregaEnVuelo.ts = Date.now();
      entregaEnVuelo.intentos++;
      log('REENVIO', 'el Shelly no confirmo ' + entregaEnVuelo.n + ' fichas, se reofrecen (intento ' + entregaEnVuelo.intentos + ')');
      res.type('text/plain').send(String(entregaEnVuelo.n));
      return;
    }
    res.type('text/plain').send('0');
    return;
  }

  if (pendingActivation > 0) {
    const n = Math.min(pendingActivation, MAX_PENDING);
    pendingActivation = 0;
    entregaEnVuelo = { n: n, ts: Date.now(), intentos: 1 };
    log('ENVIO', n + ' fichas mandadas al Shelly, esperando confirmacion');
    res.type('text/plain').send(String(n));
    return;
  }

  res.type('text/plain').send('0');
});

app.get('/shelly-ack', function (req, res) {
  if (entregaEnVuelo) {
    log('ENTREGADO', entregaEnVuelo.n + ' fichas confirmadas por el Shelly');
    entregaEnVuelo = null;
  }
  res.type('text/plain').send('ok');
});

// El Shelly avisa cada vez que arranca. Sirve para distinguir en el log
// "apagaron la maquina y la prendieron" de "se colgo el wifi y volvio solo".
app.get('/shelly-hello', function (req, res) {
  ultimoArranqueShelly = Date.now();
  ultimoPoll = Date.now();
  log('SHELLY ARRANCO', 'el Shelly acaba de encenderse (corte de luz o reinicio)');
  res.type('text/plain').send('ok');
});

app.get('/gratis', function (req, res) {
  if (!claveOk(req)) { log('RECHAZO', '/gratis sin clave valida'); return res.status(403).send('clave invalida'); }
  const ahora = Date.now();
  if (ahora - ultimoGratis < COOLDOWN_GRATIS_MS) {
    return res.send('Espera unos segundos antes de otra activacion');
  }
  ultimoGratis = ahora;
  const ok = agregarFichas(1, 'gratis');
  res.send(ok ? 'Activado (1 ficha gratis)' : 'No se activo (sistema frenado o tope alcanzado)');
});

// Venta cobrada en efectivo. Queda registrada en la caja del dia para que
// el reparto con el bar salga bien.
app.get('/efectivo', function (req, res) {
  if (!claveOk(req)) return res.status(403).send('clave invalida');
  const monto = parseInt(req.query.monto, 10);
  const combo = COMBOS.find(function (c) { return c.monto === monto; });
  if (!combo) return res.status(400).send('Monto invalido. Usar 2000, 5500, 10000 o 20000');

  if (!shellyVivo()) {
    return res.send('NO COBRES POR ACA: la maquina esta desconectada y este boton no puede entregar los tiros. Que paguen por el BILLETERO de la maquina, que funciona igual.');
  }

  const ok = agregarFichas(combo.fichas, 'EFECTIVO $' + monto);
  if (!ok) return res.send('No se activo (sistema frenado o tope alcanzado). No cobres.');

  registrarVenta(monto, combo.fichas, 'efectivo', '');
  res.send('Cobrado en efectivo $' + monto + ' -> ' + combo.fichas + ' fichas activadas');
});

app.get('/pausa', function (req, res) {
  if (!claveOk(req)) return res.status(403).send('clave invalida');
  bloqueado = true;
  motivoBloqueo = 'pausa manual';
  pendingActivation = 0;
  entregaEnVuelo = null;
  log('PAUSA', 'freno manual activado');
  res.send('Sistema PAUSADO. No se entregan mas creditos hasta /reanudar');
});

app.get('/reanudar', function (req, res) {
  if (!claveOk(req)) return res.status(403).send('clave invalida');
  bloqueado = false;
  motivoBloqueo = '';
  historialFichas = [];
  pendingActivation = 0;
  entregaEnVuelo = null;
  log('REANUDAR', 'sistema reactivado a mano');
  res.send('Sistema REANUDADO, cola en 0');
});

app.get('/reset', function (req, res) {
  if (!claveOk(req)) return res.status(403).send('clave invalida');
  pendingActivation = 0;
  entregaEnVuelo = null;
  log('RESET', 'cola vaciada a mano');
  res.send('Cola en 0');
});

// ===== CAJA DEL DIA =====
app.get('/caja', function (req, res) {
  const r = resumenJornada();
  let txt = 'CAJA DE LA JORNADA\n';
  txt += 'desde ' + new Date(r.desde).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false }) + '\n';
  txt += '========================\n\n';
  txt += 'TOTAL          $' + r.total + '\n';
  txt += 'operaciones    ' + r.operaciones + '\n';
  txt += 'fichas dadas   ' + r.fichas + '\n\n';
  txt += 'por QR         $' + r.totalQR + '  (' + r.cantidadQR + ')\n';
  txt += 'en efectivo    $' + r.totalEfectivo + '  (' + r.cantidadEfectivo + ')\n\n';
  txt += 'POR COMBO\n';
  Object.keys(r.porCombo).sort().forEach(function (k) {
    txt += '  ' + k + ' x' + r.porCombo[k].cantidad + ' = $' + r.porCombo[k].total + '\n';
  });
  txt += '\nREPARTO\n';
  txt += '  para el bar (' + PORCENTAJE_BAR + '%)  $' + r.paraBar + '\n';
  txt += '  para vos              $' + (r.total - r.paraBar) + '\n';
  txt += '  (sobre el bruto, sin descontar comision de MP)\n';
  txt += '  OJO: lo que entra por el billetero de la maquina\n';
  txt += '  no aparece aca, se cuenta aparte al vaciarlo.\n\n';
  txt += 'DETALLE\n';
  r.ventas.slice().reverse().forEach(function (v) {
    txt += '  ' + horaCorta(v.ts) + '  $' + v.monto + '  ' + v.fichas + ' fichas  ' + v.tipo + '\n';
  });
  if (r.ventas.length === 0) txt += '  todavia no hubo ventas en esta jornada\n';
  res.type('text/plain').send(txt);
});

// ===== PANEL PARA EL BAR =====
app.get('/panel', function (req, res) {
  const vivo = shellyVivo();
  const segDesdePoll = ultimoPoll ? Math.round((Date.now() - ultimoPoll) / 1000) : -1;
  const r = resumenJornada();
  const c = CLAVE ? ('?clave=' + encodeURIComponent(CLAVE)) : '';

  let color, titulo, detalle, diagnostico = '';
  if (bloqueado) {
    color = '#c0392b'; titulo = 'SISTEMA FRENADO';
    detalle = 'Alguien apretó PAUSA o saltó el corte automático.<br>Motivo: ' + motivoBloqueo +
      '<br><br><b>El billetero sigue funcionando.</b><br>Tocá REANUDAR abajo para volver a la normalidad.';
  } else if (!vivo) {
    const minCaido = segDesdePoll < 0 ? '?' : Math.round(segDesdePoll / 60);
    color = '#c0392b'; titulo = 'QR CAÍDO';
    detalle = 'La máquina no habla con el servidor hace ' + minCaido + ' min.<br><br>' +
      '<b>SÍ funciona:</b> el billetero. Que paguen con monedas o billetes directo en la máquina.<br>' +
      '<b>NO funciona:</b> el QR (lo corté a propósito para que nadie pierda plata) ni los botones de efectivo de acá abajo.<br><br>' +
      '<b>TAPAR EL CARTEL DEL QR.</b>';
    diagnostico =
      '<div class="box"><h2>Cómo arreglarlo</h2>' +
      '<p style="font-size:15px;line-height:1.7;margin:0 0 10px">' +
      '<b>1.</b> Abrí la app de Shelly y mirá el dispositivo.<br><br>' +
      '<b>Si dice "no hay conexión"</b> → es el WiFi o la corriente.<br>' +
      'Cortá la luz de la máquina 10 segundos y prendela. Si sigue igual, revisá si el WiFi del bar anda.<br><br>' +
      '<b>Si aparece conectado (online)</b> → se colgó el script.<br>' +
      'Entrá a Scripts, tocá Stop y después Start.<br><br>' +
      '<b>2.</b> Cuando vuelva, el QR se reactiva solo y las fichas en cola caen en la máquina.' +
      '</p></div>';
  } else if (qrCortado) {
    color = '#e67e22'; titulo = 'QR NO DISPONIBLE';
    detalle = 'La máquina funciona pero el QR está cortado.<br><b>Cobrar en efectivo</b> con los botones de abajo, o por billetero.';
  } else {
    color = '#1e8449'; titulo = 'TODO OK';
    detalle = 'La máquina está conectada y el QR funciona.<br>Se puede jugar normal.';
  }

  const html = '<!DOCTYPE html><html lang="es"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="refresh" content="20">' +
    '<title>BPK Panel</title><style>' +
    'body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:16px;background:#111;color:#eee}' +
    'h1{font-size:20px;margin:0 0 14px}' +
    '.sem{background:' + color + ';border-radius:14px;padding:20px;text-align:center;margin-bottom:18px}' +
    '.sem b.t{font-size:26px;display:block;margin-bottom:10px}' +
    '.sem .d{font-size:15px;line-height:1.5}' +
    '.box{background:#1d1d1d;border-radius:12px;padding:14px;margin-bottom:14px}' +
    '.box h2{font-size:15px;margin:0 0 10px;color:#999;text-transform:uppercase;letter-spacing:.5px}' +
    'a.btn{display:block;background:#2c3e50;color:#fff;text-decoration:none;padding:14px;border-radius:10px;margin-bottom:8px;font-size:16px;text-align:center}' +
    'a.rojo{background:#922b21}a.verde{background:#196f3d}a.gris{background:#333}' +
    '.fila{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #2a2a2a;font-size:15px}' +
    '.fila b{color:#fff}' +
    '.pie{color:#666;font-size:12px;text-align:center;margin-top:18px;line-height:1.6}' +
    '</style></head><body>' +
    '<h1>BPK - Beerlin</h1>' +
    '<div class="sem"><b class="t">' + titulo + '</b><div class="d">' + detalle + '</div></div>' +
    diagnostico +

    '<div class="box"><h2>Caja de hoy</h2>' +
    '<div class="fila"><span>Total</span><b>$' + r.total + '</b></div>' +
    '<div class="fila"><span>Tiros vendidos</span><b>' + r.fichas + '</b></div>' +
    '<div class="fila"><span>Operaciones</span><b>' + r.operaciones + '</b></div>' +
    '<a class="btn gris" href="/caja">Ver caja detallada</a></div>' +

    '<div class="box"><h2>Cobrar en efectivo</h2>' +
    '<a class="btn verde" href="/efectivo?monto=2000' + (c ? '&clave=' + encodeURIComponent(CLAVE) : '') + '">$2.000 - 1 tiro</a>' +
    '<a class="btn verde" href="/efectivo?monto=5500' + (c ? '&clave=' + encodeURIComponent(CLAVE) : '') + '">$5.500 - 3 tiros</a>' +
    '<a class="btn verde" href="/efectivo?monto=10000' + (c ? '&clave=' + encodeURIComponent(CLAVE) : '') + '">$10.000 - 8 tiros</a>' +
    '<a class="btn verde" href="/efectivo?monto=20000' + (c ? '&clave=' + encodeURIComponent(CLAVE) : '') + '">$20.000 - 20 tiros</a></div>' +

    '<div class="box"><h2>Otros</h2>' +
    '<a class="btn" href="/gratis' + c + '">Dar 1 tiro gratis</a>' +
    '<a class="btn" href="/log">Ver historial</a>' +
    '<a class="btn" href="/estado">Estado tecnico</a></div>' +

    '<div class="box"><h2>Emergencia</h2>' +
    '<a class="btn rojo" href="/pausa' + c + '">PAUSA - si larga tiros solo</a>' +
    '<a class="btn verde" href="/reanudar' + c + '">Reanudar despues de una pausa</a></div>' +

    '<div class="pie">Se actualiza solo cada 20 segundos.<br>' +
    'Cola: ' + pendingActivation + ' fichas' +
    (segDesdePoll >= 0 ? ' | Maquina vista hace ' + segDesdePoll + ' s' : '') +
    '<br>' + hora() + '</div>' +
    '</body></html>';

  res.type('text/html').send(html);
});

// ===== WEBHOOK DE MERCADO PAGO =====
app.post('/webhook', function (req, res) {
  res.sendStatus(200);
  const body = req.body || {};

  if (body.topic === 'merchant_order') return;

  const paymentId = (body && body.data && body.data.id) || body.resource;
  if (!((body.type === 'payment' || body.topic === 'payment') && paymentId)) return;

  const idStr = String(paymentId);

  const ok = firmaValida(req, idStr);
  if (ok === false && MP_ENFORCE) {
    log('FIRMA', 'INVALIDA (pago ' + idStr + ') -> RECHAZADO');
    return;
  }

  if (pagosProcesados[idStr]) return;
  pagosProcesados[idStr] = Date.now();
  cantidadProcesados++;
  guardarTodo();

  if (cantidadProcesados > 5000) {
    pagosProcesados = {};
    cantidadProcesados = 0;
    rutina('LIMPIEZA', 'lista de pagos procesados vaciada');
  }

  axios.get('https://api.mercadopago.com/v1/payments/' + idStr, H)
    .then(function (p) {
      const d = p.data || {};

      if (d.status !== 'approved') {
        delete pagosProcesados[idStr];
        cantidadProcesados--;
        rutina('PENDIENTE', 'pago ' + idStr + ' estado ' + d.status);
        return;
      }

      const fecha = d.date_approved || d.date_created;
      const edadMin = fecha ? (Date.now() - new Date(fecha).getTime()) / 60000 : 0;
      if (edadMin > EDAD_MAX_PAGO_MIN) {
        log('VIEJO', 'pago ' + idStr + ' aprobado hace ' + Math.round(edadMin) + ' min -> NO acredita');
        return;
      }

      const ref = String(d.external_reference || '');
      if (ref && ref.indexOf('BPK-') !== 0) {
        log('AJENO', 'pago ' + idStr + ' ref=' + ref + ' -> NO acredita');
        return;
      }

      const monto = d.transaction_amount;
      const fichas = fichasPorMonto(monto);
      if (fichas > 0) {
        if (agregarFichas(fichas, 'pago $' + monto)) {
          registrarVenta(monto, fichas, 'qr', idStr);
        }
      } else {
        log('SIN COMBO', 'pago $' + monto + ' no coincide con ningun combo');
      }
      const caja = cajas.find(function (c) { return c.monto === monto; });
      if (caja && !qrCortado) crearOrden(caja);
    })
    .catch(function (e) {
      delete pagosProcesados[idStr];
      cantidadProcesados--;
      log('ERROR MP', 'consultando pago ' + idStr + ': ' + e.message);
    });
});

app.listen(process.env.PORT || 3000, '0.0.0.0', async function () {
  log('ARRANQUE', 'Server v6. BASE_URL=' + (BASE_URL || 'FALTA') +
      ' | persistencia=' + (persistenciaOk ? 'SI' : 'NO') +
      ' | avisos=' + (NTFY_TOPIC ? 'SI' : 'NO'));
  if (!MP_TOKEN) log('ALERTA', 'FALTA MP_ACCESS_TOKEN');
  if (!BASE_URL) log('ALERTA', 'FALTA RAILWAY_PUBLIC_DOMAIN');
  await descubrirCajas();
  await crearTodasLasOrdenes();
});
