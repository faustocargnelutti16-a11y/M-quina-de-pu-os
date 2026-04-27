const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const SHELLY_IP = process.env.SHELLY_IP;
const PULSE_MS = 150;
const USER_ID = '458533297';
const POS_ID = '126297982';

function getMontoYShots() {
  const hour = new Date().getHours();
  if (hour >= 17 && hour < 21) return { monto: 1000, shots: 2 };
  return { monto: 2000, shots: 1 };
}

app.get('/', async (req, res) => {
  try {
    const { monto } = getMontoYShots();
    const order = await axios.post(
      `https://api.mercadopago.com/instore/qr/seller/collectors/${USER_ID}/pos/${POS_ID}/orders`,
      {
        external_reference: 'punos-' + Date.now(),
        total_amount: monto,
        items: [{ title: 'Puño', unit_price: monto, quantity: 1, unit_measure: 'unit', total_amount: monto }]
      },
      { headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    res.json(order.data);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).send('Error: ' + JSON.stringify(e.response?.data));
  }
});

app.get('/gratis', async (req, res) => {
  try {
    for (let i = 0; i < 1; i++) {
      await axios.get(`http://${SHELLY_IP}/relay/0?turn=on&timer=${PULSE_MS}`);
      await new Promise(r => setTimeout(r, 1000));
    }
    res.send('Activado gratis');
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
        const { shots } = getMontoYShots();
        for (let i = 0; i < shots; i++) {
          await axios.get(`http://${SHELLY_IP}/relay/0?turn=on&timer=${PULSE_MS}`);
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
