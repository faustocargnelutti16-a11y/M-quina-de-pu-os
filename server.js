const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;

let pendingActivation = 0;

function getConfig() {
  const hour = new Date().getHours();
  if (hour >= 17 && hour < 21) return { monto: 2000, shots: 2 };
  return { monto: 2000, shots: 1 };
}

app.get('/shelly-poll', (req, res) => {
  if (pendingActivation > 0) {
    pendingActivation--;
    res.send('activate');
  } else {
    res.send('ok');
  }
});

app.get('/gratis', (req, res) => {
  const { shots } = getConfig();
  pendingActivation = shots;
  res.send('Activado (' + shots + ' pulsos)');
});

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

app.get('/ok', (req, res) => {
  res.send('Pago recibido');
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  console.log('Webhook recibido:', JSON.stringify(body));
  if (body && (body.type === 'payment' || body.action === 'payment.updated')) {
    const paymentId = body.data && body.data.id;
    console.log('Payment ID:', paymentId);
    if (paymentId) {
      axios.get(
        'https://api.mercadopago.com/v1/payments/' + paymentId,
        { headers: { Authorization: 'Bearer ' + MP_TOKEN } }
      ).then(function(payment) {
        console.log('Payment status:', payment.data.status);
        if (payment.data.status === 'approved') {
          const { shots } = getConfig();
          pendingActivation = shots;
          console.log('Activando:', shots, 'pulsos');
        }
      }).catch(function(e) {
        console.error('Error MP:', e.message);
      });
    }
  }
});

app.listen(process.env.PORT || 3000);
