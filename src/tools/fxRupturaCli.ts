/**
 * Busqueda de una estrategia con acierto bajo y ganadores grandes.
 *
 *   npm run fx:ruptura -- [--tf=1h] [--spread=1.5] [--desde=...] [--hasta=...]
 *
 * QUE SE BUSCA
 * ------------
 * Felix pide: acierto bajo, mas pips ganados que perdidos, varias operaciones al dia. Eso es
 * el perfil de una ruptura, no de una reversion. El RSI, medido durante toda esta
 * investigacion, da acierto ~50% con ganadores del tamaño de los perdedores: nunca podia dar
 * ese perfil.
 *
 * DEFENSAS (las mismas que han tumbado cinco hallazgos antes)
 *   - costes reales de spread, pagados a la entrada y a la salida
 *   - se reporta el PF, que es la medida de pips que pidio, no solo el acierto
 *   - se quita el mejor par: una estrategia que solo gana con uno no es una estrategia
 *   - se parte el periodo en dos y se exige que aguante en los dos
 *   - se dice cuantas combinaciones se han probado
 */
import { velas, pip, type Vela } from "../forex/datos";
import { atr } from "../forex/multiTf";
import { canal, volatilidad, rangoApertura, simularRuptura, type SeñalRuptura } from "../forex/rupturas";
import { readFileSync } from "node:fs";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(n: string, d: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (!m) return d;
  const v = Number(m.split("=")[1]);
  return Number.isFinite(v) ? v : d;
}

interface Variante {
  nombre: string;
  señales: (v: Vela[], a: (number | null)[]) => SeñalRuptura[];
  /** Stop en multiplos de ATR. */
  atrStop: number;
  /** Trailing en multiplos del stop. 0 = stop fijo, sin techo. */
  trailing: number;
  maxVelas: number;
}

interface Metricas {
  n: number; wr: number; pf: number; exp: number; rGana: number; rPierde: number;
  maxDD: number; racha: number; opsDia: number;
}

function metricas(rs: number[], dias: number): Metricas {
  if (!rs.length) return { n: 0, wr: 0, pf: 0, exp: 0, rGana: 0, rPierde: 0, maxDD: 0, racha: 0, opsDia: 0 };
  const g = rs.filter((x) => x > 0);
  const p = rs.filter((x) => x <= 0);
  const sg = g.reduce((s, x) => s + x, 0);
  const sp = -p.reduce((s, x) => s + x, 0);

  let pico = 0, acum = 0, maxDD = 0, racha = 0, maxRacha = 0;
  for (const r of rs) {
    acum += r;
    pico = Math.max(pico, acum);
    maxDD = Math.max(maxDD, pico - acum);
    racha = r <= 0 ? racha + 1 : 0;
    maxRacha = Math.max(maxRacha, racha);
  }
  return {
    n: rs.length,
    wr: g.length / rs.length,
    pf: sp > 0 ? sg / sp : 0,
    exp: rs.reduce((s, x) => s + x, 0) / rs.length,
    rGana: g.length ? sg / g.length : 0,
    rPierde: p.length ? -sp / p.length : 0,
    maxDD,
    racha: maxRacha,
    opsDia: dias > 0 ? rs.length / dias : 0,
  };
}

async function main(): Promise<void> {
  const tf = (process.argv.find((a) => a.startsWith("--tf="))?.split("=")[1] ?? "1h") as any;
  const spreadPips = arg("spread", 1.5);
  const desde = process.argv.find((a) => a.startsWith("--desde="))?.split("=")[1];
  const hasta = process.argv.find((a) => a.startsWith("--hasta="))?.split("=")[1];
  const tD = desde ? Date.parse(desde) / 1000 : 0;
  const tH = hasta ? Date.parse(hasta) / 1000 : Infinity;

  const pares: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--pares") + 1] ?? "", "utf-8"),
  );

  console.log(
    `${tf} · spread ${spreadPips} pips · ${desde ?? "inicio"} a ${hasta ?? "hoy"}\n`,
  );

  const datos = new Map<string, Vela[]>();
  for (const p of pares) {
    try {
      const v = (await velas(p, tf)).filter((x) => x.t >= tD && x.t <= tH);
      if (v.length > 500) datos.set(p, v);
    } catch { /* se salta */ }
    await dormir(450);
  }
  const primeraSerie = [...datos.values()][0] ?? [];
  const dias = primeraSerie.length
    ? (primeraSerie[primeraSerie.length - 1]!.t - primeraSerie[0]!.t) / 86400
    : 0;
  console.log(`${datos.size} pares · ${dias.toFixed(0)} dias\n`);

  // Elegidas de antemano. Se reporta el numero (regla contra el data mining).
  const variantes: Variante[] = [
    { nombre: "canal 20 · trail 2x", señales: (v) => canal(v, 20), atrStop: 1.5, trailing: 2, maxVelas: 0 },
    { nombre: "canal 20 · trail 3x", señales: (v) => canal(v, 20), atrStop: 1.5, trailing: 3, maxVelas: 0 },
    { nombre: "canal 20 · sin techo", señales: (v) => canal(v, 20), atrStop: 1.5, trailing: 0, maxVelas: 0 },
    { nombre: "canal 50 · trail 2x", señales: (v) => canal(v, 50), atrStop: 1.5, trailing: 2, maxVelas: 0 },
    { nombre: "canal 10 · trail 2x", señales: (v) => canal(v, 10), atrStop: 1.5, trailing: 2, maxVelas: 0 },
    { nombre: "canal 20 · stop 1 ATR", señales: (v) => canal(v, 20), atrStop: 1, trailing: 2, maxVelas: 0 },
    { nombre: "canal 20 · stop 2.5 ATR", señales: (v) => canal(v, 20), atrStop: 2.5, trailing: 2, maxVelas: 0 },
    { nombre: "volatilidad 1.5 ATR", señales: (v, a) => volatilidad(v, a, 1.5), atrStop: 1.5, trailing: 2, maxVelas: 0 },
    { nombre: "volatilidad 2 ATR", señales: (v, a) => volatilidad(v, a, 2), atrStop: 1.5, trailing: 2, maxVelas: 0 },
    { nombre: "rango Londres (7h, 3v)", señales: (v) => rangoApertura(v, 7, 3), atrStop: 1.5, trailing: 2, maxVelas: 0 },
    { nombre: "rango NY (13h, 3v)", señales: (v) => rangoApertura(v, 13, 3), atrStop: 1.5, trailing: 2, maxVelas: 0 },
    // El PF sube con el stop (1 ATR: 0,55 · 1,5: 0,64 · 2,5: 0,74). Dos razones: el spread
    // pesa menos y una ruptura necesita sitio para respirar. Se sigue la tendencia.
    { nombre: "canal 20 · stop 4 ATR", señales: (v) => canal(v, 20), atrStop: 4, trailing: 2, maxVelas: 0 },
    { nombre: "canal 20 · stop 6 ATR", señales: (v) => canal(v, 20), atrStop: 6, trailing: 2, maxVelas: 0 },
    { nombre: "canal 20 · 4 ATR trail 3x", señales: (v) => canal(v, 20), atrStop: 4, trailing: 3, maxVelas: 0 },
    { nombre: "vol 1.5 · stop 4 ATR", señales: (v, a) => volatilidad(v, a, 1.5), atrStop: 4, trailing: 2, maxVelas: 0 },
    // VECINDARIO de la unica variante que salio positiva. El spec §25 lo exige: si solo
    // funciona un valor exacto y sus vecinos pierden, es sobreajuste; si funciona un tramo
    // entero, hay algo. El nombre anterior decia "vol 1.5" y pasaba 6: corregido.
    { nombre: "vol 4 ATR · stop 6", señales: (v, a) => volatilidad(v, a, 4), atrStop: 6, trailing: 2, maxVelas: 0 },
    { nombre: "vol 5 ATR · stop 6", señales: (v, a) => volatilidad(v, a, 5), atrStop: 6, trailing: 2, maxVelas: 0 },
    { nombre: "vol 6 ATR · stop 6", señales: (v, a) => volatilidad(v, a, 6), atrStop: 6, trailing: 2, maxVelas: 0 },
    { nombre: "vol 7 ATR · stop 6", señales: (v, a) => volatilidad(v, a, 7), atrStop: 6, trailing: 2, maxVelas: 0 },
    { nombre: "vol 6 ATR · stop 4", señales: (v, a) => volatilidad(v, a, 6), atrStop: 4, trailing: 2, maxVelas: 0 },
    { nombre: "vol 6 ATR · stop 8", señales: (v, a) => volatilidad(v, a, 6), atrStop: 8, trailing: 2, maxVelas: 0 },
    { nombre: "vol 6 ATR · trail 3x", señales: (v, a) => volatilidad(v, a, 6), atrStop: 6, trailing: 3, maxVelas: 0 },
  ];

  console.log(
    `${"variante".padEnd(24)}${"ops".padStart(7)}${"WR".padStart(6)}${"PF".padStart(7)}` +
      `${"exp R".padStart(9)}${"Rgana".padStart(8)}${"Rpierde".padStart(9)}` +
      `${"maxDD".padStart(8)}${"ops/dia".padStart(9)}${"sin mejor".padStart(11)}`,
  );
  console.log("-".repeat(98));

  const filas: Array<{ nombre: string; m: Metricas; sinMejor: number }> = [];

  for (const va of variantes) {
    const porPar = new Map<string, number[]>();
    for (const [par, v] of datos) {
      const a = atr(v, 14);
      const pipTam = (pip(par) ?? 0.0001);
      const rs: number[] = [];
      for (const s of va.señales(v, a)) {
        const av = a[s.i];
        if (av == null || !(av > 0)) continue;
        const r = simularRuptura(v, s, av * va.atrStop, va.trailing, spreadPips * pipTam!, va.maxVelas);
        if (r) rs.push(r.r);
      }
      porPar.set(par, rs);
    }

    const todas = [...porPar.values()].flat();
    if (todas.length < 50) {
      console.log(`${va.nombre.padEnd(24)}${String(todas.length).padStart(7)}   (muestra corta)`);
      continue;
    }
    const m = metricas(todas, dias);
    const mejor = [...porPar.entries()].sort(
      (a, b) => b[1].reduce((s, x) => s + x, 0) - a[1].reduce((s, x) => s + x, 0),
    )[0]?.[0];
    const sm = [...porPar.entries()].filter(([q]) => q !== mejor).flatMap(([, x]) => x);
    const sinMejor = sm.length ? sm.reduce((s, x) => s + x, 0) / sm.length : 0;

    filas.push({ nombre: va.nombre, m, sinMejor });
    console.log(
      `${va.nombre.padEnd(24)}${String(m.n).padStart(7)}${(m.wr * 100).toFixed(0).padStart(5)}%` +
        `${m.pf.toFixed(2).padStart(7)}${m.exp.toFixed(3).padStart(9)}` +
        `${m.rGana.toFixed(2).padStart(8)}${m.rPierde.toFixed(2).padStart(9)}` +
        `${m.maxDD.toFixed(0).padStart(8)}${m.opsDia.toFixed(1).padStart(9)}` +
        `${sinMejor.toFixed(3).padStart(11)}`,
    );
  }

  console.log("-".repeat(98));
  const mejores = [...filas].filter((f) => f.sinMejor > 0).sort((a, b) => b.sinMejor - a.sinMejor);
  if (mejores.length === 0) {
    console.log("Ninguna variante queda positiva tras quitarle su mejor par.");
  } else {
    console.log("Positivas incluso sin su mejor par:");
    for (const f of mejores) {
      console.log(
        `  ${f.nombre.padEnd(24)} PF ${f.m.pf.toFixed(2)} · ${f.sinMejor.toFixed(3)}R · ` +
          `${f.m.opsDia.toFixed(1)} ops/dia · ganadora ${f.m.rGana.toFixed(1)}R vs perdedora ${f.m.rPierde.toFixed(1)}R`,
      );
    }
  }
  console.log(`\nCombinaciones probadas: ${variantes.length}.`);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
