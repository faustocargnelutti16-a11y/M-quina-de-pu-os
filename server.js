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
  await axios.post(`${SHELLY_SERVER}/device/relay/control`, {
    auth_key: SHELLY_AUTH,
    id: SHELLY_ID,
    channel: 0,
    turn: 'on',
    timer: PULSE_MS / 1000
  });
}

app.get('/', async (req, res) => {
  try {
    const { monto } = getConfig();
    const response = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      {
        items: [{ title: 'Puño BPK', quantity: 1, unit_price: monto, currency_id: 'ARS' }],
        back_urls: { success: 'https://m-quina-de-pu-os-us-east.up.railway.app/ok' },
        auto_return: 'approved',
        external_reference: 'punos-' + Date.now()
      },
      { headers: { Authorization: `Bearer ${MP_TOKEN}` } }
    );
    res.redirect(response.data.init_point);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).send('Error: ' + JSON.stringify(e.response?.data));
  }
});

app.get('/ok', (req, res) => {
  res.send('Pago recibido, activando maquina...');
});

app.get('/gratis', async (req, res) => {
  try {
    await activarShelly();
    res.send('Activado');
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

app.post('/webhook', async (req, res) => {
  const { type, data } = req.body;
  if (type === 'payment') {
    try {
      const payment = await axios.get(
        `https://api.mercadopago.com/v1/payments/${data.id}`,
        { headers: { Authorization: `Bearer ${MP_TOKEN}` } }
      );
      if (payment.data.status === 'approved') {
        const { shots } = getConfig();
        for (let i = 0; i < shots; i++) {
          await activarShelly();
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    } catch (e) {
      console.error(e.message);
    }
  }
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Servidor escuchando en puerto ' + (process.env.PORT || 3000));
});
