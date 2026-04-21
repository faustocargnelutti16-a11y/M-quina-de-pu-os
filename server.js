const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const SHELLY_IP = process.env.SHELLY_IP;
const PULSE_MS = 150;

app.post('/webhook', async (req, res) => {
  const { type, data } = req.body;
  if (type === 'payment') {
    const payment = await axios.get(
      `https://api.mercadopago.com/v1/payments/${data.id}`,
      { headers: { Authorization: `Bearer ${MP_TOKEN}` } }
    );
    if (payment.data.status === 'approved') {
      const hour = new Date().getHours();
      const shots = (hour >= 17 && hour < 21) ? 2 : 1;
      for (let i = 0; i < shots; i++) {
        await axios.get(`http://${SHELLY_IP}/relay/0?turn=on&timer=${PULSE_MS}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  res.sendStatus(200);
});

app.get('/', async (req, res) => {
  const order = await axios.post(
    'https://api.mercadopago.com/mpmobile/instore/qr/seller/collectors/me/pos/QR1/orders',
    {
      external_reference: 'punos-' + Date.now(),
      total_amount: 2000,
      items: [{ title: 'Puño', unit_price: 2000, quantity: 1, unit_measure: 'unit', total_amount: 2000 }]
    },
    { headers: { Authorization: `Bearer ${MP_TOKEN}` } }
  );
  res.json(order.data);
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Servidor escuchando en puerto ' + (process.env.PORT || 3000));
});
