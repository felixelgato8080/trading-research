/**
 * Prueba de la estrategia TDFI + stop ATR + objetivo 0,5R en 1 hora.
 *
 *   npm run tdfi -- --lista X.json [--tf=1h] [--coste=0.02] [--cache=v.json]
 *
 * EL CONTROL ES LO QUE DECIDE
 * ---------------------------
 * Con objetivo 0,5R el equilibrio esta en 66,7% de acierto, y 66,7% es tambien lo que da entrar
 * AL AZAR con ese objetivo (paseo aleatorio: P(tocar +0,5 antes que -1) = 1/1,5). Los dos
 * numeros son el mismo.
 *
 * Por eso un acierto alto no dice nada por si solo: lo produce la forma del objetivo. La unica
 * pregunta que importa es si el TDFI supera al azar POR ENCIMA del coste. El control de entradas
 * aleatorias usa exactamente los mismos stops y objetivos, en las mismas velas.
 *
 * Se prueban ademas varias relaciones riesgo-beneficio para ver si 0,5 tiene algo especial o es
 * solo el punto donde el acierto se ve bonito.
 */
import { readFileSync, existsSync } from "node:fs";
import { velas, type Vela, type Temporalidad } from "../forex/datos";
import { atr } from "../forex/multiTf";
import {
  tdfi, estados, atrStopSeguidor, señales, simularObjetivo, type SeñalTdfi,
} from "../forex/tdfi";

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

/** Generador reproducible: dos ejecuciones del control tienen que dar lo mismo. */
function azar(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Metricas {
  n: number; wr: number; pf: number; exp: number; velas: number;
}

function medir(rs: Array<{ r: number; velas: number }>): Metricas {
  if (!rs.length) return { n: 0, wr: 0, pf: 0, exp: 0, velas: 0 };
  const v = rs.map((x) => x.r);
  const g = v.filter((x) => x > 0);
  const sg = g.reduce((s, x) => s + x, 0);
  const sp = -v.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  return {
    n: v.length,
    wr: g.length / v.length,
    pf: sp > 0 ? sg / sp : 0,
    exp: v.reduce((s, x) => s + x, 0) / v.length,
    velas: rs.reduce((s, x) => s + x.velas, 0) / rs.length,
  };
}

function fila(nombre: string, m: Metricas, equilibrio: number): string {
  return (
    `${nombre.padEnd(30)}${String(m.n).padStart(7)}${(m.wr * 100).toFixed(1).padStart(8)}%` +
    `${(equilibrio * 100).toFixed(1).padStart(9)}%${m.pf.toFixed(2).padStart(7)}` +
    `${m.exp.toFixed(4).padStart(10)}${m.velas.toFixed(1).padStart(8)}`
  );
}

async function main(): Promise<void> {
  const tf = (txt("tf") ?? "1h") as Temporalidad;
  const costeR = num("coste", 0.02);
  const cache = txt("cache");
  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );

  const datos = new Map<string, Vela[]>();
  if (cache && existsSync(cache)) {
    const g = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
    for (const k of lista) {
      const v = g[k];
      if (v && v.length > 500) datos.set(k, v);
    }
  } else {
    for (const s of lista) {
      try {
        const v = await velas(s, tf);
        if (v.length > 500) datos.set(s, v);
      } catch { /* se salta */ }
      await dormir(400);
    }
  }
  const total = [...datos.values()].reduce((s, v) => s + v.length, 0);
  console.log(
    `${datos.size} instrumentos · ${tf} · ${total.toLocaleString("es")} velas · ` +
      `coste ${(costeR * 100).toFixed(1)}% del riesgo\n`,
  );

  // Señales del TDFI, calculadas una vez y reutilizadas por todos los objetivos.
  const porInstr = new Map<string, { velas: Vela[]; sen: SeñalTdfi[] }>();
  for (const [s, v] of datos) {
    const a = atr(v, 14);
    const est = estados(tdfi(v.map((x) => x.c), num("periodo", 13)), num("umbral", 0.05));
    const stops = atrStopSeguidor(v, a, num("mult", 2));
    porInstr.set(s, { velas: v, sen: señales(v, est, stops) });
  }
  const nSen = [...porInstr.values()].reduce((s, x) => s + x.sen.length, 0);
  console.log(`${nSen} señales del TDFI\n`);

  const cab =
    `${"variante".padEnd(30)}${"ops".padStart(7)}${"acierto".padStart(9)}` +
    `${"equilib".padStart(10)}${"PF".padStart(7)}${"exp R".padStart(10)}${"velas".padStart(8)}`;

  for (const entrarEnCierre of [true, false]) {
    console.log(
      entrarEnCierre
        ? "ENTRANDO AL CIERRE DE LA VELA DE SEÑAL (lo que enseña el video)"
        : "\nENTRANDO EN LA APERTURA SIGUIENTE (mas realista)",
    );
    console.log(cab);
    console.log("-".repeat(71));

    for (const objetivo of [0.5, 1, 1.5, 2, 3]) {
      const equilibrio = 1 / (1 + objetivo);

      const tdfiRes: Array<{ r: number; velas: number }> = [];
      for (const { velas: v, sen } of porInstr.values()) {
        for (const s of sen) {
          const r = simularObjetivo(v, s, objetivo, costeR * s.riesgo, 0, entrarEnCierre);
          if (r) tdfiRes.push(r);
        }
      }

      // CONTROL: mismas velas, mismos stops, misma cantidad de operaciones, entradas al azar.
      const rnd = azar(12345 + Math.round(objetivo * 100));
      const azarRes: Array<{ r: number; velas: number }> = [];
      for (const { velas: v, sen } of porInstr.values()) {
        if (!sen.length) continue;
        const riesgoMedio = sen.reduce((s, x) => s + x.riesgo / v[x.i]!.c, 0) / sen.length;
        for (let k = 0; k < sen.length; k += 1) {
          const i = 50 + Math.floor(rnd() * (v.length - 60));
          const falsa: SeñalTdfi = {
            i,
            direccion: rnd() < 0.5 ? "LARGO" : "CORTO",
            riesgo: v[i]!.c * riesgoMedio,
          };
          const r = simularObjetivo(v, falsa, objetivo, costeR * falsa.riesgo, 0, entrarEnCierre);
          if (r) azarRes.push(r);
        }
      }

      const mT = medir(tdfiRes);
      const mA = medir(azarRes);
      console.log(fila(`TDFI · objetivo ${objetivo}R`, mT, equilibrio));
      console.log(fila(`  AZAR · objetivo ${objetivo}R`, mA, equilibrio));
    }
  }

  // ---- Lo que el video enseña: 20 operaciones ------------------------------------------
  console.log("\n\nPOR QUE 20 OPERACIONES NO DEMUESTRAN NADA");
  const equilibrio = 1 / 1.5;
  const rs: number[] = [];
  for (const { velas: v, sen } of porInstr.values()) {
    for (const s of sen) {
      const r = simularObjetivo(v, s, 0.5, costeR * s.riesgo, 0, true);
      if (r) rs.push(r.r);
    }
  }
  if (rs.length >= 200) {
    // Cuantos tramos de 20 operaciones seguidas dan 17 o mas aciertos, como el del video.
    let tramos = 0;
    let comoElVideo = 0;
    let mejores = 0;
    for (let i = 0; i + 20 <= rs.length; i += 20) {
      const t = rs.slice(i, i + 20).filter((x) => x > 0).length;
      tramos += 1;
      if (t >= 17) comoElVideo += 1;
      if (t >= 14) mejores += 1;
    }
    console.log(
      `   ${tramos} tramos de 20 operaciones seguidas en los datos reales.\n` +
        `   ${comoElVideo} dan 17 aciertos o mas (${((comoElVideo / tramos) * 100).toFixed(0)}%).\n` +
        `   ${mejores} dan 14 o mas (${((mejores / tramos) * 100).toFixed(0)}%), que ya bate al equilibrio del ${(equilibrio * 100).toFixed(0)}%.\n` +
        `   Enseñando el tramo adecuado, cualquiera de esos ${comoElVideo} parece una estrategia ganadora.`,
    );
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
