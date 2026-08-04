/* ============================================================
   QR — codificador mínimo, sin dependencias.
   Modo alfanumérico y byte · corrección M · versiones 1 a 10.
   Suficiente y de sobra para las URLs de los cupones.
   ============================================================ */
'use strict';

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

// Por versión (índice 1..10), nivel M
const CAP_ALNUM = [0, 20, 38, 61, 90, 122, 154, 178, 221, 262, 311];
const CAP_BYTE = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

// [ecPorBloque, [ [cantBloques, datosPorBloque], ... ] ]
const BLOQUES_M = [
  null,
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];

const ALINEACION = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/* ---- Campo de Galois GF(256) ---- */
const EXP = new Array(512);
const LOG = new Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function polGenerador(grado) {
  let p = [1];
  for (let i = 0; i < grado; i++) {
    const n = new Array(p.length + 1).fill(0);
    for (let j = 0; j < p.length; j++) {
      n[j] ^= p[j];
      n[j + 1] ^= gfMul(p[j], EXP[i]);
    }
    p = n;
  }
  return p;
}

function corregir(datos, cantEC) {
  const gen = polGenerador(cantEC);
  const res = new Array(cantEC).fill(0);
  for (let i = 0; i < datos.length; i++) {
    const factor = datos[i] ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let j = 0; j < cantEC; j++) res[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return res;
}

/* ---- Bits ---- */
function Bits() { this.bits = []; }
Bits.prototype.push = function (valor, cant) {
  for (let i = cant - 1; i >= 0; i--) this.bits.push((valor >>> i) & 1);
};

/* ---- Codificación de datos ---- */
function esAlnum(txt) {
  for (const c of txt) if (ALNUM.indexOf(c) === -1) return false;
  return true;
}

function elegirVersion(txt, alnum) {
  const tabla = alnum ? CAP_ALNUM : CAP_BYTE;
  for (let v = 1; v <= 10; v++) if (txt.length <= tabla[v]) return v;
  throw new Error('Texto demasiado largo para versión 10: ' + txt.length);
}

function codificar(txt, version, alnum) {
  const b = new Bits();
  if (alnum) {
    b.push(0b0010, 4);
    b.push(txt.length, 9);            // versiones 1-9: 9 bits
    for (let i = 0; i < txt.length; i += 2) {
      if (i + 1 < txt.length) {
        b.push(ALNUM.indexOf(txt[i]) * 45 + ALNUM.indexOf(txt[i + 1]), 11);
      } else {
        b.push(ALNUM.indexOf(txt[i]), 6);
      }
    }
  } else {
    b.push(0b0100, 4);
    b.push(txt.length, 8);            // versiones 1-9: 8 bits
    for (let i = 0; i < txt.length; i++) b.push(txt.charCodeAt(i) & 0xFF, 8);
  }

  const [ecPorBloque, grupos] = BLOQUES_M[version];
  let totalDatos = 0;
  grupos.forEach(([cant, tam]) => { totalDatos += cant * tam; });
  const totalBits = totalDatos * 8;

  // Terminador
  const term = Math.min(4, totalBits - b.bits.length);
  for (let i = 0; i < term; i++) b.bits.push(0);
  // Completar byte
  while (b.bits.length % 8 !== 0) b.bits.push(0);
  // Relleno
  const relleno = [0xEC, 0x11];
  let k = 0;
  while (b.bits.length < totalBits) { b.push(relleno[k % 2], 8); k++; }

  // A bytes
  const bytes = [];
  for (let i = 0; i < b.bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | b.bits[i + j];
    bytes.push(v);
  }

  // Partir en bloques
  const bloquesDatos = [], bloquesEC = [];
  let pos = 0;
  grupos.forEach(([cant, tam]) => {
    for (let i = 0; i < cant; i++) {
      const d = bytes.slice(pos, pos + tam);
      pos += tam;
      bloquesDatos.push(d);
      bloquesEC.push(corregir(d, ecPorBloque));
    }
  });

  // Intercalar
  const salida = [];
  const maxD = Math.max.apply(null, bloquesDatos.map((x) => x.length));
  for (let i = 0; i < maxD; i++) {
    for (const bl of bloquesDatos) if (i < bl.length) salida.push(bl[i]);
  }
  for (let i = 0; i < ecPorBloque; i++) {
    for (const bl of bloquesEC) salida.push(bl[i]);
  }
  return salida;
}

/* ---- Matriz ---- */
function crearMatriz(version, datos) {
  const n = version * 4 + 17;
  const m = [], reservado = [];
  for (let i = 0; i < n; i++) {
    m.push(new Array(n).fill(0));
    reservado.push(new Array(n).fill(false));
  }

  function ponerBuscador(fila, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = fila + r, x = col + c;
        if (y < 0 || y >= n || x < 0 || x >= n) continue;
        const dentro = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const anillo = (r === 0 || r === 6 || c === 0 || c === 6);
        const centro = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[y][x] = dentro && (anillo || centro) ? 1 : 0;
        reservado[y][x] = true;
      }
    }
  }
  ponerBuscador(0, 0);
  ponerBuscador(0, n - 7);
  ponerBuscador(n - 7, 0);

  // Sincronismo
  for (let i = 8; i < n - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    m[6][i] = v; reservado[6][i] = true;
    m[i][6] = v; reservado[i][6] = true;
  }

  // Alineación
  const centros = ALINEACION[version];
  for (const cy of centros) {
    for (const cx of centros) {
      if (reservado[cy][cx]) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const borde = Math.max(Math.abs(r), Math.abs(c));
          m[cy + r][cx + c] = (borde === 1) ? 0 : 1;
          reservado[cy + r][cx + c] = true;
        }
      }
    }
  }

  // Módulo oscuro
  m[4 * version + 9][8] = 1;
  reservado[4 * version + 9][8] = true;

  // Reservar formato
  for (let i = 0; i < 9; i++) {
    if (!reservado[8][i]) reservado[8][i] = true;
    if (!reservado[i][8]) reservado[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reservado[8][n - 1 - i] = true;
    reservado[n - 1 - i][8] = true;
  }

  // Datos en zigzag
  let bitIdx = 0;
  const totalBits = datos.length * 8;
  function bit(i) {
    if (i >= totalBits) return 0;
    return (datos[i >> 3] >>> (7 - (i & 7))) & 1;
  }
  let arriba = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < n; i++) {
      const fila = arriba ? n - 1 - i : i;
      for (let d = 0; d < 2; d++) {
        const c = col - d;
        if (reservado[fila][c]) continue;
        m[fila][c] = bit(bitIdx++);
      }
    }
    arriba = !arriba;
  }

  return { m, reservado, n };
}

const MASCARAS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// Tabla oficial de información de formato, nivel M, máscaras 0..7
const FORMATO_M = [
  0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0,
];

function aplicar(base, reservado, n, mascara) {
  const m = base.map((f) => f.slice());
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (reservado[r][c]) continue;
      if (MASCARAS[mascara](r, c)) m[r][c] ^= 1;
    }
  }
  // Formato
  const fmt = FORMATO_M[mascara];
  for (let i = 0; i < 15; i++) {
    const b = (fmt >>> (14 - i)) & 1;
    // Copia 1
    if (i < 6) m[8][i] = b;
    else if (i === 6) m[8][7] = b;
    else if (i === 7) m[8][8] = b;
    else if (i === 8) m[7][8] = b;
    else m[14 - i][8] = b;
    // Copia 2
    if (i < 8) m[n - 1 - i][8] = b;
    else m[8][n - 15 + i] = b;
  }
  m[n - 8][8] = 1; // módulo oscuro
  return m;
}

function penalizacion(m, n) {
  let p = 0;
  // Regla 1: corridas de 5+
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        const a = k === 0 ? m[i][j] : m[j][i];
        const b = k === 0 ? m[i][j - 1] : m[j - 1][i];
        if (a === b) { run++; } else { if (run >= 5) p += run - 2; run = 1; }
      }
      if (run >= 5) p += run - 2;
    }
  }
  // Regla 2: bloques 2x2
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
    }
  }
  // Regla 3: patrones tipo buscador
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j + 11 <= n; j++) {
        let ok1 = true, ok2 = true;
        for (let t = 0; t < 11; t++) {
          const v = k === 0 ? m[i][j + t] : m[j + t][i];
          if (v !== pat1[t]) ok1 = false;
          if (v !== pat2[t]) ok2 = false;
        }
        if (ok1) p += 40;
        if (ok2) p += 40;
      }
    }
  }
  // Regla 4: proporción de oscuros
  let osc = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) osc += m[r][c];
  const porc = (osc * 100) / (n * n);
  p += Math.floor(Math.abs(porc - 50) / 5) * 10;
  return p;
}

/* ---- API ---- */
function generar(texto) {
  const alnum = esAlnum(texto);
  const version = elegirVersion(texto, alnum);
  const datos = codificar(texto, version, alnum);
  const { m, reservado, n } = crearMatriz(version, datos);

  let mejor = null, mejorP = Infinity;
  for (let k = 0; k < 8; k++) {
    const cand = aplicar(m, reservado, n, k);
    const p = penalizacion(cand, n);
    if (p < mejorP) { mejorP = p; mejor = cand; }
  }
  return { matriz: mejor, n, version, modo: alnum ? 'alfanumérico' : 'byte' };
}

function aSVG(texto) {
  const { matriz, n } = generar(texto);
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matriz[r][c]) d += 'M' + c + ' ' + r + 'h1v1h-1z';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n +
    '" shape-rendering="crispEdges"><rect width="' + n + '" height="' + n +
    '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}

module.exports = { generar, aSVG, esAlnum, elegirVersion };
