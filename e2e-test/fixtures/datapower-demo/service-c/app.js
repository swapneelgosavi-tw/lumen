const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Service C never calls the bank directly: it calls the IBM DataPower gateway, which routes the request.
const PAYMENTS_GW_URL = process.env.PAYMENTS_GW_URL || 'https://dp-gateway.internal:8443';

app.post('/pay', async (req, res) => {
  const result = await axios.post(`${PAYMENTS_GW_URL}/payments/charge`, {
    amount: req.body.amount,
    currency: req.body.currency,
  });
  res.json({ status: result.data.status, reference: result.data.reference });
});

app.listen(3000);
