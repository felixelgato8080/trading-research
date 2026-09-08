/**
 * La estrategia de divergencias de RSI, medida.
 *
 *   npm run divergencia -- --lista L.json --mayor=fx_15m.json --menor=fx_5m.json [--costebps=1]
 *
 * EL VIDEO DEJA TRES COSAS ABIERTAS Y LAS TRES CAMBIAN EL RESULTADO
 * ----------------------------------------------------------------
 *   1. El stop "por la parte alta": ¿justo tras la zona de entrada, o tras el maximo de la
 *      divergencia? Cambia el riesgo por cuatro y con el el peso del spread.
 *   2. El objetivo: ¿la liquidez anterior, o un R:R fijo?
 *   3. "Que ni se asome al canal": ¿de verdad se exige, o basta con que el RSI sea menor?
 *
 * Se miden las ocho combinaciones. Quedarse con la mejor y presentarla seria hacer trampa, asi
 * que se imprime la tabla entera con el azar al lado.
 *
 * EN PIPS ADEMAS DE EN R, porque son preguntas distintas: R normaliza por el riesgo de cada
 * operacion y los pips no. Un acierto alto con pips negativos es ganar muchas veces poco.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Vela } from "../forex/datos";
import { pip } from "../forex/datos";
import { rsi } from "../forex/rsi";
import { atr } from "../forex/multiTf";
import { simular } from "../forex/estructuraValida";
import { evaluar, informe } from "../forex/controles";
import {
  señales, type AjustesDivergencia, type AjustesEntrada, type Objetivo, type Stop,
} from "../forex/divergencia";
import type { AjustesSMC } from "../forex/smc";
import { simularCartera, type Operacion } from "../forex/cartera";

function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
function num(n: string, d: number): number {
  const m = txt(n);
  if (m === undefined) return d;
  const v = Number(m);
  return Number.isFinite(v) ? v : d;
}
function azar(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

interface Op { r: number; pips: number }
interface M {
  n: number; wr: number; exp: number; et: number;
  pipsOp: number; etPips: number; ganaPips: number; pierdePips: number; rr: number;
}
function medir(ops: Op[], rrMedio = 0): M {
  if (!ops.length) {
    return {
      n: 0, wr: 0, exp: 0, et: 0, pipsOp: 0, etPips: 0, ganaPips: 0, pierdePips: 0, rr: 0,
    };
  }
  const g = ops.filter((x) => x.r > 0);
  const p = ops.filter((x) => x.r <= 0);
  const exp = ops.reduce((s, x) => s + x.r, 0) / ops.length;
  const mp = ops.reduce((s, x) => s + x.pips, 0) / ops.length;
  const va = ops.length > 1
    ? ops.reduce((s, x) => s + (x.r - exp) ** 2, 0) / (ops.length - 1) : 0;
  const vp = ops.length > 1
    ? ops.reduce((s, x) => s + (x.pips - mp) ** 2, 0) / (ops.length - 1) : 0;
  return {
    n: ops.length, wr: g.length / ops.length, exp, et: Math.sqrt(va / ops.length),
    pipsOp: mp, etPips: Math.sqrt(vp / ops.length),
    ganaPips: g.length ? g.reduce((s, x) => s + x.pips, 0) / g.length : 0,
    pierdePips: p.length ? -p.reduce((s, x) => s + x.pips, 0) / p.length : 0,
    rr: rrMedio,
  };
}
function fila(nombre: string, m: M, extra = ""): string {
  return (
    `${nombre.padEnd(30)}${String(m.n).padStart(6)}${(m.wr * 100).toFixed(0).padStart(5)}%` +
    `${m.rr.toFixed(1).padStart(6)}${m.ganaPips.toFixed(1).padStart(8)}` +
    `${m.pierdePips.toFixed(1).padStart(8)}${m.pipsOp.toFixed(2).padStart(8)}±${m.etPips.toFixed(2)}` +
    `${m.exp.toFixed(3).padStart(8)}±${m.et.toFixed(3)}  ${extra}`
  );
}
const CAB =
  `${"variante".padEnd(30)}${"ops".padStart(6)}${"WR".padStart(6)}${"RR".padStart(6)}` +
  `${"+pips".padStart(8)}${"-pips".padStart(8)}${"pips/op".padStart(14)}${"exp R".padStart(14)}`;

async function main(): Promise<void> {
  const mayorRuta = txt("mayor");
  const menorRuta = txt("menor");
  const listaRuta = process.argv[process.argv.indexOf("--lista") + 1] ?? txt("lista") ?? "";
  if (!mayorRuta || !menorRuta || !existsSync(mayorRuta) || !existsSync(menorRuta)
      || !existsSync(listaRuta)) {
    console.error("Hacen falta --lista L.json --mayor=15m.json --menor=5m.json");
    process.exitCode = 1;
    return;
  }
  const costeBps = num("costebps", 1);
  const maxVelas = num("maxvelas", 200);

  const lista: string[] = JSON.parse(readFileSync(listaRuta, "utf-8"));
  const gm = JSON.parse(readFileSync(mayorRuta, "utf-8")) as Record<string, Vela[]>;
  const gn = JSON.parse(readFileSync(menorRuta, "utf-8")) as Record<string, Vela[]>;

  const pares: Array<{ s: string; may: Vela[]; men: Vela[]; r: (number | null)[];
    a: (number | null)[] }> = [];
  for (const s of lista) {
    const may = gm[s];
    const men = gn[s];
    if (!may || !men || may.length < 300 || men.length < 300) continue;
    pares.push({
      s, may, men,
      r: rsi(may.map((v) => v.c), num("rsi", 14)),
      a: atr(men, 14),
    });
  }
  const totalMay = pares.reduce((x, p) => x + p.may.length, 0);
  const totalMen = pares.reduce((x, p) => x + p.men.length, 0);
  console.log(
    `${pares.length} pares · ${totalMay.toLocaleString("es")} velas mayores · ` +
      `${totalMen.toLocaleString("es")} menores · coste ${costeBps} pb\n`,
  );

  const DIV: AjustesDivergencia = {
    periodoRsi: num("rsi", 14),
    confirmacion: num("confirmacion", 2),
    umbralAlto: num("umbral", 70),
    minSeparacion: num("minsep", 3),
    maxSeparacion: num("maxsep", 60),
    exigirFueraDelCanal: true,
  };
  const ZONA: AjustesSMC = {
    minHueco: num("minhueco", 0.2), minEmpuje: num("empuje", 1), vigencia: 60,
    esperaBloque: 20, colchon: 0.1, objetivoR: 2,
    radioLiquidez: 0.5, toquesLiquidez: 3, memoriaHuecos: 50,
  };
  const ENT: AjustesEntrada = {
    zona: ZONA, esperaZona: num("esperazona", 40), esperaEntrada: num("esperaentrada", 60),
    colchon: num("colchon", 0.1), stop: "ZONA", objetivo: "FIJO",
    objetivoR: num("objetivo", 2), rrMinimo: num("rrmin", 0),
    minRiesgoAtr: num("minriesgo", 0.5),
  };

  const correr = (div: AjustesDivergencia, ent: AjustesEntrada) => {
    const ops: Op[] = [];
    const porPar = new Map<string, number[]>();
    const mitades: number[][] = [[], []];
    let sumaRR = 0;
    const corte = pares.length
      ? pares[0]!.men[Math.floor(pares[0]!.men.length / 2)]!.t
      : 0;
    const cartera: Operacion[] = [];
    for (const p of pares) {
      const propias: number[] = [];
      for (const x of señales(p.may, p.r, p.men, p.a, div, ent)) {
        const res = simular(p.men, x, (x.entrada * costeBps) / 10_000, maxVelas);
        if (!res) continue;
        const riesgo = Math.abs(x.entrada - x.stop);
        const o = { r: res.r, pips: (res.r * riesgo) / pip(p.s) };
        ops.push(o);
        propias.push(res.r);
        sumaRR += x.rr;
        mitades[p.men[x.i]!.t < corte ? 0 : 1]!.push(res.r);
        const iS = Math.min(x.i + res.velas, p.men.length - 1);
        cartera.push({
          instrumento: p.s, tEntrada: p.men[x.i]!.t, tSalida: p.men[iS]!.t, r: res.r,
          direccion: x.direccion,
          stopFraccion: x.entrada > 0 ? riesgo / x.entrada : undefined,
        });
      }
      porPar.set(p.s, propias);
    }
    const verde = [...porPar.values()].filter(
      (l) => l.length > 3 && l.reduce((s, x) => s + x, 0) > 0,
    ).length;
    return {
      ops, verde, total: porPar.size, rr: ops.length ? sumaRR / ops.length : 0,
      mitades, cartera,
    };
  };

  // ---- LAS OCHO COMBINACIONES ---------------------------------------------------------------
  console.log("LO QUE EL VIDEO DEJA ABIERTO (las tres decisiones, combinadas)");
  console.log(CAB);
  console.log("-".repeat(114));
  let mejor: { nombre: string; res: ReturnType<typeof correr> } | null = null;
  for (const stop of ["ZONA", "EXTREMO"] as Stop[]) {
    for (const objetivo of ["FIJO", "LIQUIDEZ"] as Objetivo[]) {
      for (const estricto of [true, false]) {
        const div = { ...DIV, exigirFueraDelCanal: estricto };
        const ent = { ...ENT, stop, objetivo };
        const res = correr(div, ent);
        const nombre = `stop ${stop.toLowerCase()} · tp ${objetivo.toLowerCase()}` +
          `${estricto ? " · estricto" : ""}`;
        console.log(
          fila(nombre, medir(res.ops, res.rr), `${res.verde}/${res.total} verde`),
        );
        if (res.ops.length >= 50 && (!mejor || medir(res.ops).exp > medir(mejor.res.ops).exp)) {
          mejor = { nombre, res };
        }
      }
    }
  }

  if (!mejor) {
    console.log("\nNinguna combinacion llega a 50 operaciones. No hay con que medir.");
    return;
  }

  // ---- CONTROLES: la bateria compartida, no una copia local -------------------------------
  //
  // Esto estaba escrito a mano aqui, y en `smcCli`, y en `zonasCli`. Nueve copias de la logica
  // que decide si un resultado vale o no. En una de ellas el volteado deducia mal el extremo de
  // la vela de entrada y daba -0,329R donde la verdad era -0,022R.
  const [stopMejor, objMejor, estrictoMejor] = [
    mejor.nombre.includes("extremo") ? "EXTREMO" : "ZONA",
    mejor.nombre.includes("liquidez") ? "LIQUIDEZ" : "FIJO",
    mejor.nombre.includes("estricto"),
  ] as [Stop, Objetivo, boolean];

  console.log(`\nCONTROLES sobre la mejor combinacion (${mejor.nombre})`);
  console.log(
    informe(evaluar(
      new Map(pares.map((p) => [p.s, p.men])),
      (v) => atr(v, 14),
      (par, v) => {
        const p = pares.find((x) => x.s === par);
        if (!p) return [];
        return señales(
          p.may, p.r, v, atr(v, 14),
          { ...DIV, exigirFueraDelCanal: estrictoMejor },
          { ...ENT, stop: stopMejor, objetivo: objMejor },
        );
      },
      (v, s, extremo) => simular(v, s, (s.entrada * costeBps) / 10_000, maxVelas, extremo),
    )),
  );

  // ---- DE R A DINERO: la prueba que hoy mato al resultado estrella de ETF -----------------
  //
  // 28 pares de forex NO son 28 apuestas independientes: EURUSD, EURGBP y EURJPY comparten el
  // euro y se mueven juntos. Una esperanza en R no dice nada de eso. Lo que lo dice es correr la
  // cartera con tope de posiciones y mirar la EXPOSICION: si hace falta apalancamiento, el
  // resultado era apalancamiento y no ventaja.
  const ts = mejor.res.cartera.map((o) => o.tEntrada);
  const años = ts.length ? (Math.max(...ts) - Math.min(...ts)) / 86400 / 365 : 1;
  console.log(`\nDE R A DINERO · ${años.toFixed(1)} años · riesgo 1% · tope de exposicion 1x`);
  console.log(
    `  ${"tope/exp/dir".padStart(11)}${"acepta".padStart(8)}${"rechaza".padStart(9)}` +
      `${"maxSim".padStart(8)}${"final".padStart(9)}${"anual".padStart(8)}` +
      `${"peor caida".padStart(12)}${"expo".padStart(7)}`,
  );
    // `maxPorDireccion` limita las posiciones en el MISMO sentido. Limitar solo el total no basta
  // cuando los instrumentos estan correlacionados: ocho cortos en ocho pares con euro no son
  // ocho apuestas, son una repetida ocho veces, y caen juntas.
  for (const [tope, expo, dir] of [
    [3, 0, 0], [8, 0, 0], [8, 10, 0], [8, 30, 0], [8, 10, 2], [12, 10, 3],
  ] as Array<[number, number, number]>) {
    const rc = simularCartera(mejor.res.cartera, {
      capital: 1000, riesgoPct: 0.01, maxPosiciones: tope, compuesto: true,
      ...(expo > 0 ? { maxExposicion: expo } : {}),
      ...(dir > 0 ? { maxPorDireccion: dir } : {}),
    });
    const anual = años > 0 ? (rc.capitalFinal / 1000) ** (1 / años) - 1 : 0;
    console.log(
      `  ${(`${tope}${expo > 0 ? `/${expo}x` : ""}${dir > 0 ? `/d${dir}` : ""}`).padStart(11)}` +
        `${String(rc.aceptadas).padStart(8)}` +
        `${String(rc.rechazadas).padStart(9)}${String(rc.maxSimultaneas).padStart(8)}` +
        `${Math.round(rc.capitalFinal).toLocaleString("es").padStart(9)}` +
        `${(anual * 100).toFixed(1).padStart(7)}%` +
        `${(rc.maxCaida * 100).toFixed(0).padStart(11)}%` +
        `${rc.maxExposicion.toFixed(1).padStart(6)}x`,
    );
  }

  console.log(
    "\nEl acierto necesario para no perder es 1/(1+RR). Y el coste pesa sobre el RIESGO, no\n" +
      "sobre el precio: con un stop de 5 pips y un spread de 2, el peaje es el 40% del riesgo\n" +
      "antes de empezar. Por eso importa tanto si el stop va tras la zona o tras el extremo.",
  );
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
