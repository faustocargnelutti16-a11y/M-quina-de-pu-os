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

const ARO_BPK = 'data:image/png;base64,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';

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
    /* El botón es la chapita de BeerPunch: el mismo objeto que ven en el
       cupón y en el logo. La corona va como imagen y el centro se rellena
       para que el texto se lea sobre algo sólido. */
    .aro{
      position:relative;width:min(76vw,300px);aspect-ratio:1;
      display:grid;place-items:center;cursor:pointer;user-select:none;
      background-image:url('__ARO__');
      background-size:contain;background-repeat:no-repeat;background-position:center;
      filter:drop-shadow(0 14px 22px rgba(214,19,42,.42));
      transition:transform .09s ease, filter .09s ease;
    }
    /* Relleno del hueco de la chapita */
    .aro::before{
      content:'';position:absolute;width:72%;height:72%;border-radius:50%;
      background:radial-gradient(circle at 50% 36%,#E8213B 0%,#B10E22 64%,#7C0A17 100%);
      box-shadow:inset 0 3px 0 rgba(255,255,255,.3), inset 0 -6px 14px rgba(0,0,0,.35);
    }
    .aro span{position:relative;z-index:2}
    .aro:active,.aro.press{transform:translateY(10px) scale(.985);
      filter:drop-shadow(0 5px 10px rgba(214,19,42,.3))}
    .aro:focus-visible{outline:4px solid #E8B437;outline-offset:8px}
    .aro span{font-size:clamp(28px,8.6vw,40px);font-weight:900;letter-spacing:-.01em;
      transform:skewX(-8deg);text-shadow:0 3px 0 rgba(0,0,0,.32)}
    /* Anillo de carga: se completa manteniendo apretado */
    .anillo{position:absolute;inset:-15px;border-radius:50%;pointer-events:none;
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

  return envolver('Activá tu tiro — BeerPunch', cuerpo, css.replace('__ARO__', ARO_BPK));
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
  'Este cupón es de un solo uso y ya lo activaron.'
);

const P_INVALIDO = () => pantallaMensaje(
  'NO EXISTE',
  'Este código no figura en el sistema.'
);

const P_CERRADO = () => pantallaMensaje(
  'AHORA NO',
  'Los tiros gratis se activan mientras el bar está abierto.<br>Tu cupón <strong>sigue vivo</strong> — guardalo y volvé.',
  'TU CUPÓN NO SE GASTÓ'
);

const P_EXPIRADO = () => pantallaMensaje(
  'SE PASÓ',
  'Pasaron más de ' + CONFIG.MINUTOS_PARA_ACTIVAR + ' minutos desde que lo escaneaste.'
);

const P_FRENADO = () => pantallaMensaje(
  'UN SEGUNDO',
  'La máquina está frenada por un momento.<br><strong>Tu cupón sigue sirviendo.</strong>',
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
