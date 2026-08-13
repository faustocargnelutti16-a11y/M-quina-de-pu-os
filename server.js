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
let avisoOlvidoEnviado = false;

let qrCortado = false;
let mpFallando = false;

// ===== ALMACENAMIENTO PERSISTENTE =====
const DATA_DIR = '/data';
const F_PAGOS = path.join(DATA_DIR, 'pagos.json');
const F_LOG = path.join(DATA_DIR, 'log.json');
const F_VENTAS = path.join(DATA_DIR, 'ventas.json');
// Historial de cuando la maquina se apago y se prendio. Sirve para ver a que
// hora la estan apagando de verdad, que no siempre coincide con el cierre.
const F_ENCENDIDOS = path.join(DATA_DIR, 'encendidos.json');
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

let encendidos = [];

function anotarEncendido(tipo, detalle) {
  encendidos.push({ ts: Date.now(), tipo: tipo, detalle: detalle || '' });
  const limite = Date.now() - 60 * 24 * 60 * 60 * 1000;
  encendidos = encendidos.filter(function (e) { return e.ts > limite; });
  if (persistenciaOk) {
    try { fs.writeFileSync(F_ENCENDIDOS, JSON.stringify(encendidos)); } catch (e) {}
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
const eventosRecuperados = eventos.length;
let ventas = leerJSON(F_VENTAS, []);
let ultimoGratis = 0;
let ultimoPoll = 0;
let pagosProcesados = leerJSON(F_PAGOS, {});
encendidos = leerJSON(F_ENCENDIDOS, []);
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

// Horarios reales de Beerlin:
//   domingo a jueves  17:00 a 3:30
//   viernes y sabado  17:00 a 4:30
// La madrugada pertenece a la noche del dia anterior.
const HORA_ABRE = 17;

function ahoraArg() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return { dia: d.getDay(), minutos: d.getHours() * 60 + d.getMinutes() };
}

function minutoDeCierre() {
  const t = ahoraArg();
  const nocheDe = (t.dia + 6) % 7;              // de que dia es esta madrugada
  return (nocheDe === 5 || nocheDe === 6) ? (4 * 60 + 30) : (3 * 60 + 30);
}

function enHorarioDeBar() {
  const t = ahoraArg();
  if (t.minutos >= HORA_ABRE * 60) return true;  // de las 17 en adelante
  return t.minutos < minutoDeCierre();           // madrugada, hasta que cierran
}

// Margen despues de abrir: si a esta hora la maquina sigue apagada, alguien
// se olvido de prenderla y se estan perdiendo ventas sin que nadie lo note.
function yaDeberiaEstarPrendida() {
  const t = ahoraArg();
  if (t.minutos >= (HORA_ABRE + 1) * 60) return true;
  return t.minutos < minutoDeCierre();
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
    porCombo: porCombo,
    paraBar: Math.round(total * PORCENTAJE_BAR / 100),
    ventas: delDia
  };
}

// Devuelve las ultimas n jornadas (la de hoy incluida) para ver la racha.
function jornadasPrevias(n) {
  const inicioHoy = inicioJornada();
  const dia = 24 * 60 * 60 * 1000;
  const salida = [];
  for (let i = 0; i < n; i++) {
    const desde = inicioHoy - i * dia;
    const hasta = desde + dia;
    const v = ventas.filter(function (x) { return x.ts >= desde && x.ts < hasta; });
    salida.push({
      desde: desde,
      total: v.reduce(function (a, x) { return a + x.monto; }, 0),
      fichas: v.reduce(function (a, x) { return a + x.fichas; }, 0),
      ops: v.length
    });
  }
  return salida;
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
  let ok = 0;
  for (let i = 0; i < cajas.length; i++) {
    if (await crearOrden(cajas[i])) ok++;
  }
  rutina('ORDENES', 'activas en ' + ok + '/' + cajas.length + ' cajas');

  // Si el Shelly anda pero MP no deja crear ordenes, el QR no sirve aunque
  // la maquina este perfecta: el QR no sirve aunque todo lo demas ande.
  const fallaAhora = (cajas.length === 0 || ok === 0);
  if (fallaAhora && !mpFallando) {
    mpFallando = true;
    log('MP CAIDO', 'no se pudo crear ninguna orden -> el QR no va a funcionar');
    if (shellyVivo()) {
      avisar('BPK - Mercado Pago no responde',
        'La maquina funciona bien pero el QR no se puede generar.\n' +
        'Que cobren por el billetero mientras tanto.\n' +
        'El combo de 3 tiros no se puede vender hasta que vuelva.', enHorarioDeBar());
    }
  }
  if (!fallaAhora && mpFallando) {
    mpFallando = false;
    log('MP OK', 'las ordenes se crean de nuevo');
  }
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
    // Si el bar esta cerrado, que la maquina este apagada es lo esperable.
    // Se registra en el log pero no suena el telefono: un aviso que llega
    // todas las noches deja de significar algo.
    anotarEncendido('apagada', 'silencio de ' + silencioMin + ' min');
    if (!enHorarioDeBar()) {
      alertaShellyActiva = true;
      log('MAQUINA APAGADA', 'dejo de responder (bar cerrado, no se avisa al celular)');
    } else {
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
        true
      );
    }
  }

  if (!caido && alertaShellyActiva) {
    alertaShellyActiva = false;
    avisoOlvidoEnviado = false;
    anotarEncendido('prendida', '');
    if (enHorarioDeBar()) {
      avisar('BPK - Maquina OK', 'El Shelly volvio y el QR esta activo de nuevo.', false);
    } else {
      log('SHELLY OK', 'volvio, pero el bar esta cerrado: no se avisa');
    }
  }

  // El bar ya abrio hace rato y la maquina sigue muerta. Nadie se dio cuenta.
  if (caido && yaDeberiaEstarPrendida() && !avisoOlvidoEnviado) {
    avisoOlvidoEnviado = true;
    log('MAQUINA APAGADA', 'el bar ya abrio y la maquina sigue sin dar senal');
    avisar(
      'BPK - La maquina sigue apagada',
      'Ya es horario de bar y la maquina no da senal hace ' + silencioMin + ' min.\n' +
      'Puede ser que se olvidaron de prenderla.\n\n' +
      'Mientras siga asi no entra plata por QR.',
      true
    );
  }
}

setInterval(vigilarShelly, 30 * 1000);

// ===== RESUMEN SEMANAL =====
// Todos los lunes al mediodia llega al celular como cerro la semana.
// Se guarda cual fue el ultimo enviado para no repetirlo si el server reinicia.
const F_SEMANA = path.join(DATA_DIR, 'semana.json');
let ultimaSemanaEnviada = leerJSON(F_SEMANA, { marca: '' });

function marcaDeSemana() {
  const inicio = inicioJornada();
  const dia = 24 * 60 * 60 * 1000;
  return String(Math.floor(inicio / (7 * dia)));
}

function resumenSemanal() {
  const dia = 24 * 60 * 60 * 1000;
  const hasta = inicioJornada();
  const desde = hasta - 7 * dia;
  const v = ventas.filter(function (x) { return x.ts >= desde && x.ts < hasta; });

  const total = v.reduce(function (a, x) { return a + x.monto; }, 0);
  const fichas = v.reduce(function (a, x) { return a + x.fichas; }, 0);

  const porNoche = {};
  v.forEach(function (x) {
    // ubicar en que noche de la semana cayo
    let k = Math.floor((x.ts - desde) / dia);
    if (!porNoche[k]) porNoche[k] = 0;
    porNoche[k] += x.monto;
  });
  let mejorK = null;
  Object.keys(porNoche).forEach(function (k) {
    if (mejorK === null || porNoche[k] > porNoche[mejorK]) mejorK = k;
  });

  const porCombo = {};
  v.forEach(function (x) {
    porCombo[x.monto] = (porCombo[x.monto] || 0) + 1;
  });
  let comboTop = null;
  Object.keys(porCombo).forEach(function (m) {
    if (comboTop === null || porCombo[m] > porCombo[comboTop]) comboTop = m;
  });

  return {
    desde: desde, hasta: hasta, total: total, fichas: fichas,
    operaciones: v.length,
    paraBar: Math.round(total * PORCENTAJE_BAR / 100),
    mejorNoche: mejorK === null ? null : { fecha: desde + Number(mejorK) * dia, total: porNoche[mejorK] },
    comboTop: comboTop,
    comboTopCant: comboTop ? porCombo[comboTop] : 0
  };
}

function revisarResumenSemanal() {
  const arg = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  // lunes = 1, y despues del mediodia para que la jornada del domingo ya cerro
  if (arg.getDay() !== 1 || arg.getHours() < 12) return;

  const marca = marcaDeSemana();
  if (ultimaSemanaEnviada.marca === marca) return;

  const s = resumenSemanal();
  ultimaSemanaEnviada = { marca: marca };
  if (persistenciaOk) {
    try { fs.writeFileSync(F_SEMANA, JSON.stringify(ultimaSemanaEnviada)); } catch (e) {}
  }

  const f = function (ts) {
    return new Date(ts).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit' });
  };

  let texto =
    'Semana del ' + f(s.desde) + ' al ' + f(s.hasta - 1) + '\n\n' +
    'TOTAL          $' + s.total.toLocaleString('es-AR') + '\n' +
    'Tiros            ' + s.fichas + '\n' +
    'Ventas           ' + s.operaciones + '\n\n' +
    'Para el bar    $' + s.paraBar.toLocaleString('es-AR') + '\n' +
    'Para vos       $' + (s.total - s.paraBar).toLocaleString('es-AR') + '\n';

  if (s.mejorNoche) {
    texto += '\nMejor noche: ' + f(s.mejorNoche.fecha) + ' con $' + s.mejorNoche.total.toLocaleString('es-AR') + '\n';
  }
  if (s.comboTop) {
    texto += 'Combo mas vendido: $' + Number(s.comboTop).toLocaleString('es-AR') + ' (' + s.comboTopCant + ' veces)\n';
  }
  if (s.operaciones === 0) {
    texto = 'Semana del ' + f(s.desde) + ' al ' + f(s.hasta - 1) + '\n\nNo hubo ventas por QR esta semana.\n(No cuenta lo que entro por el billetero.)';
  }

  log('RESUMEN', 'resumen semanal enviado: $' + s.total);
  avisar('BPK - Resumen de la semana', texto, false);
}

setInterval(revisarResumenSemanal, 10 * 60 * 1000);

// Endpoint para verlo cuando quieras, sin esperar al lunes.
app.get('/semana', function (req, res) {
  const s = resumenSemanal();
  const f = function (ts) {
    return new Date(ts).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit' });
  };
  let txt = 'SEMANA DEL ' + f(s.desde) + ' AL ' + f(s.hasta - 1) + '\n';
  txt += '==============================\n\n';
  txt += 'TOTAL        $' + s.total.toLocaleString('es-AR') + '\n';
  txt += 'Tiros        ' + s.fichas + '\n';
  txt += 'Ventas       ' + s.operaciones + '\n\n';
  txt += 'Para el bar  $' + s.paraBar.toLocaleString('es-AR') + '\n';
  txt += 'Para vos     $' + (s.total - s.paraBar).toLocaleString('es-AR') + '\n';
  if (s.mejorNoche) txt += '\nMejor noche  ' + f(s.mejorNoche.fecha) + '  $' + s.mejorNoche.total.toLocaleString('es-AR') + '\n';
  if (s.comboTop) txt += 'Combo top    $' + Number(s.comboTop).toLocaleString('es-AR') + ' (' + s.comboTopCant + ')\n';
  txt += '\nNo incluye lo que entra por el billetero.\n';
  res.type('text/plain').send(txt);
});

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
    'QR de Mercado Pago = ' + (qrCortado ? 'CORTADO (Shelly caido)' : (mpFallando ? 'FALLANDO (MP no crea ordenes)' : 'activo')) + '\n' +
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

// ============================================================
//  CUPONES / ACTIVACIONES
//  Cupon impreso con QR -> el cliente escanea -> pagina con boton ->
//  toca "Activar" -> sale 1 tiro gratis.
//  El codigo se quema recien al tocar el boton (no al escanear), asi el
//  preview de WhatsApp no lo gasta y el cliente entiende que tiene que
//  estar parado en la maquina.
// ============================================================

const F_CUPONES = path.join(DATA_DIR, 'cupones.json');
const F_CANJES = path.join(DATA_DIR, 'canjes.json');
const VENTANA_CONVERSION_MS = 15 * 60 * 1000;  // margen para contar si compro despues
const FICHAS_POR_CUPON = 1;

let cupones = leerJSON(F_CUPONES, {});   // { CODIGO: {lote, usado: ts|null} }
let canjes = leerJSON(F_CANJES, []);     // [{ts, codigo, lote, convertido:false}]

function guardarCupones() {
  if (!persistenciaOk) return;
  try {
    fs.writeFileSync(F_CUPONES, JSON.stringify(cupones));
    fs.writeFileSync(F_CANJES, JSON.stringify(canjes));
  } catch (e) {
    rutina('ERROR', 'guardando cupones: ' + e.message);
  }
}

// Sin letras ni numeros que se confundan al leerlos de un papel:
// nada de O/0 ni I/1. Todo en mayuscula para que el QR salga mas chico.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function codigoNuevo(largo) {
  let c = '';
  const bytes = crypto.randomBytes(largo);
  for (let i = 0; i < largo; i++) c += ALFABETO[bytes[i] % ALFABETO.length];
  return c;
}

function generarLote(lote, cantidad) {
  const nuevos = [];
  let intentos = 0;
  while (nuevos.length < cantidad && intentos < cantidad * 50) {
    intentos++;
    const c = codigoNuevo(6);
    if (cupones[c]) continue;
    cupones[c] = { lote: lote, usado: null };
    nuevos.push(c);
  }
  guardarCupones();
  return nuevos;
}

function statsCupones(lote) {
  const codigos = Object.keys(cupones).filter(function (c) {
    return !lote || cupones[c].lote === lote;
  });
  const usados = codigos.filter(function (c) { return cupones[c].usado; });
  const desde = inicioJornada();
  const hoy = canjes.filter(function (x) { return x.ts >= desde; });
  const convertidos = canjes.filter(function (x) { return x.convertido; });
  return {
    total: codigos.length,
    usados: usados.length,
    disponibles: codigos.length - usados.length,
    canjesHoy: hoy.length,
    canjesTotal: canjes.length,
    convertidos: convertidos.length,
    conversion: canjes.length ? Math.round(convertidos.length * 100 / canjes.length) : 0
  };
}

// Cuando entra un pago, si hubo un canje hace poco lo contamos como que el
// cupon funciono: el tipo probo gratis y despues compro. Es la unica forma
// de saber si vale la pena seguir imprimiendo cupones.
function marcarConversion() {
  const limite = Date.now() - VENTANA_CONVERSION_MS;
  for (let i = canjes.length - 1; i >= 0; i--) {
    if (canjes[i].ts < limite) break;
    if (!canjes[i].convertido) {
      canjes[i].convertido = true;
      log('CUPON CONVIRTIO', 'un canje de hace ' + Math.round((Date.now() - canjes[i].ts) / 60000) + ' min termino en compra');
      guardarCupones();
      return;
    }
  }
}

function paginaCupon(titulo, cuerpo, color, boton) {
  return '<!DOCTYPE html><html lang="es"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>BeerPunch</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link href="https://fonts.googleapis.com/css2?family=Anton&display=swap" rel="stylesheet">' +
    '<style>' +
    'body{margin:0;min-height:100vh;background:#1A0E0E;color:#EDE4D8;' +
    'font-family:-apple-system,system-ui,sans-serif;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;padding:28px;text-align:center}' +
    '.marca{font-family:Anton,Impact,sans-serif;font-size:24px;letter-spacing:.08em;' +
    'text-transform:uppercase;color:#7A2E2E;margin-bottom:26px}' +
    'h1{font-family:Anton,Impact,sans-serif;font-size:44px;line-height:1.05;margin:0 0 16px;' +
    'text-transform:uppercase;color:' + color + '}' +
    'p{font-size:17px;line-height:1.6;margin:0 0 12px;max-width:340px}' +
    '.chico{font-size:14px;color:#9A8378;margin-top:22px;max-width:320px}' +
    'button{font-family:Anton,Impact,sans-serif;font-size:24px;letter-spacing:.06em;' +
    'text-transform:uppercase;background:#FFB020;color:#1A0E0E;border:0;border-radius:14px;' +
    'padding:22px 44px;margin-top:26px;width:100%;max-width:340px;cursor:pointer}' +
    'button:disabled{opacity:.5}' +
    '</style></head><body>' +
    '<div class="marca">BeerPunch · Beerlin</div>' +
    '<h1>' + titulo + '</h1>' + cuerpo + (boton || '') +
    '</body></html>';
}

// Paso 1: el cliente escanea. Esto NO gasta el cupon.
// Se aceptan varias direcciones porque los cupones impresos de lotes viejos
// pueden apuntar a un camino distinto. Todas hacen lo mismo.
function paginaEscaneo(req, res) {
  const cod = String(req.params.codigo || '').toUpperCase();
  const cup = cupones[cod];

  if (!cup) {
    return res.type('text/html').send(paginaCupon(
      'Cupón no válido',
      '<p>Este código no existe. Puede estar mal escaneado.</p>' +
      '<p class="chico">Pedile otro cupón al mozo.</p>',
      '#D8443C'));
  }

  if (cup.usado) {
    const cuando = new Date(cup.usado).toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires', hour12: false,
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return res.type('text/html').send(paginaCupon(
      'Cupón ya usado',
      '<p>Este cupón se activó el ' + cuando + '.</p>' +
      '<p class="chico">Cada cupón sirve una sola vez.</p>',
      '#D8443C'));
  }

  if (!enHorarioDeBar()) {
    return res.type('text/html').send(paginaCupon(
      'Fuera de horario',
      '<p>Los cupones se activan mientras el bar está abierto.</p>' +
      '<p class="chico">Guardá el cupón: sigue estando disponible.</p>',
      '#E08A2B'));
  }

  if (!shellyVivo() || bloqueado) {
    return res.type('text/html').send(paginaCupon(
      'La máquina no está disponible',
      '<p>Ahora mismo la máquina no puede entregar tiros.</p>' +
      '<p><b>No gastamos tu cupón.</b> Guardalo y probá en un rato.</p>' +
      '<p class="chico">Avisale al mozo así lo revisan.</p>',
      '#E08A2B'));
  }

  // El boton vuelve por el mismo camino por el que entro el cliente.
  const rutaBase = '/' + String(req.path || '/c/').split('/')[1];

  // El boton manda un POST por JavaScript. Los bots que hacen preview de los
  // links no ejecutan JavaScript, asi que no pueden quemar el cupon.
  const boton =
    '<button id="b" onclick="activar()">Activar mi tiro</button>' +
    '<p class="chico">Tocá el botón solo cuando estés parado en la máquina.<br>' +
    'El tiro sale enseguida y no se puede guardar para después.</p>' +
    '<script>' +
    'function activar(){' +
    'var b=document.getElementById("b");b.disabled=true;b.textContent="Activando...";' +
    'fetch("' + rutaBase + '/' + cod + '/activar",{method:"POST"})' +
    '.then(function(r){return r.text()})' +
    '.then(function(t){document.open();document.write(t);document.close();})' +
    '.catch(function(){b.disabled=false;b.textContent="Reintentar";});' +
    '}</script>';

  res.type('text/html').send(paginaCupon(
    '1 tiro gratis',
    '<p>Tenés un tiro de regalo en la máquina de boxeo.</p>',
    '#FFB020', boton));
}

const RUTAS_CUPON = ['/c/:codigo', '/a/:codigo', '/cupon/:codigo', '/activar/:codigo'];
RUTAS_CUPON.forEach(function (r) { app.get(r, paginaEscaneo); });

// Paso 2: el cliente toca el boton. Recien aca se gasta.
function activarCupon(req, res) {
  const cod = String(req.params.codigo || '').toUpperCase();
  const cup = cupones[cod];

  if (!cup) {
    return res.type('text/html').send(paginaCupon('Cupón no válido',
      '<p>Este código no existe.</p>', '#D8443C'));
  }

  if (cup.usado) {
    return res.type('text/html').send(paginaCupon('Cupón ya usado',
      '<p>Este cupón se activó hace un rato.</p>', '#D8443C'));
  }

  if (!enHorarioDeBar()) {
    return res.type('text/html').send(paginaCupon('Fuera de horario',
      '<p>Guardá el cupón, no se gastó.</p>', '#E08A2B'));
  }

  if (!shellyVivo() || bloqueado) {
    return res.type('text/html').send(paginaCupon('La máquina no está disponible',
      '<p><b>No gastamos tu cupón.</b> Guardalo y probá en un rato.</p>', '#E08A2B'));
  }

  // Se marca usado ANTES de intentar entregar. Si dos personas tocan el boton
  // al mismo tiempo con el mismo codigo, solo una pasa de aca.
  cup.usado = Date.now();
  guardarCupones();

  const ok = agregarFichas(FICHAS_POR_CUPON, 'CUPON ' + cod);

  if (!ok) {
    // No se pudo entregar: devolvemos el cupon a disponible. El cliente no
    // se queda sin nada por un problema nuestro.
    cup.usado = null;
    guardarCupones();
    log('CUPON DEVUELTO', cod + ' no se pudo entregar, vuelve a estar disponible');
    return res.type('text/html').send(paginaCupon('No se pudo activar',
      '<p><b>Tu cupón sigue sirviendo.</b> Probá de nuevo en un minuto.</p>' +
      '<p class="chico">Si sigue igual, avisale al mozo.</p>', '#E08A2B'));
  }

  canjes.push({ ts: Date.now(), codigo: cod, lote: cup.lote, convertido: false });
  const limite = Date.now() - 90 * 24 * 60 * 60 * 1000;
  canjes = canjes.filter(function (x) { return x.ts > limite; });
  guardarCupones();
  log('CUPON', cod + ' (lote ' + cup.lote + ') canjeado');

  res.type('text/html').send(paginaCupon('¡Listo!',
    '<p>Tu tiro ya está cargado en la máquina.</p>' +
    '<p class="chico">Si no lo ves en unos segundos, avisale al mozo.</p>',
    '#4E9B5F'));
}

RUTAS_CUPON.forEach(function (r) { app.post(r + '/activar', activarCupon); });

// ===== ADMINISTRACION DE CUPONES =====

app.get('/cupones', function (req, res) {
  const s = statsCupones(req.query.lote);
  const lotes = {};
  Object.keys(cupones).forEach(function (c) {
    const l = cupones[c].lote;
    if (!lotes[l]) lotes[l] = { total: 0, usados: 0 };
    lotes[l].total++;
    if (cupones[c].usado) lotes[l].usados++;
  });

  let txt = 'CUPONES\n=======================\n\n';
  txt += 'Impresos        ' + s.total + '\n';
  txt += 'Usados          ' + s.usados + '\n';
  txt += 'Sin usar        ' + s.disponibles + '\n\n';
  txt += 'Canjes hoy      ' + s.canjesHoy + '\n';
  txt += 'Canjes total    ' + s.canjesTotal + '\n\n';
  txt += 'CONVIRTIERON EN COMPRA\n';
  txt += '  ' + s.convertidos + ' de ' + s.canjesTotal + '  (' + s.conversion + '%)\n';
  txt += '  = cuantos compraron un tiro dentro de los 15 min\n';
  txt += '    despues de usar el cupon\n\n';
  txt += 'POR LOTE\n';
  Object.keys(lotes).sort().forEach(function (l) {
    txt += '  ' + l + ': ' + lotes[l].usados + '/' + lotes[l].total + ' usados\n';
  });
  if (Object.keys(lotes).length === 0) txt += '  todavia no hay cupones cargados\n';
  txt += '\nPara crear un lote nuevo:\n';
  txt += '  /cupones/generar?lote=L3&cantidad=72&clave=' + (CLAVE || '') + '\n';
  res.type('text/plain').send(txt);
});

// Importar cupones que YA fueron impresos con otro sistema. Los codigos
// vienen separados por coma. No pisa los que ya existen.
app.get('/cupones/importar', function (req, res) {
  if (!claveOk(req)) return res.status(403).send('clave invalida');
  const lote = String(req.query.lote || '').trim().toUpperCase();
  const crudo = String(req.query.codigos || '').toUpperCase();
  if (!lote) return res.status(400).send('Falta el lote. Ej: /cupones/importar?lote=L2&codigos=AAA111,BBB222&clave=...');

  const lista = crudo.split(/[,\s]+/).map(function (c) { return c.trim(); }).filter(Boolean);
  if (lista.length === 0) return res.status(400).send('No mandaste ningun codigo.');

  let nuevos = 0, repetidos = 0;
  const yaEstaban = [];
  lista.forEach(function (c) {
    if (cupones[c]) { repetidos++; yaEstaban.push(c); return; }
    cupones[c] = { lote: lote, usado: null };
    nuevos++;
  });
  guardarCupones();
  log('CUPONES', 'lote ' + lote + ': ' + nuevos + ' importados');

  let txt = 'IMPORTACION DEL LOTE ' + lote + '\n\n';
  txt += 'Codigos recibidos   ' + lista.length + '\n';
  txt += 'Cargados            ' + nuevos + '\n';
  txt += 'Ya existian         ' + repetidos + '\n';
  if (yaEstaban.length) txt += '\nRepetidos: ' + yaEstaban.join(', ') + '\n';
  txt += '\nPara verificar, abri:\n' + (BASE_URL || '') + '/cupones\n';
  res.type('text/plain').send(txt);
});

app.get('/cupones/generar', function (req, res) {
  if (!claveOk(req)) return res.status(403).send('clave invalida');
  const lote = String(req.query.lote || '').trim().toUpperCase();
  const cantidad = Math.min(parseInt(req.query.cantidad, 10) || 0, 500);
  if (!lote) return res.status(400).send('Falta el nombre del lote. Ej: /cupones/generar?lote=L3&cantidad=72');
  if (cantidad < 1) return res.status(400).send('Falta la cantidad. Ej: /cupones/generar?lote=L3&cantidad=72');

  const nuevos = generarLote(lote, cantidad);
  log('CUPONES', 'lote ' + lote + ': ' + nuevos.length + ' cupones generados');
  res.type('text/plain').send(
    'Lote ' + lote + ': ' + nuevos.length + ' cupones creados.\n\n' +
    'Para imprimirlos, abri:\n' +
    (BASE_URL || '') + '/cupones/lista?lote=' + lote + '\n'
  );
});

// Las direcciones salen en MAYUSCULA a proposito: un QR con solo mayusculas
// y numeros usa un modo mas compacto y queda mas chico, o sea mas facil de
// escanear cuando esta impreso en un cupon de papel.
app.get('/cupones/lista', function (req, res) {
  const lote = String(req.query.lote || '').trim().toUpperCase();
  const soloLibres = String(req.query.libres || '') === '1';
  const base = (BASE_URL || '').toUpperCase().replace('HTTPS://', 'https://');

  const codigos = Object.keys(cupones)
    .filter(function (c) { return !lote || cupones[c].lote === lote; })
    .filter(function (c) { return !soloLibres || !cupones[c].usado; })
    .sort();

  if (codigos.length === 0) {
    return res.type('text/plain').send('No hay cupones para ese lote.');
  }
  res.type('text/plain').send(codigos.map(function (c) {
    return base + '/C/' + c;
  }).join('\n'));
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

// ===== PANEL DEL DUENIO =====
app.get('/admin', function (req, res) {
  const vivo = shellyVivo();
  const segDesdePoll = ultimoPoll ? Math.round((Date.now() - ultimoPoll) / 1000) : -1;
  const r = resumenJornada();
  const historial = jornadasPrevias(7);
  const c = CLAVE ? ('?clave=' + encodeURIComponent(CLAVE)) : '';
  const cAmp = CLAVE ? ('&clave=' + encodeURIComponent(CLAVE)) : '';

  let estadoColor, estadoTexto;
  if (bloqueado) { estadoColor = 'rojo'; estadoTexto = 'FRENADO — ' + motivoBloqueo; }
  else if (!vivo) { estadoColor = 'rojo'; estadoTexto = 'MAQUINA DESCONECTADA — QR cortado'; }
  else if (qrCortado || mpFallando) { estadoColor = 'ambar'; estadoTexto = 'QR SIN SERVICIO — solo billetero'; }
  else { estadoColor = 'verde'; estadoTexto = 'EN LINEA — vista hace ' + segDesdePoll + ' s'; }

  const maxHist = Math.max.apply(null, historial.map(function (h) { return h.total; }).concat([1]));

  let filasHist = '';
  historial.forEach(function (h, i) {
    const d = new Date(h.desde);
    const ancho = Math.round((h.total / maxHist) * 100);
    filasHist +=
      '<div class="hist-fila">' +
      '<span class="hist-dia">' + (i === 0 ? 'hoy' : d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit' })) + '</span>' +
      '<span class="hist-barra"><i style="width:' + ancho + '%"></i></span>' +
      '<span class="hist-monto">' + (h.total ? '$' + h.total.toLocaleString('es-AR') : '—') + '</span>' +
      '</div>';
  });

  let filasCombo = '';
  const ordenCombos = [2000, 5500, 10000, 20000];
  ordenCombos.forEach(function (m) {
    const k = '$' + m;
    const dato = r.porCombo[k];
    filasCombo +=
      '<div class="combo">' +
      '<span class="combo-precio">$' + m.toLocaleString('es-AR') + '</span>' +
      '<span class="combo-cant">' + (dato ? dato.cantidad + '' : '0') + '</span>' +
      '</div>';
  });

  const html = '<!DOCTYPE html><html lang="es"><head>' +
'<meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<meta http-equiv="refresh" content="30">' +
'<title>BPK</title>' +
'<link rel="preconnect" href="https://fonts.googleapis.com">' +
'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
'<link href="https://fonts.googleapis.com/css2?family=Anton&family=Share+Tech+Mono&display=swap" rel="stylesheet">' +
'<style>' +
':root{--fondo:#1A0E0E;--sup:#241414;--borde:#3A2020;--cuero:#7A2E2E;--hueso:#EDE4D8;--tenue:#9A8378;--led:#FFB020;--ok:#4E9B5F;--mal:#D8443C;--medio:#E08A2B}' +
'*{box-sizing:border-box}' +
'body{margin:0;background:var(--fondo);color:var(--hueso);font-family:-apple-system,system-ui,sans-serif;padding:0 0 40px}' +
'.tope{padding:20px 18px 14px;border-bottom:1px solid var(--borde)}' +
'.marca{font-family:Anton,Impact,sans-serif;font-size:34px;letter-spacing:.06em;line-height:1;text-transform:uppercase;margin:0}' +
'.marca em{font-style:normal;color:var(--cuero)}' +
'.sub{font-family:"Share Tech Mono",monospace;font-size:12px;color:var(--tenue);letter-spacing:.14em;text-transform:uppercase;margin-top:6px}' +
'.tira{display:flex;align-items:center;gap:9px;padding:11px 18px;font-family:"Share Tech Mono",monospace;font-size:13px;letter-spacing:.06em;border-bottom:1px solid var(--borde)}' +
'.tira i{width:9px;height:9px;border-radius:50%;flex:none}' +
'.verde i{background:var(--ok);box-shadow:0 0 9px var(--ok)}' +
'.ambar i{background:var(--medio);box-shadow:0 0 9px var(--medio)}' +
'.rojo i{background:var(--mal);box-shadow:0 0 9px var(--mal)}' +
'.verde{color:var(--ok)}.ambar{color:var(--medio)}.rojo{color:var(--mal)}' +
'.tablero{padding:30px 18px 24px;text-align:center;border-bottom:1px solid var(--borde)}' +
'.tablero .rot{font-family:"Share Tech Mono",monospace;font-size:11px;letter-spacing:.24em;color:var(--tenue);text-transform:uppercase}' +
'.cifra{font-family:"Share Tech Mono",monospace;font-size:62px;line-height:1.05;color:var(--led);text-shadow:0 0 22px rgba(255,176,32,.32);margin:8px 0 2px;letter-spacing:.02em}' +
'.cifra small{font-size:26px;opacity:.55}' +
'.trio{display:flex;justify-content:center;gap:26px;margin-top:16px}' +
'.trio div{text-align:center}' +
'.trio b{display:block;font-family:"Share Tech Mono",monospace;font-size:21px;color:var(--hueso)}' +
'.trio span{font-size:10px;letter-spacing:.16em;color:var(--tenue);text-transform:uppercase}' +
'.seccion{padding:22px 18px;border-bottom:1px solid var(--borde)}' +
'.titulo{font-family:Anton,Impact,sans-serif;font-size:15px;letter-spacing:.1em;text-transform:uppercase;color:var(--tenue);margin:0 0 14px}' +
'.hist-fila{display:flex;align-items:center;gap:10px;margin-bottom:7px}' +
'.hist-dia{font-family:"Share Tech Mono",monospace;font-size:11px;color:var(--tenue);width:38px;flex:none}' +
'.hist-barra{flex:1;height:16px;background:#2E1A1A;border-radius:2px;overflow:hidden}' +
'.hist-barra i{display:block;height:100%;background:var(--cuero)}' +
'.hist-monto{font-family:"Share Tech Mono",monospace;font-size:12px;width:74px;text-align:right;flex:none}' +
'.combos{display:flex;gap:8px}' +
'.combo{flex:1;background:var(--sup);border:1px solid var(--borde);border-radius:8px;padding:11px 4px;text-align:center}' +
'.combo-precio{display:block;font-size:10px;color:var(--tenue);font-family:"Share Tech Mono",monospace}' +
'.combo-cant{display:block;font-family:"Share Tech Mono",monospace;font-size:22px;color:var(--hueso);margin-top:3px}' +
'.reparto{display:flex;justify-content:space-between;font-family:"Share Tech Mono",monospace;font-size:14px;padding:8px 0;border-bottom:1px solid var(--borde)}' +
'.reparto:last-child{border-bottom:0}' +
'.reparto span{color:var(--tenue)}' +
'.botones{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
'.b{display:block;text-align:center;text-decoration:none;padding:14px 8px;border-radius:9px;font-size:14px;font-weight:600;background:var(--sup);color:var(--hueso);border:1px solid var(--borde)}' +
'.b.ancho{grid-column:1/-1}' +
'.b.alerta{background:#4A1717;border-color:#6E2222;color:#FFC9C4}' +
'.b.bien{background:#173A21;border-color:#22562F;color:#C3EBCE}' +
'.b:focus-visible{outline:2px solid var(--led);outline-offset:2px}' +
'.datos{font-family:"Share Tech Mono",monospace;font-size:12px;line-height:1.9;color:var(--tenue)}' +
'.datos b{color:var(--hueso);font-weight:400}' +
'.pie{padding:20px 18px;text-align:center;font-family:"Share Tech Mono",monospace;font-size:11px;color:#6B564E;line-height:1.8}' +
'@media(prefers-reduced-motion:reduce){*{transition:none!important}}' +
'</style></head><body>' +

'<div class="tope">' +
'<h1 class="marca">Beer<em>punch</em></h1>' +
'<div class="sub">Beerlin · Arístides Villanueva 129</div>' +
'</div>' +

'<div class="tira ' + estadoColor + '"><i></i>' + estadoTexto + '</div>' +

'<div class="tablero">' +
'<div class="rot">Caja de la jornada</div>' +
'<div class="cifra"><small>$</small>' + r.total.toLocaleString('es-AR') + '</div>' +
'<div class="trio">' +
'<div><b>' + r.fichas + '</b><span>tiros</span></div>' +
'<div><b>' + r.operaciones + '</b><span>ventas</span></div>' +
'<div><b>' + (r.operaciones ? Math.round(r.total / r.operaciones).toLocaleString('es-AR') : 0) + '</b><span>promedio</span></div>' +
'</div></div>' +

'<div class="seccion">' +
'<h2 class="titulo">Últimas 7 jornadas</h2>' + filasHist + '</div>' +

'<div class="seccion">' +
'<h2 class="titulo">Qué se vendió hoy</h2>' +
'<div class="combos">' + filasCombo + '</div>' +
'<div style="margin-top:14px">' +
'<div class="reparto"><span>Le toca al bar (' + PORCENTAJE_BAR + '%)</span><b>$' + r.paraBar.toLocaleString('es-AR') + '</b></div>' +
'<div class="reparto"><span>Te queda a vos</span><b>$' + (r.total - r.paraBar).toLocaleString('es-AR') + '</b></div>' +
'</div></div>' +

'<div class="seccion">' +
'<h2 class="titulo">Controles</h2>' +
'<div class="botones">' +
'<a class="b bien ancho" href="/gratis' + c + '">Dar un tiro gratis</a>' +
'<a class="b alerta" href="/pausa' + c + '">Frenar todo</a>' +
'<a class="b bien" href="/reanudar' + c + '">Reanudar</a>' +
'<a class="b" href="/reset' + c + '">Vaciar cola</a>' +
'<a class="b" href="/setup">Resincronizar MP</a>' +
'</div></div>' +

'<div class="seccion">' +
'<h2 class="titulo">Cupones</h2>' +
(function () {
  const s = statsCupones();
  if (s.total === 0) {
    return '<div class="datos">Todavía no hay cupones cargados.<br>' +
      'Se crean desde <b>/cupones/generar</b></div>';
  }
  return '<div class="reparto"><span>Sin usar</span><b>' + s.disponibles + ' de ' + s.total + '</b></div>' +
    '<div class="reparto"><span>Canjeados hoy</span><b>' + s.canjesHoy + '</b></div>' +
    '<div class="reparto"><span>Terminaron comprando</span><b>' + s.convertidos + ' (' + s.conversion + '%)</b></div>';
})() +
'<div class="botones" style="margin-top:12px">' +
'<a class="b" href="/cupones">Ver detalle</a>' +
'<a class="b" href="/cupones/lista">Links para imprimir</a>' +
'</div></div>' +

'<div class="seccion">' +
'<h2 class="titulo">Prendida y apagada</h2>' +
(function () {
  const ult = encendidos.slice(-8).reverse();
  if (ult.length === 0) return '<div class="datos">Todavía sin registros.</div>';
  let f = '<div class="datos">';
  ult.forEach(function (e) {
    const d = new Date(e.ts);
    const cuando = d.toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires', hour12: false,
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    f += cuando + ' · <b>' + (e.tipo === 'apagada' ? 'se apagó' : 'volvió') + '</b><br>';
  });
  return f + '</div>';
})() + '</div>' +

'<div class="seccion">' +
'<h2 class="titulo">Máquina</h2>' +
'<div class="datos">' +
'Última señal · <b>' + (segDesdePoll < 0 ? 'nunca' : 'hace ' + segDesdePoll + ' s') + '</b><br>' +
'Encendida desde · <b>' + (ultimoArranqueShelly ? new Date(ultimoArranqueShelly).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false }) : 'sin dato') + '</b><br>' +
'Se desconectó · <b>' + desconexionesHoy + ' ' + (desconexionesHoy === 1 ? 'vez' : 'veces') + '</b><br>' +
'Fichas en cola · <b>' + pendingActivation + '</b><br>' +
'Sin confirmar · <b>' + (entregaEnVuelo ? entregaEnVuelo.n : 0) + '</b><br>' +
'QR de Mercado Pago · <b>' + (qrCortado ? 'cortado' : 'activo') + '</b><br>' +
'Avisos al celular · <b>' + (NTFY_TOPIC ? 'sí' : 'NO CONFIGURADOS') + '</b><br>' +
'Memoria del log · <b>' + (persistenciaOk ? 'guardada' : 'SE PIERDE AL REINICIAR') + '</b><br>' +
'Servidor desde · <b>' + new Date(arranque).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false }) + '</b>' +
'</div></div>' +

'<div class="seccion">' +
'<h2 class="titulo">Ver más</h2>' +
'<div class="botones">' +
'<a class="b" href="/log">Historial</a>' +
'<a class="b" href="/caja">Caja detallada</a>' +
'<a class="b" href="/panel">Panel del bar</a>' +
'<a class="b" href="/probar-aviso">Probar aviso</a>' +
'</div></div>' +

'<div class="pie">Se actualiza solo cada 30 segundos<br>' + hora() + '</div>' +
'</body></html>';

  res.type('text/html').send(html);
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
      '<b>NO funciona:</b> el QR. Lo corté a propósito para que nadie pague algo que la máquina no le va a dar.<br><br>' +
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
  } else if (qrCortado || mpFallando) {
    color = '#e67e22'; titulo = 'QR SIN SERVICIO';
    detalle = 'La máquina anda bien, pero el QR no funciona.<br><br>' +
      '<b>Que paguen por el billetero</b> con monedas o billetes.<br>' +
      'El combo de 3 tiros ($5.500) no se puede vender mientras el QR esté caído.<br><br>' +
      'Tapar el cartel del QR y avisar a Fausto.';
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
          marcarConversion();
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
  log('ARRANQUE', 'Server v10. BASE_URL=' + (BASE_URL || 'FALTA') +
      ' | persistencia=' + (persistenciaOk ? 'SI' : 'NO') +
      ' | eventos recuperados=' + eventosRecuperados +
      ' | ventas guardadas=' + ventas.length +
      ' | avisos=' + (NTFY_TOPIC ? 'SI' : 'NO'));
  if (!MP_TOKEN) log('ALERTA', 'FALTA MP_ACCESS_TOKEN');
  if (!BASE_URL) log('ALERTA', 'FALTA RAILWAY_PUBLIC_DOMAIN');
  await descubrirCajas();
  await crearTodasLasOrdenes();
});
