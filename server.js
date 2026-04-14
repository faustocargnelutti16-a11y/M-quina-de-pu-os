const express = require('express');
const mercadopago = require('mercadopago');
const axios = require('axios');
const app = express();
app.use(express.json());

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const SHELLY_IP = process.env.SHELLY_IP;
const PULSE_MS = 150;

mercadopago.configure({ access_token: MP_TOKEN });

app.post('/webhook', async (req, res) => {
  const { type, data } = req.body;
  if (type === 'payment') {
    const payment = await mercadopago.payment.get(data.id);
    if (payment.body.status === 'approved') {
      const amount = payment.body.transaction_amount;
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

app.listen(process.env.PORT || 3000);
