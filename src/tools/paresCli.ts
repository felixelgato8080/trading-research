/**
 * Pares y diferenciales sobre un universo: todas las combinaciones de dos.
 *
 *   npm run pares -- --lista X.json --cache=V.json [--coste=0.10] [--ventana=60]
 *
 * LOS DOS PEAJES QUE HAY QUE CONTAR O ESTO MIENTE
 * -----------------------------------------------
 *   1. COSTE DOBLE: dos instrumentos, dos entradas, dos salidas.
 *   2. EXPOSICION DOBLE: mover 1.000 en el par son 1.000 largos y 1.000 cortos. Con un tope de
 *      1x de capital, un par ocupa el doble que una posicion normal.
 *
 * Y el control obligatorio: si el par no bate a la ruptura direccional que ya funciona, no
 * aporta nada aunque salga positivo, porque es mas complicado de ejecutar.
 */
import { readFileSync, existsSync } from "node:fs";
import { velas, type Vela } from "../forex/datos";
import { serieRatio, zScore, señales, simularPar } from "../forex/pares";
import { simularCartera, type Operacion } from "../forex/cartera";

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

interface M { n: number; wr: number; pf: number; exp: number }
function medir(rs: number[]): M {
  if (!rs.length) return { n: 0, wr: 0, pf: 0, exp: 0 };
  const g = rs.filter((x) => x > 0);
  const sg = g.reduce((s, x) => s + x, 0);
  const sp = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  return {
    n: rs.length, wr: g.length / rs.length, pf: sp > 0 ? sg / sp : 0,
    exp: rs.reduce((s, x) => s + x, 0) / rs.length,
  };
}

async function main(): Promise<void> {
  // El coste llega POR PATA y aqui se dobla: son dos instrumentos.
  const costePata = num("coste", 0.05);
  const costeR = costePata * 2;
  const ventana = num("ventana", 60);
  const cache = txt("cache");
  const capital = num("capital", 1000);

  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );

  const datos = new Map<string, Vela[]>();
  if (cache && existsSync(cache)) {
    const g = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
    for (const k of lista) {
      const v = g[k];
      if (v && v.length > 400) datos.set(k, v);
    }
  } else {
    for (const s of lista) {
      try {
        const v = await velas(s, "1d");
        if (v.length > 400) datos.set(s, v);
      } catch { /* se salta */ }
      await dormir(400);
    }
  }

  const nombres = [...datos.keys()];
  const combinaciones = (nombres.length * (nombres.length - 1)) / 2;
  console.log(
    `${nombres.length} instrumentos = ${combinaciones} pares · ventana ${ventana} · ` +
      `coste ${(costePata * 100).toFixed(1)}% por pata = ${(costeR * 100).toFixed(1)}% por operacion\n`,
  );

  console.log(
    `${"variante".padEnd(26)}${"ops".padStart(8)}${"WR".padStart(7)}${"PF".padStart(7)}` +
      `${"exp R".padStart(9)}${"sin mejor".padStart(11)}${"pares+".padStart(10)}`,
  );
  console.log("-".repeat(78));

  const guardar: Operacion[] = [];

  for (const [umbral, stopZ, salidaZ] of [
    [2, 4, 0.5], [2, 3, 0.5], [2, 4, 0], [2.5, 4, 0.5], [1.5, 3, 0.5], [3, 5, 0.5],
  ] as Array<[number, number, number]>) {
    const porPar = new Map<string, number[]>();
    const ops: Operacion[] = [];

    for (let i = 0; i < nombres.length; i += 1) {
      for (let j = i + 1; j < nombres.length; j += 1) {
        const a = nombres[i]!;
        const b = nombres[j]!;
        const puntos = serieRatio(datos.get(a)!, datos.get(b)!);
        if (puntos.length < ventana + 60) continue;

        const z = zScore(puntos.map((p) => p.ratio), ventana);
        const rs: number[] = [];
        for (const s of señales(z, umbral)) {
          const r = simularPar(puntos, ventana, s, stopZ, salidaZ, costeR, 60);
          if (!r) continue;
          rs.push(r.r);
          const iE = Math.min(s.i + 1, puntos.length - 1);
          const iS = Math.min(iE + r.velas, puntos.length - 1);
          ops.push({
            instrumento: `${a}/${b}`,
            tEntrada: puntos[iE]!.t,
            tSalida: puntos[iS]!.t,
            r: r.r,
            direccion: s.direccion,
            // EXPOSICION DOBLE: el par mueve dinero en las dos patas.
            stopFraccion: r.stopFraccion / 2,
          });
        }
        if (rs.length) porPar.set(`${a}/${b}`, rs);
      }
    }

    const todas = [...porPar.values()].flat();
    if (todas.length < 100) {
      console.log(`${`z>${umbral} stop${stopZ} sal${salidaZ}`.padEnd(26)}${String(todas.length).padStart(8)}   (muestra corta)`);
      continue;
    }
    const m = medir(todas);
    const mejor = [...porPar.entries()].sort(
      (x, y) => y[1].reduce((k, v) => k + v, 0) - x[1].reduce((k, v) => k + v, 0),
    )[0]?.[0];
    const sm = [...porPar.entries()].filter(([q]) => q !== mejor).flatMap(([, x]) => x);
    const sinMejor = sm.length ? sm.reduce((s, x) => s + x, 0) / sm.length : 0;
    const enVerde = [...porPar.values()].filter((l) => l.length > 5 && l.reduce((s, x) => s + x, 0) > 0).length;

    console.log(
      `${`z>${umbral} stop${stopZ} sal${salidaZ}`.padEnd(26)}${String(m.n).padStart(8)}` +
        `${(m.wr * 100).toFixed(0).padStart(6)}%${m.pf.toFixed(2).padStart(7)}` +
        `${m.exp.toFixed(3).padStart(9)}${sinMejor.toFixed(3).padStart(11)}` +
        `${(enVerde + "/" + porPar.size).padStart(10)}`,
    );
    if (umbral === 2 && stopZ === 4 && salidaZ === 0.5) guardar.push(...ops);
  }

  // ---- EN DINERO, con la exposicion doble contada -----------------------------------------
  if (guardar.length > 0) {
    guardar.sort((x, y) => x.tEntrada - y.tEntrada);
    const anios = (guardar[guardar.length - 1]!.tEntrada - guardar[0]!.tEntrada) / (365.25 * 86400);
    console.log(`\nEN DINERO (z>2, stop 4, salida 0,5) · ${anios.toFixed(1)} años`);
    console.log(
      `${"tope".padStart(6)}${"acepta".padStart(9)}${"final".padStart(12)}${"anual".padStart(9)}` +
        `${"peor caida".padStart(12)}${"expo max".padStart(10)}`,
    );
    console.log("-".repeat(58));
    for (const tope of [3, 5, 8, 12]) {
      const r = simularCartera(guardar, {
        capital, riesgoPct: 0.01, maxPosiciones: tope, compuesto: true, maxExposicion: 1,
      });
      const mult = r.capitalFinal / capital;
      const an = mult > 0 ? (Math.pow(mult, 1 / anios) - 1) * 100 : -100;
      console.log(
        `${String(tope).padStart(6)}${String(r.aceptadas).padStart(9)}` +
          `${r.capitalFinal.toFixed(0).padStart(12)}${an.toFixed(1).padStart(8)}%` +
          `${(r.maxCaida * 100).toFixed(0).padStart(11)}%${r.maxExposicion.toFixed(1).padStart(9)}x`,
      );
    }
  }

  console.log("\nControl a batir: la ruptura direccional da 31,2% anual con 17% de caida.");
  console.log("Combinaciones probadas: 6.");
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
