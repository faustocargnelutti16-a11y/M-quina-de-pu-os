const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ⚠️ SEGURIDAD: token expuesto en GitHub. Generá uno nuevo en MP, ponelo en Railway
// como variable MP_ACCESS_TOKEN, y borrá el texto de abajo.
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-3958198239703250-041419-e0bb2ed7830d738e9761477def48ee89-458533297';
const USER_ID = 458533297;
const STORE_ID = 73977333;

const BASE_URL = 'https://m-quina-de-pu-os-production-76fc.up.railway.app';
const H = { headers: { Authorization: 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json' } };

// Tope duro: nunca acumular más de esto en pendingActivation
const MAX_PENDING = 20;

// COMBOS: cada caja se detecta por nombre. ext = external_id que usa el server.
const COMBOS = [
  { match: 'beerlin',  monto: 2000,  fichas: 1,  ext: 'BPKPOS01' }, // BPK Beerlin = 1 tiro
  { match: '3 tiros',  monto: 5500,  fichas: 3,  ext: 'BPKPOS03' },
  { match: '8 tiros',  monto: 10000, fichas: 8,  ext: 'BPKPOS08' },
  { match: '20 tiros', monto: 20000, fichas: 20, ext: 'BPKPOS20' },
];

let pendingActivation = 0;
let cajas = [];

// Dedup de pagos: guardamos el paymentId ANTES de la llamada async a MP,
// no después. Así, si llegan dos notificaciones del mismo pago casi
// simultáneas, la segunda se descarta apenas entra, sin esperar a que
// la primera termine de consultar la API.
const pagosProcesados = new Set();
const pagosEnProceso = new Set();

function horaArg() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return now.getHours();
}

function fichasPorMonto(monto) {
  const combo = COMBOS.find(function (c) { return c.monto === monto; });
  let fichas = combo ? combo.fichas : 0;
  const h = horaArg();
  if (monto === 2000 && h >= 17 && h < 21) fichas = 2; // happy hour: 1 tiro -> 2 fichas
  return fichas;
}

function sumarFichas(fichas) {
  pendingActivation = Math.min(pendingActivation + fichas, MAX_PENDING);
}

// Detecta las cajas y, si alguna no tiene external_id (creada desde la app),
// se lo asigna por API. Esto NO cambia el QR impreso.
async function descubrirCajas() {
  try {
    const r = await axios.get('https://api.mercadopago.com/pos?store_id=' + STORE_ID, H);
    cajas = [];
    const results = r.data.results || [];
    for (let i = 0; i < results.length; i++) {
      const pos = results[i];
      const nombre = (pos.name || '').toLowerCase();
      const combo = COMBOS.find(function (c) { return nombre.indexOf(c.match) !== -1; });
      if (!combo) continue;
      let ext = pos.external_id;
      if (!ext) {
        ext = combo.ext;
        try {
          await axios.put('https://api.mercadopago.com/pos/' + pos.id, {
            name: pos.name,
            fixed_amount: true,
            store_id: STORE_ID,
            external_id: ext,
            category: pos.category || 621102
          }, H);
          console.log('external_id asignado: ' + ext + ' -> ' + pos.name);
        } catch (e) {
          console.error('No se pudo asignar external_id a ' + pos.name + ':', e.response ? JSON.stringify(e.response.data) : e.message);
          continue;
        }
      }
      cajas.push({ external_id: ext, monto: combo.monto, fichas: combo.fichas, nombre: pos.name });
    }
    console.log('Cajas:', cajas.map(function (c) { return c.nombre + ' $' + c.monto + ' (' + c.external_id + ')'; }).join(' | '));
    return cajas;
  } catch (e) {
    console.error('Error descubriendo cajas:', e.message);
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
    console.error('Error orden ' + caja.nombre + ':', e.response ? JSON.stringify(e.response.data) : e.message);
    return false;
  }
}

async function crearTodasLasOrdenes() {
  if (cajas.length === 0) await descubrirCajas();
  for (let i = 0; i < cajas.length; i++) await crearOrden(cajas[i]);
  console.log('Ordenes activas en ' + cajas.length + ' cajas');
}

setInterval(crearTodasLasOrdenes, 3 * 60 * 1000);

app.get('/', function (req, res) { res.send('BPK server OK'); });

app.get('/cajas', async function (req, res) {
  await descubrirCajas();
  res.json(cajas);
});

app.get('/setup', async function (req, res) {
  await descubrirCajas();
  await crearTodasLasOrdenes();
  res.json({ ok: true, cajas: cajas });
});

app.get('/orden', async function (req, res) {
  await crearTodasLasOrdenes();
  res.send('Ordenes creadas en ' + cajas.length + ' cajas');
});

app.get('/estado', function (req, res) {
  res.send('pendingActivation = ' + pendingActivation + ' | pagosProcesados = ' + pagosProcesados.size);
});

app.get('/shelly-poll', function (req, res) {
  if (pendingActivation > 0) {
    const n = pendingActivation;
    pendingActivation = 0;
    res.send(String(n));
  } else {
    res.send('ok');
  }
});

app.get('/gratis', function (req, res) {
  sumarFichas(1);
  res.send('Activado (1 ficha gratis)');
});

app.post('/webhook', function (req, res) {
  res.sendStatus(200); // responder ya, para que MP no reintente por timeout
  const body = req.body;
  console.log('Webhook:', JSON.stringify(body));
  const paymentId = body && body.data && body.data.id;
  if (!((body.type === 'payment' || body.topic === 'payment') && paymentId)) return;

  // Marcamos "en proceso" YA, de forma síncrona, antes de cualquier await.
  // Esto cierra la ventana de carrera: si llega otra notificación del mismo
  // pago mientras esta sigue en vuelo, se descarta acá mismo.
  if (pagosProcesados.has(paymentId) || pagosEnProceso.has(paymentId)) {
    console.log('Pago repetido/en proceso, ignorado: ' + paymentId);
    return;
  }
  pagosEnProceso.add(paymentId);

  axios.get('https://api.mercadopago.com/v1/payments/' + paymentId, H)
    .then(function (p) {
      if (p.data.status === 'approved') {
        pagosProcesados.add(paymentId);
        const monto = p.data.transaction_amount;
        const fichas = fichasPorMonto(monto);
        if (fichas > 0) {
          sumarFichas(fichas);
          console.log('Pago $' + monto + ' -> ' + fichas + ' fichas (pendingActivation=' + pendingActivation + ')');
        } else {
          console.log('Pago $' + monto + ' sin combo, no se dio ficha');
        }
        const caja = cajas.find(function (c) { return c.monto === monto; });
        if (caja) crearOrden(caja);
      }
    })
    .catch(function (e) { console.error('Error MP:', e.message); })
    .finally(function () { pagosEnProceso.delete(paymentId); });
});

app.listen(process.env.PORT || 3000, '0.0.0.0', async function () {
  console.log('Server running');
  await descubrirCajas();
  await crearTodasLasOrdenes();
});
