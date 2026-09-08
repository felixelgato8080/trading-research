/**
 * El espacio ENTERO de la estrategia SMC, en pips y con todas las horas.
 *
 *   npm run barrido:smc -- --lista X.json --cache=V.json [--costebps=1]
 *
 * POR QUE UN BARRIDO Y NO UN PUNTO
 * --------------------------------
 * Fijar los parametros antes de medir protege del sobreajuste, pero deja sin contestar si el
 * punto elegido era el malo de un vecindario bueno. Ver la superficie entera contesta las dos
 * cosas a la vez:
 *
 *   - Si TODO el vecindario pierde, la conclusion es firme y no depende de mi eleccion.
 *   - Si hay una region coherente que gana, hay algo que mirar.
 *   - Si solo gana un punto suelto rodeado de perdidas, eso es ruido y se ve.
 *
 * Lo que NO vale es quedarse con el mejor y presentarlo como el resultado. Por eso se imprime
 * la tabla completa, con el azar al lado en cada fila.
 *
 * EN PIPS, que es lo que se pidio: cuantos pips gana la ganadora media, cuantos pierde la
 * perdedora media, y cuantos quedan al final.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Vela } from "../forex/datos";
import { pip } from "../forex/datos";
import { atr } from "../forex/multiTf";
import { simular } from "../forex/estructuraValida";
import { señales, simularParcial, type AjustesSMC } from "../forex/smc";

function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
function num(n: string, d: number): number {
  const m = txt(n);
  if (m === undefined) return d;
  const v = Number(m);
  return Number.isFinite(v) ? v : d;
}

interface Op { r: number; pips: number }
interface M {
  n: number; wr: number; ganaPips: number; pierdePips: number;
  totalPips: number; pipsPorOp: number; etPips: number; exp: number; et: number;
}
function medir(ops: Op[]): M {
  if (!ops.length) {
    return {
      n: 0, wr: 0, ganaPips: 0, pierdePips: 0, totalPips: 0, pipsPorOp: 0, etPips: 0,
      exp: 0, et: 0,
    };
  }
  const g = ops.filter((x) => x.r > 0);
  const p = ops.filter((x) => x.r <= 0);
  const exp = ops.reduce((s, x) => s + x.r, 0) / ops.length;
  const mediaPips = ops.reduce((s, x) => s + x.pips, 0) / ops.length;
  const vaPips = ops.length > 1
    ? ops.reduce((s, x) => s + (x.pips - mediaPips) ** 2, 0) / (ops.length - 1)
    : 0;
  const va = ops.length > 1
    ? ops.reduce((s, x) => s + (x.r - exp) ** 2, 0) / (ops.length - 1)
    : 0;
  return {
    n: ops.length,
    wr: g.length / ops.length,
    ganaPips: g.length ? g.reduce((s, x) => s + x.pips, 0) / g.length : 0,
    pierdePips: p.length ? -p.reduce((s, x) => s + x.pips, 0) / p.length : 0,
    totalPips: ops.reduce((s, x) => s + x.pips, 0),
    pipsPorOp: mediaPips,
    // Sin esto, un "+5.000 pips" grande puede ser ruido y no se ve.
    etPips: Math.sqrt(vaPips / ops.length),
    exp,
    et: Math.sqrt(va / ops.length),
  };
}
function fila(nombre: string, m: M, extra = ""): string {
  return (
    `${nombre.padEnd(26)}${String(m.n).padStart(6)}` +
    `${(m.wr * 100).toFixed(0).padStart(5)}%` +
    `${m.ganaPips.toFixed(1).padStart(9)}${m.pierdePips.toFixed(1).padStart(9)}` +
    `${Math.round(m.totalPips).toLocaleString("es").padStart(9)}` +
    `${m.pipsPorOp.toFixed(2).padStart(8)}±${m.etPips.toFixed(2)}` +
    `${m.exp.toFixed(3).padStart(8)}±${m.et.toFixed(3)}  ${extra}`
  );
}
const CAB =
  `${"variante".padEnd(26)}${"ops".padStart(6)}${"WR".padStart(6)}${"+pips".padStart(9)}` +
  `${"-pips".padStart(9)}${"total".padStart(9)}${"pips/op".padStart(8)}` +
  `${"exp R".padStart(14)}  `;

async function main(): Promise<void> {
  const cache = txt("cache");
  const listaRuta = process.argv[process.argv.indexOf("--lista") + 1] ?? txt("lista") ?? "";
  if (!cache || !existsSync(cache) || !existsSync(listaRuta)) {
    console.error("Hacen falta --lista RUTA.json y --cache=RUTA.json");
    process.exitCode = 1;
    return;
  }
  const costeBps = num("costebps", 1);
  const maxVelas = num("maxvelas", 200);

  const lista: string[] = JSON.parse(readFileSync(listaRuta, "utf-8"));
  const g = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
  const datos = new Map<string, Vela[]>();
  const atrs = new Map<string, (number | null)[]>();
  for (const k of lista) {
    const v = g[k];
    if (v && v.length > 300) { datos.set(k, v); atrs.set(k, atr(v, 14)); }
  }
  console.log(
    `${datos.size} pares · coste ${costeBps} pb · TODAS las horas · tope ${maxVelas} velas\n`,
  );

  const BASE: AjustesSMC = {
    minHueco: 0.2, minEmpuje: 1.5, vigencia: 60, esperaBloque: 20, colchon: 0.1,
    objetivoR: 2, radioLiquidez: 0.5, toquesLiquidez: 3, memoriaHuecos: 50,
  };

  /** Corre una configuracion y devuelve las operaciones con su recorrido en pips. */
  const correr = (aj: AjustesSMC, parcial: number | null): Op[] => {
    const ops: Op[] = [];
    for (const [s, v] of datos) {
      const a = atrs.get(s)!;
      const unidad = pip(s);
      for (const x of señales(v, a, aj)) {
        const coste = (x.entrada * costeBps) / 10_000;
        const riesgo = Math.abs(x.entrada - x.stop);
        if (parcial === null) {
          const r = simular(v, x, coste, maxVelas);
          if (r) ops.push({ r: r.r, pips: (r.r * riesgo) / unidad });
        } else {
          const r = simularParcial(v, x, coste, maxVelas, parcial, 1, aj.objetivoR);
          if (r) ops.push({ r: r.r, pips: r.precio / unidad });
        }
      }
    }
    return ops;
  };

  // ---- 1. El objetivo: es el que cambia el acierto -----------------------------------------
  console.log("OBJETIVO (sube el objetivo, baja el acierto: mirar los pips, no el %)");
  console.log(CAB);
  console.log("-".repeat(92));
  for (const obj of [0.5, 0.75, 1, 1.5, 2, 3, 5]) {
    const m = medir(correr({ ...BASE, objetivoR: obj }, null));
    console.log(fila(`objetivo ${obj}R`, m, `equilibrio ${(100 / (1 + obj)).toFixed(0)}%`));
  }

  // ---- 2. El stop: un stop mas ancho diluye el coste ----------------------------------------
  console.log("\nCOLCHON DEL STOP (mas ancho = menos peso del spread, pero peor R:R real)");
  console.log(CAB);
  console.log("-".repeat(92));
  for (const col of [0.1, 0.25, 0.5, 1, 2]) {
    const m = medir(correr({ ...BASE, colchon: col }, null));
    console.log(fila(`colchon ${col}`, m));
  }

  // ---- 3. El impulso: cuanto de exigente es el filtro ---------------------------------------
  console.log("\nEXIGENCIA DEL IMPULSO");
  console.log(CAB);
  console.log("-".repeat(92));
  for (const imp of [0.5, 1, 1.5, 2, 3, 4, 5, 6]) {
    const m = medir(correr({ ...BASE, minEmpuje: imp }, null));
    console.log(fila(`impulso ${imp} ATR`, m));
  }

  // ---- 4. Parciales: lo que el video propone -------------------------------------------------
  console.log("\nSALIDA PARCIAL EN 1R + stop a la entrada (sube el acierto, recorta la cola)");
  console.log(CAB);
  console.log("-".repeat(92));
  for (const fr of [0.3, 0.5, 0.7]) {
    for (const obj of [2, 3]) {
      const m = medir(correr({ ...BASE, objetivoR: obj }, fr));
      console.log(fila(`cierra ${(fr * 100).toFixed(0)}% en 1R, resto ${obj}R`, m));
    }
  }

  // ---- 5. Los vetos, con y sin ---------------------------------------------------------------
  console.log("\nLOS DOS VETOS");
  console.log(CAB);
  console.log("-".repeat(92));
  console.log(fila("con vetos", medir(correr(BASE, null))));
  console.log(fila("sin vetos", medir(correr({ ...BASE, aplicarVetos: false }, null))));

  console.log(
    "\n'+pips' es lo que gana la ganadora media y '-pips' lo que pierde la perdedora media.\n" +
      "'total' son los pips netos de TODAS las operaciones sumadas. Un acierto alto con pips\n" +
      "negativos significa ganar muchas veces poco y perder pocas veces mucho.",
  );
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
