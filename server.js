const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const MP_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-3958198239703250-041419-e0bb2ed7830d738e9761477def48ee89-458533297';
const USER_ID = 458533297;
const STORE_ID = 73977333;
const POS_EXT = 'BPKPOS01';

let pendingActivation = 0;
const pagosProcesados = new Set();
const H = { headers: { Authorization: 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json' } };

function getConfig() {
  const hour = new Date().getHours();
  if (hour >= 17 && hour < 21) return { monto: 2000, shots: 2 };
  return { monto: 2000, shots: 1 };
}

async function crearOrden() {
  const { monto } = getConfig();
  try {
    await axios.put(
      `https://api.mercadopago.com/instore/qr/seller/collectors/${USER_ID}/pos/${POS_EXT}/orders`,
      {
        external_reference: 'BPK-' + Date.now(),
        title: 'Puno BPK',
        description: 'Maquina de punos BeerPunchAndKick',
        notification_url: 'https://m-quina-de-pu-os-production-8483.up.railway.app/webhook',
        total_amount: monto,
        items: [{
          sku_number: 'BPK001',
          category: 'entretenimiento',
          title: 'Puno BPK',
          description: 'Un tiro en la maquina',
          unit_price: monto,
          quantity: 1,
          unit_measure: 'unit',
          total_amount: monto,
          currency_id: 'ARS'
        }]
      },
      H
    );
    console.log('Orden creada: $' + monto);
    return 'Orden creada: $' + monto;
  } catch (e) {
    const err = e.response ? JSON.stringify(e.response.data) : e.message;
    console.error('Error creando orden:', err);
    return 'ERROR: ' + err;
  }
}

app.get('/setup', async (req, res) => {
  try {
    let pos;
    try {
      const r = await axios.get('https://api.mercadopago.com/pos?external_id=' + POS_EXT, H);
      if (r.data.results && r.data.results.length > 0) pos = r.data.results[0];
    } catch (e) {}
    if (!pos) {
      const r = await axios.post('https://api.mercadopago.com/pos', {
        name: 'BPK Beerlin',
        fixed_amount: true,
        store_id: STORE_ID,
        external_id: POS_EXT,
        category: 621102
      }, H);
      pos = r.data;
    }
    res.json({ ok: true, id: pos.id, external_id: pos.external_id, qr_code: pos.qr_code });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.response ? e.response.data : e.message });
  }
});

app.get('/qr', async (req, res) => {
  try {
    const r = await axios.get('https://api.mercadopago.com/pos?external_id=' + POS_EXT, H);
    const full = await axios.get('https://api.mercadopago.com/pos/' + r.data.results[0].id, H);
    res.send(full.data.qr_code);
  } catch (e) {
    res.status(500).json({ error: e.response ? e.response.data : e.message });
  }
});

app.get('/orden', async (req, res) => {
  res.send(await crearOrden());
});

app.get('/estado', (req, res) => {
  res.send('pendingActivation = ' + pendingActivation);
});

app.get('/shelly-poll', (req, res) => {
  if (pendingActivation > 0) { pendingActivation--; res.send('activate'); }
  else { res.send('ok'); }
});

app.get('/gratis', (req, res) => {
  const { shots } = getConfig();
  pendingActivation = shots;
  res.send('Activado (' + shots + ' pulsos)');
});

app.get('/', (req, res) => { res.send('BPK server OK'); });

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  console.log('Webhook recibido:', JSON.stringify(body));
  const paymentId = body && body.data && body.data.id;
  if ((body.type === 'payment' || body.topic === 'payment') && paymentId) {
    if (pagosProcesados.has(paymentId)) { console.log('Pago repetido, ignorado'); return; }
    axios.get('https://api.mercadopago.com/v1/payments/' + paymentId, H)
      .then(function(p) {
        console.log('Payment status:', p.data.status);
        if (p.data.status === 'approved') {
          pagosProcesados.add(paymentId);
          const { shots } = getConfig();
          pendingActivation = shots;
          console.log('Activando:', shots, 'pulsos');
          crearOrden();
        }
      })
      .catch(function(e) { console.error('Error MP:', e.message); });
  }
});

app.listen(process.env.PORT ||
