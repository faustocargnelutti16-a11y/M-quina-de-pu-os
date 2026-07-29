const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
//  BPK / BeerPunch - servidor de creditos
//  Version endurecida: corta sola si algo se descontrola.
// ============================================================

// ⚠️ SEGURIDAD: este token quedo expuesto en GitHub. Cuando tu papa pueda hacer
// la verificacion facial en Mercado Pago, generen uno nuevo y carguenlo en Railway
// como variable de entorno MP_ACCESS_TOKEN. Por ahora, mientras no se pueda,
// el server usa este mismo token viejo para no dejar la maquina sin funcionar.
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-3958198239703250-041419-e0bb2ed7830d738e9761477def48ee89-458533297';
const USER_ID = 458533297;
const STORE_ID = 73977333;

// La clave de los endpoints es OPCIONAL. Si cargás BPK_CLAVE en Railway, esos
// endpoints la van a exigir. Si no la cargás, funcionan libres (decisión del dueño).
const CLAVE = process.env.BPK_CLAVE || null;

// El dominio se arma solo con el que Railway tenga asignado en este arranque.
// Si Railway regenera el dominio, alcanza con reiniciar el servicio.
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'https://m-quina-de-pu-os-production-b480.up.railway.app';

const H = { headers: { Authorization: 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json' } };

// ===== COMBOS =====
const COMBOS = [
  { match: 'beerlin',  monto: 2000,  fichas: 1 },
  { match: '3 tiros',  monto: 5500,  fichas: 3 },
  { match: '8 tiros',  monto: 10000, fichas: 8 },
  { match: '20 tiros', monto: 20000, fichas: 20 },
];

// ===== TOPES DE SEGURIDAD =====
const MAX_FICHAS_POR_EVENTO = 20;   // ningun evento suelta mas que el combo mas grande
const MAX_PENDING = 45;             // techo de la cola (2 packs de 20 juntos entran completos)
const VENTANA_MIN = 10;             // ventana del limite de caudal
const MAX_FICHAS_VENTANA = 100;     // fichas maximas por ventana antes de cortar
const EDAD_MAX_PAGO_MIN = 10;       // un pago mas viejo que esto NO acredita (mata reintentos viejos)
const COOLDOWN_GRATIS_MS = 8000;    // minimo entre dos /gratis

// ===== ESTADO =====
let pendingActivation = 0;
let cajas = [];
let bloqueado = false;
let motivoBloqueo = '';
let historialFichas = [];
let eventos = [];
let ultimoGratis = 0;
let ultimoPoll = 0;
const pagosProcesados = {};
let cantidadProcesados = 0;
const arranque = Date.now();

function hora() {
  return new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
}

function log(tipo, msg) {
  const linea = hora() + ' | ' + tipo + ' | ' + msg;
  eventos.push(linea);
  if (eventos.length > 200) eventos.shift();
  console.log(linea);
}

function claveOk(req) {
  if (!CLAVE) return true; // sin clave configurada, no se exige nada
  return String(req.query.clave || '') === CLAVE;
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
    log('CORTE', motivoBloqueo + '. Entrega detenida. Revisar /log y reactivar con /reanudar?clave=' + '***');
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

// Estado completo, legible desde el celular
app.get('/estado', function (req, res) {
  const desde = Date.now() - VENTANA_MIN * 60 * 1000;
  const ultimas = historialFichas.filter(function (t) { return t > desde; }).length;
  const segDesdePoll = ultimoPoll ? Math.round((Date.now() - ultimoPoll) / 1000) : -1;
  res.type('text/plain').send(
    'pendingActivation = ' + pendingActivation + '\n' +
    'bloqueado = ' + (bloqueado ? 'SI -> ' + motivoBloqueo : 'no') + '\n' +
    'fichas ultimos ' + VENTANA_MIN + ' min = ' + ultimas + ' (tope ' + MAX_FICHAS_VENTANA + ')\n' +
    'ultimo poll del Shelly = ' + (segDesdePoll < 0 ? 'nunca' : 'hace ' + segDesdePoll + ' s') + '\n' +
    'base_url = ' + BASE_URL + '\n' +
    'arranque = ' + new Date(arranque).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) + '\n' +
    'hora servidor = ' + hora()
  );
});

// Historial de eventos: aca se ve QUE esta inyectando fichas
app.get('/log', function (req, res) {
  res.type('text/plain').send(eventos.length ? eventos.slice().reverse().join('\n') : 'sin eventos todavia');
});

// El Shelly consulta aca. Devuelve SIEMPRE un numero (0 si no hay nada).
app.get('/shelly-poll', function (req, res) {
  ultimoPoll = Date.now();
  if (bloqueado) { res.type('text/plain').send('0'); return; }
  if (pendingActivation > 0) {
    const n = Math.min(pendingActivation, MAX_PENDING);
    pendingActivation = 0;
    log('ENTREGA', n + ' fichas entregadas al Shelly');
    res.type('text/plain').send(String(n));
  } else {
    res.type('text/plain').send('0');
  }
});

// Tiro gratis: ahora pide clave y tiene cooldown
app.get('/gratis', function (req, res) {
  if (!claveOk(req)) { log('RECHAZO', '/gratis sin clave valida'); return res.status(403).send('clave invalida'); }
  const ahora = Date.now();
  if (ahora - ultimoGratis < COOLDOWN_GRATIS_MS) {
    log('RECHAZO', '/gratis demasiado seguido');
    return res.send('esperá unos segundos antes de otra activación');
  }
  ultimoGratis = ahora;
  const ok = agregarFichas(1, 'gratis');
  res.send(ok ? 'Activado (1 ficha gratis)' : 'No se activó (sistema frenado o tope alcanzado)');
});

// Freno de emergencia desde el celular, sin cortar la luz
app.get('/pausa', function (req, res) {
  if (!claveOk(req)) return res.status(403).send('clave invalida');
  bloqueado = true;
  motivoBloqueo = 'pausa manual';
  pendingActivation = 0;
  log('PAUSA', 'freno manual activado');
  res.send('Sistema PAUSADO. No se entregan mas creditos hasta /reanudar');
});

app.get('/reanudar', function (req, res) {
  if (!claveOk(req)) return res.status(403).send('clave invalida');
  bloqueado = false;
  motivoBloqueo = '';
  historialFichas = [];
  pendingActivation = 0;
  log('REANUDAR', 'sistema reactivado a mano');
  res.send('Sistema REANUDADO, cola en 0');
});

app.get('/reset', function (req, res) {
  if (!claveOk(req)) return res.status(403).send('clave invalida');
  pendingActivation = 0;
  log('RESET', 'cola vaciada a mano');
  res.send('Cola en 0');
});

// ===== WEBHOOK DE MERCADO PAGO =====
app.post('/webhook', function (req, res) {
  res.sendStatus(200);
  const body = req.body || {};
  // Log de TODO lo que llega, sea del tipo que sea. Antes esto se ignoraba en
  // silencio si no era exactamente type=payment, y un aviso raro (por ejemplo
  // de un pago pagado desde otra billetera vía QR interoperable) desaparecia
  // sin dejar rastro. Ahora siempre queda registrado en /log.
  log('WEBHOOK RAW', JSON.stringify(body).slice(0, 300));

  const paymentId = body && body.data && body.data.id;
  if (!((body.type === 'payment' || body.topic === 'payment') && paymentId)) return;

  const idStr = String(paymentId);
  if (pagosProcesados[idStr]) { log('REPETIDO', 'pago ' + idStr + ' ya procesado, ignorado'); return; }
  pagosProcesados[idStr] = true;
  cantidadProcesados++;
  if (cantidadProcesados > 5000) {
    for (const k in pagosProcesados) delete pagosProcesados[k];
    cantidadProcesados = 0;
    log('LIMPIEZA', 'lista de pagos procesados vaciada');
  }

  axios.get('https://api.mercadopago.com/v1/payments/' + idStr, H)
    .then(function (p) {
      const d = p.data || {};

      if (d.status !== 'approved') {
        delete pagosProcesados[idStr];
        log('PENDIENTE', 'pago ' + idStr + ' estado ' + d.status + ', se reintentara cuando se apruebe');
        return;
      }

      // FILTRO 1: pagos viejos no acreditan (mata los reintentos acumulados de MP)
      const fecha = d.date_approved || d.date_created;
      const edadMin = fecha ? (Date.now() - new Date(fecha).getTime()) / 60000 : 0;
      if (edadMin > EDAD_MAX_PAGO_MIN) {
        log('VIEJO', 'pago ' + idStr + ' aprobado hace ' + Math.round(edadMin) + ' min -> NO acredita');
        return;
      }

      // FILTRO 2: solo pagos originados en las cajas de BPK
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
      log('ERROR MP', 'consultando pago ' + idStr + ': ' + e.message);
    });
});

app.listen(process.env.PORT || 3000, '0.0.0.0', async function () {
  log('ARRANQUE', 'Server running. BASE_URL=' + BASE_URL);
  await descubrirCajas();
  await crearTodasLasOrdenes();
});
