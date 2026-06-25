const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ⚠️ SEGURIDAD: este token quedó expuesto en GitHub. Generá uno NUEVO en Mercado Pago,
// cargalo en Railway como variable de entorno MP_ACCESS_TOKEN, y después borrá el texto de abajo.
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-3958198239703250-041419-e0bb2ed7830d738e9761477def48ee89-458533297';
const USER_ID = 458533297;
const STORE_ID = 73977333;

const BASE_URL = 'https://m-quina-de-pu-os-production-8483.up.railway.app';
const H = { headers: { Authorization: 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json' } };

// ===== COMBOS: cada caja se detecta SOLA por su nombre en MP =====
// match = parte del nombre de la caja | monto = precio | fichas = tiros que entrega
const COMBOS = [
  { match: 'beerlin',  monto: 2000,  fichas: 1 },   // "BPK Beerlin"  = 1 tiro
  { match: '3 tiros',  monto: 5500,  fichas: 3 },   // "BPK 3 tiros"
  { match: '8 tiros',  monto: 10000, fichas: 8 },   // "BPK 8 tiros"
  { match: '20 tiros', monto: 20000, fichas: 20 },  // "BPK 20 tiros"
];

let pendingActivation = 0;
let cajas = []; // se llena solo: {external_id, monto, fichas, nombre}
const pagosProcesados = new Set();

// Hora en Argentina (Railway corre en UTC)
function horaArg() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return now.getHours();
}

// Cuántas fichas da un monto pagado
function fichasPorMonto(monto) {
  const combo = COMBOS.find(function (c) { return c.monto === monto; });
  let fichas = combo ? combo.fichas : 0;
  // HAPPY HOUR (17 a 21h): el combo de 1 tiro da 2 fichas. Los combos grandes no cambian.
  // (si NO querés happy hour, borrá la línea de abajo)
  const h = horaArg();
  if (monto === 2000 && h >= 17 && h < 21) fichas = 2;
  return fichas;
}

// Detecta las cajas en MP y las matchea con los combos por nombre
async function descubrirCajas() {
  try {
    const r = await axios.get('https://api.mercadopago.com/pos?store_id=' + STORE_ID, H);
    cajas = [];
    (r.data.results || []).forEach(function (pos) {
      const nombre = (pos.name || '').toLowerCase();
      const combo = COMBOS.find(function (c) { return nombre.indexOf(c.match) !== -1; });
      if (combo) cajas.push({ external_id: pos.external_id, monto: combo.monto, fichas: combo.fichas, nombre: pos.name });
    });
    console.log('Cajas detectadas:', cajas.map(function (c) { return c.nombre + ' $' + c.monto + ' (' + c.external_id + ')'; }).join(' | '));
    return cajas;
  } catch (e) {
    console.error('Error descubriendo cajas:', e.message);
    return [];
  }
}

// Crea/refresca la orden de una caja (para que su QR muestre el monto)
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

// Refresca las ordenes de TODAS las cajas
async function crearTodasLasOrdenes() {
  if (cajas.length === 0) await descubrirCajas();
  for (let i = 0; i < cajas.length; i++) await crearOrden(cajas[i]);
  console.log('Ordenes activas en ' + cajas.length + ' cajas');
}

// Keep-alive: refresca las ordenes cada 3 minutos (las ordenes vencen solas)
setInterval(crearTodasLasOrdenes, 3 * 60 * 1000);

// ===== ENDPOINTS =====

app.get('/', function (req, res) { res.send('BPK server OK'); });

// Muestra las cajas detectadas con su external_id (para chequear)
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
  res.send('pendingActivation = ' + pendingActivation);
});

// El Shelly pregunta cada 2s. Devuelve cuantas fichas entregar DE UNA (ej "3").
app.get('/shelly-poll', function (req, res) {
  if (pendingActivation > 0) {
    const n = pendingActivation;
    pendingActivation = 0;
    res.send(String(n));
  } else {
    res.send('ok');
  }
});

// Tiro gratis (mozos): SIEMPRE 1 ficha
app.get('/gratis', function (req, res) {
  pendingActivation += 1;
  res.send('Activado (1 ficha gratis)');
});

app.post('/webhook', function (req, res) {
  res.sendStatus(200);
  const body = req.body;
  console.log('Webhook:', JSON.stringify(body));
  const paymentId = body && body.data && body.data.id;
  if ((body.type === 'payment' || body.topic === 'payment') && paymentId) {
    if (pagosProcesados.has(paymentId)) { console.log('Pago repetido, ignorado'); return; }
    axios.get('https://api.mercadopago.com/v1/payments/' + paymentId, H)
      .then(function (p) {
        if (p.data.status === 'approved') {
          pagosProcesados.add(paymentId);
          const monto = p.data.transaction_amount;
          const fichas = fichasPorMonto(monto);
          if (fichas > 0) {
            pendingActivation += fichas;
            console.log('Pago $' + monto + ' -> ' + fichas + ' fichas');
          } else {
            console.log('Pago $' + monto + ' sin combo asociado, no se dio ficha');
          }
          const caja = cajas.find(function (c) { return c.monto === monto; });
          if (caja) crearOrden(caja); // rearma esa caja para el proximo cliente
        }
      })
      .catch(function (e) { console.error('Error MP:', e.message); });
  }
});

app.listen(process.env.PORT || 3000, '0.0.0.0', async function () {
  console.log('Server running');
  await descubrirCajas();
  await crearTodasLasOrdenes();
});
