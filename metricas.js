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
  const MINIMO_POR_FRANJA = 5;   // con 2 canjes un 100% es una moneda al aire

  function fraseMejorHora() {
    const canjes = dCanjes();
    const porHora = {};
    canjes.forEach(function (x) {
      const h = partesArg(x.ts).minutos / 60 | 0;
      if (!porHora[h]) porHora[h] = { canjes: 0, conv: 0 };
      porHora[h].canjes++;
      if (x.conv15) porHora[h].conv++;
    });
    let mejor = null, maxCanjes = 0;
    Object.keys(porHora).forEach(function (h) {
      if (porHora[h].canjes > maxCanjes) maxCanjes = porHora[h].canjes;
      if (porHora[h].canjes < MINIMO_POR_FRANJA) return;
      const tasa = porHora[h].conv / porHora[h].canjes;
      if (!mejor || tasa > mejor.tasa) {
        mejor = { hora: Number(h), tasa: tasa, canjes: porHora[h].canjes, conv: porHora[h].conv };
      }
    });
    if (!mejor) {
      return { hay: false, texto: 'Todav\u00eda no hay suficientes canjes para saber la mejor hora. ' +
        'Hacen falta al menos ' + MINIMO_POR_FRANJA + ' en una misma franja; ahora el m\u00e1ximo es ' + maxCanjes + '.' };
    }
    return { hay: true, hora: mejor.hora,
      texto: 'Repart\u00ed cupones cerca de las ' + mejor.hora + ':00. Es cuando m\u00e1s terminan en venta: ' +
        mejor.conv + ' de ' + mejor.canjes + ' canjes compraron despu\u00e9s.' };
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
    '.tabla a{color:var(--tenue);text-decoration:none;font-size:11px;border:1px solid var(--borde);' +
    'padding:3px 7px;border-radius:5px}' +
    '.tabla a.on{color:var(--led);border-color:var(--led)}' +
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
    const mej = fraseMejorHora();
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
      h += '<p class="lectura' + (mej.hay ? '' : ' tenue') + '" style="margin-top:12px">' + esc(mej.texto) + '</p>';
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

    const lista = jornadas.slice(-40).reverse();
    let h = cabeza('BPK noches', 'marcar noches &middot; normal o evento');
    h += '<div class="seccion"><p class="lectura">Marc\u00e1 cada noche. El promedio de las normales es el <b>piso</b> del negocio y el de las de evento es el <b>techo</b>: es el par de n\u00fameros que se muestra afuera. Una m\u00e1quina no puede adivinar cu\u00e1l fue cu\u00e1l, vos lo sab\u00e9s en un segundo.</p></div>';
    h += '<div class="seccion"><table class="tabla">';
    lista.forEach(function (j) {
      const d = new Date(j.desde);
      h += '<tr><td>' + d.toLocaleDateString('es-AR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' }) + '</td>' +
        '<td class="der">' + pesos(j.total) + '</td>' +
        '<td class="der"><a class="' + (j.tipo === 'normal' ? 'on' : '') + '" href="/noches?marcar=' + j.noche + '&tipo=normal' + cAmp + '">normal</a> ' +
        '<a class="' + (j.tipo === 'evento' ? 'on' : '') + '" href="/noches?marcar=' + j.noche + '&tipo=evento' + cAmp + '">evento</a></td></tr>';
    });
    if (!lista.length) h += '<tr><td>Todav\u00eda no hay noches cerradas.</td></tr>';
    h += '</table><div class="botones"><a class="b ancho" href="/metricas' + c + '">Volver</a></div></div></body></html>';
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
