/**
 * ADX de Wilder con sus dos direccionales, +DI y -DI.
 *
 * POR QUE HACE FALTA AQUI. La estrategia de retroceso del RSI es de TENDENCIA, y su filtro
 * central es que la tendencia tenga fuerza: ADX por encima de un umbral y subiendo. Sin eso, un
 * "retroceso" no se distingue de un rango lateral, que es donde esa clase de entrada muere.
 *
 * SUAVIZADO DE WILDER, NO MEDIA SIMPLE. Wilder usa `nuevo = anterior - anterior/n + actual`, que
 * es una media exponencial con k = 1/n, no la 2/(n+1) de la EMA corriente. Calcularlo con una
 * EMA normal da un ADX que se parece pero no es el mismo, y entonces un umbral de 25 medido aqui
 * no significa lo mismo que un 25 en el terminal — que es donde se va a operar.
 *
 * Los primeros `periodo * 2 - 1` valores son null: el ADX necesita suavizar el DX, que ya viene
 * de un suavizado. Devolver un numero ahi seria inventarlo.
 */
import type { Vela } from "./datos";

export interface Adx {
  adx: (number | null)[];
  mas: (number | null)[];
  menos: (number | null)[];
}

export function adx(velas: Vela[], periodo = 14): Adx {
  const n = velas.length;
  const vacio = (): (number | null)[] => new Array(n).fill(null);
  const out: Adx = { adx: vacio(), mas: vacio(), menos: vacio() };
  if (n < periodo * 2) return out;

  // Movimiento direccional y rango verdadero, vela a vela.
  const mM: number[] = [0];
  const mm: number[] = [0];
  const tr: number[] = [0];
  for (let i = 1; i < n; i += 1) {
    const v = velas[i]!;
    const p = velas[i - 1]!;
    const subida = v.h - p.h;
    const bajada = p.l - v.l;
    // SOLO CUENTA EL MAYOR DE LOS DOS, y solo si es positivo. Una vela interior no aporta
    // direccion a ninguno de los dos lados.
    mM.push(subida > bajada && subida > 0 ? subida : 0);
    mm.push(bajada > subida && bajada > 0 ? bajada : 0);
    tr.push(Math.max(v.h - v.l, Math.abs(v.h - p.c), Math.abs(v.l - p.c)));
  }

  // Primer valor: suma simple de las `periodo` primeras. Despues, suavizado de Wilder.
  let sTr = 0;
  let sM = 0;
  let sm = 0;
  for (let i = 1; i <= periodo; i += 1) {
    sTr += tr[i]!;
    sM += mM[i]!;
    sm += mm[i]!;
  }

  const dx: (number | null)[] = vacio();
  for (let i = periodo; i < n; i += 1) {
    if (i > periodo) {
      sTr = sTr - sTr / periodo + tr[i]!;
      sM = sM - sM / periodo + mM[i]!;
      sm = sm - sm / periodo + mm[i]!;
    }
    if (sTr <= 0) continue;
    const di1 = (sM / sTr) * 100;
    const di2 = (sm / sTr) * 100;
    out.mas[i] = di1;
    out.menos[i] = di2;
    const suma = di1 + di2;
    dx[i] = suma > 0 ? (Math.abs(di1 - di2) / suma) * 100 : 0;
  }

  // El ADX es el DX suavizado a su vez: primera media simple de `periodo` valores de DX.
  //
  // El primer DX esta en la vela `periodo`, asi que los `periodo` primeros son las velas
  // `periodo` a `periodo*2 - 1`, y ahi cae el primer ADX. Empezar a sumar en `periodo + 1`
  // tiraba el primer DX y corria todo el indicador una vela — poco, pero lo bastante para no
  // cuadrar con el terminal, que es justo lo que este fichero existe para evitar.
  const desde = periodo * 2 - 1;
  if (desde >= n) return out;
  let acum = 0;
  for (let i = periodo; i <= desde; i += 1) acum += dx[i] ?? 0;
  let valor = acum / periodo;
  out.adx[desde] = valor;
  for (let i = desde + 1; i < n; i += 1) {
    valor = (valor * (periodo - 1) + (dx[i] ?? 0)) / periodo;
    out.adx[i] = valor;
  }
  return out;
}
