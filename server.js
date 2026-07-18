const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ⚠️ SEGURIDAD: token expuesto en GitHub. Generá uno nuevo en MP, ponelo en Railway
// como variable MP_ACCESS_TOKEN, y borrá el texto de abajo.
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-3958198239703250-041419-e0bb2ed7830d738e9761477def48ee89-458533297';
const USER_ID = 458533297;
