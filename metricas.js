// ============================================================
// BPK / BeerPunch - modulo de METRICAS
// ------------------------------------------------------------
// Se monta encima del server que ya cobra, igual que pinas.js.
// Si este modulo falla, el cobro sigue funcionando: server.js lo
// carga adentro de un try.
//
// En server.js, despues de que esten definidas las funciones que
// necesita y ANTES del app.listen:
//
//   const montarMetricas = require('./metricas');
//   const MET = montarMetricas(app, { ... });
//
// Lo que aporta:
//   - jornadas.json : una fila por noche que NO se borra nunca.
//     Es lo mas importante del modulo: hoy las ventas se podan a
//     los 60 dias, asi que sin esto el historial largo no existe.
//   - redes.json    : en que wifi estuvo el Shelly, por tramos.
//   - escaneos.json : cuando se escaneo cada cupon (no cuando se uso).
//   - arranque.json : ultima vez que el Shelly aviso que encendio.
//   - Horarios que aceptan un momento cualquiera, no solo "ahora".
//   - Pantallas /metricas (para el bar) y /inversion (para mostrar).
// ============================================================

const fs = require('fs');
const path = require('path');

module.exports = function montarMetricas(app, ctx) {

  // ---------- lo que nos pasa el server ----------
  const DATA_DIR       = ctx.DATA_DIR || '/data';
  const persistenciaOk = !!ctx.persistenciaOk;
  const log            = ctx.log || function (t, m) { console.log(t + ' | ' + m); };
  const claveOk        = ctx.claveOk || function () { return true; };
  const CLAVE          = ctx.CLAVE || '';
  const HORA_ABRE      = typeof ctx.HORA_ABRE === 'number' ? ctx.HORA_ABRE : 17;
  const PORCENTAJE_BAR = typeof ctx.PORCENTAJE_BAR === 'number' ? ctx.PORCENTAJE_BAR : 0;
  const datos          = ctx.datos || {};
  const dVentas  = datos.ventas  || function () { return []; };
  const dCaidas  = datos.caidas  || function () { return []; };
  const dCupones = datos.cupones || function () { return {}; };
  const dCanjes  = datos.canjes  || function () { return []; };

  const TZ = 'America/Argentina/Buenos_Aires';
  const DIA = 24 * 60 * 60 * 1000;

  // ============================================================
  // 1. HORARIOS QUE ACEPTAN UN MOMENTO
  // ------------------------------------------------------------
  // Las de server.js (enHorarioDeBar, minutoDeCierre) no reciben
  // parametros: siempre responden por "ahora". Sirven para decidir
  // en vivo, pero no para analizar el pasado, porque el mismo dato
  // daria distinto segun la hora en que se mire la pantalla.
  // Estas son las mismas reglas, aplicables a cualquier momento.
  // ============================================================

  // Argentina no usa horario de verano desde 2009: el desfase es
  // -3 todo el ano. Si algun dia vuelve, hay que revisar esto.
  const MINUTOS_UTC = 180;

  function partesArg(ts) {
    const d = new Date(new Date(ts).toLocaleString('en-US', { timeZone: TZ }));
    return { y: d.getFullYear(), m: d.getMonth(), dia: d.getDate(),
             semana: d.getDay(), minutos: d.getHours() * 60 + d.getMinutes() };
  }

  function epochArg(y, m, dia, minutos) {
    return Date.UTC(y, m, dia) + (minutos + MINUTOS_UTC) * 60000;
  }

  // A que hora cierra la madrugada de un dia del calendario. Ojo: la
  // madrugada del sabado pertenece a la NOCHE del viernes, por eso se
  // mira el dia anterior. Viernes y sabado a la noche cierran 4:30;
  // el resto, 3:30.
  function cierreDeLaMadrugadaDe(diaSemana) {
    const noche = (diaSemana + 6) % 7;
    return (noche === 5 || noche === 6) ? (4 * 60 + 30) : (3 * 60 + 30);
  }

  function abiertoEn(ts) {
    const p = partesArg(ts);
    if (p.minutos >= HORA_ABRE * 60) return true;
    return p.minutos < cierreDeLaMadrugadaDe(p.semana);
  }

  // El proximo momento en que cambia abierto <-> cerrado. Con esto se
  // pueden partir las caidas que cruzan el cierre en vez de contarlas
  // enteras de un lado.
  function siguienteCambioDeHorario(ts) {
    const p = partesArg(ts);
    const cierre = cierreDeLaMadrugadaDe(p.semana);
    if (p.minutos < cierre)          return epochArg(p.y, p.m, p.dia, cierre);
    if (p.minutos < HORA_ABRE * 60)  return epochArg(p.y, p.m, p.dia, HORA_ABRE * 60);
    const man = partesArg(ts + DIA);
    return epochArg(man.y, man.m, man.dia, cierreDeLaMadrugadaDe(man.semana));
  }

  // Reparte los minutos de una caida entre abierto y cerrado. Una caida
  // que empieza 23:50 y termina a las 9 de la manana tiene unos pocos
  // minutos que duelen y muchas horas que no.
  function minutosAbiertoYCerrado(c) {
    const fin = c.fin || Date.now();
    let abiertos = 0, cerrados = 0, cursor = c.inicio, vueltas = 0;
    while (cursor < fin && vueltas++ < 400) {
      const corte = Math.min(fin, siguienteCambioDeHorario(cursor));
      const dur = (corte - cursor) / 60000;
      if (abiertoEn(cursor)) abiertos += dur; else cerrados += dur;
      cursor = corte;
    }
    return { abiertos: Math.round(abiertos), cerrados: Math.round(cerrados) };
  }

  // Cuantos minutos estuvo abierto el bar entre dos momentos. Es el
  // denominador de "confiabilidad": sin esto no se puede decir un
  // porcentaje, solo una cantidad suelta de minutos.
  function minutosAbiertosDe(desde, hasta) {
    let total = 0, cursor = desde, vueltas = 0;
    while (cursor < hasta && vueltas++ < 4000) {
      const corte = Math.min(hasta, siguienteCambioDeHorario(cursor));
      if (abiertoEn(cursor)) total += (corte - cursor) / 60000;
      cursor = corte;
    }
    return Math.round(total);
  }

  // La noche del bar arranca al mediodia, igual que en pinas.js.
  function nocheDe(ts) {
    const arg = new Date(new Date(ts).toLocaleString('en-US', { timeZone: TZ }));
    if (arg.getHours() < 12) arg.setDate(arg.getDate() - 1);
    return arg.getFullYear() + '-' +
      String(arg.getMonth() + 1).padStart(2, '0') + '-' +
      String(arg.getDate()).padStart(2, '0');
  }
  function nocheHoy() { return nocheDe(Date.now()); }

  // De la clave "2026-09-01" al momento en que arranca esa noche (12:00).
  function inicioDeNoche(clave) {
    const p = String(clave).split('-').map(Number);
    return epochArg(p[0], p[1] - 1, p[2], 12 * 60);
  }

  // ============================================================
  // 2. GUARDADO EN DISCO, ATOMICO
  // ------------------------------------------------------------
  // server.js usa writeFileSync pelado. Si se corta la luz justo en
  // el medio, el JSON queda partido y en el arranque siguiente el
  // server no levanta. Escribimos a un temporal, lo bajamos a disco
  // de verdad con fsync, y recien ahi lo renombramos: el rename es
  // atomico, o esta el viejo entero o el nuevo entero.
  // ============================================================

  function escribirAtomico(archivo, texto) {
    const tmp = archivo + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, texto);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, archivo);
  }

  function leer(archivo, porDefecto) {
    if (!persistenciaOk) return porDefecto;
    try {
      if (!fs.existsSync(archivo)) return porDefecto;
      return JSON.parse(fs.readFileSync(archivo, 'utf8'));
    } catch (e) {
      log('METRICAS', 'no se pudo leer ' + path.basename(archivo) + ': ' + e.message);
      return porDefecto;
    }
  }

  function guardar(archivo, valor) {
    if (!persistenciaOk) return;
    try { escribirAtomico(archivo, JSON.stringify(valor)); }
    catch (e) { log('METRICAS', 'no se pudo guardar ' + path.basename(archivo) + ': ' + e.message); }
  }

  const F_JORNADAS = path.join(DATA_DIR, 'jornadas.json');
  const F_REDES    = path.join(DATA_DIR, 'redes.json');
  const F_ESCANEOS = path.join(DATA_DIR, 'escaneos.json');
  const F_ARRANQUE = path.join(DATA_DIR, 'arranque.json');
  const F_PINAS    = path.join(DATA_DIR, 'pinas.json');
  const F_PREMIOS  = path.join(DATA_DIR, 'premios.json');

  let jornadas = leer(F_JORNADAS, []);
  let redes    = leer(F_REDES, []);
  let escaneos = leer(F_ESCANEOS, []);
  let arranque = leer(F_ARRANQUE, { ultimo: 0 });

  // Las pinas las lee pinas.js; aca solo las miramos, nunca las tocamos.
  // Se relee cada tanto para no castigar el disco en cada visita.
  let pinasCache = { ts: 0, lista: [] };
  function pinas() {
    if (Date.now() - pinasCache.ts < 20000) return pinasCache.lista;
    pinasCache = { ts: Date.now(), lista: leer(F_PINAS, []) };
    return pinasCache.lista;
  }
  function pinaVisible(p) { return p && !p.oculta && p.aprobada !== false; }

  let premiosCache = { ts: 0, lista: [] };
  function premios() {
    if (Date.now() - premiosCache.ts < 20000) return premiosCache.lista;
    premiosCache = { ts: Date.now(), lista: leer(F_PREMIOS, []) };
    return premiosCache.lista;
  }

  /* ---- las fotos del display ----
     El archivo lo sirve pinas.js en /api/foto/<archivo> y pide la clave. Esta
     pagina ya esta detras de la clave, asi que se la agregamos al src. Las
     ocultas TAMBIEN se muestran, en gris: son justamente las que hay que
     poder mirar para entender por que se ocultaron. */
  function fotoURL(archivo) {
    return '/api/foto/' + encodeURIComponent(archivo) +
           (CLAVE ? '?clave=' + encodeURIComponent(CLAVE) : '');
  }
  // 95 -> "1h 35m". Los minutos pelados no se leen de un vistazo.
  function fmtMin(m) {
    m = Math.max(0, Math.round(m));
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }

  function pinasDe(noche) {
    return pinas().filter(function (p) { return p.noche === noche; })
                  .sort(function (a, b) { return b.ts - a.ts; });
  }
  function fotosDe(noche) {
    return pinasDe(noche).filter(function (p) { return p.foto; });
  }
  function ultimasFotos(n) {
    return pinas().filter(function (p) { return p.foto; })
                  .sort(function (a, b) { return b.ts - a.ts; })
                  .slice(0, n || 12);
  }

  /* ---- lo que pasa en el totem, que hasta ahora no se veia en ningun lado ----
     El totem sabe cosas que el admin no: quien cargo, quien giro, que salio en
     la ruleta y que premios quedaron sin retirar. Sin esto, para saber si
     alguien tiene que pasar por la caja a buscar algo habia que acordarse. */
  function resumenTotem(dias) {
    const desde = dias ? Date.now() - dias * DIA : inicioDeNoche(nocheHoy());
    const lista = pinas().filter(function (p) { return p.ts >= desde && pinaVisible(p); });
    const pre = premios().filter(function (p) { return p.ts >= desde; });
    const gente = {};
    lista.forEach(function (p) { gente[clavePersona(p.apodo)] = 1; });
    const conIG = lista.filter(function (p) { return p.ig && String(p.ig).trim(); }).length;
    const porPremio = {};
    pre.forEach(function (p) { porPremio[p.premio] = (porPremio[p.premio] || 0) + 1; });
    const pendientes = pre.filter(function (p) { return !p.entregado; });
    const mejor = lista.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0) })[0];
    return {
      pinas: lista.length,
      personas: Object.keys(gente).length,
      conIG: conIG,
      giros: lista.filter(function (p) { return p.giro; }).length,
      premios: pre.length,
      pendientes: pendientes,
      porPremio: porPremio,
      mejor: mejor || null,
      tope: lista.filter(function (p) { return (p.score || 0) >= 999; }).length
    };
  }

  // ============================================================
  // 3. LO QUE EL SERVER NOS AVISA
  // ============================================================

  // El Shelly manda su red en cada consulta (cada 4,6 segundos). Guardar
  // en cada una serian 8.600 registros por noche y medio millon en dos
  // meses, reescribiendo el archivo entero cada vez. El dato solo vale
  // cuando CAMBIA, asi que solo ahi tocamos el disco.
  let redActual = redes.length ? redes[redes.length - 1].ssid : '';

  function anotarRed(ssid, rssi) {
    ssid = String(ssid || '').slice(0, 32);
    if (!ssid) return;
    const num = rssi === undefined || rssi === null || rssi === '' ? null : Number(rssi);
    if (ssid === redActual) {
      // misma red: solo refrescamos la senal del tramo abierto, sin escribir
      if (redes.length && num !== null && !isNaN(num)) redes[redes.length - 1].rssi = num;
      return;
    }
    if (redes.length) redes[redes.length - 1].hasta = Date.now();
    redes.push({ desde: Date.now(), hasta: null, ssid: ssid,
                 rssi: (num !== null && !isNaN(num)) ? num : null });
    const limite = Date.now() - 365 * DIA;
    redes = redes.filter(function (r) { return (r.hasta || Date.now()) > limite; });
    redActual = ssid;
    guardar(F_REDES, redes);
    log('METRICAS', 'red anotada: "' + ssid + '"');
  }

  function redEnEseMomento(ts) {
    for (let i = redes.length - 1; i >= 0; i--) {
      if (redes[i].desde <= ts && (redes[i].hasta === null || ts < redes[i].hasta)) return redes[i].ssid;
    }
    return null;
  }

  // El Shelly avisa por /shelly-hello cada vez que enciende. Guardarlo en
  // disco es lo que hace que "encendida desde" sobreviva a un deploy, y
  // ademas es lo que permite distinguir "la apagaron" de "se cayo el wifi".
  function anotarArranque() {
    arranque = { ultimo: Date.now() };
    guardar(F_ARRANQUE, arranque);
  }
  function ultimoArranque() { return arranque && arranque.ultimo ? arranque.ultimo : 0; }

  // El escaneo del cupon. No se registra en el GET de la pagina porque las
  // vistas previas de WhatsApp entran sin que nadie haya mirado nada: se
  // registra desde el navegador, un rato despues de cargar. Un robot no
  // ejecuta JavaScript ni espera; una persona si.
  const ESPERA_ESCANEO_MS = 30000;   // recargar la pagina no cuenta dos veces

  function registrarEscaneo(codigo) {
    const cod = String(codigo || '').toUpperCase().slice(0, 24);
    if (!cod) return;
    const ahora = Date.now();
    const repetido = escaneos.some(function (e) {
      return e.codigo === cod && (ahora - e.ts) < ESPERA_ESCANEO_MS;
    });
    if (repetido) return;
    escaneos.push({ ts: ahora, codigo: cod });
    const limite = ahora - 180 * DIA;
    escaneos = escaneos.filter(function (e) { return e.ts > limite; });
    guardar(F_ESCANEOS, escaneos);
  }

  // El server pega esto antes de cerrar la pagina del cupon.
  function scriptDeEscaneo(codigo) {
    const cod = String(codigo || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!cod) return '';
    return '<script>setTimeout(function(){' +
      'try{fetch("/cupon-escaneado/' + cod + '",{method:"POST"}).catch(function(){});}catch(e){}' +
      '},1200)</script>';
  }

  app.post('/cupon-escaneado/:codigo', function (req, res) {
    registrarEscaneo(req.params.codigo);
    res.json({ ok: true });
  });

  // ============================================================
  // 4. EL CIERRE DE JORNADA
  // ------------------------------------------------------------
  // Esto es lo mas importante del modulo. ventas se poda a los 60 dias
  // y caidas a los 90: sin una fila consolidada por noche, el historial
  // largo simplemente no existe y cada dia que pasa se pierde uno.
  // Son ~200 bytes por noche: 70 KB al ano.
  //
  // Al arrancar por primera vez rellena hacia atras con lo que todavia
  // quede en memoria, asi no empezamos de cero.
  // ============================================================

  function calcularJornada(clave) {
    const desde = inicioDeNoche(clave);
    const hasta = desde + DIA;
    const v = dVentas().filter(function (x) { return x.ts >= desde && x.ts < hasta; });
    const c = dCaidas().filter(function (x) { return x.inicio >= desde && x.inicio < hasta; });
    const p = pinas().filter(function (x) { return pinaVisible(x) && x.noche === clave; });

    let muertoAbierto = 0, muertoCerrado = 0, wifiAbierto = 0, apagadaAbierto = 0;
    c.forEach(function (x) {
      const r = minutosAbiertoYCerrado(x);
      muertoAbierto += r.abiertos;
      muertoCerrado += r.cerrados;
      if (x.motivo === 'apagada') apagadaAbierto += r.abiertos; else wifiAbierto += r.abiertos;
    });

    const personas = {};
    p.forEach(function (x) { personas[clavePersona(x.apodo)] = true; });

    return {
      noche: clave,
      desde: desde,
      total:       v.reduce(function (a, x) { return a + (x.monto || 0); }, 0),
      fichas:      v.reduce(function (a, x) { return a + (x.fichas || 0); }, 0),
      operaciones: v.length,
      pinas:    p.length,
      personas: Object.keys(personas).length,
      minAbierta:    minutosAbiertosDe(desde, hasta),
      muertoAbierto: muertoAbierto,
      muertoCerrado: muertoCerrado,
      wifiAbierto:    Math.round(wifiAbierto),
      apagadaAbierto: Math.round(apagadaAbierto),
      cortes: c.length,
      red: redEnEseMomento(desde + 6 * 3600e3),   // a las 18, con el bar abierto
      tipo: null                                   // 'normal' | 'evento', lo carga Fausto
    };
  }

  function clavePersona(apodo) {
    return String(apodo || '').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Cierra todas las noches terminadas que todavia no esten guardadas.
  function cerrarJornadasPendientes() {
    const hoy = nocheHoy();
    const guardadas = {};
    jornadas.forEach(function (j) { guardadas[j.noche] = true; });

    let nuevas = 0;
    for (let i = 1; i <= 90; i++) {
      const clave = nocheDe(Date.now() - i * DIA);
      if (clave === hoy || guardadas[clave]) continue;
      const j = calcularJornada(clave);
      // No guardamos noches vacias del pasado remoto: serian filas de ceros
      // inventadas por noches en las que el sistema ni existia.
      if (j.total === 0 && j.pinas === 0 && j.cortes === 0) continue;
      jornadas.push(j);
      guardadas[clave] = true;
      nuevas++;
    }
    if (nuevas) {
      jornadas.sort(function (a, b) { return a.desde - b.desde; });
      guardar(F_JORNADAS, jornadas);
      log('METRICAS', nuevas + (nuevas === 1 ? ' jornada guardada' : ' jornadas guardadas') +
          ' (total historico: ' + jornadas.length + ')');
    }
  }

  // La noche en curso todavia no esta cerrada: se calcula al vuelo para
  // que el panel muestre lo de hoy junto con lo historico.
  function jornadaEnCurso() { return calcularJornada(nocheHoy()); }

  function historico() {
    return jornadas.concat([jornadaEnCurso()]);
  }

  // ============================================================
  // 5. LOS NUMEROS, CON SU CONCLUSION AL LADO
  // ------------------------------------------------------------
  // Un numero solo nunca dice que hacer. Cada calculo devuelve tambien
  // la frase que lo interpreta, y cuando no hay datos suficientes lo
  // dice en vez de inventar un porcentaje con dos casos.
  // ============================================================

  function pesos(n) { return '$' + Math.round(n || 0).toLocaleString('es-AR'); }

  function duracion(min) {
    min = Math.round(min || 0);
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    return h + ' h ' + String(min % 60).padStart(2, '0') + ' min';
  }

  // ---- tiempo muerto, los cuatro casilleros ----
  function tiempoMuerto(desde, hasta) {
    const lista = dCaidas().filter(function (c) { return (c.fin || Date.now()) >= desde && c.inicio < hasta; });
    const r = {
      wifiAbierto: 0, wifiCerrado: 0, apagadaAbierto: 0, apagadaCerrado: 0,
      cortesWifiAbierto: 0, cortesApagadaAbierto: 0,
      minAbiertos: minutosAbiertosDe(desde, Math.min(hasta, Date.now())),
      aperturasFallidas: [], apagadasAnticipadas: [], lista: lista,
      abierta: null
    };
    lista.forEach(function (c) {
      const m = minutosAbiertoYCerrado(c);
      if (c.motivo === 'apagada') {
        r.apagadaAbierto += m.abiertos; r.apagadaCerrado += m.cerrados;
        if (m.abiertos > 0) r.cortesApagadaAbierto++;
      } else {
        r.wifiAbierto += m.abiertos; r.wifiCerrado += m.cerrados;
        if (m.abiertos > 0) r.cortesWifiAbierto++;
      }
      if (c.fin === null) r.abierta = c;

      // "Apertura fallida": el bar abrio y la maquina no estaba. Se
      // reconoce porque la caida ya venia de antes y sigue despues de
      // las 17, no porque haya empezado justo a esa hora.
      if (c.motivo === 'apagada' && m.abiertos > 0) {
        const p = partesArg(c.inicio);
        const abrio = epochArg(p.y, p.m, p.dia, HORA_ABRE * 60);
        const finC = c.fin || Date.now();
        if (c.inicio < abrio && finC > abrio) {
          r.aperturasFallidas.push({ caida: c, abrio: abrio, tarde: Math.round((finC - abrio) / 60000) });
        } else if (abiertoEn(c.inicio)) {
          // se apago sola en medio de la noche, con el bar andando
          r.apagadasAnticipadas.push(c);
        }
      }
    });
    r.muertoAbierto = r.wifiAbierto + r.apagadaAbierto;
    r.confiabilidad = r.minAbiertos > 0
      ? Math.max(0, Math.min(100, 100 * (1 - r.muertoAbierto / r.minAbiertos)))
      : null;
    return r;
  }

  // Los minutos muertos en pesos. Es una estimacion y hay que decirlo,
  // pero "18 minutos" no le dice nada a nadie y "$4.300 que no se
  // cobraron" se entiende solo.
  function plataPorMinuto() {
    const h = historico().filter(function (j) { return j.minAbierta > 0 && j.total > 0; }).slice(-14);
    if (!h.length) return 0;
    const suma = h.reduce(function (a, j) { return a + j.total / j.minAbierta; }, 0);
    return suma / h.length;
  }

  // ---- embudo del cupon ----
  // Repartidos -> escaneados -> activados -> compraron. Cada escalon dice
  // que arreglar, y son cosas distintas: el papel, la pagina, el precio.
  function embudoCupones(desde, hasta) {
    const cup = dCupones() || {};
    const codigos = Object.keys(cup);
    const repartidos = codigos.length;
    const esc = {};
    escaneos.forEach(function (e) { if (e.ts >= desde && e.ts < hasta) esc[e.codigo] = true; });
    const canjes = dCanjes().filter(function (x) { return x.ts >= desde && x.ts < hasta; });
    const escaneados = Object.keys(esc).length;
    const activados  = canjes.length;
    const compraron  = canjes.filter(function (x) { return x.conv15; }).length;

    const pc = function (a, b) { return b ? Math.round(a * 100 / b) : 0; };
    const e = {
      repartidos: repartidos, escaneados: escaneados,
      activados: activados, compraron: compraron,
      pcEscaneo: pc(escaneados, repartidos),
      pcActivacion: pc(activados, escaneados),
      pcCompra: pc(compraron, activados),
      recaudado: canjes.reduce(function (a, x) { return a + (x.montoConv || 0); }, 0),
      hayEscaneos: escaneados > 0
    };

    // Donde se corta la cadena. Solo opinamos si hay volumen para opinar.
    e.diagnostico = null;
    if (repartidos >= 5 && e.hayEscaneos) {
      if (e.pcEscaneo < 40) e.diagnostico = 'Se reparten pero casi no se escanean. El problema est\u00e1 en el cup\u00f3n impreso: no invita a sacar el tel\u00e9fono.';
      else if (e.pcActivacion < 40) e.diagnostico = 'Escanean y se arrepienten antes de apretar el bot\u00f3n. El problema est\u00e1 en la p\u00e1gina o en el momento en que se reparte.';
      else if (e.pcCompra < 25) e.diagnostico = 'Juegan el tiro gratis y se van sin comprar. El tiro gratis no est\u00e1 enganchando: probar repartir en otra franja.';
      else e.diagnostico = 'El embudo est\u00e1 sano: se escanean, se activan y compran.';
    } else if (!e.hayEscaneos && repartidos > 0) {
      e.diagnostico = 'Todav\u00eda no hay escaneos registrados. El registro arranca desde que se subi\u00f3 este m\u00f3dulo, no cuenta hacia atr\u00e1s.';
    }
    return e;
  }

  // ---- la mejor hora, como recomendacion y no como numero suelto ----
  /* ---- cuando conviene repartir los cupones ----
     Antes esto miraba hora por hora y pedia 5 canjes en la MISMA hora para
     decir algo. Con un bar abierto de 17 a 3:30 son diez casilleros: con 20
     canjes te quedan dos por casillero y nunca llega a 5, asi que el panel
     siempre mostraba "no alcanza". El dato no estaba mal, estaba mal cortado.
     Tres franjas juntan datos cuatro veces mas rapido y ademas es como se
     piensa un bar: temprano, el pico, y la madrugada. */
  const FRANJAS = [
    { nom: 'Temprano (17 a 21)',   dentro: function (m) { return m >= 17 * 60 && m < 21 * 60; } },
    { nom: 'El pico (21 a 00)',    dentro: function (m) { return m >= 21 * 60; } },
    { nom: 'Madrugada (00 en adelante)', dentro: function (m) { return m < 12 * 60; } }
  ];
  const MINIMO_FRANJA = 3;   // con 2 canjes un 100% es una moneda al aire

  function franjaDe(ts) {
    const m = partesArg(ts).minutos;
    for (let i = 0; i < FRANJAS.length; i++) if (FRANJAS[i].dentro(m)) return i;
    return 0;
  }

  function porFranjas(dias) {
    const desde = Date.now() - (dias || 30) * DIA;
    const f = FRANJAS.map(function (x) { return { nom: x.nom, canjes: 0, conv: 0 }; });
    dCanjes().forEach(function (x) {
      if (x.ts < desde) return;
      const i = franjaDe(x.ts);
      f[i].canjes++;
      if (x.conv15) f[i].conv++;
    });
    f.forEach(function (x) { x.pc = x.canjes ? Math.round(x.conv * 100 / x.canjes) : null; });

    const conDatos = f.filter(function (x) { return x.canjes >= MINIMO_FRANJA; });
    const total = f.reduce(function (a, x) { return a + x.canjes; }, 0);
    if (!conDatos.length) {
      const masLlena = f.slice().sort(function (a, b) { return b.canjes - a.canjes; })[0];
      return { filas: f, hay: false, total: total,
        texto: total === 0
          ? 'Todav\u00eda no se canje\u00f3 ning\u00fan cup\u00f3n. Este cuadro se llena solo a medida que los usen.'
          : 'Con ' + total + ' ' + (total === 1 ? 'canje' : 'canjes') + ' todav\u00eda no alcanza para comparar franjas. ' +
            'Con ' + MINIMO_FRANJA + ' en una misma franja ya te puedo decir cu\u00e1l convierte mejor; ' +
            'la que m\u00e1s tiene es "' + masLlena.nom + '" con ' + masLlena.canjes + '.' };
    }
    const mejor = conDatos.slice().sort(function (a, b) { return b.pc - a.pc; })[0];
    const peor  = conDatos.slice().sort(function (a, b) { return a.pc - b.pc; })[0];
    let texto = 'La franja que mejor convierte es <b>' + esc(mejor.nom) + '</b>: de ' + mejor.canjes +
      ' canjes, ' + mejor.conv + ' ' + (mejor.conv === 1 ? 'compr\u00f3' : 'compraron') + ' despu\u00e9s (' + mejor.pc + '%).';
    if (conDatos.length > 1 && mejor.pc > peor.pc) {
      texto += ' Contra ' + peor.pc + '% de "' + esc(peor.nom) + '": el mismo cup\u00f3n rinde ' +
        (peor.pc > 0 ? (mejor.pc / peor.pc).toFixed(1) + ' veces m\u00e1s' : 'mucho m\u00e1s') + ' si se reparte en esa franja.';
    }
    return { filas: f, hay: true, total: total, mejor: mejor, texto: texto };
  }

  // ---- ingresos ----
  function ingresosEntre(desdeNoche, hastaNoche) {
    const h = historico().filter(function (j) { return j.noche >= desdeNoche && j.noche <= hastaNoche; });
    return {
      total: h.reduce(function (a, j) { return a + j.total; }, 0),
      fichas: h.reduce(function (a, j) { return a + j.fichas; }, 0),
      noches: h.length, lista: h
    };
  }

  function claveHaceDias(n) { return nocheDe(Date.now() - n * DIA); }

  function fraseComparativa(actual, anterior) {
    if (!anterior) return null;
    const delta = Math.round((actual - anterior) * 100 / anterior);
    if (Math.abs(delta) < 5) return 'Estable respecto a la semana pasada.';
    return (delta > 0 ? '+' : '') + delta + '% que la semana pasada (' + pesos(anterior) + ').';
  }

  // ---- piso y techo: noche normal vs noche de evento ----
  function pisoYTecho(dias) {
    const desde = claveHaceDias(dias || 30);
    const h = historico().filter(function (j) { return j.noche >= desde && j.total > 0; });
    const prom = function (l) { return l.length ? l.reduce(function (a, j) { return a + j.total; }, 0) / l.length : 0; };
    const normales = h.filter(function (j) { return j.tipo === 'normal'; });
    const eventos  = h.filter(function (j) { return j.tipo === 'evento'; });
    const sinMarcar = h.filter(function (j) { return !j.tipo; });
    return {
      piso: prom(normales), nNormales: normales.length,
      techo: prom(eventos), nEventos: eventos.length,
      sinMarcar: sinMarcar.length,
      promedioGeneral: prom(h), noches: h.length
    };
  }

  // ---- adopcion: el numero que prueba (o no) la tesis del negocio ----
  // Que porcentaje de los tiros pagos termina con una pina cargada al
  // ranking. Si da bajo, esto es una maquina de monedas con una pantalla
  // al lado; si da alto, es una experiencia. Es la metrica mas cara de
  // todo el sistema y era la unica que no se estaba midiendo.
  function adopcion(dias) {
    const desde = claveHaceDias(dias || 30);
    const h = historico().filter(function (j) { return j.noche >= desde; });
    const fichas = h.reduce(function (a, j) { return a + j.fichas; }, 0);
    const pin    = h.reduce(function (a, j) { return a + j.pinas; }, 0);
    if (!fichas) return { hay: false, texto: 'Todav\u00eda no hay tiros pagos en el per\u00edodo.' };
    const pc = Math.round(pin * 100 / fichas);
    let texto;
    if (pc >= 50)      texto = 'De cada 100 tiros pagos, ' + pc + ' terminaron con una pi\u00f1a cargada. La gente usa el sistema, no solo la m\u00e1quina.';
    else if (pc >= 25) texto = 'De cada 100 tiros pagos, ' + pc + ' cargaron su pi\u00f1a. Hay enganche pero queda mucho arriba de la mesa: vale la pena empujar el QR.';
    else               texto = 'Solo ' + pc + ' de cada 100 tiros pagos cargaron su pi\u00f1a. Hoy esto funciona m\u00e1s como m\u00e1quina de monedas que como experiencia.';
    return { hay: true, pc: pc, fichas: fichas, pinas: pin, texto: texto };
  }

  // ---- recurrencia: cuanta gente vuelve otra noche ----
  // Despues de la facturacion es el numero mas importante que existe:
  // separa una novedad de un negocio.
  function recurrencia(dias) {
    const desde = claveHaceDias(dias || 30);
    const porPersona = {};
    pinas().forEach(function (p) {
      if (!pinaVisible(p) || p.noche < desde) return;
      const k = clavePersona(p.apodo);
      if (!k) return;
      if (!porPersona[k]) porPersona[k] = {};
      porPersona[k][p.noche] = true;
    });
    const gente = Object.keys(porPersona);
    if (gente.length < 5) return { hay: false, texto: 'Todav\u00eda hay poca gente registrada para medir si vuelven.' };
    const repiten = gente.filter(function (k) { return Object.keys(porPersona[k]).length > 1; });
    const pc = Math.round(repiten.length * 100 / gente.length);
    return { hay: true, personas: gente.length, repiten: repiten.length, pc: pc,
      texto: pc >= 25
        ? pc + '% de la gente jug\u00f3 en m\u00e1s de una noche distinta. Hay recurrencia real.'
        : 'Solo ' + pc + '% volvi\u00f3 otra noche. Por ahora la mayor\u00eda prueba una vez y no vuelve.' };
  }

  // ---- que red se lleva los cortes ----
  function cortesPorRed(dias) {
    const desde = Date.now() - (dias || 30) * DIA;
    const porRed = {};
    dCaidas().forEach(function (c) {
      if (c.inicio < desde || c.motivo !== 'wifi') return;
      const m = minutosAbiertoYCerrado(c);
      const r = redEnEseMomento(c.inicio) || 'sin dato';
      if (!porRed[r]) porRed[r] = { cortes: 0, minutos: 0 };
      porRed[r].cortes++;
      porRed[r].minutos += m.abiertos + m.cerrados;
    });
    return porRed;
  }

  /* ---- LA NOCHE, HORA POR HORA ----
     Los numeros sueltos ("se cayo 40 minutos", "entraron $18.000") no dicen
     nada solos. Puestos en la misma fila por hora si: se ve que el corte fue
     justo a las 2, que a esa hora el bar estaba lleno, y cuanta plata no se
     cobro mientras estaba muerta. Es la unica forma de discutir si conviene
     cambiar de wifi o si el problema es que alguien la apaga. */
  function horaPorHora(clave) {
    const arranque = inicioDeNoche(clave);          // mediodia de ese dia
    const caidas = dCaidas();
    const ventas = dVentas();
    const pin = pinas().filter(function (p) { return pinaVisible(p) && p.noche === clave; });
    const ppm = plataPorMinuto();
    const filas = [];
    for (let i = 5; i <= 17; i++) {                 // de las 17 a las 05
      const desde = arranque + i * 3600e3;
      const hasta = desde + 3600e3;
      if (desde > Date.now()) break;
      const abiertos = minutosAbiertosDe(desde, Math.min(hasta, Date.now()));
      if (!abiertos) continue;                      // el bar estaba cerrado
      let muerto = 0, motivo = null;
      caidas.forEach(function (c) {
        const a = Math.max(c.inicio, desde), b = Math.min(c.fin || Date.now(), hasta);
        if (b <= a || c.incompleta) return;
        const m = minutosAbiertosDe(a, b);
        if (!m) return;
        muerto += m;
        if (!motivo || m > 0) motivo = c.motivo || 'wifi';
      });
      muerto = Math.min(muerto, abiertos);
      filas.push({
        hora: (i + 12) % 24,
        abiertos: abiertos,
        muerto: muerto,
        motivo: motivo,
        red: redEnEseMomento(desde + 1800e3),
        pinas: pin.filter(function (p) { return p.ts >= desde && p.ts < hasta; }).length,
        plata: ventas.filter(function (v) { return v.ts >= desde && v.ts < hasta; })
                     .reduce(function (a, v) { return a + (v.monto || 0); }, 0),
        perdido: Math.round(muerto * ppm)
      });
    }
    return filas;
  }

  /* ---- que red rinde mas, no solo cual se corta mas ----
     La seccion de wifi que ya estaba solo contaba cortes. Un corte de 2
     minutos a las 18 y uno de 40 a las 2 pesan igualito ahi, y no son lo
     mismo. Esto cruza cada red con las horas que estuvo puesta, la plata que
     entro mientras tanto y la senal promedio. */
  function rendimientoPorRed(dias) {
    const desde = Date.now() - (dias || 30) * DIA;
    const porRed = {};
    const tocar = function (ssid) {
      const k = ssid || 'sin dato';
      if (!porRed[k]) porRed[k] = { minutos: 0, muerto: 0, cortes: 0, plata: 0,
                                    pinas: 0, senal: [], red: k };
      return porRed[k];
    };
    // cuanto tiempo estuvo puesta cada red, dentro del horario del bar
    redes.forEach(function (r) {
      const a = Math.max(r.desde, desde), b = Math.min(r.hasta || Date.now(), Date.now());
      if (b <= a) return;
      const e = tocar(r.ssid);
      e.minutos += minutosAbiertosDe(a, b);
      if (typeof r.rssi === 'number') e.senal.push(r.rssi);
    });
    dCaidas().forEach(function (c) {
      if (c.incompleta || (c.fin || Date.now()) < desde) return;
      const m = minutosAbiertoYCerrado(c);
      if (!m.abiertos) return;
      const e = tocar(redEnEseMomento(c.inicio));
      e.muerto += m.abiertos;
      if (c.motivo !== 'apagada') e.cortes++;
    });
    dVentas().forEach(function (v) {
      if (v.ts < desde) return;
      const e = tocar(redEnEseMomento(v.ts));
      e.plata += (v.monto || 0);
    });
    pinas().forEach(function (p) {
      if (p.ts < desde || !pinaVisible(p)) return;
      tocar(redEnEseMomento(p.ts)).pinas++;
    });
    return Object.keys(porRed).map(function (k) {
      const e = porRed[k];
      e.senalProm = e.senal.length
        ? Math.round(e.senal.reduce(function (a, x) { return a + x; }, 0) / e.senal.length) : null;
      e.caidaPc = e.minutos > 0 ? (100 * e.muerto / e.minutos) : 0;
      return e;
    }).sort(function (a, b) { return b.minutos - a.minutos; });
  }

  // Una senal en dBm no le dice nada a nadie. En palabras, si.
  function calidadSenal(dbm) {
    if (dbm === null || dbm === undefined) return { txt: 'sin dato', color: 'tenue' };
    if (dbm >= -60) return { txt: 'buena', color: 'ok' };
    if (dbm >= -67) return { txt: 'justa', color: 'ok' };
    if (dbm >= -75) return { txt: 'pobre', color: 'aviso' };
    return { txt: 'muy pobre', color: 'mal' };
  }

  /* ---- ANTES Y DESPUES DEL TOTEM ----
     La fecha en que la pantalla empezo a funcionar. Todo lo anterior es el
     "antes": la misma maquina, el mismo bar, la misma gente, sin el juego.
     Es el unico numero que le importa a alguien que va a poner plata: no
     cuanto factura la maquina, sino CUANTO CAMBIO cuando se le puso esto
     encima. Y se compara por noche abierta, no por total, porque si un lado
     tiene mas noches que el otro el total miente solo. */
  const TOTEM_DESDE = '2026-09-09';

  function antesYDespues() {
    const lado = { antes: [], despues: [] };
    historico().forEach(function (j) {
      if (!j || !j.noche || !j.minAbierta) return;
      // Una noche sin un peso no es una noche floja: casi siempre es una
      // noche en que el bar no abrio o la maquina no estaba. Mezclarlas
      // arruina los dos promedios.
      if (!j.total) return;
      (j.noche < TOTEM_DESDE ? lado.antes : lado.despues).push(j);
    });
    const prom = function (l, campo) {
      if (!l.length) return 0;
      return l.reduce(function (a, j) { return a + (j[campo] || 0); }, 0) / l.length;
    };
    const a = prom(lado.antes, 'total'), d = prom(lado.despues, 'total');
    const suficiente = lado.antes.length >= 3 && lado.despues.length >= 3;
    return {
      desde: TOTEM_DESDE,
      nochesAntes: lado.antes.length,
      nochesDespues: lado.despues.length,
      porNocheAntes: a,
      porNocheDespues: d,
      totalAntes: lado.antes.reduce(function (x, j) { return x + j.total; }, 0),
      totalDespues: lado.despues.reduce(function (x, j) { return x + j.total; }, 0),
      pinasDespues: prom(lado.despues, 'pinas'),
      personasDespues: prom(lado.despues, 'personas'),
      cambio: a > 0 ? ((d - a) / a * 100) : null,
      suficiente: suficiente
    };
  }

  // ---- las alertas: solo lo que pide una accion ----
  function alertas() {
    const a = [];
    const sem = tiempoMuerto(Date.now() - 7 * DIA, Date.now());

    sem.aperturasFallidas.forEach(function (x) {
      const d = new Date(x.abrio);
      a.push({ nivel: 'alto', texto: 'El ' + d.toLocaleDateString('es-AR', { timeZone: TZ, weekday: 'long' }) +
        ' la m\u00e1quina no estaba prendida cuando abri\u00f3 el bar. Arranc\u00f3 ' + duracion(x.tarde) + ' tarde.' });
    });
    if (sem.apagadasAnticipadas.length) {
      a.push({ nivel: 'alto', texto: sem.apagadasAnticipadas.length === 1
        ? 'Una noche la m\u00e1quina se apag\u00f3 con el bar todav\u00eda abierto. No fue el apagado de rutina.'
        : sem.apagadasAnticipadas.length + ' veces esta semana la m\u00e1quina se apag\u00f3 con el bar abierto.' });
    }
    if (sem.wifiAbierto >= 20) {
      const red = redes.length ? redes[redes.length - 1].ssid : null;
      a.push({ nivel: 'medio', texto: 'El wifi cort\u00f3 el cobro ' + duracion(sem.wifiAbierto) +
        ' esta semana con el bar abierto' + (red ? ', estando en "' + red + '"' : '') + '.' });
    }
    if (!persistenciaOk) {
      a.push({ nivel: 'alto', texto: 'El volumen de Railway no est\u00e1 montado: nada de esto se est\u00e1 guardando en disco.' });
    }
    const hoy = jornadaEnCurso();
    if (hoy.fichas > 10 && hoy.pinas === 0) {
      a.push({ nivel: 'medio', texto: 'Hoy se vendieron ' + hoy.fichas + ' tiros y no se carg\u00f3 ninguna pi\u00f1a. Revisar que el QR de la m\u00e1quina est\u00e9 visible y que el t\u00f3tem funcione.' });
    }
    return a;
  }

  // ============================================================
  // 6. LAS PANTALLAS
  // ============================================================

  const c = CLAVE ? ('?clave=' + encodeURIComponent(CLAVE)) : '';
  const cAmp = CLAVE ? ('&clave=' + encodeURIComponent(CLAVE)) : '';

  const ESTILOS =
    ':root{--fondo:#1A0E0E;--sup:#241414;--borde:#3A2020;--cuero:#7A2E2E;--hueso:#EDE4D8;' +
    '--tenue:#9A8378;--led:#FFB020;--ok:#4E9B5F;--mal:#D8443C;--medio:#E08A2B}' +
    '*{box-sizing:border-box}' +
    'body{margin:0;background:var(--fondo);color:var(--hueso);font-family:-apple-system,system-ui,sans-serif;padding:0 0 48px}' +
    '.tope{padding:20px 18px 14px;border-bottom:1px solid var(--borde)}' +
    '.marca{font-family:Anton,Impact,sans-serif;font-size:32px;letter-spacing:.06em;line-height:1;text-transform:uppercase;margin:0}' +
    '.marca em{font-style:normal;color:var(--cuero)}' +
    '.sub{font-family:"Share Tech Mono",monospace;font-size:12px;color:var(--tenue);letter-spacing:.14em;text-transform:uppercase;margin-top:6px}' +
    '.seccion{padding:22px 18px;border-bottom:1px solid var(--borde)}' +
    '.titulo{font-family:Anton,Impact,sans-serif;font-size:15px;letter-spacing:.1em;text-transform:uppercase;color:var(--tenue);margin:0 0 14px}' +
    '.cifra{font-family:"Share Tech Mono",monospace;font-size:52px;line-height:1.05;color:var(--led);text-shadow:0 0 22px rgba(255,176,32,.32);margin:2px 0}' +
    '.cifra.chica{font-size:34px}' +
    '.cifra.texto{font-size:26px;word-break:break-all;line-height:1.15}' +
    '.cifra.mala{color:var(--mal);text-shadow:0 0 22px rgba(216,68,60,.3)}' +
    '.cifra.buena{color:var(--ok);text-shadow:0 0 22px rgba(78,155,95,.3)}' +
    '.lectura{font-size:14px;line-height:1.5;color:var(--hueso);opacity:.92;margin:8px 0 0}' +
    '.lectura.tenue{color:var(--tenue)}' +
    '.rot{font-family:"Share Tech Mono",monospace;font-size:11px;letter-spacing:.24em;color:var(--tenue);text-transform:uppercase}' +
    '.alerta{display:flex;gap:11px;align-items:flex-start;background:#3A1414;border-left:3px solid var(--mal);' +
    'padding:12px 14px;margin-bottom:9px;font-size:14px;line-height:1.45;border-radius:0 6px 6px 0}' +
    '.alerta.medio{background:#33220E;border-left-color:var(--medio)}' +
    '.alerta b{flex:none;font-family:"Share Tech Mono",monospace;font-size:11px;letter-spacing:.1em;opacity:.75;padding-top:2px}' +
    '.reparto{display:flex;justify-content:space-between;gap:12px;font-family:"Share Tech Mono",monospace;' +
    'font-size:14px;padding:9px 0;border-bottom:1px solid var(--borde)}' +
    '.reparto:last-child{border-bottom:0}' +
    '.reparto span{color:var(--tenue)}' +
    '.cuadrantes{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:6px}' +
    '.cua{background:var(--sup);border:1px solid var(--borde);border-radius:8px;padding:13px}' +
    '.cua.duele{border-color:#5A2020;background:#2A1414}' +
    '.cua .et{font-family:"Share Tech Mono",monospace;font-size:10px;letter-spacing:.12em;color:var(--tenue);text-transform:uppercase}' +
    '.cua .va{font-family:"Share Tech Mono",monospace;font-size:24px;margin-top:5px}' +
    '.cua.duele .va{color:var(--mal)}' +
    '.cua.tranqui .va{color:var(--tenue);opacity:.6}' +
    '.embudo div{margin-bottom:7px}' +
    '.paso{display:flex;align-items:center;gap:9px;font-family:"Share Tech Mono",monospace;font-size:13px}' +
    '.paso .nom{width:96px;flex:none;color:var(--tenue);font-size:11px;letter-spacing:.08em;text-transform:uppercase}' +
    '.paso .barra{flex:1;height:19px;background:#2E1A1A;border-radius:2px;overflow:hidden}' +
    '.paso .barra i{display:block;height:100%;background:var(--cuero)}' +
    '.paso .num{width:66px;text-align:right;flex:none}' +
    '.hist{display:flex;align-items:flex-end;gap:3px;height:96px;margin-bottom:10px}' +
    '.hist div{flex:1;background:var(--cuero);border-radius:2px 2px 0 0;min-height:2px;position:relative}' +
    '.hist div.evento{background:var(--led)}' +
    '.hist div.hoy{opacity:.55}' +
    '.botones{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}' +
    '.b{display:block;text-align:center;padding:13px 8px;background:var(--sup);border:1px solid var(--borde);' +
    'border-radius:8px;color:var(--hueso);text-decoration:none;font-size:13px}' +
    '.b.ancho{grid-column:1/-1}' +
    '.b.on{background:var(--cuero);border-color:var(--cuero)}' +
    '.tabla{width:100%;border-collapse:collapse;font-family:"Share Tech Mono",monospace;font-size:13px}' +
    '.tabla td{padding:8px 4px;border-bottom:1px solid var(--borde)}' +
    '.tabla td.der{text-align:right}' +
    '.tabla td.tenue{color:var(--tenue)}' +
    '.tenue{color:var(--tenue)}' +
    '.tabla a{color:var(--tenue);text-decoration:none;font-size:11px;border:1px solid var(--borde);' +
    'padding:3px 7px;border-radius:5px}' +
    '.tabla a.on{color:var(--led);border-color:var(--led)}' +
    '.tira{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:9px}' +
    '.pic{display:block;text-decoration:none;color:inherit;background:var(--sup);border:1px solid var(--borde);' +
    'border-radius:8px;overflow:hidden}' +
    '.pic img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:#1a1010}' +
    '.pic .cap{padding:6px 7px 7px;font-family:"Share Tech Mono",monospace;font-size:11px;line-height:1.35}' +
    '.pic .cap b{display:block;color:var(--led);font-size:15px}' +
    '.pic .cap span{color:var(--tenue)}' +
    '.pic.oculta{opacity:.4}' +
    '.pic.oculta .cap b{color:var(--mal)}' +
    /* la noche hora por hora: una fila por hora, con la barra de plata al
       lado del estado de la maquina. Cruzar los dos es el unico modo de ver
       si el corte pasa cuando el bar esta lleno o cuando no hay nadie. */
    '.hh{font-family:"Share Tech Mono",monospace;font-size:12.5px}' +
    '.hh .f{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--borde)}' +
    '.hh .f:last-child{border-bottom:0}' +
    '.hh .h{width:42px;flex:none;color:var(--tenue)}' +
    '.hh .luz{width:9px;height:26px;flex:none;border-radius:2px;background:var(--ok)}' +
    '.hh .luz.mitad{background:linear-gradient(180deg,var(--ok) 50%,var(--mal) 50%)}' +
    '.hh .luz.mala{background:var(--mal)}' +
    '.hh .bar{flex:1;height:22px;background:#2E1A1A;border-radius:2px;overflow:hidden;position:relative}' +
    '.hh .bar i{display:block;height:100%;background:var(--cuero)}' +
    '.hh .bar u{position:absolute;inset:0;display:flex;align-items:center;padding:0 6px;' +
    'font-style:normal;font-size:11px;color:var(--hueso);opacity:.92}' +
    '.hh .pl{width:74px;flex:none;text-align:right}' +
    '.hh .nota{color:var(--mal);font-size:11px;padding:0 0 7px 50px;border-bottom:1px solid var(--borde)}' +
    '.hh .ssid{color:var(--tenue);font-size:10.5px;letter-spacing:.06em}' +
    '.pie{padding:18px;text-align:center;color:var(--tenue);font-size:11px;font-family:"Share Tech Mono",monospace}';

  function cabeza(titulo, sub) {
    return '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + titulo + '</title>' +
      '<link rel="preconnect" href="https://fonts.googleapis.com">' +
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      '<link href="https://fonts.googleapis.com/css2?family=Anton&family=Share+Tech+Mono&display=swap" rel="stylesheet">' +
      '<style>' + ESTILOS + '</style></head><body>' +
      '<div class="tope"><h1 class="marca">Beer<em>punch</em></h1>' +
      '<div class="sub">' + sub + '</div></div>';
  }

  function esc(t) {
    return String(t === null || t === undefined ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .split('"').join('&quot;');
  }

  // ---------- /metricas : la pantalla del bar ----------
  app.get('/metricas', function (req, res) {
    if (!claveOk(req)) return res.status(403).send('clave invalida');
    cerrarJornadasPendientes();

    const hoy = jornadaEnCurso();
    const tmHoy = tiempoMuerto(inicioDeNoche(nocheHoy()), Date.now());
    const tmSem = tiempoMuerto(Date.now() - 7 * DIA, Date.now());
    const porMin = plataPorMinuto();
    const emb = embudoCupones(Date.now() - 30 * DIA, Date.now());
    const mej = porFranjas(30);
    const ado = adopcion(30);
    const rec = recurrencia(30);
    const sem  = ingresosEntre(claveHaceDias(6), nocheHoy());
    const sem2 = ingresosEntre(claveHaceDias(13), claveHaceDias(7));
    const redes30 = cortesPorRed(30);
    const al = alertas();

    let h = cabeza('BPK metricas', 'panel de m\u00e9tricas &middot; ' +
      new Date().toLocaleString('es-AR', { timeZone: TZ, hour12: false }));

    // --- alertas ---
    if (al.length) {
      h += '<div class="seccion"><h2 class="titulo">Lo que pide una acci\u00f3n</h2>';
      al.forEach(function (x) {
        h += '<div class="alerta' + (x.nivel === 'medio' ? ' medio' : '') + '">' +
          '<b>' + (x.nivel === 'alto' ? '!' : '~') + '</b><div>' + esc(x.texto) + '</div></div>';
      });
      h += '</div>';
    }

    // --- esta noche ---
    h += '<div class="seccion"><h2 class="titulo">Esta noche</h2>' +
      '<div class="rot">Recaudado</div>' +
      '<div class="cifra">' + pesos(hoy.total) + '</div>' +
      '<p class="lectura">' + hoy.fichas + ' tiros vendidos en ' + hoy.operaciones + ' operaciones' +
      (hoy.pinas ? ', y ' + hoy.pinas + (hoy.pinas === 1 ? ' pi\u00f1a cargada' : ' pi\u00f1as cargadas') +
        ' por ' + hoy.personas + (hoy.personas === 1 ? ' persona' : ' personas') : ', sin pi\u00f1as cargadas todav\u00eda') +
      '.</p>' +
      (PORCENTAJE_BAR ? '<div class="reparto" style="margin-top:12px"><span>Le toca al bar</span><b>' +
        pesos(hoy.total * PORCENTAJE_BAR / 100) + '</b></div>' : '') +
      '</div>';

    // --- tiempo muerto ---
    const perdidoSem = Math.round(tmSem.muertoAbierto * porMin);
    h += '<div class="seccion"><h2 class="titulo">Tiempo muerto &middot; \u00faltimos 7 d\u00edas</h2>' +
      '<div class="cuadrantes">' +
      '<div class="cua' + (tmSem.wifiAbierto ? ' duele' : ' tranqui') + '">' +
        '<div class="et">Wifi &middot; bar abierto</div><div class="va">' + duracion(tmSem.wifiAbierto) + '</div></div>' +
      '<div class="cua' + (tmSem.apagadaAbierto ? ' duele' : ' tranqui') + '">' +
        '<div class="et">Apagada &middot; bar abierto</div><div class="va">' + duracion(tmSem.apagadaAbierto) + '</div></div>' +
      '</div>';
    if (tmSem.muertoAbierto > 0 && porMin > 0) {
      h += '<p class="lectura">Al ritmo de las \u00faltimas noches, esos ' + duracion(tmSem.muertoAbierto) +
        ' son aproximadamente <b>' + pesos(perdidoSem) + ' que no se cobraron</b>. Es una estimaci\u00f3n, no una cuenta exacta.</p>';
    } else {
      h += '<p class="lectura">Ni un minuto de cobro perdido con el bar abierto esta semana.</p>';
    }
    if (tmSem.confiabilidad !== null) {
      h += '<div class="reparto" style="margin-top:12px"><span>Pudo cobrar</span><b>' +
        tmSem.confiabilidad.toFixed(1) + '% del horario abierto</b></div>';
    }
    h += '<div class="reparto"><span>Hoy, con el bar abierto</span><b>' + duracion(tmHoy.muertoAbierto) + '</b></div>' +
      '<div class="reparto"><span>Con el bar cerrado (no afecta)</span><b>' +
      duracion(tmSem.wifiCerrado + tmSem.apagadaCerrado) + '</b></div>';
    if (tmSem.abierta) {
      h += '<div class="alerta" style="margin-top:12px"><b>!</b><div>Est\u00e1 ca\u00edda ahora mismo, hace ' +
        duracion((Date.now() - tmSem.abierta.inicio) / 60000) + '.</div></div>';
    }
    h += '</div>';

    // --- wifi ---
    h += '<div class="seccion"><h2 class="titulo">Wifi de la m\u00e1quina</h2>';
    if (redes.length) {
      const ult = redes[redes.length - 1];
      h += '<div class="rot">Conectada a</div><div class="cifra texto">' + esc(ult.ssid) + '</div>' +
        '<p class="lectura tenue">Desde el ' + new Date(ult.desde).toLocaleString('es-AR',
          { timeZone: TZ, hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) +
        (ult.rssi ? ' &middot; se\u00f1al ' + ult.rssi + ' dBm' : '') + '.</p>';
      const claves = Object.keys(redes30);
      if (claves.length) {
        h += '<div style="margin-top:14px">';
        claves.sort(function (a, b) { return redes30[b].cortes - redes30[a].cortes; }).forEach(function (k) {
          h += '<div class="reparto"><span>' + esc(k) + '</span><b>' + redes30[k].cortes +
            (redes30[k].cortes === 1 ? ' corte' : ' cortes') + ' &middot; ' + duracion(redes30[k].minutos) + '</b></div>';
        });
        h += '</div><p class="lectura">Cortes de wifi de los \u00faltimos 30 d\u00edas, separados por la red en la que estaba la m\u00e1quina en ese momento. Con dos semanas de datos ya se puede decidir si conviene cambiarla de red.</p>';
      } else {
        h += '<p class="lectura">Todav\u00eda no hubo cortes de wifi registrados con red conocida.</p>';
      }
    } else {
      h += '<p class="lectura tenue">Todav\u00eda no lleg\u00f3 ning\u00fan dato de red. Aparece la primera vez que el Shelly informe en qu\u00e9 wifi est\u00e1.</p>';
    }
    h += '</div>';

    /* --- prendida o apagada ---
       Sale de la MISMA cuenta que usa el panel de /admin (tiempoMuerto), a
       proposito: dos pantallas que calculan lo mismo por caminos distintos
       tarde o temprano dicen numeros distintos, y ahi ya no se le cree a
       ninguna. Lo que agrega aca es el corte largo: 30 dias en vez de 7, y
       la division entre "la apagaron" y "se cayo el wifi", que son dos
       problemas con dos soluciones distintas. */
    const mes = tiempoMuerto(Date.now() - 30 * DIA, Date.now());
    h += '<div class="seccion"><h2 class="titulo">Prendida y apagada &middot; 30 d\u00edas</h2>' +
      '<div class="cuadrantes">' +
      '<div class="cua' + (mes.apagadaAbierto > 60 ? ' duele' : ' tranqui') + '">' +
      '<div class="et">Apagada con el bar abierto</div><div class="va">' +
        duracion(mes.apagadaAbierto) + '</div></div>' +
      '<div class="cua' + (mes.wifiAbierto > 60 ? ' duele' : ' tranqui') + '">' +
      '<div class="et">Sin wifi con el bar abierto</div><div class="va">' +
        duracion(mes.wifiAbierto) + '</div></div>' +
      '<div class="cua' + (mes.aperturasFallidas.length ? ' duele' : ' tranqui') + '">' +
      '<div class="et">Abri\u00f3 el bar y no estaba</div><div class="va">' +
        mes.aperturasFallidas.length + (mes.aperturasFallidas.length === 1 ? ' noche' : ' noches') +
        '</div></div>' +
      '<div class="cua' + (mes.apagadasAnticipadas.length ? ' duele' : ' tranqui') + '">' +
      '<div class="et">Se apag\u00f3 en plena noche</div><div class="va">' +
        mes.apagadasAnticipadas.length + (mes.apagadasAnticipadas.length === 1 ? ' vez' : ' veces') +
        '</div></div>' +
      '</div>';
    if (mes.confiabilidad !== null) {
      h += '<div class="reparto" style="margin-top:12px"><span>Estuvo cobrando</span><b>' +
        mes.confiabilidad.toFixed(1).replace('.', ',') + '% del tiempo que el bar estuvo abierto</b></div>';
    }
    h += '<p class="lectura">' +
      (mes.apagadaAbierto > mes.wifiAbierto
        ? 'Se pierde m\u00e1s tiempo por m\u00e1quina apagada que por wifi: el arreglo es de rutina del bar, no de red.'
        : (mes.wifiAbierto > 0
          ? 'Se pierde m\u00e1s tiempo por wifi que por apagados: el arreglo es de red. Abajo est\u00e1 cu\u00e1l aguanta mejor.'
          : 'No se perdi\u00f3 tiempo con el bar abierto en estos 30 d\u00edas.')) +
      ' Es la misma cuenta del panel, pero en 30 d\u00edas en vez de 7.</p></div>';

    /* --- que red rinde mas ---
       Contar cortes no alcanza para decidir: una red puede cortarse poco y
       estar puesta una hora, y otra cortarse mas pero haber aguantado veinte
       noches. Lo que se compara es el porcentaje de tiempo muerto sobre el
       tiempo que cada red estuvo realmente puesta, con el bar abierto. */
    const rend = rendimientoPorRed(30);
    if (rend.length && rend.some(function (r) { return r.minutos > 30; })) {
      h += '<div class="seccion"><h2 class="titulo">Qu\u00e9 red aguanta mejor &middot; 30 d\u00edas</h2>';
      rend.forEach(function (r) {
        if (r.minutos < 30) return;
        const cal = calidadSenal(r.senalProm);
        const pc = r.caidaPc.toFixed(1).replace('.', ',');
        h += '<div class="reparto"><span>' + esc(r.red) + '</span><b>' +
          (r.caidaPc >= 5 ? '<span style="color:var(--mal)">' : '<span style="color:var(--ok)">') +
          pc + '% ca\u00edda</span></b></div>' +
          '<p class="lectura tenue" style="margin:2px 0 12px">' +
          duracion(r.minutos) + ' puesta con el bar abierto &middot; ' +
          r.cortes + (r.cortes === 1 ? ' corte' : ' cortes') + ' &middot; ' +
          duracion(r.muerto) + ' muertos &middot; ' +
          (r.senalProm !== null ? ('se\u00f1al ' + r.senalProm + ' dBm (' + cal.txt + ')') : 'sin se\u00f1al medida') +
          ' &middot; ' + pesos(r.plata) + ' cobrados.</p>';
      });
      const mejor = rend.filter(function (r) { return r.minutos >= 240; })
                        .sort(function (a, b) { return a.caidaPc - b.caidaPc; })[0];
      const peor = rend.filter(function (r) { return r.minutos >= 240; })
                       .sort(function (a, b) { return b.caidaPc - a.caidaPc; })[0];
      if (mejor && peor && mejor.red !== peor.red && (peor.caidaPc - mejor.caidaPc) >= 2) {
        h += '<div class="alerta medio"><b>&rsaquo;</b><div>Con los datos de estos 30 d\u00edas, <b>' +
          esc(mejor.red) + '</b> se cae menos que <b>' + esc(peor.red) + '</b> (' +
          mejor.caidaPc.toFixed(1).replace('.', ',') + '% contra ' +
          peor.caidaPc.toFixed(1).replace('.', ',') + '%). Si hay que elegir una, es esa.</div></div>';
      } else {
        h += '<p class="lectura">Todav\u00eda no hay diferencia clara entre las redes. Hacen falta m\u00e1s noches en cada una para decidir con datos y no de memoria.</p>';
      }
      h += '</div>';
    }

    /* --- la noche hora por hora ---
       Es la seccion que contesta "se corto y cuanto me costo". Cada fila
       cruza cuatro cosas del mismo rato: si estaba viva, en que wifi, cuanta
       gente cargo pina y cuanta plata entro. */
    const mapa = horaPorHora(nocheHoy());
    h += '<div class="seccion"><h2 class="titulo">Hora por hora, esta noche</h2>';
    if (!mapa.length) {
      h += '<p class="lectura tenue">La noche todav\u00eda no arranc\u00f3. Esto se llena solo a partir de las ' +
        HORA_ABRE + ':00.</p>';
    } else {
      const tope = Math.max.apply(null, mapa.map(function (f) { return f.plata; }).concat([1]));
      h += '<div class="hh">';
      mapa.forEach(function (f) {
        const malo = f.muerto >= f.abiertos * 0.9;
        const algo = f.muerto > 2;
        h += '<div class="f">' +
          '<span class="h">' + String(f.hora).padStart(2, '0') + ':00</span>' +
          '<span class="luz' + (malo ? ' mala' : (algo ? ' mitad' : '')) + '"></span>' +
          '<span class="bar"><i style="width:' + Math.round(f.plata * 100 / tope) + '%"></i>' +
          '<u>' + (f.pinas ? f.pinas + (f.pinas === 1 ? ' pi\u00f1a' : ' pi\u00f1as') : '') +
          (f.red ? ' <span class="ssid">' + esc(f.red) + '</span>' : '') + '</u></span>' +
          '<span class="pl">' + (f.plata ? pesos(f.plata) : '\u2014') + '</span>' +
          '</div>';
        if (algo) {
          h += '<div class="nota">' + duracion(f.muerto) + ' sin poder cobrar' +
            (f.motivo === 'apagada' ? ' (apagada)' : ' (wifi)') +
            (f.perdido > 0 ? ' &middot; ~' + pesos(f.perdido) + ' que no entraron' : '') + '</div>';
        }
      });
      h += '</div>';
      const muertoTotal = mapa.reduce(function (a, f) { return a + f.muerto; }, 0);
      const plataTotal  = mapa.reduce(function (a, f) { return a + f.plata; }, 0);
      const pico = mapa.slice().sort(function (a, b) { return b.plata - a.plata; })[0];
      h += '<p class="lectura">' +
        (muertoTotal ? 'Esta noche estuvo ' + duracion(muertoTotal) + ' sin poder cobrar. '
                     : 'Esta noche no perdi\u00f3 un minuto. ') +
        (plataTotal ? 'Entraron ' + pesos(plataTotal) + ', y la hora m\u00e1s fuerte fue las ' +
          String(pico.hora).padStart(2, '0') + ':00 con ' + pesos(pico.plata) + '. ' : '') +
        'La barra es la plata de esa hora; la tirita de la izquierda, si la m\u00e1quina estaba viva.</p>';
    }
    h += '</div>';

    // --- lo que paso en el totem ---
    const tvHoy = resumenTotem(0), tvSem = resumenTotem(7);
    h += '<div class="seccion"><h2 class="titulo">El t\u00f3tem esta noche</h2>';
    if (tvHoy.pinas) {
      h += '<div class="rot">Pi\u00f1as cargadas</div><div class="cifra">' + tvHoy.pinas + '</div>' +
        '<p class="lectura">De ' + tvHoy.personas + ' ' + (tvHoy.personas === 1 ? 'persona' : 'personas') +
        (tvHoy.conIG ? ', ' + tvHoy.conIG + ' con Instagram' : '') + '.</p>';
      if (tvHoy.mejor) {
        h += '<div class="reparto"><span>Mejor de la noche</span><b>' +
          esc(tvHoy.mejor.apodo) + ' &middot; ' + (tvHoy.mejor.score || 0) + '</b></div>';
      }
      h += '<div class="reparto"><span>Giraron la ruleta</span><b>' + tvHoy.giros + '</b></div>';
      if (tvHoy.tope >= 2) {
        h += '<div class="alerta" style="margin-top:12px"><b>!</b><div>' + tvHoy.tope +
          ' pi\u00f1as llegaron a 999, que es el tope de la m\u00e1quina. El r\u00e9cord hist\u00f3rico ya no se puede romper: ' +
          'como gancho est\u00e1 gastado y conviene cambiarlo por otro desaf\u00edo.</div></div>';
      }
    } else {
      h += '<p class="lectura tenue">Todav\u00eda no se carg\u00f3 ninguna pi\u00f1a esta noche.</p>';
    }
    h += '<div class="reparto" style="margin-top:14px"><span>Pi\u00f1as en 7 d\u00edas</span><b>' + tvSem.pinas +
      ' &middot; ' + tvSem.personas + ' personas</b></div>';
    h += '</div>';

    /* --- las fotos del display ---
       Hasta ahora la unica forma de verlas era abrir /fotos a mano, asi que
       en la practica nadie las miraba: se cargaban puntajes y nadie
       controlaba nada. Aca estan al lado del resto de los numeros. La foto es
       la unica prueba de que el puntaje es real, y ademas es material para
       Instagram. Se muestran las de esta noche; si la noche recien empieza,
       las ultimas que haya. */
    h += '<div class="seccion"><h2 class="titulo">El t\u00f3tem, en vivo</h2>' +
      '<p class="lectura">Lo mismo que est\u00e1 saliendo en la tele ahora, en la pantalla del ' +
      'celular y en 9:16: lo que grabes ya sale con la medida de una historia.</p>' +
      '<div class="botones"><a class="b ancho on" href="/vivo' + c + '">VER EN VIVO</a></div></div>';

    const fotoHoy = fotosDe(nocheHoy());
    const fotoLista = fotoHoy.length ? fotoHoy : ultimasFotos(12);
    h += '<div class="seccion"><h2 class="titulo">Fotos del display</h2>';
    if (fotoLista.length) {
      h += '<div class="tira">';
      fotoLista.slice(0, 24).forEach(function (p) {
        const hora = new Date(p.ts).toLocaleString('es-AR', { timeZone: TZ, hour12: false,
          hour: '2-digit', minute: '2-digit' });
        h += '<a class="pic' + (p.oculta ? ' oculta' : '') + '" target="_blank" rel="noopener" href="' +
          fotoURL(p.foto) + '">' +
          '<img loading="lazy" src="' + fotoURL(p.foto) + '" alt="">' +
          '<div class="cap"><b>' + (p.score || 0) + '</b>' +
          '<span>' + esc(String(p.apodo || '').slice(0, 12)) + '<br>' + hora +
          (p.oculta ? ' &middot; oculta' : '') + '</span></div></a>';
      });
      h += '</div>';
      h += '<p class="lectura tenue">' +
        (fotoHoy.length ? 'Las de esta noche. ' : 'Esta noche todav\u00eda no hay: estas son las \u00faltimas. ') +
        'Toc\u00e1 una para verla grande. Si un puntaje no coincide con su foto, se saca del ranking desde ' +
        '<a href="/fotos?clave=' + encodeURIComponent(CLAVE) + '" style="color:var(--led)">la pantalla de pi\u00f1as</a>.</p>';
      const sinFoto = (fotoHoy.length ? pinasDe(nocheHoy()) : []).filter(function (p) { return !p.foto; }).length;
      if (sinFoto) {
        h += '<div class="alerta medio" style="margin-top:12px"><b>!</b><div>' + sinFoto +
          (sinFoto === 1 ? ' pi\u00f1a entr\u00f3 sin foto' : ' pi\u00f1as entraron sin foto') +
          '. Sin foto no hay con qu\u00e9 comprobar el puntaje.</div></div>';
      }
    } else {
      h += '<p class="lectura tenue">Todav\u00eda no carg\u00f3 nadie una foto del display.</p>';
    }
    h += '</div>';

    // --- premios de la ruleta, con lo que falta entregar ---
    h += '<div class="seccion"><h2 class="titulo">Premios de la ruleta</h2>';
    if (tvSem.premios) {
      Object.keys(tvSem.porPremio).forEach(function (k) {
        h += '<div class="reparto"><span>' + esc(k) + '</span><b>' + tvSem.porPremio[k] + '</b></div>';
      });
      h += '<p class="lectura tenue">\u00daltimos 7 d\u00edas.</p>';
    } else {
      h += '<p class="lectura tenue">No sali\u00f3 ning\u00fan premio en los \u00faltimos 7 d\u00edas.</p>';
    }
    if (tvSem.pendientes.length) {
      h += '<div class="alerta" style="margin-top:12px"><b>!</b><div>Hay <b>' + tvSem.pendientes.length +
        '</b> ' + (tvSem.pendientes.length === 1 ? 'premio sin retirar' : 'premios sin retirar') +
        '. La caja los cobra con el c\u00f3digo de 4 d\u00edgitos:</div></div>';
      tvSem.pendientes.slice(0, 8).forEach(function (p) {
        const d = new Date(p.ts).toLocaleString('es-AR', { timeZone: TZ, hour12: false,
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        h += '<div class="reparto"><span>' + esc(p.apodo) + ' &middot; ' + d + '</span><b>' +
          esc(p.premio) + ' &middot; c\u00f3digo ' + esc(p.codigo) + '</b></div>';
      });
    }
    h += '</div>';

    // --- cupones ---
    h += '<div class="seccion"><h2 class="titulo">Cupones &middot; \u00faltimos 30 d\u00edas</h2>';
    if (emb.repartidos) {
      const maxE = Math.max(emb.repartidos, 1);
      const paso = function (nom, val, pct) {
        return '<div class="paso"><span class="nom">' + nom + '</span>' +
          '<span class="barra"><i style="width:' + Math.round(val * 100 / maxE) + '%"></i></span>' +
          '<span class="num">' + val + (pct === null ? '' : ' &middot; ' + pct + '%') + '</span></div>';
      };
      h += '<div class="embudo">' +
        paso('Repartidos', emb.repartidos, null) +
        paso('Escaneados', emb.escaneados, emb.pcEscaneo) +
        paso('Activados', emb.activados, emb.pcActivacion) +
        paso('Compraron', emb.compraron, emb.pcCompra) +
        '</div>';
      if (emb.diagnostico) h += '<p class="lectura">' + esc(emb.diagnostico) + '</p>';
      if (emb.recaudado) h += '<div class="reparto" style="margin-top:10px"><span>Plata que trajeron</span><b>' + pesos(emb.recaudado) + '</b></div>';
      /* Las tres franjas, con su conversion al lado: se entiende de un
         vistazo cual rinde y cual no, incluso con pocos datos. */
      h += '<div class="rot" style="margin-top:16px">Cu\u00e1ndo conviene repartirlos</div>';
      mej.filas.forEach(function (f) {
        const flojo = f.canjes < MINIMO_FRANJA;
        h += '<div class="reparto"' + (flojo ? ' style="opacity:.55"' : '') + '><span>' + esc(f.nom) + '</span><b>' +
          (f.canjes ? f.canjes + (f.canjes === 1 ? ' canje &middot; ' : ' canjes &middot; ') +
                      f.conv + (f.conv === 1 ? ' compr\u00f3' : ' compraron') + ' (' + f.pc + '%)'
                    : 'sin canjes') + '</b></div>';
      });
      h += '<p class="lectura' + (mej.hay ? '' : ' tenue') + '">' + mej.texto + '</p>';
    } else {
      h += '<p class="lectura tenue">Todav\u00eda no hay cupones cargados.</p>';
    }
    h += '<div class="botones"><a class="b ancho" href="/cupones' + c + '">Administrar cupones</a></div></div>';

    // --- adopcion y recurrencia ---
    h += '<div class="seccion"><h2 class="titulo">La gente y el sistema</h2>' +
      '<div class="rot">Adopci\u00f3n &middot; 30 d\u00edas</div>' +
      '<div class="cifra ' + (ado.hay ? (ado.pc >= 50 ? 'buena' : (ado.pc >= 25 ? '' : 'mala')) : '') + '">' +
      (ado.hay ? ado.pc + '%' : '&mdash;') + '</div>' +
      '<p class="lectura">' + esc(ado.texto) + '</p>' +
      (ado.hay ? '<p class="lectura tenue">' + ado.pinas + ' pi\u00f1as sobre ' + ado.fichas + ' tiros pagos.</p>' : '') +
      '<div class="reparto" style="margin-top:16px"><span>Vuelven otra noche</span><b>' +
      (rec.hay ? rec.pc + '%' : 'sin datos') + '</b></div>' +
      '<p class="lectura">' + esc(rec.texto) + '</p></div>';

    // --- ingresos ---
    const hist = historico().slice(-21);
    const maxT = Math.max.apply(null, hist.map(function (j) { return j.total; }).concat([1]));
    h += '<div class="seccion"><h2 class="titulo">Ingresos</h2>' +
      '<div class="rot">\u00daltimos 7 d\u00edas</div>' +
      '<div class="cifra chica">' + pesos(sem.total) + '</div>';
    const comp = fraseComparativa(sem.total, sem2.total);
    if (comp) h += '<p class="lectura">' + esc(comp) + '</p>';
    h += '<div class="hist" style="margin-top:16px">';
    hist.forEach(function (j, i) {
      h += '<div class="' + (j.tipo === 'evento' ? 'evento ' : '') + (i === hist.length - 1 ? 'hoy' : '') +
        '" style="height:' + Math.max(2, Math.round(j.total * 100 / maxT)) + '%" title="' +
        esc(j.noche + ': ' + pesos(j.total)) + '"></div>';
    });
    h += '</div><p class="lectura tenue">\u00daltimas ' + hist.length +
      ' noches. Las amarillas est\u00e1n marcadas como noche de evento.</p>';

    const pt = pisoYTecho(30);
    if (pt.nNormales || pt.nEventos) {
      h += '<div class="reparto" style="margin-top:14px"><span>Piso &middot; noche normal</span><b>' +
        (pt.nNormales ? pesos(pt.piso) : 'sin marcar') + '</b></div>' +
        '<div class="reparto"><span>Techo &middot; noche de evento</span><b>' +
        (pt.nEventos ? pesos(pt.techo) : 'sin marcar') + '</b></div>';
    }
    if (pt.sinMarcar) {
      h += '<p class="lectura tenue">Quedan ' + pt.sinMarcar +
        ' noches sin marcar como normal o evento. Marcalas abajo: es lo que separa el piso del techo.</p>';
    }
    h += '<div class="botones"><a class="b ancho" href="/noches' + c + '">Marcar noches normal / evento</a>' +
      '<a class="b" href="/admin' + c + '">Panel de siempre</a>' +
      '<a class="b" href="/inversion' + c + '">Vista para mostrar</a></div></div>';

    h += '<div class="pie">Se guardan ' + jornadas.length + ' noches en el hist\u00f3rico permanente<br>' +
      (persistenciaOk ? 'guardado en el volumen' : 'SIN GUARDAR EN DISCO') + '</div></body></html>';

    res.type('text/html').send(h);
  });

  // ---------- /noches : marcar normal o evento ----------
  app.get('/noches', function (req, res) {
    if (!claveOk(req)) return res.status(403).send('clave invalida');
    cerrarJornadasPendientes();

    const marcar = String(req.query.marcar || '');
    const tipo = String(req.query.tipo || '');
    if (marcar && (tipo === 'normal' || tipo === 'evento' || tipo === '')) {
      const j = jornadas.filter(function (x) { return x.noche === marcar; })[0];
      if (j) { j.tipo = tipo || null; guardar(F_JORNADAS, jornadas); }
    }

    /* Historial COMPLETO, no las ultimas 40. Lo que se ve una noche suelta no
       dice nada; lo que dice algo es la serie: si sube, si baja, que dias
       rinden y cuanto se pierde por estar caido. Se puede filtrar por tipo. */
    const filtro = String(req.query.ver || '');
    let lista = jornadas.slice().reverse();
    if (filtro === 'normal' || filtro === 'evento') {
      lista = lista.filter(function (j) { return j.tipo === filtro; });
    } else if (filtro === 'sinmarcar') {
      lista = lista.filter(function (j) { return !j.tipo; });
    }

    const suma = function (campo) {
      return lista.reduce(function (a, j) { return a + (j[campo] || 0); }, 0);
    };
    const nNoches = lista.length;
    const totPlata = suma('total'), totPinas = suma('pinas'), totMuerto = suma('muertoAbierto');
    const totAbierta = suma('minAbierta');
    const prom = nNoches ? Math.round(totPlata / nNoches) : 0;
    const mejor = lista.slice().sort(function (a, b) { return b.total - a.total; })[0];

    let h = cabeza('BPK noches', 'historial completo');

    h += '<div class="seccion"><h2 class="titulo">' +
      (nNoches ? nNoches + (nNoches === 1 ? ' noche' : ' noches') : 'sin noches') +
      (filtro ? ' &middot; ' + esc(filtro) : ' &middot; todo el historial') + '</h2>';
    if (nNoches) {
      h += '<div class="rot">Promedio por noche</div><div class="cifra">' + pesos(prom) + '</div>';
      h += '<div class="reparto"><span>Total acumulado</span><b>' + pesos(totPlata) + '</b></div>';
      h += '<div class="reparto"><span>Mejor noche</span><b>' + pesos(mejor.total) + ' &middot; ' +
        new Date(mejor.desde).toLocaleDateString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit' }) + '</b></div>';
      h += '<div class="reparto"><span>Pi\u00f1as cargadas</span><b>' + totPinas + '</b></div>';
      if (totAbierta) {
        const pc = Math.round(totMuerto * 1000 / totAbierta) / 10;
        h += '<div class="reparto"><span>Sin poder cobrar, con el bar abierto</span><b>' +
          Math.round(totMuerto / 60) + ' h &middot; ' + pc + '%</b></div>';
        h += '<p class="lectura tenue">Ese porcentaje es el que importa: cu\u00e1nto del tiempo ' +
          'que el bar estuvo abierto la m\u00e1quina no pudo cobrar. Todo lo que pas\u00f3 con el bar ' +
          'cerrado no se cuenta.</p>';
      }
    } else {
      h += '<p class="lectura tenue">Todav\u00eda no hay noches cerradas con ese filtro.</p>';
    }
    h += '<div class="botones">' +
      ['', 'normal', 'evento', 'sinmarcar'].map(function (f) {
        const et = f === '' ? 'Todas' : (f === 'sinmarcar' ? 'Sin marcar' : f.charAt(0).toUpperCase() + f.slice(1) + 'es');
        return '<a class="b' + (filtro === f ? ' on' : '') + '" href="/noches' +
          (f ? '?ver=' + f + cAmp : c) + '">' + et + '</a>';
      }).join('') + '</div></div>';

    h += '<div class="seccion"><h2 class="titulo">Noche por noche</h2>' +
      '<p class="lectura tenue">Marc\u00e1 cada una: el promedio de las normales es el <b>piso</b> ' +
      'del negocio y el de las de evento es el <b>techo</b>. Una m\u00e1quina no puede adivinar ' +
      'cu\u00e1l fue cu\u00e1l, vos lo sab\u00e9s en un segundo.</p>';
    h += '<table class="tabla" style="margin-top:12px">';
    h += '<tr><td class="tenue" style="font-size:11px;letter-spacing:.1em">FECHA</td>' +
      '<td class="der tenue" style="font-size:11px;letter-spacing:.1em">CAJA</td>' +
      '<td class="der tenue" style="font-size:11px;letter-spacing:.1em">PI\u00d1AS</td>' +
      '<td class="der tenue" style="font-size:11px;letter-spacing:.1em">CA\u00cdDA</td>' +
      '<td class="der"></td></tr>';
    lista.forEach(function (j) {
      const d = new Date(j.desde);
      const caido = j.muertoAbierto || 0;
      const color = caido >= 60 ? 'var(--mal)' : (caido >= 15 ? 'var(--medio)' : 'var(--tenue)');
      h += '<tr><td>' + d.toLocaleDateString('es-AR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' }) + '</td>' +
        '<td class="der">' + pesos(j.total) + '</td>' +
        '<td class="der">' + (j.pinas || 0) + (j.personas ? '<span style="color:var(--tenue)">/' + j.personas + '</span>' : '') + '</td>' +
        '<td class="der" style="color:' + color + '">' + (caido ? fmtMin(caido) : '&mdash;') + '</td>' +
        '<td class="der"><a class="' + (j.tipo === 'normal' ? 'on' : '') + '" href="/noches?marcar=' + j.noche + '&tipo=normal' + cAmp + (filtro ? '&ver=' + filtro : '') + '">normal</a> ' +
        '<a class="' + (j.tipo === 'evento' ? 'on' : '') + '" href="/noches?marcar=' + j.noche + '&tipo=evento' + cAmp + (filtro ? '&ver=' + filtro : '') + '">evento</a></td></tr>';
    });
    if (!lista.length) h += '<tr><td>Todav\u00eda no hay noches cerradas.</td></tr>';
    h += '</table>';
    h += '<p class="lectura tenue" style="margin-top:12px">En PI\u00d1AS, el n\u00famero chico es cu\u00e1nta ' +
      'gente distinta carg\u00f3. En CA\u00cdDA, s\u00f3lo los minutos con el bar abierto.</p>';
    h += '<div class="botones"><a class="b ancho" href="/metricas' + c + '">Volver</a></div></div></body></html>';
    res.type('text/html').send(h);
  });

  // ---------- /inversion : la vista para mostrar afuera ----------
  app.get('/inversion', function (req, res) {
    if (!claveOk(req)) return res.status(403).send('clave invalida');
    cerrarJornadasPendientes();

    const pt = pisoYTecho(30);
    const ado = adopcion(30);
    const rec = recurrencia(30);
    const tm = tiempoMuerto(Date.now() - 30 * DIA, Date.now());
    const ing = ingresosEntre(claveHaceDias(29), nocheHoy());

    let h = cabeza('BPK inversion', 'resumen &middot; \u00faltimos 30 d\u00edas &middot; beerlin, mendoza');

    h += '<div class="seccion"><h2 class="titulo">Facturaci\u00f3n</h2>' +
      '<div class="cifra">' + pesos(ing.total) + '</div>' +
      '<p class="lectura">En ' + ing.noches + ' noches, ' + ing.fichas + ' tiros vendidos.</p></div>';

    /* Lo primero que pregunta cualquiera que vaya a poner plata: la maquina
       sola ya existia, que agrego la pantalla. Se compara POR NOCHE ABIERTA,
       porque los totales de cada lado dependen de cuantas noches tiene cada
       uno y eso no compara nada. Y si el "antes" tiene pocas noches se dice,
       en vez de mostrar un porcentaje que suena espectacular y no se sostiene
       si el tipo pregunta. Un numero inflado que no aguanta una repregunta
       cuesta la inversion entera. */
    const ad = antesYDespues();
    const fecha = ad.desde.split('-').reverse().join('/');
    h += '<div class="seccion"><h2 class="titulo">Antes y despu\u00e9s del t\u00f3tem</h2>' +
      '<div class="cuadrantes">' +
      '<div class="cua"><div class="et">Antes (' + ad.nochesAntes +
        (ad.nochesAntes === 1 ? ' noche' : ' noches') + ')</div><div class="va">' +
        (ad.nochesAntes ? pesos(ad.porNocheAntes) : '&mdash;') + '</div></div>' +
      '<div class="cua"><div class="et">Despu\u00e9s (' + ad.nochesDespues +
        (ad.nochesDespues === 1 ? ' noche' : ' noches') + ')</div><div class="va">' +
        (ad.nochesDespues ? pesos(ad.porNocheDespues) : '&mdash;') + '</div></div>' +
      '</div>' +
      '<p class="lectura tenue">Promedio por noche abierta. El t\u00f3tem arranc\u00f3 el ' + fecha + '.</p>';
    if (ad.cambio !== null && ad.nochesAntes && ad.nochesDespues) {
      const signo = ad.cambio >= 0 ? '+' : '';
      h += '<div class="cifra ' + (ad.cambio >= 0 ? 'buena' : 'mala') + '">' +
        signo + ad.cambio.toFixed(0) + '%</div>';
      h += '<p class="lectura">' + (ad.suficiente
        ? 'Con ' + ad.nochesAntes + ' noches de un lado y ' + ad.nochesDespues +
          ' del otro, la diferencia por noche ya es una se\u00f1al, no una casualidad.'
        : '<b>Ojo:</b> con ' + ad.nochesAntes + ' ' + (ad.nochesAntes === 1 ? 'noche' : 'noches') +
          ' antes y ' + ad.nochesDespues + ' despu\u00e9s, este porcentaje todav\u00eda no prueba nada. ' +
          'Hacen falta al menos tres noches de cada lado, y mejor si son del mismo d\u00eda de semana. ' +
          'Mostrarlo antes de eso es regalarle la objeci\u00f3n al que escucha.') + '</p>';
    } else {
      h += '<p class="lectura tenue">Para comparar hacen falta noches con facturaci\u00f3n de los dos lados del ' +
        fecha + '. Por ahora solo hay de uno.</p>';
    }
    if (ad.nochesDespues) {
      h += '<div class="reparto" style="margin-top:12px"><span>Pi\u00f1as por noche, con t\u00f3tem</span><b>' +
        ad.pinasDespues.toFixed(1).replace('.', ',') + '</b></div>' +
        '<div class="reparto"><span>Personas por noche</span><b>' +
        ad.personasDespues.toFixed(1).replace('.', ',') + '</b></div>';
    }
    h += '</div>';

    h += '<div class="seccion"><h2 class="titulo">Piso y techo</h2>';
    if (pt.nNormales || pt.nEventos) {
      h += '<div class="reparto"><span>Noche normal (' + pt.nNormales + ')</span><b>' +
        (pt.nNormales ? pesos(pt.piso) : '&mdash;') + '</b></div>' +
        '<div class="reparto"><span>Noche de evento (' + pt.nEventos + ')</span><b>' +
        (pt.nEventos ? pesos(pt.techo) : '&mdash;') + '</b></div>';
      if (pt.nNormales && pt.nEventos) {
        h += '<p class="lectura">El negocio factura incluso en la noche m\u00e1s floja; las noches de evento multiplican por ' +
          (pt.techo / pt.piso).toFixed(1) + '.</p>';
      } else {
        h += '<p class="lectura tenue">Faltan noches marcadas de uno de los dos tipos para poder comparar.</p>';
      }
    } else {
      h += '<p class="lectura tenue">Todav\u00eda no hay noches marcadas como normal o evento. Se marcan desde el panel.</p>';
    }
    h += '<div class="reparto"><span>Promedio de todas</span><b>' + pesos(pt.promedioGeneral) + '</b></div></div>';

    h += '<div class="seccion"><h2 class="titulo">Adopci\u00f3n de la experiencia</h2>' +
      '<div class="cifra ' + (ado.hay && ado.pc >= 50 ? 'buena' : '') + '">' +
      (ado.hay ? ado.pc + '%' : '&mdash;') + '</div>' +
      '<p class="lectura">' + esc(ado.texto) + '</p>' +
      (rec.hay ? '<div class="reparto" style="margin-top:14px"><span>Volvieron otra noche</span><b>' +
        rec.pc + '% de ' + rec.personas + ' personas</b></div>' : '') + '</div>';

    h += '<div class="seccion"><h2 class="titulo">Confiabilidad</h2>' +
      '<div class="cifra chica">' + (tm.confiabilidad === null ? '&mdash;' : tm.confiabilidad.toFixed(1) + '%') + '</div>' +
      '<p class="lectura">Del horario en que el bar estuvo abierto, ese porcentaje del tiempo la m\u00e1quina pudo cobrar. ' +
      tm.lista.length + (tm.lista.length === 1 ? ' ca\u00edda' : ' ca\u00eddas') + ' en 30 d\u00edas.</p>' +
      '<p class="lectura tenue">Este n\u00famero mide las ca\u00eddas que el propio sistema puede ver. Si el que se cae es el servidor, no queda nadie anotando: para un dato auditable hace falta un chequeo externo.</p></div>';

    h += '<div class="seccion"><div class="botones"><a class="b ancho" href="/metricas' + c + '">Volver al panel</a></div></div>' +
      '<div class="pie">Generado el ' + new Date().toLocaleString('es-AR', { timeZone: TZ, hour12: false }) + '</div></body></html>';

    res.type('text/html').send(h);
  });

  // ---------- datos crudos, por si hacen falta ----------
  app.get('/api/metricas', function (req, res) {
    if (!claveOk(req)) return res.status(403).json({ error: 'clave invalida' });
    cerrarJornadasPendientes();
    res.json({
      hoy: jornadaEnCurso(),
      jornadas: jornadas.slice(-60),
      redes: redes.slice(-30),
      tiempoMuerto7: tiempoMuerto(Date.now() - 7 * DIA, Date.now()),
      embudo30: embudoCupones(Date.now() - 30 * DIA, Date.now()),
      adopcion30: adopcion(30),
      recurrencia30: recurrencia(30),
      pisoYTecho30: pisoYTecho(30),
      alertas: alertas()
    });
  });

  // ---------- arranque ----------
  cerrarJornadasPendientes();
  setInterval(cerrarJornadasPendientes, 30 * 60 * 1000);
  log('METRICAS', 'modulo montado - ' + jornadas.length + ' noches en el historico, ' +
      redes.length + ' tramos de red, ' + escaneos.length + ' escaneos');

  // Lo que el server usa desde afuera.
  return {
    anotarRed: anotarRed,
    anotarArranque: anotarArranque,
    ultimoArranque: ultimoArranque,
    registrarEscaneo: registrarEscaneo,
    scriptDeEscaneo: scriptDeEscaneo,
    escribirAtomico: escribirAtomico,
    abiertoEn: abiertoEn,
    minutosAbiertosDe: minutosAbiertosDe,
    resumenSemanalLargo: function () {
      const sem  = ingresosEntre(claveHaceDias(6), nocheHoy());
      const sem2 = ingresosEntre(claveHaceDias(13), claveHaceDias(7));
      const tm = tiempoMuerto(Date.now() - 7 * DIA, Date.now());
      const ado = adopcion(30);
      const al = alertas();
      const lineas = [];
      lineas.push(pesos(sem.total) + ' en ' + sem.noches + ' noches');
      const comp = fraseComparativa(sem.total, sem2.total);
      if (comp) lineas.push(comp);
      lineas.push('Cobro ca\u00eddo con el bar abierto: ' + duracion(tm.muertoAbierto));
      if (ado.hay) lineas.push('Adopci\u00f3n: ' + ado.pc + '% de los tiros cargaron pi\u00f1a');
      if (al.length) lineas.push('ALERTAS: ' + al.length + ' (ver /metricas)');
      return lineas.join('\n');
    }
  };
};
