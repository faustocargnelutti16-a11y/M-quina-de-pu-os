// ============================================================
// BPK / BeerPunch - modulo de PIÑAS
// ------------------------------------------------------------
// Se monta encima del server que ya cobra. No toca Mercado Pago,
// no toca el Shelly, no toca las ordenes. Si este modulo falla,
// el cobro sigue funcionando igual.
//
// En server.js, dos lineas y nada mas:
//
//   const montarPinas = require('./pinas');
//   montarPinas(app, {
//     DATA_DIR, persistenciaOk, log, rutina, claveOk,
//     enHorarioDeBar, inicioJornada, agregarFichas, avisar, BASE_URL
//   });
//
// Ponerlas DESPUES de que esas funciones esten definidas y ANTES
// del app.listen.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function montarPinas(app, ctx) {

  // Si el server no nos pasa algo, seguimos igual con un reemplazo inofensivo.
  const DATA_DIR       = ctx.DATA_DIR || '/data';
  const persistenciaOk = !!ctx.persistenciaOk;
  const log            = ctx.log    || function (t, m) { console.log(t + ' | ' + m); };
  const rutina         = ctx.rutina || function () {};
  const claveOk        = ctx.claveOk || function () { return true; };
  const enHorario      = ctx.enHorarioDeBar || function () { return true; };
  const inicioJornada  = ctx.inicioJornada || function () { return Date.now() - 12 * 3600e3; };
  const agregarFichas  = ctx.agregarFichas || function () { return false; };
  const avisar         = ctx.avisar || function () {};

  // ===== CONFIG =====
  const APROBACION_MANUAL = false;   // true = la piña espera visto bueno antes de entrar al ranking
  const TOP               = 10;
  const MAX_FOTO_BYTES    = 900 * 1024;
  const DIAS_QUE_GUARDAMOS = 120;
  const MAX_PREMIOS_NOCHE  = 25;     // techo duro de premios por noche
  const MAX_TIROS_PREMIO   = 2;      // ningún premio puede soltar más que esto

  // ===== LA RULETA VIVE ACÁ, NO EN EL CELULAR =====
  // El orden tiene que ser IDÉNTICO al del array GAJOS de publico/carga.html:
  // el server elige el gajo y el celular solo lo dibuja.
  const RULETA = [
    { t: '$100.000',              peso: 0.02,    premio: true },   // 1 cada 5.000
    { t: 'SEGUÍ\nPARTICIPANDO',   peso: 16.0128 },
    { t: 'COMBO DE\nFERNET',      peso: 0.07,    premio: true },   // 1 cada 1.429
    { t: 'SEGUÍ\nPARTICIPANDO',   peso: 16.0128 },
    { t: '2 BIRRITAS',            peso: 0.3333,  premio: true },   // 1 cada 300
    { t: 'SEGUÍ\nPARTICIPANDO',   peso: 16.0128 },
    { t: 'DEVOLUCIÓN\n$2.000',    peso: 0.5,     premio: true },   // 1 cada 200
    { t: 'SEGUÍ\nPARTICIPANDO',   peso: 16.0128 },
    { t: 'BIRRITA\nGRATIS',       peso: 1,       premio: true },   // 1 cada 100
    { t: 'SEGUÍ\nPARTICIPANDO',   peso: 16.0128 },
    { t: 'TIRO\nGRATIS',          peso: 2,       premio: true },   // 1 cada 50
    { t: 'SEGUÍ\nPARTICIPANDO',   peso: 16.0128 }
  ];
  const SEGUI_OTROS = [5, 7, 9, 11];

  // Azar impredecible: esto decide quien se lleva plata, asi que no usamos
  // Math.random (rapido pero adivinable) sino el generador criptografico.
  function azar() { return crypto.randomInt(0, 1000000) / 1000000; }

  // Gajo perdedor. Cae sobre todo pegado a los premios gordos para que el
  // "casi" tenga sentido. No cambia las chances de ganar de nadie.
  function gajoPerdedor() {
    const r = azar();
    if (r < 0.44) return 1;
    if (r < 0.74) return 3;
    return SEGUI_OTROS[Math.floor(azar() * SEGUI_OTROS.length) % SEGUI_OTROS.length];
  }

  function girarServidor() {
    const tot = RULETA.reduce(function (a, g) { return a + g.peso; }, 0);
    let x = azar() * tot;
    for (let i = 0; i < RULETA.length; i++) {
      x -= RULETA[i].peso;
      if (x <= 0) return RULETA[i].premio ? i : gajoPerdedor();
    }
    return gajoPerdedor();
  }

  const F_PINAS   = path.join(DATA_DIR, 'pinas.json');
  const F_PREMIOS = path.join(DATA_DIR, 'premios.json');
  const DIR_FOTOS = path.join(DATA_DIR, 'fotos');
  const DIR_WEB   = path.join(__dirname, 'publico');

  // ===== PERSISTENCIA (mismo criterio que el server: si no hay volumen, no mentimos) =====
  function leer(archivo, porDefecto) {
    if (!persistenciaOk) return porDefecto;
    try {
      if (!fs.existsSync(archivo)) return porDefecto;
      return JSON.parse(fs.readFileSync(archivo, 'utf8'));
    } catch (e) { return porDefecto; }
  }

  let pinas   = leer(F_PINAS, []);
  let premios = leer(F_PREMIOS, []);

  if (persistenciaOk) {
    try { if (!fs.existsSync(DIR_FOTOS)) fs.mkdirSync(DIR_FOTOS, { recursive: true }); }
    catch (e) { rutina('PINAS', 'no se pudo crear la carpeta de fotos: ' + e.message); }
  }

  // Escritura demorada: si entran 5 piñas seguidas no castigamos el disco 5 veces.
  // Escritura segura: se escribe en un archivo temporal y recien cuando
  // esta completo se lo renombra encima del bueno. Renombrar es instantaneo,
  // asi que un corte a mitad de camino deja el archivo viejo entero en vez
  // de dejar uno roto (que se leeria como "no hay nada" y borraria todo).
  function escribirAtomico(archivo, texto) {
    const tmp = archivo + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, texto); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, archivo);
  }

  let guardando = false;
  function guardar() {
    if (!persistenciaOk || guardando) return;
    guardando = true;
    setTimeout(function () {
      guardando = false;
      try {
        escribirAtomico(F_PINAS, JSON.stringify(pinas));
        escribirAtomico(F_PREMIOS, JSON.stringify(premios));
      } catch (e) { rutina('PINAS', 'error guardando: ' + e.message); }
    }, 2000);
  }

  // ===== HERRAMIENTAS =====
  // "EL TANO", "el  tano" y "El Tanó" son la misma persona. Sin esto, el
  // mismo tipo puede ocupar tres lugares del top escribiendolo distinto.
  function clavePersona(apodo) {
    return String(apodo || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  const limpiar = function (s, n) {
    return String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n || 20);
  };

  // La noche del bar arranca al mediodia, igual que la jornada de ventas del
  // server. Calculamos el desfase de forma explicita para no depender de en
  // que zona horaria este corriendo el proceso.
  function nocheDe(ts) {
    const real = new Date(ts);
    const arg = new Date(real.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    if (arg.getHours() < 12) arg.setDate(arg.getDate() - 1);
    const y = arg.getFullYear();
    const m = String(arg.getMonth() + 1).padStart(2, '0');
    const d = String(arg.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  const nocheHoy = function () { return nocheDe(Date.now()); };

  const visible = function (p) { return !p.oculta && (p.aprobada || !APROBACION_MANUAL); };

  // Del ranking sale el MEJOR golpe de cada persona, no todos sus intentos.
  // Si no, el que compra 20 tiros llena la tabla solo y no queda lugar para nadie.
  function mejorPorPersona(lista, n) {
    const mejores = new Map();
    lista.forEach(function (p) {
      const k = clavePersona(p.apodo);
      if (!mejores.has(k) || mejores.get(k).score < p.score) mejores.set(k, p);
    });
    return Array.from(mejores.values())
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, n || TOP)
      .map(function (p) { return { id: p.id, nombre: p.apodo, ig: p.ig || '', score: p.score }; });
  }

  function estado() {
    const hoy = nocheHoy();
    const dela = pinas.filter(function (p) { return visible(p) && p.noche === hoy; });
    const todas = pinas.filter(visible);
    const record = todas.reduce(function (a, p) { return (!a || p.score > a.score) ? p : a; }, null);
    return {
      noche:     mejorPorPersona(dela),
      mujeres:   mejorPorPersona(dela.filter(function (p) { return p.sexo === 'F'; })),
      historico: mejorPorPersona(todas),
      record:    record ? { score: record.score, nombre: record.apodo } : { score: 0, nombre: null },
      pinas:     dela.length,
      ts: Date.now()
    };
  }

  // ===== CANAL EN VIVO HACIA EL TOTEM =====
  const clientes = new Set();
  function emitir(tipo, dato) {
    const bloque = 'event: ' + tipo + '\ndata: ' + JSON.stringify(dato) + '\n\n';
    clientes.forEach(function (res) {
      try { res.write(bloque); } catch (e) { clientes.delete(res); }
    });
  }

  app.get('/api/stream', function (req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    res.write('event: estado\ndata: ' + JSON.stringify(estado()) + '\n\n');
    clientes.add(res);
    req.on('close', function () { clientes.delete(res); });
  });

  // Latido: mantiene viva la conexion con el tótem toda la noche.
  setInterval(function () { emitir('ping', { t: Date.now() }); }, 25000);

  app.get('/api/estado', function (req, res) { res.json(estado()); });

  // ===== FOTOS =====
  // Van a disco, no adentro del JSON: una foto en base64 dentro del archivo
  // de piñas lo haria pesar megas y ralentizaria cada guardado.
  function guardarFoto(id, dataURL) {
    if (!persistenciaOk || !dataURL) return null;
    try {
      const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i.exec(String(dataURL));
      if (!m) return null;
      const bin = Buffer.from(m[2], 'base64');
      if (bin.length > MAX_FOTO_BYTES) return null;
      const nombre = id + '.' + (m[1].toLowerCase() === 'png' ? 'png' : 'jpg');
      fs.writeFileSync(path.join(DIR_FOTOS, nombre), bin);
      return nombre;
    } catch (e) { rutina('PINAS', 'foto: ' + e.message); return null; }
  }

  app.get('/api/foto/:archivo', function (req, res) {
    if (!claveOk(req)) return res.status(401).send('clave');
    const n = path.basename(String(req.params.archivo || ''));
    const f = path.join(DIR_FOTOS, n);
    if (!fs.existsSync(f)) return res.status(404).send('no está');
    res.sendFile(f);
  });

  // ===== CARGA DE UNA PIÑA (esto llama el celular del cliente) =====
  const ultimaCargaPorIP = {};
  // La libreta se vacia sola cada 10 min: antes crecia toda la noche.
  setInterval(function () {
    const viejo = Date.now() - 10 * 60 * 1000;
    Object.keys(ultimaCargaPorIP).forEach(function (k) {
      if (ultimaCargaPorIP[k] < viejo) delete ultimaCargaPorIP[k];
    });
  }, 10 * 60 * 1000);

  app.post('/api/carga', function (req, res) {
    const b = req.body || {};
    const apodo = limpiar(b.apodo, 14).toUpperCase();
    const score = Math.floor(Number(b.score) || 0);
    const sexo  = (b.sexo === 'F') ? 'F' : 'M';

    if (!apodo)                    return res.status(400).json({ error: 'falta el apodo' });
    if (!(score > 0 && score <= 999)) return res.status(400).json({ error: 'el score va de 1 a 999' });

    // Freno simple contra el que aprieta enviar diez veces seguidas.
    const ip = req.headers['x-forwarded-for'] || req.ip || '?';
    const ahora = Date.now();
    if (ultimaCargaPorIP[ip] && ahora - ultimaCargaPorIP[ip] < 4000) {
      return res.status(429).json({ error: 'esperá unos segundos' });
    }
    ultimaCargaPorIP[ip] = ahora;

    // Si el celular reintenta porque se le corto la red a mitad de camino,
    // devolvemos la misma respuesta en vez de cargar la piña dos veces.
    const envio = limpiar(b.envio, 40);
    if (envio) {
      const repetida = pinas.find(function (p) { return p.envio === envio; });
      if (repetida) {
        const pr = premios.find(function (x) { return x.pina === repetida.id; });
        return res.json({
          ok: true, repetida: true,
          gajo: (typeof repetida.gajo === 'number') ? repetida.gajo : -1,
          premio: pr ? pr.premio : null,
          codigo: pr ? pr.codigo : null,
          puesto: 0, esRecord: false
        });
      }
    }

    // UN GIRO POR PERSONA POR NOCHE. Las piñas se cargan todas (el ranking
    // las necesita); lo que se usa una sola vez es la ruleta.
    const yaGiro = pinas.some(function (p) {
      return p.giro && p.noche === nocheHoy() && clavePersona(p.apodo) === clavePersona(apodo);
    });

    const id = 'p' + ahora.toString(36) + crypto.randomBytes(2).toString('hex');
    const foto = guardarFoto(id, b.foto);

    const previo = estado().record.score;

    const pina = {
      id: id,
      ts: ahora,
      noche: nocheHoy(),
      apodo: apodo,
      ig: limpiar(b.ig, 30),
      sexo: sexo,
      score: score,
      foto: foto,
      envio: envio || null,
      giro: !yaGiro,
      gajo: null,
      aprobada: !APROBACION_MANUAL,
      oculta: false,
      ip: String(ip).slice(0, 45)
    };
    pinas.push(pina);

    // Limpieza: no guardamos la historia entera para siempre.
    const limite = ahora - DIAS_QUE_GUARDAMOS * 24 * 3600e3;
    pinas = pinas.filter(function (p) { return p.ts > limite; });

    // ===== LA RULETA LA GIRA EL SERVIDOR =====
    // El celular NO decide nada: manda su piña, el server sortea, y le
    // devuelve en qué gajo tiene que frenar la rueda. Antes el celular
    // mandaba el premio y cualquiera podía pedir "4 TIROS" con un POST.
    // gajo = -1 significa "no le toca girar". El celular ya sabe leerlo:
    // muestra "PIÑA CARGADA / YA GIRASTE ESTA NOCHE" y no anima la rueda.
    let gajo = yaGiro ? -1 : girarServidor();
    let codigo = null;
    let nombrePremio = null;

    // Techo por noche. IMPORTANTE: si se llego al tope hay que mover el gajo
    // a uno perdedor. Si no, la rueda frena clavada en "$100.000" con la
    // musica de ganador y despues la pantalla dice que no gano nada.
    if (gajo >= 0 && RULETA[gajo].premio) {
      const premiosHoy = premios.filter(function (p) { return p.noche === nocheHoy(); }).length;
      if (premiosHoy >= MAX_PREMIOS_NOCHE) {
        log('PREMIO FRENADO', 'tope de ' + MAX_PREMIOS_NOCHE + ' premios en la noche');
        avisar('BPK - Tope de premios', 'Se llegó a ' + MAX_PREMIOS_NOCHE +
               ' premios en la noche. La ruleta deja de entregar hasta mañana.', true);
        gajo = gajoPerdedor();
      }
    }
    const g = gajo >= 0 ? RULETA[gajo] : null;

    if (g && g.premio) {
      {
        nombrePremio = g.t.replace(/\n/g, ' ');
        // Codigo que no se repita con otro vivo de la misma noche.
        const hoyCod = nocheHoy();
        const usados = {};
        premios.forEach(function (p) { if (p.noche === hoyCod) usados[p.codigo] = 1; });
        let intentos = 0;
        do { codigo = String(crypto.randomInt(1000, 10000)); intentos++; }
        while (usados[codigo] && intentos < 50);
        premios.push({
          id: 'x' + ahora.toString(36) + crypto.randomBytes(2).toString('hex'),
          codigo: codigo,
          premio: nombrePremio,
          apodo: apodo,
          ts: ahora,
          noche: nocheHoy(),
          entregado: false,
          entregadoTs: null,
          pina: id
        });
        log('PREMIO', nombrePremio + ' para ' + apodo + ' · código ' + codigo);
      }
    }

    pina.gajo = gajo;
    guardar();

    const esRecord = score > previo;
    const nuevo = estado();
    const puesto = nuevo.noche.findIndex(function (e) { return e.id === id; }) + 1;

    emitir(esRecord ? 'record' : 'golpe', {
      nombre: apodo, ig: pina.ig, score: score, esRecord: esRecord, sexo: sexo
    });
    emitir('estado', nuevo);

    log('PIÑA', apodo + ' ' + score + (esRecord ? ' RÉCORD' : '') + (puesto ? ' (#' + puesto + ')' : ''));

    if (esRecord && previo > 0) {
      avisar('BPK - Nuevo récord', apodo + ' hizo ' + score + ' puntos (antes ' + previo + ')', false);
    }

    res.json({ ok: true, gajo: gajo, premio: nombrePremio, codigo: codigo, puesto: puesto, esRecord: esRecord });
  });

  // ===== PREMIOS: lo que ve la caja =====
  app.get('/api/premios', function (req, res) {
    if (!claveOk(req)) return res.status(401).json({ error: 'clave' });
    const hoy = nocheHoy();
    const dia = premios.filter(function (p) { return p.noche === hoy; });
    res.json({
      pendientes: dia.filter(function (p) { return !p.entregado; })
                     .sort(function (a, b) { return b.ts - a.ts; }),
      entregados: dia.filter(function (p) { return p.entregado; })
                     .sort(function (a, b) { return b.entregadoTs - a.entregadoTs; }),
      totales: { hoy: dia.length, entregados: dia.filter(function (p) { return p.entregado; }).length }
    });
  });

  // Se busca por CÓDIGO, no por id: es lo que el cliente canta en la barra.
  app.post('/api/premios/entregar', function (req, res) {
    if (!claveOk(req)) return res.status(401).json({ error: 'clave' });
    const cod = limpiar((req.body || {}).codigo, 8);
    const hoy = nocheHoy();
    const p = premios.find(function (x) { return x.codigo === cod && x.noche === hoy; });

    if (!p)           return res.status(404).json({ error: 'ese código no existe en la noche de hoy' });
    if (p.entregado)  return res.status(409).json({ error: 'ya fue entregado', premio: p });

    p.entregado = true;
    p.entregadoTs = Date.now();

    // Si el premio son tiros, se cargan solos en la máquina usando la
    // misma cola que ya usa todo lo demás. La caja no toca nada más.
    let fichasOk = null;
    const m = /(\d+)\s*TIRO/i.exec(p.premio);
    if (m) fichasOk = agregarFichas(Math.min(MAX_TIROS_PREMIO, Number(m[1]) || 1), 'premio ruleta ' + p.codigo);
    else if (/TIRO/i.test(p.premio)) fichasOk = agregarFichas(1, 'premio ruleta ' + p.codigo);

    guardar();
    log('PREMIO ENTREGADO', p.premio + ' · código ' + p.codigo);
    res.json({ ok: true, premio: p, fichasOk: fichasOk });
  });

  // ===== MODERACIÓN =====
  app.get('/api/pinas', function (req, res) {
    if (!claveOk(req)) return res.status(401).json({ error: 'clave' });
    const hoy = nocheHoy();
    res.json(pinas.filter(function (p) { return p.noche === hoy; })
                  .sort(function (a, b) { return b.ts - a.ts; }));
  });

  app.post('/api/pinas/:id/ocultar', function (req, res) {
    if (!claveOk(req)) return res.status(401).json({ error: 'clave' });
    const p = pinas.find(function (x) { return x.id === req.params.id; });
    if (!p) return res.status(404).json({ error: 'no existe' });
    p.oculta = !p.oculta;
    guardar();
    emitir('estado', estado());
    log('PIÑA', (p.oculta ? 'ocultada' : 'restaurada') + ': ' + p.apodo + ' ' + p.score);
    res.json({ ok: true, oculta: p.oculta });
  });

  // ===== PANTALLA DE MODERACION (la de Aldana) =====
  // Las pinas de la noche con la foto al lado y un boton para ocultar.
  // Pensada para el celular, detras de la clave.
  const HTML_FOTOS = [
'<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
'<meta name="color-scheme" content="dark"><title>BeerPunch · Piñas de la noche</title>',
'<style>',
'*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
'body{background:#0a0b10;color:#fff;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;',
'  padding:0 14px calc(40px + env(safe-area-inset-bottom));max-width:620px;margin:0 auto}',
'header{position:sticky;top:0;background:#0a0b10;padding:18px 0 12px;border-bottom:1px solid #23262f;z-index:5}',
'h1{font-size:19px;letter-spacing:.5px}h1 span{color:#D7252A}',
'.sub{color:#8b93a1;font-size:13px;margin-top:3px}',
'.fila{display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid #191c23}',
'.fila.off{opacity:.4}',
'.foto{width:74px;height:74px;flex:none;border-radius:10px;object-fit:cover;background:#161922;border:1px solid #23262f}',
'.foto.sin{display:flex;align-items:center;justify-content:center;font-size:10px;color:#5b6270;text-align:center}',
'.dat{flex:1;min-width:0}',
'.nom{font-weight:700;letter-spacing:.6px;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.meta{color:#8b93a1;font-size:12.5px;margin-top:2px}',
'.sc{font-weight:800;font-size:21px;color:#FFD518;font-variant-numeric:tabular-nums}',
'.f{background:#F1437B22;color:#F1437B;border-radius:20px;padding:1px 7px;font-size:11px;font-weight:700}',
'button.ac{flex:none;border:1px solid #3a4150;background:#161922;color:#c7cdd6;border-radius:9px;',
'  padding:10px 12px;font-size:12.5px;font-weight:700;letter-spacing:.5px;cursor:pointer}',
'button.ac.on{border-color:#D7252A;background:#D7252A22;color:#ff8b8d}',
'.vacio{text-align:center;color:#5b6270;padding:50px 0}',
'.err{background:#3a1212;border:1px solid #7a2323;color:#ff9a9c;padding:14px;border-radius:10px;margin-top:18px}',
'</style></head><body>',
'<header><h1>BEER<span>PUNCH</span> · piñas de la noche</h1>',
'<div class="sub" id="sub">cargando…</div></header>',
'<div id="lista"></div>',
'<script>',
'var CLAVE=new URLSearchParams(location.search).get("clave")||"";',
'var q=CLAVE?("?clave="+encodeURIComponent(CLAVE)):"";',
'function hora(ts){return new Date(ts).toLocaleTimeString("es-AR",{timeZone:"America/Argentina/Buenos_Aires",hour:"2-digit",minute:"2-digit",hour12:false});}',
'function pintar(ps){',
'  var L=document.getElementById("lista");L.innerHTML="";',
'  document.getElementById("sub").textContent=ps.length+" piñas · tocá OCULTAR para sacarla del ranking";',
'  if(!ps.length){L.innerHTML="<div class=\'vacio\'>Todavía no cargó nadie</div>";return;}',
'  ps.forEach(function(p){',
'    var d=document.createElement("div");d.className="fila"+(p.oculta?" off":"");',
'    var img;',
'    if(p.foto){img=document.createElement("img");img.className="foto";img.src="/api/foto/"+p.foto+q;img.alt="";}',
'    else{img=document.createElement("div");img.className="foto sin";img.textContent="SIN FOTO";}',
'    d.appendChild(img);',
'    var dat=document.createElement("div");dat.className="dat";',
'    var n=document.createElement("div");n.className="nom";n.textContent=p.apodo;',
'    if(p.sexo==="F"){var b=document.createElement("span");b.className="f";b.textContent="MUJER";n.appendChild(document.createTextNode(" "));n.appendChild(b);}',
'    dat.appendChild(n);',
'    var sc=document.createElement("div");sc.className="sc";sc.textContent=p.score;dat.appendChild(sc);',
'    var m=document.createElement("div");m.className="meta";',
'    m.textContent=hora(p.ts)+(p.ig?" · "+p.ig:"")+(p.oculta?" · OCULTA":"");',
'    dat.appendChild(m);d.appendChild(dat);',
'    var bt=document.createElement("button");bt.className="ac"+(p.oculta?" on":"");',
'    bt.textContent=p.oculta?"MOSTRAR":"OCULTAR";',
'    bt.onclick=function(){',
'      bt.disabled=true;',
'      fetch("/api/pinas/"+p.id+"/ocultar"+q,{method:"POST"})',
'        .then(function(r){return r.json();})',
'        .then(function(){cargar();})',
'        .catch(function(){bt.disabled=false;bt.textContent="ERROR";});',
'    };',
'    d.appendChild(bt);L.appendChild(d);',
'  });',
'}',
'function cargar(){',
'  fetch("/api/pinas"+q).then(function(r){',
'    if(r.status===401){throw new Error("clave");}',
'    return r.json();',
'  }).then(pintar).catch(function(e){',
'    document.getElementById("lista").innerHTML=',
'      "<div class=\'err\'>"+(e.message==="clave"?"Clave incorrecta. Abrí el link con ?clave=…":"No se pudo cargar. Revisá la conexión.")+"</div>";',
'    document.getElementById("sub").textContent="";',
'  });',
'}',
'cargar();setInterval(cargar,20000);',
'<\/script></body></html>'
  ].join('\n');

  app.get('/fotos', function (req, res) {
    if (!claveOk(req)) return res.status(401).send('falta la clave');
    res.type('html').send(HTML_FOTOS);
  });

  // ===== PÁGINAS =====
  // Los HTML viven en la carpeta publico/ del repo.
  function servir(nombre) {
    return function (req, res) {
      const f = path.join(DIR_WEB, nombre);
      if (!fs.existsSync(f)) return res.status(404).send('falta publico/' + nombre);
      res.sendFile(f);
    };
  }
  app.get('/m',     servir('carga.html'));   // el QR de la máquina apunta acá
  app.get('/totem', servir('totem.html'));   // lo que abre el TV Box

  log('PIÑAS', 'módulo montado · ' + pinas.length + ' piñas y ' + premios.length + ' premios en memoria' +
      (persistenciaOk ? '' : ' · SIN VOLUMEN: no se van a guardar'));
};
