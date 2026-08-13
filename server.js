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
//  v4: volumen persistente + diagnostico de firma + hora 24h
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

// ===== AVISOS AL CELULAR =====
// Se manda un aviso si el Shelly deja de consultar. Usa ntfy.sh: gratis,
// sin cuenta. El "topic" es como una direccion secreta: quien la sepa,
// recibe los avisos. Por eso conviene que sea larga y rara.
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const ALERTA_SILENCIO_MS = 5 * 60 * 1000;  // 5 min sin poll = algo anda mal
let alertaShellyActiva = false;

// ===== ALMACENAMIENTO PERSISTENTE =====
// Railway borra todo lo que este en memoria al reiniciar. El volumen montado
// en /data sobrevive los reinicios. Si el volumen no existe todavia, el server
// sigue funcionando igual pero sin persistencia (y lo avisa en /estado).
const DATA_DIR = '/data';
const F_PAGOS = path.join(DATA_DIR, 'pagos.json');
const F_LOG = path.join(DATA_DIR, 'log.json');
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
  // Se agrupa: si entran varios eventos juntos, escribe una sola vez.
  if (guardadoPendiente) return;
  guardadoPendiente = true;
  setTimeout(function () {
    guardadoPendiente = false;
    try {
      fs.writeFileSync(F_PAGOS, JSON.stringify(pagosProcesados));
      fs.writeFileSync(F_LOG, JSON.stringify(eventos));
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
let ultimoGratis = 0;
let ultimoPoll = 0;
let pagosProcesados = leerJSON(F_PAGOS, {});
let cantidadProcesados = Object.keys(pagosProcesados).length;
const arranque = Date.now();

function hora() {
  return new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour12: false
  });
}

function log(tipo, msg) {
  const linea = hora() + ' | ' + tipo + ' | ' + msg;
  eventos.push(linea);
  if (eventos.length > 200) eventos.shift();
  console.log(linea);
  guardarTodo();
}

function claveOk(req) {
  if (!CLAVE) return true;
  return String(req.query.clave || '') === CLAVE;
}

// ===== AVISOS =====
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
    log('ERROR AVISO', e.message);
  });
}

// Vigila que el Shelly siga consultando. Si se queda mudo, avisa una sola vez
// (no spamea). Cuando vuelve, manda el aviso de que se recupero.
function vigilarShelly() {
  if (!ultimoPoll) return;  // todavia no consulto nunca desde el arranque
  const silencioMs = Date.now() - ultimoPoll;
  const silencioMin = Math.round(silencioMs / 60000);

  if (silencioMs > ALERTA_SILENCIO_MS && !alertaShellyActiva) {
    alertaShellyActiva = true;
    log('ALERTA', 'Shelly mudo hace ' + silencioMin + ' min, aviso enviado');
    avisar(
      'BPK - Shelly caido',
      'La maquina NO esta entregando creditos.\n' +
      'El Shelly no consulta hace ' + silencioMin + ' min.\n' +
      'Fichas en cola: ' + pendingActivation + '\n\n' +
      'Que corten la luz de la maquina 10 segundos y la prendan.',
      true
    );
    return;
  }

  if (silencioMs <= ALERTA_SILENCIO_MS && alertaShellyActiva) {
    alertaShellyActiva = false;
    log('ALERTA', 'Shelly recuperado');
    avisar('BPK - Shelly OK', 'El Shelly volvio. Maquina operativa de nuevo.', false);
  }
}

setInterval(vigilarShelly, 60 * 1000);

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
    log('CORTE', motivoBloqueo + '. Entrega detenida. Revisar /log y reactivar con /reanudar');
    return false;
  }

  for (let i = 0; i < nSeguro; i++) historialFichas.push(ahora);
  pendingActivation = Math.min(pendingActivation + nSeguro, MAX_PENDING);
  log('FICHAS', '+' + nSeguro + ' (' + origen + ') -> cola=' + pendingActivation);
  return true;
}

function horaArg() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return now.getHours();
}

function fichasPorMonto(monto) {
  const combo = COMBOS.find(function (c) { return c.monto === monto; });
  let fichas = combo ? combo.fichas : 0;
  const h = horaArg();
  if (monto === 2000 && h >= 17 && h < 21) fichas = 2; // happy hour, solo QR
  return fichas;
}

// ===== FIRMA DE MERCADO PAGO =====
// MP manda: x-signature: "ts=...,v1=..." y x-request-id.
// El manifest es: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
// OJO: la doc de MP dice que el id sale del PARAMETRO DE QUERY "data.id",
// no del body. Por eso se prueban las dos variantes.
function firmaValida(req, idBody) {
  if (!MP_SECRET) return null;
  try {
    const sig = String(req.headers['x-signature'] || '');
    const reqId = String(req.headers['x-request-id'] || '');
    if (!sig) {
      log('FIRMA', 'este aviso no trae x-signature (formato viejo de las cajas QR)');
      return false;
    }

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
      if (esperado === v1) {
        if (candidatos[i].etiqueta !== 'body') log('FIRMA', 'coincidio usando el id de ' + candidatos[i].etiqueta);
        return true;
      }
    }

    // No coincidio con ninguna variante: dejamos rastro para poder diagnosticar.
    log('DIAG FIRMA', 'idBody=' + idBody + ' idQuery=' + (idQuery || 'no vino') +
        ' reqId=' + (reqId || 'no vino') + ' ts=' + ts +
        ' v1_recibido=' + v1.slice(0, 12) + '...');
    return false;
  } catch (e) {
    log('ERROR FIRMA', e.message);
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
    log('CAJAS', cajas.map(function (c) { return c.nombre + ' $' + c.monto + ' (' + c.external_id + ')'; }).join(' | '));
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

async function crearTodasLasOrdenes() {
  if (cajas.length === 0) await descubrirCajas();
  for (let i = 0; i < cajas.length; i++) await crearOrden(cajas[i]);
  log('ORDENES', 'activas en ' + cajas.length + ' cajas');
}

setInterval(crearTodasLasOrdenes, 3 * 60 * 1000);

// ===== ENDPOINTS =====

app.get('/', function (req, res) { res.send('BPK server OK'); });

app.get('/cajas', async function (req, res) {
  await descubrirCajas();
  res.json(cajas);
});

app.get('/setup', async function (req, res) {
  await descubrirCajas();
  await crearTodasLasOrdenes();
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
    'fichas ultimos ' + VENTANA_MIN + ' min = ' + ultimas + ' (tope ' + MAX_FICHAS_VENTANA + ')\n' +
    'ultimo poll del Shelly = ' + (segDesdePoll < 0 ? 'nunca' : 'hace ' + segDesdePoll + ' s') + '\n' +
    'base_url = ' + (BASE_URL || '*** FALTA RAILWAY_PUBLIC_DOMAIN ***') + '\n' +
    'token MP = ' + (MP_TOKEN ? 'cargado' : '*** FALTA MP_ACCESS_TOKEN ***') + '\n' +
    'firma MP = ' + (!MP_SECRET ? 'sin secreto' : (MP_ENFORCE ? 'ENFORCE (bloquea)' : 'modo prueba (solo loguea)')) + '\n' +
    'memoria persistente = ' + (persistenciaOk ? 'SI (volumen /data)' : 'NO -> se pierde todo al reiniciar') + '\n' +
    'avisos al celular = ' + (NTFY_TOPIC ? 'activados' : '*** FALTA NTFY_TOPIC ***') + '\n' +
    'pagos recordados = ' + cantidadProcesados + '\n' +
    'arranque = ' + new Date(arranque).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false }) + '\n' +
    'hora servidor = ' + hora()
  );
});

app.get('/log', function (req, res) {
  res.type('text/plain').send(eventos.length ? eventos.slice().reverse().join('\n') : 'sin eventos todavia');
});

// Sirve para comprobar que los avisos llegan al celular.
app.get('/probar-aviso', function (req, res) {
  if (!NTFY_TOPIC) return res.send('No hay NTFY_TOPIC configurado en Railway');
  avisar('BPK - Prueba', 'Si estas leyendo esto, los avisos funcionan.', false);
  log('AVISO', 'aviso de prueba enviado');
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

app.get('/gratis', function (req, res) {
  if (!claveOk(req)) { log('RECHAZO', '/gratis sin clave valida'); return res.status(403).send('clave invalida'); }
  const ahora = Date.now();
  if (ahora - ultimoGratis < COOLDOWN_GRATIS_MS) {
    log('RECHAZO', '/gratis demasiado seguido');
    return res.send('espera unos segundos antes de otra activacion');
  }
  ultimoGratis = ahora;
  const ok = agregarFichas(1, 'gratis');
  res.send(ok ? 'Activado (1 ficha gratis)' : 'No se activo (sistema frenado o tope alcanzado)');
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

// ===== WEBHOOK DE MERCADO PAGO =====
app.post('/webhook', function (req, res) {
  res.sendStatus(200);
  const body = req.body || {};

  if (body.topic === 'merchant_order') return;

  log('WEBHOOK RAW', JSON.stringify(body).slice(0, 300));

  const paymentId = (body && body.data && body.data.id) || body.resource;
  if (!((body.type === 'payment' || body.topic === 'payment') && paymentId)) return;

  const idStr = String(paymentId);

  const ok = firmaValida(req, idStr);
  if (ok === null) {
    log('FIRMA', 'sin MP_WEBHOOK_SECRET cargado, no se valida');
  } else if (ok === true) {
    log('FIRMA', 'valida (pago ' + idStr + ')');
  } else {
    log('FIRMA', 'INVALIDA (pago ' + idStr + ')' + (MP_ENFORCE ? ' -> RECHAZADO' : ' -> modo prueba, se deja pasar'));
    if (MP_ENFORCE) return;
  }

  if (pagosProcesados[idStr]) { log('REPETIDO', 'pago ' + idStr + ' ya procesado, ignorado'); return; }
  pagosProcesados[idStr] = Date.now();
  cantidadProcesados++;
  guardarTodo();

  if (cantidadProcesados > 5000) {
    pagosProcesados = {};
    cantidadProcesados = 0;
    log('LIMPIEZA', 'lista de pagos procesados vaciada');
  }

  axios.get('https://api.mercadopago.com/v1/payments/' + idStr, H)
    .then(function (p) {
      const d = p.data || {};

      if (d.status !== 'approved') {
        delete pagosProcesados[idStr];
        cantidadProcesados--;
        log('PENDIENTE', 'pago ' + idStr + ' estado ' + d.status + ', se reintentara cuando se apruebe');
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
        log('AJENO', 'pago ' + idStr + ' ref=' + ref + ' no es de BPK -> NO acredita');
        return;
      }

      const monto = d.transaction_amount;
      const fichas = fichasPorMonto(monto);
      if (fichas > 0) {
        agregarFichas(fichas, 'pago $' + monto + ' id=' + idStr);
      } else {
        log('SIN COMBO', 'pago $' + monto + ' no coincide con ningun combo');
      }
      const caja = cajas.find(function (c) { return c.monto === monto; });
      if (caja) crearOrden(caja);
    })
    .catch(function (e) {
      delete pagosProcesados[idStr];
      cantidadProcesados--;
      log('ERROR MP', 'consultando pago ' + idStr + ': ' + e.message);
    });
});

app.listen(process.env.PORT || 3000, '0.0.0.0', async function () {
  log('ARRANQUE', 'Server running. BASE_URL=' + (BASE_URL || 'FALTA') +
      ' | persistencia=' + (persistenciaOk ? 'SI' : 'NO') +
      ' | pagos recordados=' + cantidadProcesados);
  if (!MP_TOKEN) log('ALERTA', 'FALTA MP_ACCESS_TOKEN: no va a poder hablar con Mercado Pago');
  if (!BASE_URL) log('ALERTA', 'FALTA RAILWAY_PUBLIC_DOMAIN: no se pueden crear ordenes');
  await descubrirCajas();
  await crearTodasLasOrdenes();
});

      
