const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const PULSE_MS = 150;
const SHELLY_SERVER = 'https://shelly-241-eu.shelly.cloud';
const SHELLY_AUTH = 'M2Q4ZTgydWlk033A8E1E4AD95AA98CB4CFB8AA70CDAE12D02B50CC4BBC04206BD1B1AA359119A7E50748967649C0';
const SHELLY_ID = 'DCB4D9C47830';

function getConfig() {
  const hour = new Date().getHours();
  if (hour >= 17 && hour < 21) return { monto: 2000, shots: 2 };
  return { monto: 2000, shots: 1 };
}

async function activarShelly() {
  await axios.post(SHELLY_SERVER + '/device/rpc', {
    auth_key: SHELLY_AUTH,
    id: SHELLY_ID,
    method: 'Switch.Set',
    params: { id: 0, on: true, toggle_after: PULSE_MS / 1000 }
  });
}

app.get('/', async (req, res) => {
  try {
    const { monto } = getConfig();
    const response = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      {
        items: [{ title: 'Puno BPK', quantity: 1, unit_price: monto, currency_id: 'ARS' }],
        back_urls: { success: 'https://m-quina-de-pu-os-us-east.up.railway.app/ok' },
        auto_return: 'approved',
        external_reference: 'punos-' + Date.now()
      },
      { headers: { Authorization: 'Bearer ' + MP_TOKEN } }
    );
    res.redirect(response.data.init_point);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

app.get('/ok', function(req, res) {
  res.send('Pago recibido');
});

app.get('/gratis', async (req, res) => {
  try {
    const { shots } = getConfig();
    for (let i = 0; i < shots; i++) {
      await activarShelly();
      if (i < shots - 1) await new Promise(function(r) { setTimeout(r, 2000); });
    }
    res.send('Activado ' + shots + ' pulsos');
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

app.post('/webhook', async (req, res) => {
  const { type, data } = req.body;
  if (type === 'payment') {
    try {
      const payment = await axios.get(
        'https://api.mercadopago.com/v1/payments/' + data.id,
        { headers: { Authorization: 'Bearer ' + MP_TOKEN } }
      );
      if (payment.data.status === 'approved') {
        const { shots } = getConfig();
        for (let i = 0; i < shots; i++) {
          await activarShelly();
          if (i < shots - 1) await new Promise(function(r) { setTimeout(r, 2000); });
        }
      }
    } catch (e) {
      console.error(e.message);
    }
  }
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000);
