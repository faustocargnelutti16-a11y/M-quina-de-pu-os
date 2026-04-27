const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const SHELLY_IP = process.env.SHELLY_IP;
const PULSE_MS = 150;

function getConfig() {
  const hour = new Date().getHours();
  if (hour >= 17 && hour < 21) return { monto: 1000, shots: 1 };
  return { monto: 2000, shots: 1 };
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
  res.send('
