/**
 * CONTRASTAR EL REGISTRO CONTRA LO QUE EL BACKTEST PREDICE.
 *
 * LA PREGUNTA
 * -----------
 * Los grabadores existen para contestar una sola cosa: ¿miente mi backtest? Y esa pregunta no se
 * contesta comparando promedios. Dos series pueden dar la misma esperanza operacion por operacion
 * distinta, y entonces el promedio coincide por casualidad mientras el simulador esta roto.
 *
 * Se compara OPERACION A OPERACION, emparejando por instrumento y momento de la señal.
 *
 * TRES DISCREPANCIAS, Y CADA UNA SIGNIFICA UNA COSA DISTINTA
 * ---------------------------------------------------------
 *   1. La señal ya no existe, o aparece una que el grabador no vio.
 *      -> Los datos historicos han cambiado, o la estrategia no es deterministica. Si la fuente
 *         revisa velas viejas, todo backtest sobre ella es arena movediza.
 *
 *   2. La misma señal con OTROS PRECIOS de entrada, stop u objetivo.
 *      -> Peor que lo anterior: significa que recalcular hoy da un plan distinto del que se
 *         apunto entonces. Es la firma de que algo mira al futuro.
 *
 *   3. Mismos precios, DISTINTO RESULTADO.
 *      -> El simulador esta mal. Es el hallazgo mas valioso de los tres, porque todos los
 *         numeros del proyecto salen de el.
 *
 * CONSTRUIDO ANTES DE QUE LLEGUEN LOS DATOS, a proposito. Escribir la herramienta despues de ver
 * el resultado invita a ajustarla hasta que el resultado parezca bueno.
 */
import type { Cerrada } from "./grabador";

export interface Predicha {
  par: string;
  tSeñal: number;
  entrada: number;
  stop: number;
  objetivo: number;
  /** Resultado que el backtest dice que habria tenido, en R. */
  r: number;
}

export interface Discrepancia {
  par: string;
  tSeñal: number;
  detalle: string;
}

export interface Contraste {
  /** Operaciones que existen en los dos y con los mismos precios. */
  emparejadas: number;
  /** Estaban en el registro y el backtest ya no las produce. */
  soloEnRegistro: Discrepancia[];
  /** El backtest las produce y el grabador no las vio, dentro de su ventana. */
  soloEnBacktest: Discrepancia[];
  /** Misma señal, precios distintos: la firma de que algo mira al futuro. */
  preciosDistintos: Discrepancia[];
  /** Mismos precios, distinto resultado: el simulador esta mal. */
  resultadosDistintos: Discrepancia[];
  /** Esperanza de las emparejadas, en el registro y en el backtest. */
  esperanzaRegistro: number;
  esperanzaBacktest: number;
  /** Diferencia media por operacion, con su error tipico. */
  diferencia: number;
  errorDiferencia: number;
}

const cerca = (a: number, b: number, tolerancia = 1e-6): boolean =>
  Math.abs(a - b) <= tolerancia * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Empareja registro y backtest por instrumento y momento de señal.
 *
 * `desde` y `hasta` acotan la ventana del registro: el grabador solo vio lo que paso mientras
 * estuvo encendido, y contarle como fallo las señales de antes o de despues seria injusto.
 */
export function contrastar(
  cerradas: Cerrada[],
  predichas: Predicha[],
  desde: number,
  hasta: number,
): Contraste {
  const clave = (par: string, t: number): string => `${par}@${t}`;
  const enVentana = (t: number): boolean => t >= desde && t <= hasta;

  const porBacktest = new Map<string, Predicha>();
  for (const p of predichas) {
    if (enVentana(p.tSeñal)) porBacktest.set(clave(p.par, p.tSeñal), p);
  }

  const soloEnRegistro: Discrepancia[] = [];
  const preciosDistintos: Discrepancia[] = [];
  const resultadosDistintos: Discrepancia[] = [];
  const vistas = new Set<string>();
  const paresR: number[] = [];
  const paresB: number[] = [];

  for (const c of cerradas) {
    const k = clave(c.par, c.tSeñal);
    vistas.add(k);
    const p = porBacktest.get(k);
    if (!p) {
      soloEnRegistro.push({
        par: c.par, tSeñal: c.tSeñal,
        detalle: "el backtest ya no produce esta señal: ¿los datos historicos han cambiado?",
      });
      continue;
    }
    if (!cerca(p.entrada, c.entrada) || !cerca(p.stop, c.stop)
        || !cerca(p.objetivo, c.objetivo)) {
      preciosDistintos.push({
        par: c.par, tSeñal: c.tSeñal,
        detalle:
          `grabado e=${c.entrada} s=${c.stop} o=${c.objetivo} · ` +
          `backtest e=${p.entrada} s=${p.stop} o=${p.objetivo}`,
      });
      continue;
    }
    paresR.push(c.r);
    paresB.push(p.r);
    if (!cerca(p.r, c.r, 1e-3)) {
      resultadosDistintos.push({
        par: c.par, tSeñal: c.tSeñal,
        detalle: `grabado ${c.r.toFixed(3)}R · backtest ${p.r.toFixed(3)}R`,
      });
    }
  }

  const soloEnBacktest: Discrepancia[] = [];
  for (const [k, p] of porBacktest) {
    if (vistas.has(k)) continue;
    soloEnBacktest.push({
      par: p.par, tSeñal: p.tSeñal,
      detalle: "el backtest la produce y el grabador no la vio",
    });
  }

  const media = (l: number[]): number => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0);
  const difs = paresR.map((r, i) => r - paresB[i]!);
  const m = media(difs);
  const va = difs.length > 1
    ? difs.reduce((s, x) => s + (x - m) ** 2, 0) / (difs.length - 1)
    : 0;

  return {
    emparejadas: paresR.length,
    soloEnRegistro, soloEnBacktest, preciosDistintos, resultadosDistintos,
    esperanzaRegistro: media(paresR),
    esperanzaBacktest: media(paresB),
    diferencia: m,
    errorDiferencia: difs.length ? Math.sqrt(va / difs.length) : 0,
  };
}

/**
 * El veredicto en texto.
 *
 * Se separa lo GRAVE de lo esperable. Que el backtest vea señales que el grabador no vio es
 * normal: el grabador estuvo apagado ratos, y la primera pasada de cada instrumento no apunta
 * nada. Que una señal grabada haya cambiado de precio, no.
 */
export function veredicto(c: Contraste): string {
  const l: string[] = [];
  l.push(`Emparejadas: ${c.emparejadas}`);
  l.push(
    `  registro ${c.esperanzaRegistro.toFixed(3)}R · ` +
      `backtest ${c.esperanzaBacktest.toFixed(3)}R · ` +
      `diferencia ${c.diferencia.toFixed(3)}±${c.errorDiferencia.toFixed(3)}`,
  );
  l.push("");

  const grave = c.preciosDistintos.length + c.resultadosDistintos.length;
  if (c.resultadosDistintos.length) {
    l.push(`GRAVE · ${c.resultadosDistintos.length} con MISMOS PRECIOS y DISTINTO RESULTADO.`);
    l.push("  El simulador esta mal, y de el salen todos los numeros del proyecto.");
    for (const d of c.resultadosDistintos.slice(0, 5)) {
      l.push(`    ${d.par} ${new Date(d.tSeñal * 1000).toISOString().slice(0, 16)}  ${d.detalle}`);
    }
  }
  if (c.preciosDistintos.length) {
    l.push(`GRAVE · ${c.preciosDistintos.length} con la MISMA señal y OTROS PRECIOS.`);
    l.push("  Recalcular hoy da un plan distinto del que se apunto: algo mira al futuro.");
    for (const d of c.preciosDistintos.slice(0, 5)) {
      l.push(`    ${d.par} ${new Date(d.tSeñal * 1000).toISOString().slice(0, 16)}  ${d.detalle}`);
    }
  }
  if (c.soloEnRegistro.length) {
    l.push(`AVISO · ${c.soloEnRegistro.length} grabadas que el backtest ya no produce.`);
    l.push("  Suele significar que la fuente reviso velas viejas.");
  }
  if (c.soloEnBacktest.length) {
    l.push(
      `NORMAL · ${c.soloEnBacktest.length} que el backtest ve y el grabador no vio ` +
        "(estuvo apagado, o era la primera pasada de ese instrumento).",
    );
  }
  if (!grave) {
    l.push("Sin discrepancias graves: el backtest reproduce lo que de verdad paso.");
  }
  return l.join("\n");
}
