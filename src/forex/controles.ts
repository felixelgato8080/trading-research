/**
 * LA BATERIA DE CONTROLES, en un solo sitio.
 *
 * POR QUE
 * -------
 * Todas las conclusiones de este proyecto descansan en los mismos cuatro controles, y estaban
 * copiados a mano en nueve herramientas distintas. Nueve copias de la logica que decide si un
 * resultado vale o no, cada una con sus pequeñas variaciones, y ninguna forma de saber si
 * divergieron.
 *
 * Ya paso con la version volteada: en una copia el extremo valido de la vela de entrada se
 * deducia del lado de la operacion, y eso mataba el control con un extremo ya pasado. Decia
 * -0,329R cuando la verdad era -0,022R. Un control roto hace parecer excelente a una estrategia
 * mediocre, que es la peor forma de equivocarse aqui.
 *
 * QUE CONTESTA CADA UNO
 * ---------------------
 *   azar        ¿la ventaja es de las reglas, o de la forma del pago? Un stop corto con objetivo
 *               lejano en un mercado con colas gordas gana solo, sin reglas ningunas.
 *   al reves    ¿aporta acertar el LADO? Mismas entradas, mismo riesgo, misma distancia al
 *               objetivo, direccion contraria.
 *   mitades     ¿es estable en el tiempo, o vive entero en un tramo?
 *   sin el mejor ¿depende de un solo instrumento?
 *
 * Ninguno es opcional. Un resultado sin ellos no significa nada.
 */
import type { Vela } from "./datos";

export interface SeñalEvaluable {
  i: number;
  direccion: "LARGO" | "CORTO";
  entrada: number;
  stop: number;
  objetivo: number;
  rr: number;
}

/** Como se resuelve una señal. `extremo` dice que lado de la vela de entrada es creible. */
export type Simulador = (
  velas: Vela[],
  s: SeñalEvaluable,
  extremo?: "MINIMO" | "MAXIMO" | "NINGUNO",
) => { r: number } | null;

export interface Medida {
  n: number;
  acierto: number;
  pf: number;
  esperanza: number;
  /** Error tipico de la esperanza. Sin esto no se puede leer ninguna diferencia. */
  error: number;
  rr: number;
}

export function medir(rs: Array<{ r: number; rr: number }>): Medida {
  if (!rs.length) return { n: 0, acierto: 0, pf: 0, esperanza: 0, error: 0, rr: 0 };
  const v = rs.map((x) => x.r);
  const g = v.filter((x) => x > 0);
  const sp = -v.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  const esperanza = v.reduce((s, x) => s + x, 0) / v.length;
  const va = v.length > 1
    ? v.reduce((s, x) => s + (x - esperanza) ** 2, 0) / (v.length - 1)
    : 0;
  return {
    n: v.length,
    acierto: g.length / v.length,
    pf: sp > 0 ? g.reduce((s, x) => s + x, 0) / sp : 0,
    esperanza,
    error: Math.sqrt(va / v.length),
    rr: rs.reduce((s, x) => s + x.rr, 0) / rs.length,
  };
}

/** Cuantas sigmas separan dos medidas. Es lo unico que decide si una diferencia es real. */
export function sigmas(a: Medida, b: Medida): number {
  const e = Math.sqrt(a.error ** 2 + b.error ** 2);
  return e > 0 ? (a.esperanza - b.esperanza) / e : 0;
}

export interface Bateria {
  estrategia: Medida;
  azar: Medida;
  alReves: Medida;
  mitades: [Medida, Medida];
  /** Instante que separa las dos mitades. */
  corte: number;
  /** Instrumentos con mas de 3 operaciones y suma positiva. */
  enVerde: number;
  instrumentos: number;
  /** Esperanza quitando el instrumento que mas aporta. */
  sinElMejor: number;
}

export interface Opciones {
  /** Cuantas entradas al azar por operacion real. Mas es mejor: aprieta el error del control. */
  vecesAzar?: number;
  semilla?: number;
  /** Riesgo de las entradas al azar, en ATR. */
  riesgoAtr?: number;
}

/**
 * Corre la estrategia y sus cuatro controles.
 *
 * `atrDe` hace falta solo para el control de azar, que necesita una escala con la que inventar
 * stops comparables.
 */
export function evaluar(
  datos: Map<string, Vela[]>,
  atrDe: (velas: Vela[]) => (number | null)[],
  señalesDe: (par: string, velas: Vela[]) => SeñalEvaluable[],
  simular: Simulador,
  op: Opciones = {},
): Bateria {
  const vecesAzar = op.vecesAzar ?? 20;
  const riesgoAtr = op.riesgoAtr ?? 1.5;

  let s = (op.semilla ?? 20260908) >>> 0;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  const todas: Array<{ r: number; rr: number }> = [];
  const alReves: Array<{ r: number; rr: number }> = [];
  const porInstrumento = new Map<string, number[]>();
  const conTiempo: Array<{ t: number; r: number; rr: number }> = [];

  for (const [par, velas] of datos) {
    const propias: number[] = [];
    for (const x of señalesDe(par, velas)) {
      const res = simular(velas, x);
      if (res) {
        todas.push({ r: res.r, rr: x.rr });
        propias.push(res.r);
        conTiempo.push({ t: velas[x.i]!.t, r: res.r, rr: x.rr });
      }

      // AL REVES. El extremo valido de la vela de entrada lo fija el VIAJE del precio, que es el
      // de la señal original. Deducirlo del lado volteado la mata con un extremo ya pasado: ese
      // fallo dio -0,329R donde la verdad era -0,022R.
      const largo = x.direccion === "CORTO";
      const riesgo = Math.abs(x.entrada - x.stop);
      const dist = Math.abs(x.objetivo - x.entrada);
      const inv = simular(velas, {
        i: x.i, direccion: largo ? "LARGO" : "CORTO", entrada: x.entrada,
        stop: largo ? x.entrada - riesgo : x.entrada + riesgo,
        objetivo: largo ? x.entrada + dist : x.entrada - dist,
        rr: x.rr,
      }, x.direccion === "LARGO" ? "MINIMO" : "MAXIMO");
      if (inv) alReves.push({ r: inv.r, rr: x.rr });
    }
    porInstrumento.set(par, propias);
  }

  // AZAR CON EL MISMO PERFIL. Entrada al cierre, asi que de esa vela no queda nada: "NINGUNO".
  const rrMedio = todas.length ? todas.reduce((a, x) => a + x.rr, 0) / todas.length : 2;
  const azar: Array<{ r: number; rr: number }> = [];
  const porPar = Math.max(1, Math.round((todas.length / Math.max(1, datos.size)) * vecesAzar));
  for (const [, velas] of datos) {
    const a = atrDe(velas);
    for (let k = 0; k < porPar; k += 1) {
      const i = 50 + Math.floor(rnd() * Math.max(1, velas.length - 250));
      const av = a[i];
      if (av == null || !(av > 0)) continue;
      const largo = rnd() < 0.5;
      const entrada = velas[i]!.c;
      const riesgo = av * riesgoAtr;
      const r = simular(velas, {
        i, direccion: largo ? "LARGO" : "CORTO", entrada,
        stop: largo ? entrada - riesgo : entrada + riesgo,
        objetivo: largo ? entrada + riesgo * rrMedio : entrada - riesgo * rrMedio,
        rr: rrMedio,
      }, "NINGUNO");
      if (r) azar.push({ r: r.r, rr: rrMedio });
    }
  }

  // MITADES por tiempo, no por numero de operaciones: partir por cuenta mete las dos mitades en
  // el mismo tramo cuando un instrumento opera mucho mas que otro.
  const tiempos = [...datos.values()].flat().map((x) => x.t).sort((a, b) => a - b);
  const corte = tiempos[Math.floor(tiempos.length / 2)] ?? 0;
  const primera = conTiempo.filter((x) => x.t < corte);
  const segunda = conTiempo.filter((x) => x.t >= corte);

  const suma = (l: number[]): number => l.reduce((a, b) => a + b, 0);
  const enVerde = [...porInstrumento.values()].filter((l) => l.length > 3 && suma(l) > 0).length;
  const mejor = [...porInstrumento.entries()].sort((a, b) => suma(b[1]) - suma(a[1]))[0]?.[0];
  const resto = [...porInstrumento.entries()]
    .filter(([k]) => k !== mejor)
    .flatMap(([, l]) => l);

  return {
    estrategia: medir(todas),
    azar: medir(azar),
    alReves: medir(alReves),
    mitades: [medir(primera), medir(segunda)],
    corte,
    enVerde,
    instrumentos: porInstrumento.size,
    sinElMejor: resto.length ? suma(resto) / resto.length : 0,
  };
}

const fecha = (t: number): string => new Date(t * 1000).toISOString().slice(0, 7);

/** La bateria en texto, con las sigmas ya calculadas para no leer diferencias que son ruido. */
export function informe(b: Bateria): string {
  const fila = (n: string, m: Medida, extra = ""): string =>
    `${n.padEnd(26)}${String(m.n).padStart(6)}${(m.acierto * 100).toFixed(0).padStart(5)}%` +
    `${m.pf.toFixed(2).padStart(7)}${m.esperanza.toFixed(3).padStart(9)}±${m.error.toFixed(3)}` +
    `  ${extra}`;

  const vsAzar = sigmas(b.estrategia, b.azar);
  const vsReves = sigmas(b.estrategia, b.alReves);
  return [
    `${"".padEnd(26)}${"ops".padStart(6)}${"WR".padStart(6)}${"PF".padStart(7)}${"exp R".padStart(9)}`,
    "-".repeat(74),
    fila("la estrategia", b.estrategia, `${b.enVerde}/${b.instrumentos} en verde`),
    fila("azar mismo perfil", b.azar, `la estrategia le gana por ${vsAzar.toFixed(1)}σ`),
    fila("misma señal al reves", b.alReves, `diferencia de ${vsReves.toFixed(1)}σ`),
    fila(`1a mitad (hasta ${fecha(b.corte)})`, b.mitades[0]!),
    fila(`2a mitad (desde ${fecha(b.corte)})`, b.mitades[1]!),
    "",
    `Quitando el instrumento que mas aporta: ${b.sinElMejor.toFixed(3)}R`,
    "Una diferencia por debajo de 2σ es ruido, por muy grande que parezca el numero.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// LA OTRA FAMILIA
// ---------------------------------------------------------------------------------------------
//
// En este proyecto conviven dos formas de expresar una operacion:
//
//   por PRECIOS   entrada, stop y objetivo son niveles concretos. La entrada es una orden
//                 limitada y puede llenarse dentro de su vela, asi que importa que extremo de
//                 esa vela sigue siendo alcanzable. Es lo que come `evaluar`.
//
//   por RIESGO    se entra AL CIERRE de la vela de la señal, el stop esta a una distancia dada
//                 y el objetivo a tantos riesgos. TDFI, VWAP y flujo hablan asi.
//
// La segunda es un caso particular de la primera, no otra cosa: fijado el cierre, los tres
// niveles quedan determinados. Por eso los controles no se reimplementan — se traduce a la ida,
// se destraduce en el simulador, y la logica que decide si un resultado vale sigue viviendo en
// un solo sitio.

/** Señal de la familia por riesgo: entrada al cierre de `i`, stop a `riesgo` de distancia. */
export interface SeñalPorRiesgo {
  i: number;
  direccion: "LARGO" | "CORTO";
  riesgo: number;
}

/**
 * La misma bateria, para estrategias que hablan en riesgo y multiplos de R.
 *
 * `simular` recibe la señal ya en los terminos de la familia y el objetivo en R, que es lo que
 * `simularObjetivo` y compañia esperan.
 *
 * EL `extremo` SE PASA AUNQUE ESTA FAMILIA NO SUELA NECESITARLO. Entrando al cierre no queda
 * nada de la vela de la señal por recorrer, asi que da igual; pero el mismo simulador puede
 * entrar en la apertura siguiente, y ahi si importa. Tragarselo aqui seria decidir por el
 * llamante, y esa clase de suposicion callada es la que hizo divergir las copias: un control
 * que deducia el extremo del lado volteado daba -0,329R donde la verdad era -0,022R.
 */
export function evaluarPorRiesgo(
  datos: Map<string, Vela[]>,
  atrDe: (velas: Vela[]) => (number | null)[],
  señalesDe: (par: string, velas: Vela[]) => SeñalPorRiesgo[],
  objetivoR: number,
  simular: (
    velas: Vela[],
    s: SeñalPorRiesgo,
    objetivoR: number,
    extremo?: "MINIMO" | "MAXIMO" | "NINGUNO",
  ) => { r: number } | null,
  op: Opciones = {},
): Bateria {
  return evaluar(
    datos,
    atrDe,
    (par, velas) => {
      const out: SeñalEvaluable[] = [];
      for (const x of señalesDe(par, velas)) {
        const c = velas[x.i]?.c;
        if (c == null || !(x.riesgo > 0)) continue;
        const largo = x.direccion === "LARGO";
        out.push({
          i: x.i, direccion: x.direccion, entrada: c,
          stop: largo ? c - x.riesgo : c + x.riesgo,
          objetivo: largo ? c + x.riesgo * objetivoR : c - x.riesgo * objetivoR,
          rr: objetivoR,
        });
      }
      return out;
    },
    (velas, x, extremo) => {
      const riesgo = Math.abs(x.entrada - x.stop);
      if (!(riesgo > 0)) return null;
      return simular(
        velas, { i: x.i, direccion: x.direccion, riesgo },
        Math.abs(x.objetivo - x.entrada) / riesgo, extremo,
      );
    },
    op,
  );
}
