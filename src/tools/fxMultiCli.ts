/**
 * ¿Mejora la estructura de tres temporalidades al RSI solo?
 *
 *   npm run fx:multi -- [--spread=1.5] [--stop=20]
 *
 * El RSI solo a 5 min da 53% de acierto y +0,050R sin costes, pero el spread cuesta 0,15R.
 * La pregunta es si filtrar por tendencia de H1 y zona de M15 sube ese acierto lo bastante
 * para que el coste deje de mandar.
 */
import { velas, pip, type Vela } from "../forex/datos";
import { señalesMulti, REGLAS_MULTI, type ReglasMulti } from "../forex/multiTf";
import { simular, resumir } from "../forex/backtest";

const PARES = ["USDJPY=X", "EURUSD=X", "GBPUSD=X", "EURJPY=X", "GBPJPY=X"];
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(n: string, d: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (!m) return d;
  const v = Number(m.split("=")[1]);
  return Number.isFinite(v) ? v : d;
}

async function main(): Promise<void> {
  const spreadPips = arg("spread", 1.5);
  const stopPips = arg("stop", 20);
  console.log(`spread ${spreadPips} pips · stop ${stopPips} pips · objetivo 1:1\n`);

  const datos = new Map<string, { m5: Vela[]; m15: Vela[]; h1: Vela[] }>();
  for (const p of PARES) {
    const m5 = await velas(p, "5m");
    await dormir(600);
    const m15 = await velas(p, "15m");
    await dormir(600);
    const h1 = await velas(p, "1h");
    await dormir(600);
    datos.set(p, { m5, m15, h1 });
    console.log(`  ${p.padEnd(10)} m5 ${m5.length} · m15 ${m15.length} · h1 ${h1.length}`);
  }
  console.log();

  const variantes: Array<[string, ReglasMulti]> = [
    ["M5 solo (sin filtros)", { ...REGLAS_MULTI, emaH1: 0, exigirM15: false }],
    ["M5 + tendencia H1", { ...REGLAS_MULTI, exigirM15: false }],
    ["M5 + zona M15", { ...REGLAS_MULTI, emaH1: 0, exigirM15: true }],
    ["M5 + H1 + M15 (completa)", { ...REGLAS_MULTI }],
    ["completa, EMA50 en vez de 200", { ...REGLAS_MULTI, emaH1: 50 }],
  ];

  console.log(
    `${"variante".padEnd(30)}${"ops".padStart(7)}${"acierto".padStart(9)}` +
      `${"R media".padStart(10)}${"R total".padStart(10)}${"sin su mejor par".padStart(18)}`,
  );
  console.log("-".repeat(84));

  for (const [nombre, reglas] of variantes) {
    const porPar = new Map<string, number[]>();
    for (const [par, d] of datos) {
      const ss = señalesMulti(d.m5, d.m15, d.h1, reglas);
      const ops = simular(d.m5, ss, { objetivoR: 1, stopPips, maxVelas: 0 }, { spreadPips }, (pip(par) ?? 0.0001));
      porPar.set(par, ops.map((o) => o.r));
    }
    const todas = [...porPar.values()].flat();
    if (todas.length < 30) {
      console.log(`${nombre.padEnd(30)}${String(todas.length).padStart(7)}   (muestra corta)`);
      continue;
    }
    const r = resumir(
      todas.map((x) => ({ iEntrada: 0, iSalida: 0, direccion: "LARGO" as const, r: x, motivo: "FIN" as const, velas: 0 })),
    );
    // Quitarle su mejor par: una estrategia que solo gana con uno no es una estrategia.
    const mejor = [...porPar.entries()].sort(
      (a, b) => b[1].reduce((s, x) => s + x, 0) - a[1].reduce((s, x) => s + x, 0),
    )[0]?.[0];
    const sinMejor = [...porPar.entries()].filter(([p]) => p !== mejor).flatMap(([, v]) => v);
    const mediaSin = sinMejor.length ? sinMejor.reduce((s, x) => s + x, 0) / sinMejor.length : 0;

    console.log(
      `${nombre.padEnd(30)}${String(r.operaciones).padStart(7)}` +
        `${(r.tasaAcierto * 100).toFixed(0).padStart(8)}%` +
        `${r.mediaR.toFixed(3).padStart(10)}${r.totalR.toFixed(1).padStart(10)}` +
        `${mediaSin.toFixed(3).padStart(18)}`,
    );
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
