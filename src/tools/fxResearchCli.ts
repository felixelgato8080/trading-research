/**
 * Las variantes concretas que propone el Deep Research 2026, medidas.
 *
 *   npm run fx:research -- [--spread=0] [--tf=5m]
 *
 * Prueba lo que el informe recomienda y que yo no habia medido:
 *   - stops por ATR (1,5 ATR SL / 3 ATR TP) en vez de pips fijos
 *   - filtro de tendencia con EMA en la MISMA temporalidad (EMA20 M5), no EMA200 en H1
 *   - la plantilla GBPJPY: RSI(5) re-cross + EMA20 + salidas por ATR
 *
 * Mi medicion anterior decia que el filtro de tendencia destruye el borde, pero yo usaba
 * EMA200 en H1 y el informe describe EMA20 en M5. No son el mismo filtro ni excluyen las
 * mismas operaciones, asi que la contradiccion puede ser mia.
 */
import { velas, pip, type Vela } from "../forex/datos";
import { rsi, señales, type ReglasRsi } from "../forex/rsi";
import { atr, filtroEmaPropia } from "../forex/multiTf";
import { simular, resumir, type ReglasSalidaFx } from "../forex/backtest";

const PARES = ["EURUSD=X", "USDJPY=X", "GBPJPY=X"];
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(n: string, d: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (!m) return d;
  const v = Number(m.split("=")[1]);
  return Number.isFinite(v) ? v : d;
}

interface V {
  nombre: string;
  rsi: ReglasRsi;
  salida: ReglasSalidaFx;
  /** Periodo de EMA en la misma temporalidad. 0 = sin filtro. */
  emaPropia: number;
}

async function main(): Promise<void> {
  const spreadPips = arg("spread", 0);
  const tf = (process.argv.find((a) => a.startsWith("--tf="))?.split("=")[1] ?? "5m") as any;
  console.log(`${tf} · spread ${spreadPips} pips\n`);

  const datos = new Map<string, Vela[]>();
  for (const p of PARES) {
    const v = await velas(p, tf);
    if (v.length > 200) datos.set(p, v);
    await dormir(600);
  }

  const base: ReglasRsi = { periodo: 14, sobreventa: 30, sobrecompra: 70, esperarCruce: true };
  const fijo: ReglasSalidaFx = { objetivoR: 1, stopPips: 40, maxVelas: 0 };

  const variantes: V[] = [
    { nombre: "REFERENCIA: pips fijos 1:1", rsi: base, salida: fijo, emaPropia: 0 },
    { nombre: "ATR: 1.5 SL / 3 TP (2R)", rsi: base, salida: { ...fijo, atrStop: 1.5, objetivoR: 2 }, emaPropia: 0 },
    { nombre: "ATR: 1.5 SL / 1.5 TP (1R)", rsi: base, salida: { ...fijo, atrStop: 1.5, objetivoR: 1 }, emaPropia: 0 },
    { nombre: "ATR: 2 SL / 3 TP (1.5R)", rsi: base, salida: { ...fijo, atrStop: 2, objetivoR: 1.5 }, emaPropia: 0 },
    { nombre: "+ EMA20 misma TF", rsi: base, salida: { ...fijo, atrStop: 1.5, objetivoR: 2 }, emaPropia: 20 },
    { nombre: "+ EMA50 misma TF", rsi: base, salida: { ...fijo, atrStop: 1.5, objetivoR: 2 }, emaPropia: 50 },
    { nombre: "+ EMA200 misma TF", rsi: base, salida: { ...fijo, atrStop: 1.5, objetivoR: 2 }, emaPropia: 200 },
    {
      nombre: "PLANTILLA: RSI5 + EMA20 + ATR",
      rsi: { ...base, periodo: 5 },
      salida: { ...fijo, atrStop: 1.5, objetivoR: 2 },
      emaPropia: 20,
    },
    {
      nombre: "RSI5 + ATR, sin EMA",
      rsi: { ...base, periodo: 5 },
      salida: { ...fijo, atrStop: 1.5, objetivoR: 2 },
      emaPropia: 0,
    },
  ];

  console.log(
    `${"variante".padEnd(30)}${"ops".padStart(7)}${"acierto".padStart(9)}` +
      `${"R media".padStart(10)}${"sin su mejor par".padStart(18)}`,
  );
  console.log("-".repeat(76));

  for (const v of variantes) {
    const porPar = new Map<string, number[]>();
    for (const [par, velasPar] of datos) {
      const cierres = velasPar.map((x) => x.c);
      const valoresRsi = rsi(cierres, v.rsi.periodo);
      const valoresAtr = atr(velasPar, 14);
      let ss = señales(cierres, v.rsi);

      if (v.emaPropia > 0) {
        // Solo a favor de la EMA de su propia temporalidad, que es lo que describe el informe.
        const alcista = filtroEmaPropia(velasPar, v.emaPropia);
        ss = ss.filter((s) => {
          const a = alcista[s.i];
          if (a == null) return false;
          return s.direccion === "LARGO" ? a : !a;
        });
      }

      const ops = simular(velasPar, ss, v.salida, { spreadPips }, (pip(par) ?? 0.0001), valoresRsi, valoresAtr);
      porPar.set(par, ops.map((o) => o.r));
    }

    const todas = [...porPar.values()].flat();
    if (todas.length < 50) {
      console.log(`${v.nombre.padEnd(30)}${String(todas.length).padStart(7)}   (muestra corta)`);
      continue;
    }
    const media = todas.reduce((s, x) => s + x, 0) / todas.length;
    const acierto = todas.filter((x) => x > 0).length / todas.length;
    const mejor = [...porPar.entries()].sort(
      (a, b) => b[1].reduce((s, x) => s + x, 0) - a[1].reduce((s, x) => s + x, 0),
    )[0]?.[0];
    const sm = [...porPar.entries()].filter(([p]) => p !== mejor).flatMap(([, x]) => x);
    const sinMejor = sm.length ? sm.reduce((s, x) => s + x, 0) / sm.length : 0;

    console.log(
      `${v.nombre.padEnd(30)}${String(todas.length).padStart(7)}` +
        `${(acierto * 100).toFixed(0).padStart(8)}%` +
        `${media.toFixed(3).padStart(10)}${sinMejor.toFixed(3).padStart(18)}`,
    );
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
