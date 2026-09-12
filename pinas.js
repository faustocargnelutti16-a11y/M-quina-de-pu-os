// ============================================================
// BPK / BeerPunch - modulo de PINAS
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
  const APROBACION_MANUAL = false;   // true = la pina espera visto bueno antes de entrar al ranking
  const TOP               = 10;
  const MAX_FOTO_BYTES    = 900 * 1024;
  const DIAS_QUE_GUARDAMOS = 120;
  const MAX_PREMIOS_NOCHE  = 12;     // techo duro de premios por noche
  const MAX_TIROS_PREMIO   = 2;      // ningun premio puede soltar mas que esto

  // ===== EL REY DE LA NOCHE (el premio de las 3) =====
  // A la hora que diga aca, el que quedo primero en el ranking de la noche se
  // lleva un premio. No es azar: es aguantar. Sirve para que el que va
  // ganando a las 12 no se vaya, y para que el que esta segundo compre otra
  // ficha a las 2:40. Todo lo que hay que tocar esta en este bloque.
  const REY = {
    premio:    '1 BIRRITA',   // el mismo texto que ya promete el totem
    minPersonas: 3,           // hacen falta al menos 3 PERSONAS distintas en el ranking
    reina:     true,          // ademas del rey, la mejor mujer (el totem ya lo promete)
    minMujeres: 3,            // y otras 3 en el de mujeres para que haya reina
    premioReina: '1 BIRRITA',
    anuncioCada: 4 * 60000,   // cada cuanto lo vuelve a cantar el totem
    anuncios:  12             // 12 x 4 min = los primeros 45 min despues de la hora
  };

  /* La hora tiene que ser EXACTAMENTE la misma que el totem viene contando
     toda la noche ("PREMIO A LAS 3 AM - FALTAN 2H 15M"). El totem la calcula
     asi: jueves, viernes y sabado a la madrugada se entrega a las 4; el resto
     de los dias, a las 3. Si aca pusieramos 3 fijo, un sabado se coronaria al
     rey una hora antes de lo que el propio cartel anuncio. */
  function horaDeEntrega(d) {
    const dia = d.getHours() < 6 ? (d.getDay() + 6) % 7 : d.getDay();
    return (dia === 4 || dia === 5 || dia === 6) ? 4 : 3;
  }

  // ===== LA RULETA VIVE ACA, NO EN EL CELULAR =====
  // El orden tiene que ser IDENTICO al del array GAJOS de publico/carga.html:
  // el server elige el gajo y el celular solo lo dibuja.
  // Los premios que CUESTAN plata se recortaron fuerte. El tiro gratis no:
  // ese no sale del bolsillo (la maquina ya esta prendida) y ademas devuelve
  // a la persona a la maquina, que es donde vuelve a gastar. Bajar el tiro
  // gratis seria ahorrar en lo unico que no cuesta y que trae gente.
  const RULETA = [
    { t: '$100.000',              peso: 0.005,   premio: true },   // 1 cada 20.000
    { t: 'SEGU\u00cd\nPARTICIPANDO',   peso: 16.1300 },
    { t: 'COMBO DE\nFERNET',      peso: 0.015,   premio: true },   // 1 cada 6.667
    { t: 'SEGU\u00cd\nPARTICIPANDO',   peso: 16.1300 },
    { t: '2 BIRRITAS',            peso: 0.1,     premio: true },   // 1 cada 1.000
    { t: 'SEGU\u00cd\nPARTICIPANDO',   peso: 16.1300 },
    { t: 'DEVOLUCI\u00d3N\n$2.000',    peso: 0.2,     premio: true },   // 1 cada 500
    { t: 'SEGU\u00cd\nPARTICIPANDO',   peso: 16.1300 },
    { t: 'BIRRITA\nGRATIS',       peso: 0.4,     premio: true },   // 1 cada 250
    { t: 'SEGU\u00cd\nPARTICIPANDO',   peso: 16.1300 },
    { t: 'TIRO\nGRATIS',          peso: 2.5,     premio: true },   // 1 cada 40
    { t: 'SEGU\u00cd\nPARTICIPANDO',   peso: 16.1300 }
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
  // Los HTML pueden estar en publico/ o al lado de este archivo. Probamos
  // los dos, asi no importa como quedaron subidos al repo.
  const DIRS_WEB = [path.join(__dirname, 'publico'), __dirname];

  function buscarWeb(nombre) {
    for (let i = 0; i < DIRS_WEB.length; i++) {
      const f = path.join(DIRS_WEB[i], nombre);
      try { if (fs.existsSync(f)) return f; } catch (e) {}
    }
    return null;
  }

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

  // Escritura demorada: si entran 5 pinas seguidas no castigamos el disco 5 veces.
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
  // "EL TANO", "el  tano" y "El Tano" son la misma persona. Sin esto, el
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
      // Si ya se corono al rey, viaja en el estado: asi el totem lo sigue
      // mostrando aunque se reinicie o se corte la conexion a las 3:05.
      // El CODIGO no viaja: en la pantalla lo lee cualquiera.
      rey:       reyDeLaNoche(hoy),
      reina:     coronadoDe(hoy, 'reina'),
      ts: Date.now()
    };
  }

  function coronadoDe(noche, tipo) {
    const r = premios.find(function (p) { return p.tipo === tipo && p.noche === noche; });
    return r ? { nombre: r.apodo, score: r.score || 0, premio: r.premio,
                 entregado: !!r.entregado, ts: r.ts } : null;
  }
  function reyDeLaNoche(noche) { return coronadoDe(noche, 'rey'); }

  // Codigo de 4 digitos que no choque con otro vivo de la misma noche.
  function nuevoCodigo() {
    const hoy = nocheHoy();
    const usados = {};
    premios.forEach(function (p) { if (p.noche === hoy) usados[p.codigo] = 1; });
    let cod = null, intentos = 0;
    do { cod = String(crypto.randomInt(1000, 10000)); intentos++; }
    while (usados[cod] && intentos < 50);
    return cod;
  }

  // ===== CORONACION =====
  // Se llama sola a la hora del premio. Es idempotente: si ya hay rey de esta
  // noche no hace nada, asi que no importa si el reloj la llama dos veces ni
  // si el server se reinicia justo a las 3.
  // Cuanta gente distinta hay en una lista de pinas.
  function personasDe(lista) {
    const k = {};
    lista.forEach(function (p) { k[clavePersona(p.apodo)] = 1; });
    return Object.keys(k).length;
  }

  // El mejor puntaje de la lista. Si empatan, gana el que lo hizo PRIMERO:
  // llego antes y el otro tuvo toda la noche para superarlo.
  function mejorDe(lista) {
    let campeon = null;
    lista.forEach(function (p) {
      if (!campeon || p.score > campeon.score ||
          (p.score === campeon.score && p.ts < campeon.ts)) campeon = p;
    });
    return campeon;
  }

  function anotarCoronado(tipo, campeon, textoPremio, hoy) {
    const premio = {
      id: 'r' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
      codigo: nuevoCodigo(),
      premio: textoPremio,
      apodo: campeon.apodo,
      score: campeon.score,
      ts: Date.now(),
      noche: hoy,
      tipo: tipo,
      entregado: false,
      entregadoTs: null,
      pina: campeon.id,
      disp: campeon.disp || null
    };
    premios.push(premio);
    return premio;
  }

  function coronarRey() {
    const hoy = nocheHoy();
    if (reyDeLaNoche(hoy)) return null;

    const dela = pinas.filter(function (p) { return visible(p) && p.noche === hoy; });
    // Se cuentan PERSONAS, no pinas: uno solo que compra ocho tiros no hace
    // una competencia, y un premio que se gana sin competencia no se gana.
    const cuantos = personasDe(dela);
    if (cuantos < REY.minPersonas) {
      log('REY', 'noche floja (' + cuantos + (cuantos === 1 ? ' persona' : ' personas') +
          ', hacen falta ' + REY.minPersonas + '): no se corona a nadie');
      return null;
    }

    const campeon = mejorDe(dela);
    if (!campeon) return null;
    const premio = anotarCoronado('rey', campeon, REY.premio, hoy);

    // La reina: el totem tiene una pestana de mujeres que promete su propia
    // birrita toda la noche. Si no se entregara, esa pestana estaria
    // prometiendo algo que no existe. Si la mejor mujer YA es la campeona
    // general, no se le dan dos birras: es la misma persona.
    let reina = null;
    if (REY.reina) {
      const mujeres = dela.filter(function (p) { return p.sexo === 'F'; });
      const mejorM = mejorDe(mujeres);
      if (mejorM && personasDe(mujeres) >= REY.minMujeres &&
          clavePersona(mejorM.apodo) !== clavePersona(campeon.apodo)) {
        reina = anotarCoronado('reina', mejorM, REY.premioReina, hoy);
      }
    }

    guardar();

    log('REY DE LA NOCHE', campeon.apodo + ' con ' + campeon.score +
        ' \u00b7 ' + premio.premio + ' \u00b7 c\u00f3digo ' + premio.codigo);
    if (reina) log('REINA DE LA NOCHE', reina.apodo + ' con ' + reina.score +
                   ' \u00b7 ' + reina.premio + ' \u00b7 c\u00f3digo ' + reina.codigo);

    avisar('BPK - Se entrega el premio',
           'Rey: ' + campeon.apodo + ' (' + campeon.score + ') c\u00f3digo ' + premio.codigo +
           (reina ? '\nReina: ' + reina.apodo + ' (' + reina.score + ') c\u00f3digo ' + reina.codigo : '') +
           '\nEst\u00e1n en el panel de premios.', true);

    emitir('estado', estado());
    anunciarRey(premio, reina, 0);
    return premio;
  }

  // El totem lo canta varias veces: a las 3 en punto media barra esta mirando
  // para otro lado. Una sola vez es lo mismo que ninguna.
  function anunciarRey(premio, reina, vuelta) {
    if (vuelta >= REY.anuncios) return;
    if (nocheHoy() !== premio.noche) return;   // ya es otra noche, se corta
    emitir('rey', {
      nombre: premio.apodo,
      score: premio.score,
      premio: premio.premio,
      reina: reina ? { nombre: reina.apodo, score: reina.score, premio: reina.premio } : null,
      vuelta: vuelta
    });
    setTimeout(function () { anunciarRey(premio, reina, vuelta + 1); }, REY.anuncioCada);
  }

  // Un reloj cada 30 s en vez de un setTimeout largo: si el server se
  // reinicia a las 2:59 el timeout se habria perdido y no se coronaba a nadie.
  setInterval(function () {
    try {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      const min = d.getHours() * 60 + d.getMinutes();
      const obj = horaDeEntrega(d) * 60;
      // Ventana de 20 min: cubre un reinicio o un deploy justo a esa hora.
      if (min >= obj && min < obj + 20) coronarRey();
    } catch (e) { rutina('PINAS', 'reloj del rey: ' + e.message); }
  }, 30000);

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

  // Latido: mantiene viva la conexion con el totem toda la noche.
  setInterval(function () { emitir('ping', { t: Date.now() }); }, 25000);

  /* Cambio de noche.
     El ranking de la noche se arma filtrando por fecha, asi que el servidor
     siempre contesta bien. El problema era otro: el totem solo se entera de
     algo cuando pasa algo. Si a las 12 del mediodia arranca la noche nueva y
     nadie carga una pina hasta las 8, el totem se queda ocho horas mostrando
     el ranking de anoche como si fuera el de hoy. Ahora, cuando cambia la
     fecha, el servidor avisa solo y la tabla queda en blanco. */
  let nocheEnCurso = nocheHoy();
  setInterval(function () {
    const ahora = nocheHoy();
    if (ahora === nocheEnCurso) return;
    nocheEnCurso = ahora;
    log('NOCHE NUEVA', 'arranca la noche del ' + ahora + ': el ranking vuelve a cero');
    emitir('estado', estado());
  }, 30000);

  app.get('/api/estado', function (req, res) { res.json(estado()); });

  // ===== FOTOS =====
  // Van a disco, no adentro del JSON: una foto en base64 dentro del archivo
  // de pinas lo haria pesar megas y ralentizaria cada guardado.
  // Huella de la foto: si dos pinas traen exactamente la misma imagen, es la
  // misma foto subida dos veces. La foto es la unica prueba del puntaje, asi
  // que si vale dos veces no prueba nada. Esto NO detecta una foto nueva del
  // mismo display (son bytes distintos), pero corta el caso facil: guardar
  // una foto buena y volver a mandarla.
  function huellaFoto(dataURL) {
    try {
      const m = /^data:image\/(?:jpeg|jpg|png|webp);base64,(.+)$/i.exec(String(dataURL || ''));
      if (!m) return null;
      return crypto.createHash('sha256').update(m[1]).digest('hex').slice(0, 32);
    } catch (e) { return null; }
  }

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
    if (!fs.existsSync(f)) return res.status(404).send('no est\u00e1');
    res.sendFile(f);
  });

  // ===== CARGA DE UNA PINA (esto llama el celular del cliente) =====
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
      return res.status(429).json({ error: 'esper\u00e1 unos segundos' });
    }
    ultimaCargaPorIP[ip] = ahora;

    // Si el celular reintenta porque se le corto la red a mitad de camino,
    // devolvemos la misma respuesta en vez de cargar la pina dos veces.
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

    // Esta foto ya se uso? Se chequea despues del control de reintento por
    // "envio" y antes de crear la pina.
    const huella = huellaFoto(b.foto);
    if (huella) {
      const yaEsta = pinas.find(function (p) { return p.huella === huella; });
      if (yaEsta) {
        // Si es la misma persona hace un ratito, no fue trampa: se le corto la
        // red, recargo y volvio a mandar. Se le devuelve lo de la primera vez.
        // Un reintento de verdad viene con el MISMO nombre: la persona no
        // cambia de apodo porque se le corto la red. Si el nombre cambio,
        // no es un reintento, es la misma foto usada para otra pina.
        const dispAhora = limpiar(b.disp, 40);
        const mismoDuenio = clavePersona(yaEsta.apodo) === clavePersona(apodo) &&
                            (!dispAhora || !yaEsta.disp || yaEsta.disp === dispAhora);
        if (mismoDuenio && (ahora - yaEsta.ts) < 3 * 60 * 1000) {
          const pr0 = premios.find(function (x) { return x.pina === yaEsta.id; });
          return res.json({
            ok: true, repetida: true,
            gajo: (typeof yaEsta.gajo === 'number') ? yaEsta.gajo : -1,
            premio: pr0 ? pr0.premio : null,
            codigo: pr0 ? pr0.codigo : null,
            puesto: 0, esRecord: false
          });
        }
        log('FOTO REPETIDA', apodo + ' mando una foto que ya habia cargado ' + yaEsta.apodo);
        return res.status(409).json({
          error: 'Esa foto ya se us\u00f3 para cargar otra pi\u00f1a. Sacale una foto nueva al display.'
        });
      }
    }

    // UN GIRO POR PERSONA POR NOCHE. Las pinas se cargan todas (el ranking
    // las necesita); lo que se usa una sola vez es la ruleta.
    // Se compara por apodo Y por aparato. Antes solo por apodo: cambiabas el
    // nombre y volvias a girar, y cada giro extra es una chance real de
    // premio pago. El aparato no es infalible, pero corta el atajo facil.
    const disp = limpiar(b.disp, 40);
    const yaGiro = pinas.some(function (p) {
      return p.giro && p.noche === nocheHoy() &&
             (clavePersona(p.apodo) === clavePersona(apodo) ||
              (!!disp && p.disp === disp));
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
      disp: disp || null,        // que aparato la cargo, para el giro por noche
      huella: huella || null,    // para que la misma foto no entre dos veces
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
    // El celular NO decide nada: manda su pina, el server sortea, y le
    // devuelve en que gajo tiene que frenar la rueda. Antes el celular
    // mandaba el premio y cualquiera podia pedir "4 TIROS" con un POST.
    // gajo = -1 significa "no le toca girar". El celular ya sabe leerlo:
    // muestra "PINA CARGADA / YA GIRASTE ESTA NOCHE" y no anima la rueda.
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
        avisar('BPK - Tope de premios', 'Se lleg\u00f3 a ' + MAX_PREMIOS_NOCHE +
               ' premios en la noche. La ruleta deja de entregar hasta ma\u00f1ana.', true);
        gajo = gajoPerdedor();
      }
    }
    const g = gajo >= 0 ? RULETA[gajo] : null;

    if (g && g.premio) {
      nombrePremio = g.t.replace(/\n/g, ' ');
      codigo = nuevoCodigo();
      premios.push({
        id: 'x' + ahora.toString(36) + crypto.randomBytes(2).toString('hex'),
        codigo: codigo,
        premio: nombrePremio,
        apodo: apodo,
        ts: ahora,
        noche: nocheHoy(),
        tipo: 'ruleta',
        entregado: false,
        entregadoTs: null,
        pina: id,
        disp: disp || null
      });
      log('PREMIO', nombrePremio + ' para ' + apodo + ' \u00b7 c\u00f3digo ' + codigo);
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

    // La ruleta tambien sale en el totem. Girarla en la palma de la mano no
    // la ve nadie; en la pantalla la mira el bar entero, y el que mira es el
    // que despues compra. Solo cuando de verdad giro (gajo -1 = ya giro hoy).
    if (gajo >= 0) {
      emitir('ruleta', {
        nombre: apodo,
        gajo: gajo,
        gano: !!(g && g.premio),
        texto: RULETA[gajo].t.replace(/\n/g, ' ')
      });
    }

    log('PI\u00d1A', apodo + ' ' + score + (esRecord ? ' R\u00c9CORD' : '') + (puesto ? ' (#' + puesto + ')' : ''));

    if (esRecord && previo > 0) {
      avisar('BPK - Nuevo r\u00e9cord', apodo + ' hizo ' + score + ' puntos (antes ' + previo + ')', false);
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

  // ===== "GANE ALGO?" - lo consulta el celular del cliente =====
  // Sin clave, porque lo abre el cliente, pero solo devuelve lo que le
  // corresponde a ESE aparato y solo de la noche de hoy. El totem canta el
  // nombre del rey; el codigo sale aca, en la mano del que gano.
  /* El aparato es la llave, asi que hay que hacer que probar llaves no sirva.
     Sin freno, alguien podria tirar millones de "disp" inventados hasta pegarle
     al del ganador. Con 20 intentos por minuto por IP, pegarle de casualidad
     lleva mas tiempo que la vida del bar. */
  const consultasPremio = {};
  setInterval(function () {
    const viejo = Date.now() - 60000;
    Object.keys(consultasPremio).forEach(function (k) {
      if (consultasPremio[k].desde < viejo) delete consultasPremio[k];
    });
  }, 60000);

  app.get('/api/mipremio', function (req, res) {
    const quien = String(req.headers['x-forwarded-for'] || req.ip || '?').slice(0, 45);
    const ahoraMs = Date.now();
    const reg = consultasPremio[quien];
    if (!reg || ahoraMs - reg.desde > 60000) consultasPremio[quien] = { desde: ahoraMs, n: 1 };
    else if (++reg.n > 20) {
      log('PREMIO', 'demasiadas consultas de premio desde ' + quien);
      return res.status(429).json({ premios: [] });
    }

    const disp = limpiar(req.query.disp, 40);
    if (!disp) return res.json({ premios: [] });
    const hoy = nocheHoy();
    const mios = premios.filter(function (p) {
      return p.noche === hoy && p.disp && p.disp === disp;
    });
    res.json({
      premios: mios.map(function (p) {
        return { codigo: p.codigo, premio: p.premio, tipo: p.tipo || 'ruleta',
                 apodo: p.apodo, score: p.score || 0, entregado: !!p.entregado, ts: p.ts };
      })
    });
  });

  // Se busca por CODIGO, no por id: es lo que el cliente canta en la barra.
  app.post('/api/premios/entregar', function (req, res) {
    if (!claveOk(req)) return res.status(401).json({ error: 'clave' });
    const cod = limpiar((req.body || {}).codigo, 8);
    const hoy = nocheHoy();
    const p = premios.find(function (x) { return x.codigo === cod && x.noche === hoy; });

    if (!p)           return res.status(404).json({ error: 'ese c\u00f3digo no existe en la noche de hoy' });
    if (p.entregado)  return res.status(409).json({ error: 'ya fue entregado', premio: p });

    p.entregado = true;
    p.entregadoTs = Date.now();

    // Si el premio son tiros, se cargan solos en la maquina usando la
    // misma cola que ya usa todo lo demas. La caja no toca nada mas.
    let fichasOk = null;
    const m = /(\d+)\s*TIRO/i.exec(p.premio);
    if (m) fichasOk = agregarFichas(Math.min(MAX_TIROS_PREMIO, Number(m[1]) || 1), 'premio ruleta ' + p.codigo);
    else if (/TIRO/i.test(p.premio)) fichasOk = agregarFichas(1, 'premio ruleta ' + p.codigo);

    guardar();
    log('PREMIO ENTREGADO', p.premio + ' \u00b7 c\u00f3digo ' + p.codigo);
    res.json({ ok: true, premio: p, fichasOk: fichasOk });
  });

  // Coronar a mano: si una noche cierran antes, o para probarlo.
  app.get('/api/rey/coronar', function (req, res) {
    if (!claveOk(req)) return res.status(401).json({ error: 'clave' });
    const r = coronarRey();
    if (!r) return res.json({ ok: false, motivo: reyDeLaNoche(nocheHoy())
      ? 'ya hay rey esta noche'
      : 'hacen falta al menos ' + REY.minPersonas + ' personas distintas en el ranking' });
    res.json({ ok: true, rey: { apodo: r.apodo, score: r.score, premio: r.premio, codigo: r.codigo } });
  });

  // ===== "GANE?" - LA PAGINA QUE SE ESCANEA DESDE EL TOTEM =====
  /* El codigo no puede salir en la pantalla del bar: lo lee cualquiera y lo va
     a cantar a la caja. Pero tampoco sirve dejarlo escondido en el celular del
     que cargo, porque a las 3 de la manana ese celular ya cerro la pagina.
     Entonces el totem muestra un QR: "ganaste? escanea aca". Lo escanea todo
     el mundo, y la pagina le contesta a cada uno segun el aparato con el que
     cargo su pina. Al que gano le muestra el codigo; al resto le dice que no.
     El que no gano no puede sacarle el codigo a nadie: el aparato no lo tiene. */
  const HTML_PREMIO = [
'<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
'<meta name="color-scheme" content="dark"><title>BeerPunch \u00b7 \u00bfGanaste?</title>',
'<link rel="preconnect" href="https://fonts.googleapis.com">',
'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
'<link href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow+Condensed:wght@600;700&display=swap" rel="stylesheet">',
'<style>',
'*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
'body{background:#04050a;color:#fff;font:600 16px/1.5 "Barlow Condensed",system-ui,sans-serif;',
'  min-height:100vh;display:flex;align-items:center;justify-content:center;',
'  padding:34px 22px calc(34px + env(safe-area-inset-bottom));text-align:center}',
'.caja{width:100%;max-width:380px}',
'.marca{font-family:Anton,Impact,sans-serif;font-size:22px;letter-spacing:.04em}',
'.marca i{font-style:normal;color:#D7252A}',
'.corona{font-size:52px;line-height:1;margin-top:18px}',
'.tit{font-family:Anton,Impact,sans-serif;color:#FFD518;font-size:27px;margin-top:12px;line-height:1.15}',
'.sub{color:#c7cdd6;font-size:15px;margin-top:10px;line-height:1.5}',
'.ficha{margin-top:22px;padding:22px;border-radius:18px;border:1px solid rgba(255,213,24,.45);',
'  background:rgba(255,213,24,.08)}',
'.et{color:#8b93a1;letter-spacing:3px;font-size:10.5px}',
'.cod{font-family:Anton,Impact,sans-serif;font-size:54px;letter-spacing:9px;line-height:1;margin-top:10px}',
'.no{color:#8b93a1;font-size:15px;line-height:1.6;margin-top:14px}',
'.b{display:block;margin-top:22px;padding:15px;border-radius:13px;background:#D7252A;color:#fff;',
'  text-decoration:none;font-family:Anton,Impact,sans-serif;font-size:17px;letter-spacing:.04em}',
'.gris{background:transparent;border:1px solid #2b303b;color:#8b93a1;font-size:14px}',
'</style></head><body><div class="caja" id="c">',
'<div class="marca">BEER<i>PUNCH</i></div>',
'<div class="sub" id="estado">Fij\u00e1ndonos\u2026</div>',
'</div>',
'<script>',
'var DISP="";try{DISP=localStorage.getItem("bp_disp")||"";}catch(e){}',
'function esc(t){var d=document.createElement("div");d.textContent=t==null?"":t;return d.innerHTML;}',
'function pintar(h){document.getElementById("c").innerHTML=',
'  \'<div class="marca">BEER<i>PUNCH</i></div>\'+h;}',
'function nada(msg){',
'  pintar(\'<div class="tit" style="color:#fff;margin-top:26px">\'+msg+\'</div>\'+',
'    \'<div class="no">El premio de la noche es para el que qued\u00f3 primero en el ranking.\'+',
'    \'<br><br>Si cargaste tu pi\u00f1a desde OTRO celular, abr\u00ed esto desde ese.\'+',
'    \'<br><br>Y si est\u00e1s seguro de que ganaste, and\u00e1 a la caja y dec\u00ed tu apodo: ah\u00ed te lo buscan igual.</div>\'+',
'    \'<a class="b" href="/m">CARGAR UNA PI\u00d1A</a>\');',
'}',
'if(!DISP){ nada("NO CARGASTE NINGUNA PI\u00d1A DESDE ESTE CELULAR"); }',
'else{',
'  fetch("/api/mipremio?disp="+encodeURIComponent(DISP)).then(function(r){return r.json();})',
'  .then(function(d){',
'    var l=(d&&d.premios)||[];',
'    var g=null;',
'    for(var i=0;i<l.length;i++){ if(l[i].tipo==="rey"||l[i].tipo==="reina"){ g=l[i]; break; } }',
'    if(!g){ nada("ESTA NOCHE NO GANASTE"); return; }',
'    if(g.entregado){',
'      pintar(\'<div class="corona">&#127894;</div><div class="tit">YA LO RETIRASTE</div>\'+',
'        \'<div class="sub">\'+esc(g.premio)+\' &middot; c\u00f3digo \'+esc(g.codigo)+\'</div>\');',
'      return;',
'    }',
'    pintar(\'<div class="corona">&#127894;</div>\'+',
'      \'<div class="tit">SOS \'+(g.tipo==="reina"?"LA REINA":"EL REY")+\'<br>DE LA NOCHE</div>\'+',
'      \'<div class="sub">Quedaste primero con <b>\'+(g.score||0)+\' puntos</b><br>Te ganaste \'+esc(g.premio)+\'</div>\'+',
'      \'<div class="ficha"><div class="et">C\u00d3DIGO PARA LA CAJA</div>\'+',
'      \'<div class="cod">\'+esc(g.codigo)+\'</div>\'+',
'      \'<div class="et" style="margin-top:12px;letter-spacing:1px;line-height:1.5">And\u00e1 a la caja y mostr\u00e1 este c\u00f3digo<br>Si lo perd\u00e9s, lo buscan por tu apodo</div></div>\');',
'    try{ if(navigator.vibrate) navigator.vibrate([90,70,90,70,220]); }catch(e){}',
'  })',
'  .catch(function(){ nada("NO SE PUDO CONSULTAR"); });',
'}',
'<\/script></body></html>'
  ].join('\n');

  app.get('/premio', function (req, res) { res.type('html').send(HTML_PREMIO); });

  // ===== LA PANTALLA DE LA CAJA =====
  /* Hasta ahora los premios se entregaban con un POST que habia que armar a
     mano. En la practica eso significa que no se entregaban. Esta es la
     pantalla que abre la caja: los que faltan retirar, con un boton cada uno,
     y un casillero para tipear el codigo que canta el cliente. */
  const HTML_CAJA = [
'<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
'<meta name="color-scheme" content="dark"><title>BeerPunch \u00b7 Premios</title>',
'<style>',
'*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
'body{background:#0a0b10;color:#fff;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;',
'  padding:0 14px calc(40px + env(safe-area-inset-bottom));max-width:620px;margin:0 auto}',
'header{position:sticky;top:0;background:#0a0b10;padding:18px 0 12px;border-bottom:1px solid #23262f;z-index:5}',
'h1{font-size:19px;letter-spacing:.5px}h1 span{color:#D7252A}',
'.sub{color:#8b93a1;font-size:13px;margin-top:3px}',
'.buscar{display:flex;gap:8px;margin:16px 0}',
'.buscar input{flex:1;min-width:0;background:#161922;border:1px solid #2b303b;color:#fff;border-radius:11px;',
'  padding:14px;font-size:26px;letter-spacing:6px;text-align:center;font-weight:700}',
'.buscar button{flex:none;background:#FFD518;color:#000;border:0;border-radius:11px;padding:0 18px;',
'  font-size:14px;font-weight:800;letter-spacing:.5px}',
'.fila{display:flex;gap:12px;align-items:center;padding:13px 0;border-bottom:1px solid #191c23}',
'.dat{flex:1;min-width:0}',
'.nom{font-weight:700;letter-spacing:.5px;font-size:17px}',
'.meta{color:#8b93a1;font-size:12.5px;margin-top:2px}',
'.pr{color:#FFD518;font-weight:700;font-size:14px}',
'.cod{font-family:ui-monospace,Menlo,monospace;font-size:21px;font-weight:700;letter-spacing:2px}',
'.rey{display:inline-block;background:#FFD51822;color:#FFD518;border-radius:20px;padding:1px 8px;',
'  font-size:11px;font-weight:700;margin-left:5px}',
'.reina{background:#F1437B22;color:#F1437B}',
'button.ac{flex:none;border:0;background:#1f7a3a;color:#fff;border-radius:10px;padding:12px 14px;',
'  font-size:13px;font-weight:800;letter-spacing:.5px}',
'button.ac:disabled{opacity:.5}',
'.vacio{text-align:center;color:#5b6270;padding:44px 0}',
'.msg{margin:14px 0;padding:14px;border-radius:11px;font-size:15px;line-height:1.45}',
'.msg.ok{background:#12301c;border:1px solid #1f7a3a;color:#9be0b0}',
'.msg.mal{background:#3a1212;border:1px solid #7a2323;color:#ff9a9c}',
'h2{font-size:12px;letter-spacing:2px;color:#5b6270;margin:22px 0 4px;text-transform:uppercase}',
'.ya{opacity:.45}',
'</style></head><body>',
'<header><h1>BEER<span>PUNCH</span> \u00b7 premios</h1>',
'<div class="sub" id="sub">cargando\u2026</div></header>',
'<div class="buscar"><input id="cod" inputmode="numeric" maxlength="4" placeholder="0000">',
'<button onclick="entregar(document.getElementById(\'cod\').value)">ENTREGAR</button></div>',
'<div id="msg"></div><div id="lista"></div>',
'<script>',
'var CLAVE=new URLSearchParams(location.search).get("clave")||"";',
'var q=CLAVE?("?clave="+encodeURIComponent(CLAVE)):"";',
'function hora(ts){return new Date(ts).toLocaleTimeString("es-AR",{timeZone:"America/Argentina/Buenos_Aires",hour:"2-digit",minute:"2-digit",hour12:false});}',
'function aviso(t,ok){var m=document.getElementById("msg");',
'  m.innerHTML="<div class=\'msg "+(ok?"ok":"mal")+"\'>"+t+"</div>";',
'  setTimeout(function(){m.innerHTML="";},6000);}',
'function tarjeta(p,entregado){',
'  var d=document.createElement("div");d.className="fila"+(entregado?" ya":"");',
'  var dat=document.createElement("div");dat.className="dat";',
'  var n=document.createElement("div");n.className="nom";n.textContent=p.apodo;',
'  if(p.tipo==="rey"||p.tipo==="reina"){var b=document.createElement("span");',
'    b.className="rey"+(p.tipo==="reina"?" reina":"");',
'    b.textContent=p.tipo==="reina"?"REINA DE LA NOCHE":"REY DE LA NOCHE";n.appendChild(b);}',
'  dat.appendChild(n);',
'  var pr=document.createElement("div");pr.className="pr";pr.textContent=p.premio;dat.appendChild(pr);',
'  var m=document.createElement("div");m.className="meta";',
'  m.textContent=hora(p.ts)+(p.score?" \u00b7 "+p.score+" puntos":"")+(entregado?" \u00b7 entregado":"");',
'  dat.appendChild(m);',
'  var c=document.createElement("div");c.className="cod";c.textContent=p.codigo;',
'  d.appendChild(c);d.appendChild(dat);',
'  if(!entregado){',
'    var bt=document.createElement("button");bt.className="ac";bt.textContent="ENTREGAR";',
'    bt.onclick=function(){bt.disabled=true;entregar(p.codigo);};',
'    d.appendChild(bt);',
'  }',
'  return d;',
'}',
'function pintar(d){',
'  var L=document.getElementById("lista");L.innerHTML="";',
'  var pen=d.pendientes||[],ent=d.entregados||[];',
'  document.getElementById("sub").textContent=',
'    pen.length?(pen.length+(pen.length===1?" premio sin retirar":" premios sin retirar")):"no queda ninguno sin retirar";',
'  if(!pen.length&&!ent.length){L.innerHTML="<div class=\'vacio\'>Todav\u00eda no sali\u00f3 ning\u00fan premio esta noche</div>";return;}',
'  if(pen.length){var h=document.createElement("h2");h.textContent="Sin retirar";L.appendChild(h);',
'    pen.forEach(function(p){L.appendChild(tarjeta(p,false));});}',
'  if(ent.length){var h2=document.createElement("h2");h2.textContent="Ya entregados";L.appendChild(h2);',
'    ent.forEach(function(p){L.appendChild(tarjeta(p,true));});}',
'}',
'function cargar(){',
'  fetch("/api/premios"+q).then(function(r){if(r.status===401)throw new Error("clave");return r.json();})',
'  .then(pintar).catch(function(e){',
'    document.getElementById("lista").innerHTML="<div class=\'msg mal\'>"+',
'      (e.message==="clave"?"Clave incorrecta. Abr\u00ed el link con ?clave=\u2026":"No se pudo cargar")+"</div>";});',
'}',
'function entregar(cod){',
'  cod=String(cod||"").trim();',
'  if(cod.length<4){aviso("Escrib\u00ed el c\u00f3digo de 4 n\u00fameros",false);cargar();return;}',
'  fetch("/api/premios/entregar"+q,{method:"POST",headers:{"Content-Type":"application/json"},',
'    body:JSON.stringify({codigo:cod})})',
'  .then(function(r){return r.json().then(function(j){return{s:r.status,j:j};});})',
'  .then(function(x){',
'    if(x.s===200){',
'      var f=x.j.fichasOk===null?"":(x.j.fichasOk?" \u00b7 los tiros ya cayeron en la m\u00e1quina":" \u00b7 OJO: los tiros no se pudieron cargar");',
'      aviso("Entregado a <b>"+x.j.premio.apodo+"</b>: "+x.j.premio.premio+f,true);',
'      document.getElementById("cod").value="";',
'    } else { aviso(x.j.error||"no se pudo",false); }',
'    cargar();',
'  }).catch(function(){aviso("Sin conexi\u00f3n",false);cargar();});',
'}',
'cargar();setInterval(cargar,15000);',
'<\/script></body></html>'
  ].join('\n');

  app.get('/premios', function (req, res) {
    if (!claveOk(req)) return res.status(401).send('falta la clave');
    res.type('html').send(HTML_CAJA);
  });

  // ===== EL TOTEM EN VIVO, PARA MIRARLO Y GRABARLO =====
  /* Es la MISMA pagina del totem metida adentro, en modo espejo: misma
     conexion en vivo, mismos datos, mismos carteles, al mismo tiempo que la
     tele. No es una copia ni una simulacion.
     Sirve para dos cosas: mirar desde la barra como esta quedando sin darse
     vuelta, y grabar la pantalla del celular para Instagram. Por eso entra
     derecha y en 9:16, que es la medida de una historia o un reel: lo que
     grabes ya sale con la proporcion justa, sin bordes negros ni recortes.
     El boton de pantalla completa saca la barra del navegador, que es lo
     unico que ensucia una captura. */
  const HTML_VIVO = [
'<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
'<meta name="color-scheme" content="dark"><title>BeerPunch &middot; En vivo</title>',
/* Con esto, si se agrega a la pantalla de inicio, iOS lo abre SIN la barra
   del navegador: es la unica forma de tener pantalla completa de verdad en
   un iPhone, porque Safari no deja pedirla por codigo salvo para videos. */
'<meta name="apple-mobile-web-app-capable" content="yes">',
'<meta name="mobile-web-app-capable" content="yes">',
'<meta name="apple-mobile-web-app-status-bar-style" content="black">',
'<style>',
'*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
'html,body{height:100%;background:#000;overflow:hidden;',
'  font:600 15px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff}',
'#caja{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}',
'#tv{flex:none;border:0;display:block;transform-origin:center center;background:#04050a;',
'  border-radius:10px;box-shadow:0 18px 50px -18px rgba(0,0,0,.9)}',
'body.limpio #barra{opacity:0;pointer-events:none}',
'body.limpio #tv{border-radius:0;box-shadow:none}',
'#barra{position:fixed;left:0;right:0;bottom:0;z-index:5;display:flex;gap:8px;',
'  padding:12px 14px calc(12px + env(safe-area-inset-bottom));',
'  background:linear-gradient(180deg,transparent,rgba(0,0,0,.85) 45%);transition:opacity .25s}',
'.b{flex:1;text-align:center;border:1px solid #2b303b;background:rgba(20,22,29,.92);color:#fff;',
'  border-radius:11px;padding:13px 8px;font-size:13.5px;font-weight:700;letter-spacing:.4px;',
'  text-decoration:none}',
'.b.on{background:#FFD518;border-color:#FFD518;color:#000}',
'#ayuda{position:fixed;left:0;right:0;top:0;z-index:5;padding:12px 16px;font-size:12.5px;',
'  color:#98A1B0;display:flex;justify-content:space-between;align-items:center;gap:12px;',
'  background:linear-gradient(180deg,rgba(0,0,0,.85),transparent);transition:opacity .25s}',
'#ayuda a{color:#FFD518;text-decoration:none;font-weight:700}',
'#cartel{position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;',
'  padding:24px;background:rgba(4,5,10,.93)}',
'#cartel.ver{display:flex}',
'#cartel .caja2{max-width:360px;background:#14161d;border:1px solid #2b303b;border-radius:16px;',
'  padding:22px;font-size:14.5px;line-height:1.55;color:#D9DEE7}',
'#cartel b{color:#fff}',
'#cartel p{margin:12px 0 0}',
'#cartel .ok2{display:block;margin-top:18px;text-align:center;background:#FFD518;color:#000;',
'  border-radius:11px;padding:13px;font-weight:800;letter-spacing:.5px}',
'#caja{overflow:hidden}',
'body.limpio #ayuda{opacity:0}',
/* La hoja del ranking: sube desde abajo, tapa la mitad de la pantalla y deja
   ver el totem arriba, para que se vea el cambio en el momento en que se
   toca el boton. */
'#hoja{position:fixed;left:0;right:0;bottom:0;z-index:12;max-height:62%;overflow:auto;',
'  transform:translateY(110%);transition:transform .25s ease;background:#0d0f15;',
'  border-top:1px solid #2b303b;border-radius:18px 18px 0 0;',
'  padding:16px 14px calc(16px + env(safe-area-inset-bottom))}',
'#hoja.ver{transform:translateY(0)}',
'#hoja h3{font-size:12.5px;letter-spacing:1.4px;color:#98A1B0;margin:2px 0 10px;text-transform:uppercase}',
'#hoja .linea{display:flex;gap:8px;margin-bottom:9px}',
'#hoja .linea .b{padding:11px 6px;font-size:13px}',
'.nom{display:flex;align-items:center;gap:10px;padding:9px 12px;margin-bottom:7px;',
'  background:#141720;border:1px solid #232833;border-radius:11px}',
'.nom .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px}',
'.nom .s{color:#FFD518;font-weight:800;font-size:14px}',
'.nom .x{flex:none;width:38px;height:34px;border:1px solid #47212a;background:#24141a;color:#ff6b7d;',
'  border-radius:9px;font-size:17px;font-weight:800;line-height:1}',
'.vacia{color:#6a7383;font-size:13.5px;padding:8px 2px 12px}',
'#sexo{display:flex;gap:8px;margin-bottom:11px}',
'#sexo .b{padding:10px}',
'</style></head><body>',
'<div id="ayuda"><a id="bVolver" href="#">&larr; volver</a>',
'<span>en vivo, lo mismo que la tele</span></div>',
'<div id="caja"><iframe id="tv" src="/totem?espejo=1" title="T&oacute;tem"></iframe></div>',
'<div id="cartel"><div class="caja2">',
'<b>Para grabar sin la barra del navegador</b>',
'<p>En iPhone no se puede pedir pantalla completa desde la p&aacute;gina: lo bloquea Safari. ',
'El camino que s&iacute; funciona, y se hace una sola vez:</p>',
'<p><b>1.</b> Toc\u00e1 <b>Compartir</b> (el cuadrito con la flecha, abajo).<br>',
'<b>2.</b> <b>Agregar a inicio</b>.<br>',
'<b>3.</b> Cerr\u00e1 Safari y abrilo desde el &iacute;cono nuevo.</p>',
'<p>Desde ah&iacute; entra sin barra ni nada, a pantalla completa. Despu&eacute;s ',
'<b>OCULTAR</b> y grab&aacute;s la pantalla limpia.</p>',
'<span class="ok2">ENTENDIDO</span>',
'</div></div>',
'<div id="hoja">',
'<h3>Ranking de esta noche</h3>',
'<div id="sexo">',
'<button class="b on" id="sM">Hombres</button>',
'<button class="b" id="sF">Mujeres</button>',
'</div>',
'<div id="lista"></div>',
'<div class="linea">',
'<button class="b" id="mas1">+1 nombre</button>',
'<button class="b" id="mas3">+3</button>',
'<button class="b" id="mas10">Llenar 10</button>',
'</div>',
'<div class="linea">',
'<button class="b" id="borrarP">Borrar los de prueba</button>',
'<button class="b" id="desco">Descoronar</button>',
'</div>',
'<div class="linea"><button class="b" id="cerrarHoja">Listo</button></div>',
'</div>',
'<div id="barra">',
'<button class="b" id="bLimpio">OCULTAR</button>',
'<button class="b" id="bRank">RANKING</button>',
'<button class="b" id="bLlenar">ENCUADRE</button>',
'<button class="b" id="bFull">PANTALLA COMPLETA</button>',
'</div>',
'<script>',
'var CLAVE=new URLSearchParams(location.search).get("clave")||"";',
'document.getElementById("bVolver").href="/metricas"+(CLAVE?"?clave="+encodeURIComponent(CLAVE):"");',
/* El totem es 9:16. En vez de deformarlo, se lo dibuja SIEMPRE a 1080x1920
   -que es la medida nativa de una historia- y se lo achica entero con una
   escala. Asi la maqueta de adentro es identica a la de la tele: si se le
   diera un tamano raro, las medidas internas cambiarian y no estarias
   mirando lo mismo que se ve afuera. */
'var ANCHO=1080, ALTO=1920;',
'var llenar=false;',
'function acomodar(){',
'  var tv=document.getElementById("tv");',
'  var w=window.innerWidth, h=window.innerHeight;',
/* "Entrar" muestra el totem completo y deja bandas negras si el celular es
   mas largo que 9:16 (casi todos lo son). "Llenar" no deja bandas, al precio
   de recortar un poco arriba y abajo. Para una historia conviene llenar; para
   mirar como quedo, entrar. */
'  var k=llenar?Math.max(w/ANCHO,h/ALTO):Math.min(w/ANCHO,h/ALTO);',
'  tv.style.width=ANCHO+"px"; tv.style.height=ALTO+"px";',
'  tv.style.transform="scale("+k+")";',
'}',
'window.addEventListener("resize",acomodar);',
'window.addEventListener("orientationchange",function(){setTimeout(acomodar,300);});',
'acomodar();',
'var limpio=false;',
'document.getElementById("bLimpio").onclick=function(){',
'  limpio=!limpio; document.body.classList.toggle("limpio",limpio);',
'  this.classList.toggle("on",limpio);',
'  this.textContent=limpio?"MOSTRAR":"OCULTAR";',
'};',
/* Al tocar la pantalla con los botones ocultos vuelven a aparecer: si no,
   quedarias encerrado sin forma de salir. */
'document.getElementById("caja").onclick=function(){',
'  if(!limpio)return;',
'  limpio=false; document.body.classList.remove("limpio");',
'  var b=document.getElementById("bLimpio");',
'  b.classList.remove("on"); b.textContent="OCULTAR";',
'};',
'document.getElementById("bLlenar").onclick=function(){',
'  llenar=!llenar; this.classList.toggle("on",llenar);',
'  this.textContent=llenar?"9:16":"ENCUADRE"; acomodar();',
'};',
/* ===== el ranking, desde el mismo celular con el que se graba =====
   Para una historia de Instagram hace falta que la tabla tenga nombres, y
   para probar como se ve vacia hace falta poder vaciarla. Todo lo que se
   toca aca sale por el mismo canal que una pina real, asi que el totem del
   iframe -que es el de verdad- se actualiza solo, sin recargar nada. */
'var q=CLAVE?("?clave="+encodeURIComponent(CLAVE)):"";',
'var sexo="M";',
'function llamar(ruta,datos){',
'  return fetch(ruta+q,{method:"POST",headers:{"Content-Type":"application/json"},',
'    body:JSON.stringify(datos||{})}).then(function(r){return r.json();})',
'  .then(function(d){ verLista(); return d; })',
'  .catch(function(){ return null; });',
'}',
'function verLista(){',
'  fetch("/api/estado"+q).then(function(r){return r.json();}).then(function(e){',
'    var l=(sexo==="F"?e.mujeres:e.noche)||[];',
'    var c=document.getElementById("lista");',
'    if(!l.length){ c.innerHTML=\'<div class="vacia">No hay nadie anotado. As&iacute; se ve el t&oacute;tem vac&iacute;o: tres puestos grandes y el cuarto asom&aacute;ndose.</div>\'; return; }',
'    c.innerHTML="";',
'    l.forEach(function(p,i){',
'      var f=document.createElement("div"); f.className="nom";',
'      var t=document.createElement("span"); t.className="t"; t.textContent=(i+1)+". "+p.nombre;',
'      var s=document.createElement("span"); s.className="s"; s.textContent=p.score;',
'      var x=document.createElement("button"); x.className="x"; x.textContent="\\u00d7";',
'      x.title="sacar del ranking";',
'      x.onclick=function(){ llamar("/api/probar/quitar",{apodo:p.nombre}); };',
'      f.appendChild(t); f.appendChild(s); f.appendChild(x); c.appendChild(f);',
'    });',
'  }).catch(function(){});',
'}',
'function marcarSexo(){',
'  document.getElementById("sM").classList.toggle("on",sexo==="M");',
'  document.getElementById("sF").classList.toggle("on",sexo==="F");',
'  verLista();',
'}',
'document.getElementById("sM").onclick=function(){sexo="M";marcarSexo();};',
'document.getElementById("sF").onclick=function(){sexo="F";marcarSexo();};',
'document.getElementById("mas1").onclick=function(){llamar("/api/probar/llenar",{cuantos:1,sexo:sexo});};',
'document.getElementById("mas3").onclick=function(){llamar("/api/probar/llenar",{cuantos:3,sexo:sexo});};',
'document.getElementById("mas10").onclick=function(){llamar("/api/probar/llenar",{cuantos:10,sexo:sexo});};',
'document.getElementById("borrarP").onclick=function(){llamar("/api/probar/limpiar");};',
'document.getElementById("desco").onclick=function(){llamar("/api/probar/descoronar");};',
'var hoja=document.getElementById("hoja");',
'document.getElementById("bRank").onclick=function(){',
'  var ver=!hoja.classList.contains("ver");',
'  hoja.classList.toggle("ver",ver); this.classList.toggle("on",ver);',
'  if(ver)verLista();',
'};',
'document.getElementById("cerrarHoja").onclick=function(){',
'  hoja.classList.remove("ver");',
'  document.getElementById("bRank").classList.remove("on");',
'};',
/* Safari de iOS no tiene requestFullscreen fuera de los videos: el boton
   quedaba puesto y no hacia nada. Si el navegador no la soporta, en vez de
   un boton muerto se explica el camino que SI funciona. */
'var hayFull=!!(document.documentElement.requestFullscreen||document.documentElement.webkitRequestFullscreen);',
'var bF=document.getElementById("bFull");',
'if(!hayFull){',
'  bF.textContent="SACAR LA BARRA";',
'  bF.onclick=function(){',
'    document.getElementById("cartel").classList.add("ver");',
'  };',
'}else{',
'  bF.onclick=function(){',
'    var d=document.documentElement;',
'    try{',
'      if(document.fullscreenElement||document.webkitFullscreenElement){',
'        (document.exitFullscreen||document.webkitExitFullscreen).call(document);',
'      }else{',
'        (d.requestFullscreen||d.webkitRequestFullscreen).call(d);',
'      }',
'    }catch(e){}',
'    setTimeout(acomodar,400);',
'  };',
'}',
'var cc=document.getElementById("cartel");',
'if(cc)cc.onclick=function(){this.classList.remove("ver");};',
'<\/script></body></html>'
  ].join('\n');

  app.get('/vivo', function (req, res) {
    if (!claveOk(req)) return res.status(401).send('falta la clave');
    res.type('html').send(HTML_VIVO);
  });

  // ===== MODO PRUEBA =====
  /* Todo esto vive detras de la clave y no lo puede tocar un cliente. Es para
     poder ver funcionar el sistema un martes a las 4 de la tarde en vez de
     tener que esperar a que sea sabado a las 3 de la manana con el bar lleno.
     Las pinas que se cargan desde aca quedan marcadas y se borran todas
     juntas con un boton, asi no ensucian las metricas de verdad. */
  function limpiarPruebas() {
    const antesP = pinas.length, antesX = premios.length;
    const ids = {};
    pinas.forEach(function (p) { if (p.prueba) ids[p.id] = 1; });
    pinas = pinas.filter(function (p) { return !p.prueba; });
    premios = premios.filter(function (x) { return !(x.pina && ids[x.pina]) && !x.prueba; });
    guardar();
    return { pinas: antesP - pinas.length, premios: antesX - premios.length };
  }

  app.post('/api/probar/pina', function (req, res) {
    if (!claveOk(req)) return res.status(401).json({ error: 'clave' });
    const b = req.body || {};
    const apodo = (limpiar(b.apodo, 14) || 'PRUEBA').toUpperCase();
    const score = Math.max(1, Math.min(999, Math.floor(Number(b.score) || (100 + crypto.randomInt(0, 850)))));
    const ahora = Date.now();
    const previo = estado().record.score;
    const pina = {
      id: 'p' + ahora.toString(36) + crypto.randomBytes(2).toString('hex'),
      ts: ahora, noche: nocheHoy(), apodo: apodo, ig: '',
      sexo: (b.sexo === 'F') ? 'F' : 'M', score: score, foto: null,
      envio: null, disp: null, huella: null, giro: false, gajo: null,
      aprobada: true, oculta: false, ip: 'prueba', prueba: true
    };
    pinas.push(pina);
    guardar();
    const esRecord = score > previo;
    emitir(esRecord ? 'record' : 'golpe',
      { nombre: apodo, ig: '', score: score, esRecord: esRecord, sexo: pina.sexo });
    emitir('estado', estado());
    log('PRUEBA', 'pi\u00f1a de prueba: ' + apodo + ' ' + score);
    res.json({ ok: true, apodo: apodo, score: score, esRecord: esRecord });
  });

  // Volver a habilitar el giro: es lo que Fausto necesita para probar la
  // ruleta mas de una vez con el mismo celular.
  app.post('/api/probar/desbloquear', function (req, res) {
    if (!claveOk(req)) return res.status(401).json({ error: 'clave' });
    const b = req.body || {};
    const disp = limpiar(b.disp, 40);
    const apodo = limpiar(b.apodo, 14).toUpperCase();
    const hoy = nocheHoy();
    let n = 0;
    pinas.forEach(function (p) {
      if (p.noche !== hoy) return;
      const mismo = (disp && p.disp === disp) ||
                    (apodo && clavePersona(p.apodo) === clavePersona(apodo));
      if (mismo && p.giro) { p.giro = false; n++; }
    });
    // La huella de la foto tambien frena el reintento: si va a volver a
    // cargar la misma foto para probar, hay que soltarla.
    if (disp) pinas.forEach(function (p) { if (p.noche === hoy && p.disp === disp) p.huella = null; });
    guardar();
    log('PRUEBA', 'giro desbloqueado (' + n + ' pi\u00f1as) para ' + (apodo || disp));
    res.json({ ok: true, liberadas: n });
  });

  // Nombres de mentira para llenar el ranking desde el celular y ver como
  // queda la pantalla con gente. Son los nombres que de verdad se escriben
  // en el bar: si la maqueta se prueba con "Test 1" no se prueba nada.
  const NOMBRES_M = ['EL RUSO', 'JOSE', 'NACHO', 'EL FLACO', 'TONY', 'MARTIN',
                     'EL NEGRO PABLO', 'JUANMA', 'EL CHAQUE\u00d1O', 'LUCHO'];
  const NOMBRES_F = ['CAMI', 'SOFI', 'LU', 'AGUS', 'MECHI', 'JOSE', 'VALEN',
                     'ROCIO', 'BELEN', 'FLOR'];

  app.post('/api/probar/llenar', function (req, res) {
    if (!claveOk(req)) return res.status(401).json({ error: 'clave' });
    const b = req.body || {};
    const cuantos = Math.max(1, Math.min(10, Math.floor(Number(b.cuantos) || 1)));
    const fem = (b.sexo === 'F');
    const fuente = fem ? NOMBRES_F : NOMBRES_M;
    const hoy = nocheHoy();
    // No repetir a alguien que ya esta: el ranking toma el mejor golpe por
    // persona, asi que un nombre repetido no agrega una fila y parece roto.
    const puestos = {};
    pinas.forEach(function (p) { if (p.noche === hoy) puestos[clavePersona(p.apodo)] = 1; });
    const ahora = Date.now();
    const hechos = [];
    for (let i = 0; i < fuente.length && hechos.length < cuantos; i++) {
      const nombre = fuente[i];
      if (puestos[clavePersona(nombre)]) continue;
      puestos[clavePersona(nombre)] = 1;
      const score = 380 + crypto.randomInt(0, 570);
      pinas.push({
        id: 'p' + (ahora + hechos.length).toString(36) + crypto.randomBytes(2).toString('hex'),
        ts: ahora + hechos.length, noche: hoy, apodo: nombre, ig: '',
        sexo: fem ? 'F' : 'M', score: score, foto: null,
        envio: null, disp: null, huella: null, giro: false, gajo: null,
        aprobada: true, oculta: false, ip: 'prueba', prueba: true
      });
      hechos.push({ apodo: nombre, score: score });
    }
    guardar();
    emitir('estado', estado());
    log('PRUEBA', 'ranking rellenado con ' + hechos.length + ' nombres');
    res.json({ ok: true, agregados: hechos });
  });

  // Sacar UN nombre del ranking desde la vista en vivo. No borra la pina: la
  // oculta, que es lo mismo que hace la pantalla de moderacion. Asi sirve
  // igual para un nombre de prueba que para uno real que no puede salir.
  app.post('/api/probar/quitar', function (req, res) {
    if (!claveOk(req)) return res.status(401).json({ error: 'clave' });
    const apodo = limpiar((req.body || {}).apodo, 14);
    if (!apodo) return res.status(400).json({ error: 'falta el nombre' });
    const hoy = nocheHoy(), k = clavePersona(apodo);
    let n = 0;
    pinas.forEach(function (p) {
      if (p.noche === hoy && clavePersona(p.apodo) === k && !p.oculta) { p.oculta = true; n++; }
    });
    guardar();
    emitir('estado', estado());
    log('PRUEBA', 'sacado del ranking: ' + apodo + ' (' + n + ' pi\u00f1as ocultas)');
    res.json({ ok: true, ocultas: n });
  });

  app.post('/api/probar/limpiar', function (req, res) {
    if (!claveOk(req)) return res.status(401).json({ error: 'clave' });
    const r = limpiarPruebas();
    emitir('estado', estado());
    log('PRUEBA', 'borradas ' + r.pinas + ' pi\u00f1as de prueba y ' + r.premios + ' premios');
    res.json({ ok: true, borradas: r });
  });

  // Descoronar, para poder volver a probar el premio de la noche.
  app.post('/api/probar/descoronar', function (req, res) {
    if (!claveOk(req)) return res.status(401).json({ error: 'clave' });
    const hoy = nocheHoy();
    const antes = premios.length;
    premios = premios.filter(function (p) {
      return !((p.tipo === 'rey' || p.tipo === 'reina') && p.noche === hoy);
    });
    guardar();
    emitir('estado', estado());
    res.json({ ok: true, borrados: antes - premios.length });
  });

  const HTML_PROBAR = [
'<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
'<meta name="color-scheme" content="dark"><title>BeerPunch \u00b7 Probar</title>',
'<style>',
'*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
'body{background:#0a0b10;color:#fff;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;',
'  padding:0 14px calc(40px + env(safe-area-inset-bottom));max-width:560px;margin:0 auto}',
'header{padding:20px 0 12px;border-bottom:1px solid #23262f}',
'h1{font-size:19px;letter-spacing:.5px}h1 span{color:#D7252A}',
'.sub{color:#8b93a1;font-size:13px;margin-top:4px;line-height:1.45}',
'h2{font-size:11px;letter-spacing:2.4px;color:#5b6270;margin:24px 0 8px;text-transform:uppercase}',
'.b{display:block;width:100%;text-align:center;border:1px solid #2b303b;background:#161922;color:#fff;',
'  border-radius:12px;padding:15px;font-size:15px;font-weight:700;margin-bottom:9px;text-decoration:none}',
'.b.oro{background:#FFD518;color:#000;border-color:#FFD518}',
'.b.rojo{background:#2a1414;border-color:#7a2323;color:#ff9a9c}',
'.b:disabled{opacity:.5}',
'.fila{display:flex;gap:8px;margin-bottom:9px}',
'.fila input{flex:1;min-width:0;background:#161922;border:1px solid #2b303b;color:#fff;',
'  border-radius:12px;padding:15px;font-size:15px}',
'.msg{margin:12px 0;padding:13px;border-radius:11px;font-size:14.5px;line-height:1.45}',
'.msg.ok{background:#12301c;border:1px solid #1f7a3a;color:#9be0b0}',
'.msg.mal{background:#3a1212;border:1px solid #7a2323;color:#ff9a9c}',
'.nota{color:#5b6270;font-size:12.5px;line-height:1.5;margin:6px 0 0}',
'</style></head><body>',
'<header><h1>BEER<span>PUNCH</span> \u00b7 probar</h1>',
'<div class="sub">Todo lo de ac\u00e1 es de mentira y se borra con un bot\u00f3n. ',
'Ten\u00e9 el t\u00f3tem a la vista mientras toc\u00e1s: la idea es que veas pasar las cosas en la pantalla.</div></header>',
'<div id="msg"></div>',

'<h2>1 \u00b7 el t\u00f3tem</h2>',
'<button class="b" onclick="pina()">Cargar una pi\u00f1a de prueba</button>',
'<div class="fila"><input id="ap" placeholder="apodo" maxlength="14">',
'<input id="sc" placeholder="puntos" inputmode="numeric" maxlength="3"></div>',
'<p class="nota">Si dej\u00e1s los casilleros vac\u00edos inventa un nombre y un puntaje. ',
'Si el puntaje supera al r\u00e9cord, en el t\u00f3tem salta el cartel\u00f3n de r\u00e9cord.</p>',

'<h2>2 \u00b7 el premio de la noche</h2>',
'<button class="b oro" onclick="pedir("/api/rey/coronar","GET")">Coronar al rey AHORA</button>',
'<p class="nota">Hace de cuenta que son las 3. Necesita al menos 5 pi\u00f1as cargadas esta noche ',
'(carg\u00e1 5 de prueba con el bot\u00f3n de arriba). En el t\u00f3tem sale el anuncio con el QR.</p>',
'<a class="b" href="/premio">Abrir la p\u00e1gina del QR (\u00bfgan\u00e9?)</a>',
'<a class="b" id="lPremios" href="#">Abrir la pantalla de la caja</a>',
'<button class="b rojo" onclick="pedir("/api/probar/descoronar")">Descoronar (para volver a probar)</button>',

'<h2>3 \u00b7 la ruleta</h2>',
'<button class="b" onclick="desbloquear()">Dejarme girar de nuevo</button>',
'<p class="nota">La ruleta se gira una vez por noche por persona y por celular. ',
'Esto suelta el candado de ESTE celular para que puedas volver a cargar y girar.</p>',
'<a class="b" href="/m">Ir a cargar una pi\u00f1a de verdad</a>',

'<h2>4 \u00b7 limpiar</h2>',
'<button class="b rojo" onclick="pedir("/api/probar/limpiar")">Borrar todas las pi\u00f1as de prueba</button>',
'<p class="nota">Borra s\u00f3lo las que cargaste desde ac\u00e1. Las de verdad no se tocan.</p>',

'<script>',
'var CLAVE=new URLSearchParams(location.search).get("clave")||"";',
'var q=CLAVE?("?clave="+encodeURIComponent(CLAVE)):"";',
'document.getElementById("lPremios").href="/premios"+q;',
'document.getElementById("lVivo").href="/vivo"+q;',
'function aviso(t,ok){var m=document.getElementById("msg");',
'  m.innerHTML="<div class=\'msg "+(ok?"ok":"mal")+"\'>"+t+"</div>";',
'  window.scrollTo(0,0);setTimeout(function(){m.innerHTML="";},7000);}',
'function pedir(ruta,metodo,datos){',
'  return fetch(ruta+q,{method:metodo||"POST",headers:{"Content-Type":"application/json"},',
'    body:(metodo==="GET")?undefined:JSON.stringify(datos||{})})',
'  .then(function(r){return r.json();})',
'  .then(function(d){',
'    if(d.error){aviso(d.error,false);return d;}',
'    if(d.ok===false){aviso(d.motivo||"no se pudo",false);return d;}',
'    if(d.rey){aviso("Coronado <b>"+d.rey.apodo+"</b> con "+d.rey.score+" \u00b7 "+d.rey.premio+" \u00b7 c\u00f3digo <b>"+d.rey.codigo+"</b>. Mir\u00e1 el t\u00f3tem.",true);return d;}',
'    if(d.borradas){aviso("Borradas "+d.borradas.pinas+" pi\u00f1as de prueba",true);return d;}',
'    if(typeof d.borrados==="number"){aviso("Listo, ya se puede volver a coronar",true);return d;}',
'    if(typeof d.liberadas==="number"){aviso("Listo: pod\u00e9s volver a cargar y girar desde este celular",true);return d;}',
'    aviso("Listo",true);return d;',
'  }).catch(function(){aviso("Sin conexi\u00f3n",false);});',
'}',
'function pina(){',
'  var a=document.getElementById("ap").value,s=document.getElementById("sc").value;',
'  pedir("/api/probar/pina","POST",{apodo:a,score:s}).then(function(d){',
'    if(d&&d.ok)aviso("Cargada: <b>"+d.apodo+"</b> con "+d.score+(d.esRecord?" \u00b7 \u00a1R\u00c9CORD!":"")+". Mir\u00e1 el t\u00f3tem.",true);',
'  });',
'}',
'function desbloquear(){',
'  var disp="";try{disp=localStorage.getItem("bp_disp")||"";}catch(e){}',
'  pedir("/api/probar/desbloquear","POST",{disp:disp,apodo:document.getElementById("ap").value});',
'}',
'<\/script></body></html>'
  ].join('\n');

  app.get('/probar', function (req, res) {
    if (!claveOk(req)) return res.status(401).send('falta la clave');
    res.type('html').send(HTML_PROBAR);
  });

  // ===== MODERACION =====
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
    log('PI\u00d1A', (p.oculta ? 'ocultada' : 'restaurada') + ': ' + p.apodo + ' ' + p.score);
    res.json({ ok: true, oculta: p.oculta });
  });

  // ===== PANTALLA DE MODERACION (la de Aldana) =====
  // Las pinas de la noche con la foto al lado y un boton para ocultar.
  // Pensada para el celular, detras de la clave.
  const HTML_FOTOS = [
'<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
'<meta name="color-scheme" content="dark"><title>BeerPunch \u00b7 Pi\u00f1as de la noche</title>',
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
'<header><h1>BEER<span>PUNCH</span> \u00b7 pi\u00f1as de la noche</h1>',
'<div class="sub" id="sub">cargando\u2026</div></header>',
'<div id="lista"></div>',
'<script>',
'var CLAVE=new URLSearchParams(location.search).get("clave")||"";',
'var q=CLAVE?("?clave="+encodeURIComponent(CLAVE)):"";',
'function hora(ts){return new Date(ts).toLocaleTimeString("es-AR",{timeZone:"America/Argentina/Buenos_Aires",hour:"2-digit",minute:"2-digit",hour12:false});}',
'function pintar(ps){',
'  var L=document.getElementById("lista");L.innerHTML="";',
'  document.getElementById("sub").textContent=ps.length+" pi\u00f1as \u00b7 toc\u00e1 OCULTAR para sacarla del ranking";',
'  if(!ps.length){L.innerHTML="<div class=\'vacio\'>Todav\u00eda no carg\u00f3 nadie</div>";return;}',
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
'    m.textContent=hora(p.ts)+(p.ig?" \u00b7 "+p.ig:"")+(p.oculta?" \u00b7 OCULTA":"");',
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
'      "<div class=\'err\'>"+(e.message==="clave"?"Clave incorrecta. Abr\u00ed el link con ?clave=\u2026":"No se pudo cargar. Revis\u00e1 la conexi\u00f3n.")+"</div>";',
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

  // ===== PAGINAS =====
  // Los HTML viven en la carpeta publico/ del repo.
  function servir(nombre) {
    return function (req, res) {
      const f = buscarWeb(nombre);
      if (!f) return res.status(404).send('falta el archivo ' + nombre +
        ' (lo busque en publico/ y en la raiz del repo)');
      res.sendFile(f);
    };
  }
  app.get('/m',     servir('carga.html'));   // el QR de la maquina apunta aca
  app.get('/totem', servir('totem.html'));   // lo que abre el TV Box

  const faltan = ['carga.html', 'totem.html'].filter(function (n) { return !buscarWeb(n); });
  if (faltan.length) {
    log('PI\u00d1AS', 'OJO: faltan las paginas ' + faltan.join(' y ') +
        '. El ranking funciona pero /m y /totem van a dar 404.');
  }

  log('PI\u00d1AS', 'm\u00f3dulo montado \u00b7 ' + pinas.length + ' pi\u00f1as y ' + premios.length + ' premios en memoria' +
      (persistenciaOk ? '' : ' \u00b7 SIN VOLUMEN: no se van a guardar'));
};
