const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const MP_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-3958198239703250-041419-e0bb2ed7830d738e9761477def48ee89-458533297';
const POS_ID = 126297982;

let pendingActivation = 0;

function getConfig() {
  const hour = new Date().getHours();
  if (hour >= 17 && hour < 21) return { monto: 2000, shots: 2 };
  return { monto: 2000, shots: 1 };
}

async function crearOrden() {
  const { monto } = getConfig();
  try {
    await axios.put(
      `https://api.mercadopago.com/instore/qr/seller/collectors/458533297/stores/73977333/pos/${POS_ID}/orders`,
      {
        external_reference: 'BPK-' + Date.now(),
        title: 'Puno BPK',
        description: 'Máquina de puños BeerPunchAndKick',
        notification_url: 'https://m-quina-de-pu-os-production-8483.up.railway.app/webhook',
        total_amount: monto,
        items: [{
          sku_number: 'BPK001',
          category: 'entretenimiento',
          title: 'Puno BPK',
          description: 'Un tiro en la máquina',
          unit_price: monto,
          quantity: 1,
          unit_measure: 'unit',
          total_amount: monto
        }]
      },
      { headers: { Authorization: 'Bearer ' + MP_TOKEN } }
    );
    console.log('Orden creada: $' + monto);
  } catch (e) {
    console.error('Error creando orden:', e.response?.data || e.message);
  }
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

app.get('/ok', (req, res) => {
  res.send('Pago recibido');
});

app.get('/', async (req, res) => {
  await crearOrden();
  res.send('Orden lista');
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  console.log('Webhook recibido:', JSON.stringify(body));
  if (body && (body.type === 'payment' || body.topic === 'payment')) {
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
          crearOrden();
        }
      }).catch(function(e) {
        console.error('Error MP:', e.message);
      });
    }
  }
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('Server running');
  crearOrden();
});
