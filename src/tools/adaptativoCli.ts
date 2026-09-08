/**
 * ¿EL AGENTE QUE SE AUTOOPTIMIZA GANA AL QUE NO TOCA NADA?
 *
 *   npm run adaptativo -- --lista monedas.json [--revision=30] [--memoria=180]
 *
 * COMO SE MIDE
 * ------------
 * Se simula exactamente lo que promete el video: cada `revision` dias, el agente mira las
 * ultimas `memoria` dias de resultados de CADA combinacion de parametros, se queda con la que
 * mejor fue, y opera con ella el periodo siguiente. Repite para siempre.
 *
 * Contra eso se comparan cuatro referencias:
 *   - FIJO MEDIANO: la combinacion del medio de la rejilla, elegida sin mirar nada.
 *   - FIJO MEJOR AL FINAL: la que resulto mejor en TODO el periodo. Es imposible de conocer de
 *     antemano; se pone como techo teorico.
 *   - AZAR: cada periodo se elige una combinacion al azar. Es el suelo.
 *   - PROMEDIO DE TODAS: operar todas las combinaciones a la vez.
 *
 * Si el adaptativo no bate al fijo mediano, la autooptimizacion no aporta. Si ademas no bate al
 * azar, es que esta persiguiendo ruido y hace daño.
 *
 * Todo mira SOLO hacia atras: la eleccion de cada periodo usa datos anteriores a ese periodo.
 */
import { readFileSync } from "node:fs";
import { velasBinance } from "../forex/binance";
import { atr } from "../forex/multiTf";
import { volatilidad, simularRuptura } from "../forex/rupturas";
import type { Vela } from "../forex/datos";
import { desviacion, muestraNecesaria, operacionesPorRevision } from "../forex/aprendizaje";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

interface Combo { k: number; stop: number; trailing: number; nombre: string }
interface Op {
  /** Instante de ENTRADA. Decide en que periodo cuenta la operacion. */
  t: number;
  /**
   * Instante de CIERRE. Es lo que decide cuando el agente pudo SABER el resultado.
   *
   * Sin esto, una operacion abierta hace 5 dias que dura 60 contaria entera en la ventana
   * "pasada" del agente, aunque en ese momento aun estuviera abierta. Eso es mirar el futuro y
   * es exactamente lo que infla los resultados de cualquier sistema que se reoptimiza.
   */
  tCierre: number;
  r: number;
}

async function main(): Promise<void> {
  const revision = num("revision", 30);
  const memoria = num("memoria", 180);
  const costeBps = num("costebps", 10);
  const lista: string[] = JSON.parse(readFileSync(txt("lista") ?? "monedas.json", "utf-8"));

  const datos = new Map<string, Vela[]>();
  for (const s of lista) {
    try {
      const v = await velasBinance(s, "1d", 3000);
      if (v.length > 300) datos.set(s, v);
    } catch { /* se salta */ }
    await dormir(250);
  }

  // La rejilla que el agente puede explorar. Se fija de antemano.
  const combos: Combo[] = [];
  for (const k of [1.5, 2, 2.5, 3]) {
    for (const stop of [1.5, 2, 3]) {
      combos.push({ k, stop, trailing: 2, nombre: `vol ${k} · stop ${stop}` });
    }
  }

  // Operaciones de cada combinacion, con su fecha. Se calcula una vez.
  const porCombo = new Map<string, Op[]>();
  for (const c of combos) {
    const ops: Op[] = [];
    for (const [, v] of datos) {
      const a = atr(v, 14);
      for (const sig of volatilidad(v, a, c.k)) {
        const av = a[sig.i];
        if (av == null || !(av > 0)) continue;
        const stop = av * c.stop;
        const precio = v[sig.i]!.c;
        const r = simularRuptura(v, sig, stop, c.trailing, ((precio * costeBps) / 10_000) / 2, 0);
        if (!r) continue;
        const iSalida = Math.min(sig.i + 1 + r.velas, v.length - 1);
        ops.push({ t: v[sig.i]!.t, tCierre: v[iSalida]!.t, r: r.r });
      }
    }
    ops.sort((x, y) => x.t - y.t);
    porCombo.set(c.nombre, ops);
  }

  const todas = [...porCombo.values()].flat();
  const tMin = Math.min(...todas.map((o) => o.t));
  const tMax = Math.max(...todas.map((o) => o.t));
  const DIA = 86400;
  const arranque = tMin + memoria * DIA;

  console.log(
    `${datos.size} monedas · ${combos.length} combinaciones · revision cada ${revision} dias · ` +
      `memoria ${memoria} dias · coste ${costeBps} pb\n`,
  );

  /** Operaciones ABIERTAS en el tramo. Es lo que se opera. */
  const enTramo = (nombre: string, desde: number, hasta: number): Op[] =>
    (porCombo.get(nombre) ?? []).filter((o) => o.t >= desde && o.t < hasta);

  /**
   * Operaciones ya CERRADAS antes de `hasta`. Es lo unico que el agente puede haber visto.
   *
   * La diferencia con `enTramo` no es un matiz: en seguimiento de tendencia una operacion dura
   * un mes de media, asi que en cualquier ventana hay muchas abiertas cuyo resultado todavia no
   * existe.
   */
  const conocidas = (nombre: string, desde: number, hasta: number): Op[] =>
    (porCombo.get(nombre) ?? []).filter((o) => o.tCierre < hasta && o.t >= desde);
  const suma = (ops: Op[]): number => ops.reduce((s, o) => s + o.r, 0);

  // ---- El agente adaptativo -------------------------------------------------------------
  const rAdapt: number[] = [];
  const elegidos: string[] = [];
  let cambios = 0;
  let anterior = "";
  for (let t = arranque; t < tMax; t += revision * DIA) {
    // Elige mirando SOLO el pasado.
    let mejor = combos[0]!.nombre;
    let mejorR = -Infinity;
    for (const c of combos) {
      const pasado = conocidas(c.nombre, t - memoria * DIA, t);
      const total = pasado.length >= 3 ? suma(pasado) : -Infinity;
      if (total > mejorR) { mejorR = total; mejor = c.nombre; }
    }
    if (anterior && mejor !== anterior) cambios += 1;
    anterior = mejor;
    elegidos.push(mejor);
    for (const o of enTramo(mejor, t, t + revision * DIA)) rAdapt.push(o.r);
  }

  // ---- Las referencias ------------------------------------------------------------------
  const medio = combos[Math.floor(combos.length / 2)]!.nombre;
  const rFijo = enTramo(medio, arranque, tMax).map((o) => o.r);

  let mejorGlobal = combos[0]!.nombre;
  let mejorGlobalR = -Infinity;
  for (const c of combos) {
    const total = suma(enTramo(c.nombre, arranque, tMax));
    if (total > mejorGlobalR) { mejorGlobalR = total; mejorGlobal = c.nombre; }
  }
  const rOraculo = enTramo(mejorGlobal, arranque, tMax).map((o) => o.r);

  const rnd = azar(4242);
  const rAzar: number[] = [];
  for (let t = arranque; t < tMax; t += revision * DIA) {
    const c = combos[Math.floor(rnd() * combos.length)]!;
    for (const o of enTramo(c.nombre, t, t + revision * DIA)) rAzar.push(o.r);
  }

  const rTodas = combos.flatMap((c) => enTramo(c.nombre, arranque, tMax).map((o) => o.r));

  const resumen = (nombre: string, rs: number[]): void => {
    if (!rs.length) { console.log(`${nombre.padEnd(28)} sin operaciones`); return; }
    const g = rs.filter((x) => x > 0);
    const sg = g.reduce((s, x) => s + x, 0);
    const sp = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
    console.log(
      `${nombre.padEnd(28)}${String(rs.length).padStart(7)}` +
        `${((g.length / rs.length) * 100).toFixed(0).padStart(6)}%` +
        `${(sp > 0 ? sg / sp : 0).toFixed(2).padStart(7)}` +
        `${(rs.reduce((s, x) => s + x, 0) / rs.length).toFixed(3).padStart(9)}` +
        `${rs.reduce((s, x) => s + x, 0).toFixed(0).padStart(9)}`,
    );
  };

  console.log(
    `${"variante".padEnd(28)}${"ops".padStart(7)}${"WR".padStart(7)}${"PF".padStart(7)}` +
      `${"exp R".padStart(9)}${"R total".padStart(9)}`,
  );
  console.log("-".repeat(67));
  resumen("AGENTE que se reoptimiza", rAdapt);
  resumen("fijo mediano (sin tocar)", rFijo);
  resumen("azar cada periodo", rAzar);
  resumen("promedio de todas", rTodas);
  resumen(`ORACULO (${mejorGlobal})`, rOraculo);

  console.log(
    `\nEl agente cambio de configuracion ${cambios} veces en ${elegidos.length} revisiones ` +
      `(${((cambios / Math.max(1, elegidos.length)) * 100).toFixed(0)}%).`,
  );
  const cuenta = new Map<string, number>();
  for (const e of elegidos) cuenta.set(e, (cuenta.get(e) ?? 0) + 1);
  const top = [...cuenta.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`Mas elegidas: ${top.map(([n, c]) => `${n} (${c})`).join(" · ")}`);

  // ---- La aritmetica que lo explica -----------------------------------------------------
  const rs = rFijo;
  if (rs.length > 20) {
    const g = rs.filter((x) => x > 0);
    const d = {
      acierto: g.length / rs.length,
      rGana: g.reduce((s, x) => s + x, 0) / Math.max(1, g.length),
      rPierde: -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0) /
        Math.max(1, rs.length - g.length),
    };
    const sd = desviacion(d);
    const opsAño = (rs.length / ((tMax - arranque) / DIA)) * 365.25;
    const porRevision = operacionesPorRevision(opsAño, revision);
    const necesarias = muestraNecesaria(sd, 0.15);
    console.log(
      `\nPOR QUE: cada revision ve ${porRevision.toFixed(1)} operaciones. Para distinguir una ` +
        `diferencia\nde 0,15R con esta dispersion (sd ${sd.toFixed(2)}) hacen falta ` +
        `${necesarias}. Faltan ${(necesarias / porRevision).toFixed(0)} revisiones\npor cada ` +
        `decision que el agente toma cada una.`,
    );
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
