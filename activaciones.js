/* ============================================================
   BEERPUNCH — SISTEMA DE ACTIVACIONES (Fase 1: cupón impreso)
   ------------------------------------------------------------
   Módulo autocontenido. Se monta desde server.js así:

     const activaciones = require('./activaciones');
     app.use(activaciones({ agregarFichas }));

   Endpoints que expone:
     GET  /c/:codigo          -> escanea + QUEMA + página con botón ACTIVAR
     GET  /canjear/:codigo    -> alias de /c/:codigo
     POST /activar/:codigo    -> encola la ficha (paso 2, frente a la máquina)
     GET  /activaciones       -> panel de métricas (protegido por token)
     GET  /activaciones/json  -> mismas métricas en JSON

   REGLAS DE NEGOCIO IMPLEMENTADAS
     - Un solo escaneo por código. Se quema en el primer escaneo real.
     - Doble paso: escanear NO acredita. Hay que apretar ACTIVAR.
     - Ventana horaria como NOCHE (jue/vie/sáb 22:00 -> 03:00 AR), no como día.
     - Fuera de la ventana NO se quema el código (se puede usar otra noche).
     - Previews de WhatsApp/IG/Telegram NO queman el código.
     - Persistencia en /data para sobrevivir reinicios de Railway.
   ============================================================ */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------
   CONFIGURACIÓN
   ------------------------------------------------------------ */
const CONFIG = {
  // Minutos que dura la pantalla de ACTIVAR después de escanear.
  MINUTOS_PARA_ACTIVAR: 10,

  FICHAS_POR_CUPON: 1,

  /* ---- VENTANA ----
     Por defecto: TODOS los días, en horario de bar (17:00 -> 05:00).
     Para el cliente y para la carta esto es "sin límite": el bar está
     cerrado el resto del tiempo. No es un filtro comercial, es una
     protección: si alguien activa un cupón un martes a las 15:00, la
     ficha queda encolada y se dispara cuando el Shelly reconecte,
     regalándole un crédito a quien esté parado ahí.

     Se puede cambiar desde Railway sin tocar código:
       ACT_DIAS=0,1,2,3,4,5,6   (0=Dom ... 6=Sáb)
       ACT_HORA_INICIO=17
       ACT_HORA_FIN=5           (del día siguiente)                    */
  DIAS_VALIDOS: String(process.env.ACT_DIAS || '0,1,2,3,4,5,6')
    .split(',').map(function (d) { return parseInt(d.trim(), 10); })
    .filter(function (d) { return !isNaN(d); }),

  HORA_INICIO: parseInt(process.env.ACT_HORA_INICIO || '17', 10),
  HORA_FIN: parseInt(process.env.ACT_HORA_FIN || '5', 10),

  // Argentina no tiene horario de verano: UTC-3 fijo.
  OFFSET_AR: -3,

  ALERTA_STOCK: 10,

  // Misma clave que ya usás en /pausa, /gratis, /reanudar.
  TOKEN_PANEL: process.env.ACTIVACIONES_TOKEN || process.env.BPK_CLAVE || 'bpk2026',

  MODO_PRUEBA: String(process.env.ACTIVACIONES_TEST || '').toLowerCase() === 'true',

  IG: '@beerpunch.mdz',
  IG_URL: 'https://www.instagram.com/beerpunch.mdz',

  // Precios que se muestran en las pantallas sin salida.
  // Si cambian los combos, se cambian acá y listo.
  COMBOS: [
    { tiros: '1 TIRO',   precio: '$2.000' },
    { tiros: '3 TIROS',  precio: '$5.500' },
    { tiros: '8 TIROS',  precio: '$10.000' },
    { tiros: '20 TIROS', precio: '$20.000' },
  ],
  HAPPY_DESDE: 17,
  HAPPY_HASTA: 21,
};

/* ------------------------------------------------------------
   ALMACENAMIENTO PERSISTENTE
   Vive en /data (volumen de Railway). Si no existe, cae a ./data
   para poder correrlo local sin romper nada.
   ------------------------------------------------------------ */
const DIR_DATOS = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const ARCHIVO = path.join(DIR_DATOS, 'activaciones.json');

let db = { lote: null, generadoEn: null, codigos: {} };

function cargarDB() {
  try {
    if (!fs.existsSync(DIR_DATOS)) fs.mkdirSync(DIR_DATOS, { recursive: true });
    if (fs.existsSync(ARCHIVO)) {
      db = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
      if (!db.codigos) db.codigos = {};
      console.log('[ACT] Base cargada:', Object.keys(db.codigos).length, 'códigos — lote', db.lote);
    } else {
      console.log('[ACT] No hay base todavía. Subí codigos.json y llamá a /activaciones/importar');
    }
  } catch (e) {
    console.error('[ACT] Error leyendo la base:', e.message);
    db = { lote: null, generadoEn: null, codigos: {} };
  }
}

// Escritura atómica: archivo temporal + rename. Si el server muere a mitad
// de la escritura, el archivo viejo queda intacto (no se corrompe la base).
//
// Es SINCRÓNICO a propósito. Diferirlo (setImmediate/debounce) abre una
// ventana en la que el cupón ya se marcó como quemado en memoria pero
// todavía no está en disco: si Railway reinicia justo ahí, el código
// revive y se puede volver a usar. Son ~20 KB y unas pocas escrituras
// por noche — el costo es nulo y el modo de falla desaparece.
function guardarDB() {
  try {
    if (!fs.existsSync(DIR_DATOS)) fs.mkdirSync(DIR_DATOS, { recursive: true });
    const tmp = ARCHIVO + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, ARCHIVO);
  } catch (e) {
    console.error('[ACT] Error guardando la base:', e.message);
  }
}

cargarDB();

/* ------------------------------------------------------------
   TIEMPO Y VENTANA HORARIA
   La ventana cruza medianoche: jueves 22h -> viernes 3am.
   Por eso NO se pregunta "¿qué día es?", se pregunta
   "¿a qué NOCHE pertenece este momento?".
   ------------------------------------------------------------ */
function ahoraAR() {
  // Desplazo el reloj para poder usar los getters UTC como si fueran locales AR.
  return new Date(Date.now() + CONFIG.OFFSET_AR * 3600 * 1000);
}

/**
 * Devuelve la noche a la que pertenece un momento, o null si está fuera.
 * Ejemplo: viernes 01:30 pertenece a la noche del JUEVES.
 */
function nocheDe(fechaAR) {
  const hora = fechaAR.getUTCHours();
  let noche;

  if (hora >= CONFIG.HORA_INICIO) {
    noche = new Date(fechaAR.getTime());           // la noche empezó hoy
  } else if (hora < CONFIG.HORA_FIN) {
    noche = new Date(fechaAR.getTime() - 86400000); // sigue siendo la noche de ayer
  } else {
    return null;                                    // entre 03:00 y 22:00: cerrado
  }

  if (CONFIG.DIAS_VALIDOS.indexOf(noche.getUTCDay()) === -1) return null;

  return noche.toISOString().slice(0, 10); // "2026-08-06" = noche del jueves 6
}

function ventanaAbierta() {
  if (CONFIG.MODO_PRUEBA) return 'PRUEBA';
  return nocheDe(ahoraAR());
}

function horaLegible(iso) {
  if (!iso) return '—';
  const d = new Date(new Date(iso).getTime() + CONFIG.OFFSET_AR * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

/* ------------------------------------------------------------
   ANTI-PREVIEW
   WhatsApp, Instagram, Telegram y compañía hacen un GET automático
   cuando alguien pega el link o manda la foto. Sin este filtro,
   ese GET quemaría el cupón sin que ningún humano lo haya visto.
   ------------------------------------------------------------ */
const BOTS = [
  'whatsapp', 'facebookexternalhit', 'facebot', 'instagram', 'telegrambot',
  'twitterbot', 'discordbot', 'slackbot', 'linkedinbot', 'skypeuripreview',
  'bot', 'crawler', 'spider', 'preview', 'curl', 'wget', 'python-requests',
  'headlesschrome', 'googlebot', 'bingbot',
];

function esBot(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (!ua) return true; // sin user-agent no es un navegador de verdad
  return BOTS.some((b) => ua.indexOf(b) !== -1);
}

/* ------------------------------------------------------------
   COOKIES (sin dependencias externas)
   ------------------------------------------------------------ */
function leerCookie(req, nombre) {
  const raw = req.headers.cookie || '';
  const partes = raw.split(';');
  for (const p of partes) {
    const i = p.indexOf('=');
    if (i === -1) continue;
    if (p.slice(0, i).trim() === nombre) return decodeURIComponent(p.slice(i + 1).trim());
  }
  return null;
}

function nuevoToken() {
  return crypto.randomBytes(12).toString('hex');
}

/* ============================================================
   DISEÑO DE LAS PANTALLAS
   ------------------------------------------------------------
   Decisiones deliberadas para el contexto real de uso:

   - CERO fuentes web. En un bar con wifi saturada, si la tipografía
     no carga el usuario ve una pantalla rota justo en el momento
     de máxima efusividad. Se usa el stack del sistema con pesos
     altos + skew CSS para el italic agresivo del cupón.
   - Fondo oscuro: a las 2am, un fondo blanco encandila y molesta.
   - Un solo elemento por pantalla. Nadie lee parado con amigos gritando.
   - El botón ocupa media pantalla: se aprieta con el pulgar,
     con una mano, probablemente con la otra sosteniendo un vaso.
   - El botón se "carga" al mantenerlo apretado (400ms). Evita el
     activado accidental al sacar el teléfono del bolsillo y refuerza
     el gesto físico de "cargar el golpe".
   ============================================================ */

const CSS_BASE = `
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{height:100%}
  body{
    background:#111318;
    color:#fff;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    display:flex;flex-direction:column;
    min-height:100dvh;
    overflow-x:hidden;
    text-align:center;
    padding:22px 20px calc(22px + env(safe-area-inset-bottom));
  }
  .franja{position:fixed;left:-20%;width:140%;height:3px;pointer-events:none;z-index:0}
  .franja.azul{top:11%;background:#1F52C4;transform:rotate(-9deg)}
  .franja.roja{bottom:16%;background:#D6132A;transform:rotate(-9deg)}
  .marca{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;gap:9px;
    font-size:11px;letter-spacing:.22em;font-weight:800;color:#7A8093}
  .marca b{color:#fff}
  .marca .r{color:#D6132A}
  main{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:18px}
  .titulo{
    font-size:clamp(40px,13vw,64px);line-height:.92;font-weight:900;letter-spacing:-.02em;
    transform:skewX(-8deg);text-shadow:4px 4px 0 #D6132A;
  }
  .bajada{font-size:16px;line-height:1.45;color:#A8AEC0;max-width:19em}
  .bajada strong{color:#fff}
  .dorado{color:#E8B437;font-weight:800}
  footer{position:relative;z-index:1;font-size:10.5px;letter-spacing:.16em;color:#575D70;font-weight:700}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

/* Las pantallas de "no se puede" son callejones sin salida: la persona llegó
   con el teléfono en la mano y ganas de jugar. Mostrarle los precios ahí
   convierte un "no" en la posibilidad de una venta. NO va en la pantalla del
   botón ACTIVAR: ahí la única acción posible es apretar. */
const CSS_PRECIOS = `
  .precios{margin-top:26px;width:100%;max-width:22em}
  .precios-tit{font-size:11px;letter-spacing:.2em;color:#6E7488;font-weight:800;margin-bottom:11px}
  .precios-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
  .combo{background:#191C24;border:1px solid #262A36;border-radius:11px;padding:11px 8px}
  .combo .t{font-size:13px;font-weight:900;letter-spacing:-.01em}
  .combo .p{font-size:15px;font-weight:900;color:#E8B437;margin-top:3px;font-variant-numeric:tabular-nums}
  .happy{grid-column:1/-1;background:#20141A;border-color:#D6132A}
  .happy .t{color:#FF4257}
  .happy .p{color:#fff;font-size:13px}
  .cta{margin-top:14px;font-size:14.5px;font-weight:800;line-height:1.4}
  .cta span{color:#E8B437}
`;

function bloquePrecios() {
  const h = ahoraAR().getUTCHours();
  const happy = h >= CONFIG.HAPPY_DESDE && h < CONFIG.HAPPY_HASTA;

  const items = CONFIG.COMBOS.map(function (c) {
    return '<div class="combo"><div class="t">' + c.tiros + '</div>' +
           '<div class="p">' + c.precio + '</div></div>';
  }).join('');

  const banda = happy
    ? '<div class="combo happy"><div class="t">HAPPY HOUR &middot; HASTA LAS ' + CONFIG.HAPPY_HASTA + '</div>' +
      '<div class="p">$2.000 = 2 TIROS, pagando con QR</div></div>'
    : '';

  return '<div class="precios">' +
    '<div class="precios-tit">SEGUÍ PEGANDO</div>' +
    '<div class="precios-grid">' + banda + items + '</div>' +
    '<p class="cta">Escaneá el <span>QR de pago</span> que está en la máquina.</p>' +
    '</div>';
}

function envolver(titulo, cuerpo, extraCSS) {
  return `<!DOCTYPE html><html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1">
<meta name="theme-color" content="#111318">
<title>${titulo}</title>
<style>${CSS_BASE}${CSS_PRECIOS}${extraCSS || ''}</style>
</head><body>
<div class="franja azul"></div><div class="franja roja"></div>
<div class="marca"><b>BEERLIN</b> <span class="r">&times;</span> <b>BEER</b><span class="r">PUNCH</span></div>
${cuerpo}
</body></html>`;
}

/* --------- Pantalla 1: el botón (el momento que importa) --------- */
function pantallaActivar(codigo, segundosRestantes) {
  const css = `
    .aro{
      position:relative;width:min(74vw,290px);aspect-ratio:1;border-radius:50%;
      display:grid;place-items:center;cursor:pointer;user-select:none;
      background:radial-gradient(circle at 50% 38%,#E8213B 0%,#B10E22 62%,#780916 100%);
      box-shadow:0 16px 0 #4B060E, 0 22px 44px rgba(214,19,42,.42), inset 0 3px 0 rgba(255,255,255,.34);
      transition:transform .09s ease, box-shadow .09s ease;
    }
    .aro:active,.aro.press{transform:translateY(13px);box-shadow:0 3px 0 #4B060E,0 6px 16px rgba(214,19,42,.3),inset 0 3px 0 rgba(255,255,255,.2)}
    .aro:focus-visible{outline:4px solid #E8B437;outline-offset:8px}
    .aro span{font-size:clamp(28px,8.6vw,40px);font-weight:900;letter-spacing:-.01em;
      transform:skewX(-8deg);text-shadow:0 3px 0 rgba(0,0,0,.32)}
    /* Anillo de carga: se completa manteniendo apretado */
    .anillo{position:absolute;inset:-13px;border-radius:50%;pointer-events:none;
      background:conic-gradient(#E8B437 var(--p,0%), transparent 0);
      -webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 6px),#000 calc(100% - 5px));
      mask:radial-gradient(farthest-side,transparent calc(100% - 6px),#000 calc(100% - 5px));
      opacity:0;transition:opacity .12s}
    .aro.press .anillo{opacity:1}
    .instruccion{font-size:19px;font-weight:800;line-height:1.35;max-width:15em}
    .instruccion em{font-style:normal;color:#E8B437;display:block;font-size:15px;font-weight:700;margin-top:7px}
    .reloj{font-size:12px;letter-spacing:.14em;color:#6E7488;font-weight:800;font-variant-numeric:tabular-nums}
    .cargando{opacity:.4;pointer-events:none}
  `;

  const cuerpo = `
  <main>
    <p class="instruccion">Pará frente a la máquina<em>Manteé apretado para cargar tu tiro</em></p>

    <div class="aro" id="btn" role="button" tabindex="0" aria-label="Mantener apretado para activar el tiro">
      <div class="anillo" id="anillo"></div>
      <span>ACTIVAR</span>
    </div>

    <p class="reloj" id="reloj"></p>
  </main>
  <footer>CÓDIGO ${codigo} &middot; 1 SOLO USO</footer>

  <script>
  (function(){
    var btn=document.getElementById('btn'),anillo=document.getElementById('anillo');
    var reloj=document.getElementById('reloj'),restante=${segundosRestantes};
    var t0=null,raf=null,enviado=false;
    var DURACION=400;

    function tick(){
      var m=Math.floor(restante/60),s=restante%60;
      reloj.textContent= restante>0 ? ('EXPIRA EN '+m+':'+(s<10?'0':'')+s) : 'EXPIRADO';
      if(restante<=0){btn.classList.add('cargando');return;}
      restante--;setTimeout(tick,1000);
    }
    tick();

    function frame(ts){
      if(t0===null)t0=ts;
      var p=Math.min((ts-t0)/DURACION,1);
      anillo.style.setProperty('--p',(p*100)+'%');
      if(p>=1){soltarOK();return;}
      raf=requestAnimationFrame(frame);
    }
    function empezar(e){
      if(enviado||restante<=0)return;
      if(e&&e.cancelable)e.preventDefault();
      btn.classList.add('press');t0=null;raf=requestAnimationFrame(frame);
    }
    function cancelar(){
      if(enviado)return;
      cancelAnimationFrame(raf);btn.classList.remove('press');
      anillo.style.setProperty('--p','0%');t0=null;
    }
    function soltarOK(){
      if(enviado)return;enviado=true;
      cancelAnimationFrame(raf);btn.classList.add('cargando');
      if(navigator.vibrate)navigator.vibrate([28,50,90]);
      fetch('/activar/${codigo}',{method:'POST',credentials:'same-origin'})
        .then(function(r){return r.text()})
        .then(function(html){document.open();document.write(html);document.close();})
        .catch(function(){location.href='/c/${codigo}'});
    }

    btn.addEventListener('touchstart',empezar,{passive:false});
    btn.addEventListener('touchend',cancelar);
    btn.addEventListener('touchcancel',cancelar);
    btn.addEventListener('mousedown',empezar);
    btn.addEventListener('mouseup',cancelar);
    btn.addEventListener('mouseleave',cancelar);
    btn.addEventListener('keydown',function(e){if(e.key===' '||e.key==='Enter')empezar(e)});
    btn.addEventListener('keyup',cancelar);
  })();
  </script>`;

  return envolver('Activá tu tiro — BeerPunch', cuerpo, css);
}

/* --------- Pantalla 2: listo, pegá --------- */
function pantallaExito() {
  const css = `
    .titulo{animation:entra .42s cubic-bezier(.2,.9,.3,1.4) both}
    .ig-btn{display:inline-flex;align-items:center;gap:8px;margin-top:13px;
      background:#E8B437;color:#171A22;text-decoration:none;
      padding:13px 22px;border-radius:11px;font-size:15px;font-weight:900;
      letter-spacing:-.01em;box-shadow:0 4px 0 #A87C15;transition:transform .09s,box-shadow .09s}
    .ig-btn:active{transform:translateY(4px);box-shadow:0 0 0 #A87C15}
    .ig-btn:focus-visible{outline:3px solid #fff;outline-offset:3px}
    .ig-btn svg{width:18px;height:18px;flex:none}
    @keyframes entra{from{opacity:0;transform:skewX(-8deg) scale(.7)}to{opacity:1;transform:skewX(-8deg) scale(1)}}
    .ig{margin-top:6px;border:2px solid #E8B437;border-radius:13px;padding:15px 17px;max-width:20em}
    .ig p{font-size:14.5px;line-height:1.5;color:#D6D9E3}
    .ig b{color:#E8B437;display:block;font-size:15px;margin-bottom:5px;letter-spacing:.02em}
  `;
  const cuerpo = `
  <main>
    <h1 class="titulo">¡DALE!</h1>
    <p class="bajada">Tu tiro ya está cargado en la máquina.<br><strong>Pegá.</strong></p>
    <div class="ig">
      <p><b>¿Superás el récord?</b>Filmate y subilo a IG etiquetando <span class="dorado">${CONFIG.IG}</span> — te ganás una birrita.</p>
    </div>
    <a class="ig-btn" href="${CONFIG.IG_URL}" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" fill="none" stroke="#171A22" stroke-width="2.1"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2" y="2" width="20" height="20" rx="5"/>
        <circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.1" fill="#171A22"/>
      </svg>
      Seguinos en Instagram
    </a>
    ${bloquePrecios()}
  </main>
  <footer>BEERLIN &times; BEERPUNCH</footer>`;
  return envolver('¡Dale! — BeerPunch', cuerpo, css);
}

/* --------- Pantallas de error (dirigen, no se disculpan) --------- */
function pantallaMensaje(titulo, bajada, pie, sinPrecios) {
  const cuerpo = `
  <main>
    <h1 class="titulo">${titulo}</h1>
    <p class="bajada">${bajada}</p>
    ${sinPrecios ? '' : bloquePrecios()}
  </main>
  <footer>${pie || 'BEERLIN &times; BEERPUNCH'}</footer>`;
  return envolver(titulo + ' — BeerPunch', cuerpo);
}

const P_USADO = () => pantallaMensaje(
  'YA SE USÓ',
  'Este cupón es de un solo uso y ya lo activaron.<br><strong>Pedile otro a tu mozo.</strong>'
);

const P_INVALIDO = () => pantallaMensaje(
  'NO EXISTE',
  'Este código no figura en el sistema.<br><strong>Mostrale el cupón a tu mozo.</strong>'
);

const P_CERRADO = () => pantallaMensaje(
  'AHORA NO',
  'Los tiros gratis se activan mientras el bar está abierto.<br>Tu cupón <strong>sigue vivo</strong> — guardalo y volvé.',
  'TU CUPÓN NO SE GASTÓ'
);

const P_EXPIRADO = () => pantallaMensaje(
  'SE PASÓ',
  'Pasaron más de ' + CONFIG.MINUTOS_PARA_ACTIVAR + ' minutos desde que lo escaneaste.<br><strong>Pedile otro a tu mozo.</strong>'
);

const P_FRENADO = () => pantallaMensaje(
  'UN SEGUNDO',
  'La máquina está frenada en este momento.<br><strong>Avisale al mozo</strong> — tu cupón sigue sirviendo.',
  'TU CUPÓN NO SE GASTÓ'
);

const P_PREVIEW = () => pantallaMensaje(
  '¿TE ANIMÁS?',
  'Un tiro gratis en la máquina <strong>BeerPunch</strong>, en Beerlin.<br>Escaneá el cupón parado frente a la máquina.',
  null, true
);

/* ============================================================
   RUTAS
   ============================================================ */
module.exports = function crearActivaciones(deps) {
  deps = deps || {};

  // Si server.js no pasa agregarFichas, avisamos fuerte en el log
  // en vez de fallar silenciosamente (una activación perdida es plata).
  const agregarFichas = deps.agregarFichas || function () {
    console.error('[ACT] ¡FALTA agregarFichas! La ficha NO se encoló.');
    return false;
  };

  const router = express.Router();

  /* ---------- PASO 1: escanear (quema el código) ---------- */
  function manejarEscaneo(req, res) {
    const codigo = String(req.params.codigo || '').toUpperCase().trim();

    // Previews de WhatsApp/IG: mostramos algo lindo pero NO quemamos nada.
    if (esBot(req)) return res.status(200).send(P_PREVIEW());

    const item = db.codigos[codigo];
    if (!item) {
      console.log('[ACT] Código inexistente:', codigo);
      return res.status(404).send(P_INVALIDO());
    }

    const sesionCookie = leerCookie(req, 'bpk_' + codigo);

    // --- Ya fue escaneado antes ---
    if (item.estado !== 'virgen') {
      if (item.estado === 'activado') return res.send(P_USADO());

      const mismaPersona = sesionCookie && sesionCookie === item.sesion;
      const minutos = (Date.now() - new Date(item.escaneadoEn).getTime()) / 60000;

      // El mismo celular que lo escaneó puede volver a ver el botón
      // (se le apagó la pantalla, se le cerró el navegador, etc.).
      // Otro celular NO: ahí está el bloqueo al compartir.
      if (mismaPersona && minutos < CONFIG.MINUTOS_PARA_ACTIVAR) {
        const restante = Math.max(0, Math.round((CONFIG.MINUTOS_PARA_ACTIVAR - minutos) * 60));
        return res.send(pantallaActivar(codigo, restante));
      }
      if (mismaPersona) return res.send(P_EXPIRADO());
      return res.send(P_USADO());
    }

    // --- Está virgen: chequeo la ventana ANTES de quemar ---
    // Clave: si está cerrado, el cupón NO se gasta. Alguien que escanea
    // un martes por curiosidad no pierde su tiro.
    const noche = ventanaAbierta();
    if (!noche) {
      console.log('[ACT] Escaneo fuera de ventana:', codigo);
      return res.send(P_CERRADO());
    }

    /* ==== QUEMA ATÓMICA ====
       Todo lo que sigue es SÍNCRONO. Node es single-thread: entre estas
       líneas no puede colarse otro request. Recién después de dejar el
       estado en 'escaneado' se hace cualquier cosa async (guardar, loguear).
       Este es el MISMO patrón que arregló la ráfaga de créditos.        */
    const token = nuevoToken();
    item.estado = 'escaneado';
    item.escaneadoEn = new Date().toISOString();
    item.noche = noche;
    item.sesion = token;
    /* ==== fin del bloque atómico ==== */

    guardarDB();
    console.log('[ACT] Escaneado', codigo, '— noche', noche);

    res.setHeader('Set-Cookie',
      'bpk_' + codigo + '=' + token + '; Max-Age=' + (CONFIG.MINUTOS_PARA_ACTIVAR * 60) +
      '; Path=/; SameSite=Lax');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    return res.send(pantallaActivar(codigo, CONFIG.MINUTOS_PARA_ACTIVAR * 60));
  }

  router.get('/c/:codigo', manejarEscaneo);
  router.get('/canjear/:codigo', manejarEscaneo);

  /* ---------- PASO 2: activar (encola la ficha) ---------- */
  router.post('/activar/:codigo', function (req, res) {
    const codigo = String(req.params.codigo || '').toUpperCase().trim();
    const item = db.codigos[codigo];

    if (!item) return res.status(404).send(P_INVALIDO());
    if (item.estado === 'activado') return res.send(P_USADO());
    if (item.estado === 'virgen') return res.send(P_INVALIDO());

    const sesionCookie = leerCookie(req, 'bpk_' + codigo);
    if (!sesionCookie || sesionCookie !== item.sesion) return res.send(P_USADO());

    const minutos = (Date.now() - new Date(item.escaneadoEn).getTime()) / 60000;
    if (minutos > CONFIG.MINUTOS_PARA_ACTIVAR) return res.send(P_EXPIRADO());

    /* ==== MARCA ATÓMICA, ANTES DE ENCOLAR ====
       Si dos POST entraran casi juntos, el segundo ya encuentra 'activado'.
       Marcar primero y acreditar después: nunca al revés.                */
    item.estado = 'activado';
    item.activadoEn = new Date().toISOString();
    /* ==== fin del bloque atómico ==== */

    guardarDB();

    /* agregarFichas del server devuelve false si el sistema está en /pausa,
       si se activó el corte automático o si se llegó al tope de la ventana.
       En ese caso la ficha NO cae, así que sería una estafa mostrar "¡DALE!"
       y consumir el cupón. Se devuelve el código al estado anterior para que
       la persona pueda reintentar cuando el sistema vuelva.
       No reabre la carrera: un segundo POST simultáneo ya vio 'activado'.  */
    let entregada = false;
    try {
      entregada = agregarFichas(CONFIG.FICHAS_POR_CUPON, 'activacion:' + codigo) !== false;
    } catch (e) {
      console.error('[ACT] Falló agregarFichas para', codigo, e.message);
      entregada = false;
    }

    if (!entregada) {
      item.estado = 'escaneado';
      item.activadoEn = null;
      guardarDB();
      console.log('[ACT] NO ENTREGADA', codigo, '— sistema frenado o tope. Cupón devuelto.');
      return res.send(P_FRENADO());
    }

    console.log('[ACT] ACTIVADO', codigo, '— +' + CONFIG.FICHAS_POR_CUPON + ' ficha');
    return res.send(pantallaExito());
  });

  /* ---------- MÉTRICAS ---------- */
  function calcularMetricas() {
    const codigos = Object.values(db.codigos);
    const total = codigos.length;
    const virgenes = codigos.filter((c) => c.estado === 'virgen').length;
    const escaneados = codigos.filter((c) => c.estado !== 'virgen').length;
    const activados = codigos.filter((c) => c.estado === 'activado').length;
    const colgados = escaneados - activados;

    const noches = {};
    codigos.filter((c) => c.noche).forEach((c) => {
      if (!noches[c.noche]) noches[c.noche] = { escaneados: 0, activados: 0, horas: [] };
      noches[c.noche].escaneados++;
      if (c.estado === 'activado') noches[c.noche].activados++;
      noches[c.noche].horas.push(horaLegible(c.escaneadoEn));
    });

    return {
      lote: db.lote,
      total, virgenes, escaneados, activados, colgados,
      conversion: escaneados ? Math.round((activados / escaneados) * 100) : 0,
      alertaStock: virgenes <= CONFIG.ALERTA_STOCK && total > 0,
      ventana: ventanaAbierta(),
      noches: Object.keys(noches).sort().reverse().map((n) => ({
        noche: n,
        escaneados: noches[n].escaneados,
        activados: noches[n].activados,
        horas: noches[n].horas.sort(),
      })),
    };
  }

  function chequearToken(req, res) {
    const dada = String(req.query.clave || req.query.token || '');
    if (dada !== CONFIG.TOKEN_PANEL) {
      res.status(401).send('Falta la clave. Agregá ?clave=... a la URL.');
      return false;
    }
    return true;
  }

  router.get('/activaciones/json', function (req, res) {
    if (!chequearToken(req, res)) return;
    res.json(calcularMetricas());
  });

  router.get('/activaciones', function (req, res) {
    if (!chequearToken(req, res)) return;
    const m = calcularMetricas();

    const diaSemana = (iso) => {
      const d = new Date(iso + 'T12:00:00Z');
      return ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][d.getUTCDay()];
    };

    const css = `
      body{justify-content:flex-start;text-align:left;padding:20px 18px 40px;font-size:15px}
      main{align-items:stretch;justify-content:flex-start;text-align:left;gap:16px;width:100%;max-width:620px;margin:16px auto 0}
      h1{font-size:30px;font-weight:900;transform:skewX(-8deg);text-shadow:3px 3px 0 #D6132A;margin-bottom:2px}
      .sub{font-size:11px;letter-spacing:.16em;color:#6E7488;font-weight:800}
      .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
      .card{background:#191C24;border:1px solid #262A36;border-radius:13px;padding:15px}
      .card .n{font-size:33px;font-weight:900;line-height:1;font-variant-numeric:tabular-nums}
      .card .l{font-size:10.5px;letter-spacing:.14em;color:#7A8093;font-weight:800;margin-top:7px}
      .card.wide{grid-column:1/-1}
      .card.oro{border-color:#E8B437}.card.oro .n{color:#E8B437}
      .card.alerta{border-color:#D6132A;background:#20141A}.card.alerta .n{color:#FF4257}
      .estado{border-radius:11px;padding:12px 15px;font-size:13px;font-weight:800;letter-spacing:.03em}
      .abierta{background:#12251A;border:1px solid #1F7A45;color:#4ADE80}
      .cerrada{background:#191C24;border:1px solid #262A36;color:#7A8093}
      table{width:100%;border-collapse:collapse;margin-top:4px}
      th{font-size:10px;letter-spacing:.13em;color:#7A8093;text-align:left;padding:0 0 9px;font-weight:800}
      td{padding:11px 0;border-top:1px solid #262A36;font-size:14px;vertical-align:top}
      td.num{font-variant-numeric:tabular-nums;font-weight:800;white-space:nowrap}
      .horas{color:#7A8093;font-size:11.5px;line-height:1.65;font-variant-numeric:tabular-nums;margin-top:3px}
      .vacio{color:#7A8093;font-size:14px;padding:14px 0}
    `;

    const filas = m.noches.length
      ? m.noches.map((n) => `<tr>
          <td><b>${diaSemana(n.noche)}</b> ${n.noche.slice(8)}/${n.noche.slice(5, 7)}
            <div class="horas">${n.horas.join(' · ')}</div></td>
          <td class="num">${n.escaneados}</td>
          <td class="num" style="color:#E8B437">${n.activados}</td>
        </tr>`).join('')
      : `<tr><td colspan="3" class="vacio">Todavía no se escaneó ningún cupón.</td></tr>`;

    const cuerpo = `
    <main>
      <div>
        <h1>ACTIVACIONES</h1>
        <div class="sub">LOTE ${m.lote || '—'} &middot; ${m.total} CUPONES</div>
      </div>

      <div class="estado ${m.ventana ? 'abierta' : 'cerrada'}">
        ${m.ventana ? '● VENTANA ABIERTA — se pueden activar tiros' : '○ Fuera de horario — se activan de ' + CONFIG.HORA_INICIO + ' a ' + CONFIG.HORA_FIN}
      </div>

      <div class="grid">
        <div class="card ${m.alertaStock ? 'alerta' : ''}">
          <div class="n">${m.virgenes}</div>
          <div class="l">${m.alertaStock ? '⚠ QUEDAN POCOS' : 'SIN ESCANEAR'}</div>
        </div>
        <div class="card"><div class="n">${m.escaneados}</div><div class="l">ESCANEADOS</div></div>
        <div class="card oro"><div class="n">${m.activados}</div><div class="l">TIROS ACTIVADOS</div></div>
        <div class="card"><div class="n">${m.colgados}</div><div class="l">ESCANEÓ Y NO PEGÓ</div></div>
        <div class="card wide">
          <div class="n">${m.conversion}<span style="font-size:19px">%</span></div>
          <div class="l">ESCANEÓ → ACTIVÓ</div>
        </div>
      </div>

      <table>
        <tr><th>NOCHE</th><th>ESCAN.</th><th>ACTIV.</th></tr>
        ${filas}
      </table>
    </main>`;

    res.setHeader('Cache-Control', 'no-store');
    res.send(envolver('Activaciones — BeerPunch', cuerpo, css));
  });

  /* ---------- IMPORTAR UN LOTE NUEVO ---------- */
  // Se usa una vez por lote. Pegar el contenido de codigos.json.
  // No pisa códigos que ya existen: si repetís el lote, los ya
  // escaneados siguen escaneados.
  router.post('/activaciones/importar', express.json({ limit: '2mb' }), function (req, res) {
    if (!chequearToken(req, res)) return;
    const nuevo = req.body;
    if (!nuevo || !Array.isArray(nuevo.codigos)) {
      return res.status(400).json({ error: 'Esperaba {"lote":"L1","codigos":["BPK-XXXX",...]}' });
    }

    let agregados = 0, existentes = 0;
    nuevo.codigos.forEach((c) => {
      const cod = String(c).toUpperCase().trim();
      if (db.codigos[cod]) { existentes++; return; }
      db.codigos[cod] = {
        lote: nuevo.lote || 'L1',
        estado: 'virgen',
        escaneadoEn: null,
        activadoEn: null,
        noche: null,
        sesion: null,
      };
      agregados++;
    });

    db.lote = nuevo.lote || db.lote || 'L1';
    db.generadoEn = db.generadoEn || new Date().toISOString();
    guardarDB();

    console.log('[ACT] Importados', agregados, 'códigos nuevos (', existentes, 'ya existían )');
    res.json({ ok: true, agregados, existentes, total: Object.keys(db.codigos).length });
  });

  /* ---------- CARGAR UN LOTE DESDE EL NAVEGADOR ----------
     El importador por POST necesita curl desde una compu. Este pega los
     códigos por la URL, que es lo único que se puede hacer desde el celular.
     Mismo comportamiento: no pisa códigos que ya existen.                */
  router.get('/activaciones/cargar', function (req, res) {
    if (!chequearToken(req, res)) return;

    const lista = String(req.query.codigos || '')
      .split(/[\s,;]+/)
      .map(function (c) { return c.toUpperCase().trim(); })
      .filter(Boolean);

    if (!lista.length) {
      return res.type('text/plain').send(
        'Faltan códigos.\n\n' +
        'Uso: /activaciones/cargar?clave=TU_CLAVE&lote=L1&codigos=ABC12,DEF34,GHI56\n' +
        '(separados por coma, sin espacios)'
      );
    }

    let agregados = 0, existentes = 0;
    const lote = String(req.query.lote || 'L1').toUpperCase();
    lista.forEach(function (cod) {
      if (db.codigos[cod]) { existentes++; return; }
      db.codigos[cod] = {
        lote: lote, estado: 'virgen', escaneadoEn: null,
        activadoEn: null, noche: null, sesion: null,
      };
      agregados++;
    });

    db.lote = lote;
    db.generadoEn = db.generadoEn || new Date().toISOString();
    guardarDB();
    console.log('[ACT] Cargados por URL:', agregados, 'nuevos,', existentes, 'ya existían');

    res.type('text/plain').send(
      'LISTO\n\n' +
      'Lote: ' + lote + '\n' +
      'Agregados: ' + agregados + '\n' +
      'Ya existían (no se tocaron): ' + existentes + '\n' +
      'Total en el sistema: ' + Object.keys(db.codigos).length
    );
  });

  console.log('[ACT] Sistema de activaciones montado. Datos en', ARCHIVO,
    CONFIG.MODO_PRUEBA ? '— ⚠ MODO PRUEBA (sin ventana horaria)' : '');

  return router;
};

module.exports.CONFIG = CONFIG;
