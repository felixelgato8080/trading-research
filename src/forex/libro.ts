/**
 * EL COSTE REAL, medido en el libro de ordenes en vez de supuesto.
 *
 * POR QUE ESTO IMPORTA MAS QUE CUALQUIER ESTRATEGIA
 * ------------------------------------------------
 * El coste es lo que ha matado a todas las estrategias medidas en este proyecto, y es el unico
 * numero que nunca se ha medido: siempre se ha puesto a ojo. 10 puntos basicos planos para las
 * treinta monedas, elegidos por mi.
 *
 * Y una mirada al libro basta para ver que eso es falso: BTCUSDT tiene el spread pegado al tick
 * y no se mueve con 10.000 dolares, mientras que INJUSDT —una de nuestras treinta, y con posicion
 * abierta ahora mismo— se come 9 puntos basicos solo de deslizamiento con ese mismo tamaño.
 *
 * QUE COMPONE EL COSTE DE UNA IDA Y VUELTA
 * ---------------------------------------
 *   - El SPREAD, una vez: se compra en la oferta y se vende en la demanda.
 *   - El IMPACTO, dos veces: comerse el libro al entrar y al salir.
 *   - La COMISION, dos veces.
 *
 * El impacto depende del TAMAÑO, y por eso el coste no es una propiedad de la moneda sino de la
 * pareja moneda-capital. Una estrategia rentable con 1.000 dolares puede no serlo con 50.000, y
 * eso no se ve en ningun backtest que use un coste plano.
 */

export interface Nivel {
  precio: number;
  cantidad: number;
}

export interface Libro {
  simbolo: string;
  /** Epoch en segundos. */
  t: number;
  /** Ordenadas de mejor a peor: demandas descendentes, ofertas ascendentes. */
  demandas: Nivel[];
  ofertas: Nivel[];
}

export interface CosteMedido {
  simbolo: string;
  t: number;
  medio: number;
  spreadBps: number;
  /** Impacto de comerse el libro con ese nocional, en puntos basicos. */
  impactoBps: number;
  /** Nocional que se pidio medir, en la moneda de cotizacion. */
  nocional: number;
  /** Si el libro no daba para tanto: entonces el impacto es un minimo, no una medida. */
  librosCortos: boolean;
  /** Profundidad total del lado comprador, en moneda de cotizacion. */
  profundidad: number;
}

/** Punto medio entre la mejor demanda y la mejor oferta. */
export function medio(l: Libro): number | null {
  const d = l.demandas[0]?.precio;
  const o = l.ofertas[0]?.precio;
  if (d == null || o == null || !(d > 0) || !(o > 0)) return null;
  return (d + o) / 2;
}

/** Spread en puntos basicos sobre el punto medio. */
export function spreadBps(l: Libro): number | null {
  const m = medio(l);
  const d = l.demandas[0]?.precio;
  const o = l.ofertas[0]?.precio;
  if (m == null || d == null || o == null) return null;
  return ((o - d) / m) * 10_000;
}

/**
 * Cuanto empeora el precio medio al comerse el libro con `nocional`.
 *
 * Devuelve el impacto SOBRE EL MEJOR PRECIO de ese lado, no sobre el medio: el spread ya se
 * cuenta aparte y sumarlo dos veces inflaria el coste.
 *
 * Si el libro se acaba antes de llenar el nocional, se marca `cortos`: entonces el numero es un
 * suelo, no una medida, y presentarlo como medida seria mentir en la direccion optimista.
 */
export function impacto(
  niveles: Nivel[],
  nocional: number,
): { bps: number; cortos: boolean; profundidad: number } {
  const mejor = niveles[0]?.precio;
  const profundidad = niveles.reduce((s, n) => s + n.precio * n.cantidad, 0);
  if (mejor == null || !(mejor > 0) || !(nocional > 0)) {
    return { bps: 0, cortos: niveles.length === 0, profundidad };
  }
  let queda = nocional;
  let pagado = 0;
  let unidades = 0;
  for (const n of niveles) {
    const disponible = n.precio * n.cantidad;
    const usa = Math.min(queda, disponible);
    if (usa <= 0) break;
    pagado += usa;
    unidades += usa / n.precio;
    queda -= usa;
    if (queda <= 0) break;
  }
  if (unidades <= 0) return { bps: 0, cortos: true, profundidad };
  const efectivo = pagado / unidades;
  const bps = Math.abs(efectivo / mejor - 1) * 10_000;
  return {
    // Un tamaño que cabe entero en el primer nivel no tiene impacto, pero dividir y multiplicar
    // deja restos de 1e-14. Un impacto "casi cero" que no es cero se propaga a los resumenes y
    // ensucia comparaciones que deberian salir exactas.
    bps: bps < 1e-9 ? 0 : bps,
    cortos: queda > 0,
    profundidad,
  };
}

/** Mide un libro para un tamaño de posicion concreto. */
export function medirLibro(l: Libro, nocional: number): CosteMedido | null {
  const m = medio(l);
  const s = spreadBps(l);
  if (m == null || s == null) return null;
  const compra = impacto(l.ofertas, nocional);
  const venta = impacto(l.demandas, nocional);
  return {
    simbolo: l.simbolo,
    t: l.t,
    medio: m,
    spreadBps: s,
    // El peor de los dos lados: entrar y salir pasan por los dos, y quedarse con el bueno seria
    // elegir el dato que mas conviene.
    impactoBps: Math.max(compra.bps, venta.bps),
    nocional,
    librosCortos: compra.cortos || venta.cortos,
    profundidad: Math.min(compra.profundidad, venta.profundidad),
  };
}

/**
 * El coste de una IDA Y VUELTA completa, en puntos basicos.
 *
 * El spread se paga una vez —se compra arriba y se vende abajo— y el impacto y la comision dos.
 */
export function costeIdaVuelta(c: CosteMedido, comisionBps: number): number {
  return c.spreadBps + 2 * c.impactoBps + 2 * comisionBps;
}

export interface Resumen {
  simbolo: string;
  muestras: number;
  spreadMediano: number;
  impactoMediano: number;
  /** El percentil 90: lo que pagas en los momentos malos, que es cuando mas se opera. */
  costeP90: number;
  costeMediano: number;
  algunaMuestraCorta: boolean;
}

const mediana = (xs: number[]): number => {
  if (!xs.length) return 0;
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.floor(o.length / 2)]!;
};
const percentil = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.floor(o.length * p))]!;
};

/**
 * Resume las muestras de un simbolo.
 *
 * Se da la MEDIANA y el percentil 90, no la media: un solo momento de libro vacio dispara la
 * media y hace parecer intratable una moneda que casi siempre esta bien. Y al reves, la mediana
 * sola esconde que en los momentos de estres —que es cuando saltan los stops— se paga el doble.
 */
export function resumir(ms: CosteMedido[], comisionBps: number): Resumen {
  const costes = ms.map((m) => costeIdaVuelta(m, comisionBps));
  return {
    simbolo: ms[0]?.simbolo ?? "",
    muestras: ms.length,
    spreadMediano: mediana(ms.map((m) => m.spreadBps)),
    impactoMediano: mediana(ms.map((m) => m.impactoBps)),
    costeMediano: mediana(costes),
    costeP90: percentil(costes, 0.9),
    algunaMuestraCorta: ms.some((m) => m.librosCortos),
  };
}
