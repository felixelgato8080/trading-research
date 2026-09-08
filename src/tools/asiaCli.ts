/**
 * ¿Sobrevive el RSI en sesion asiatica, o es el superviviente afortunado de un barrido?
 *
 *   npm run asia -- --pares X.json [--tf=1h] [--spread=0.7]
 *
 * POR QUE ESTE CLI APARTE
 * -----------------------
 * En el barrido general esta variante aguanta hasta 2,19 pips de coste cuando una cuenta ECN
 * real cuesta ~0,7. Eso la deja positiva, y corrige un resumen anterior que la daba por muerta
 * usando 1,5 pips (spread de broker malo).
 *
 * Pero es la MEJOR de un barrido de decenas de variantes, y eso es exactamente el perfil de un
 * hallazgo que se evapora. Antes de creerselo hacen falta las tres pruebas de siempre:
 *
 *   1. VECINDARIO de horas: si solo funciona 0-7 UTC y las ventanas vecinas pierden, es
 *      sobreajuste. Si funciona toda la franja, hay algo real en la sesion asiatica.
 *   2. FUERA DE MUESTRA: las dos mitades del calendario por separado.
 *   3. AMPLITUD: cuantos pares aportan, y si aguanta sin el mejor.
 */
import { readFileSync } from "node:fs";
import { velas, pip, type Vela, type Temporalidad } from "../forex/datos";
import { rsi, señales, filtrarPorSesion, type ReglasRsi } from "../forex/rsi";
import { simular, type ReglasSalidaFx } from "../forex/backtest";

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

interface Res { n: number; media: number; equilibrio: number }

function evaluar(
  datos: Map<string, Vela[]>,
  desde: number,
  hasta: number,
  spreadPips: number,
  corte: { min: number; max: number } | null,
): { global: Res; sinMejor: Res; enVerde: number; total: number } {
  const porPar = new Map<string, number[]>();
  let sumaPips = 0;
  let nPips = 0;

  for (const [par, v] of datos) {
    const usadas = corte ? v.filter((x) => x.t >= corte.min && x.t <= corte.max) : v;
    if (usadas.length < 300) continue;
    // Mismos ajustes que la variante que sobrevivio en el barrido: RSI14 70/30 con cruce de
    // vuelta y objetivo 1:1. Cambiarlos aqui seria comparar otra cosa.
    const cierres = usadas.map((x) => x.c);
    const reglas: ReglasRsi = { periodo: 14, sobreventa: 30, sobrecompra: 70, esperarCruce: true };
    const salida: ReglasSalidaFx = { objetivoR: 1, stopPips: 40, maxVelas: 0 };
    const valores = rsi(cierres, reglas.periodo);
    let ss = señales(cierres, reglas);
    ss = filtrarPorSesion(ss, usadas.map((x) => x.t), desde, hasta);
    const ops = simular(usadas, ss, salida, { spreadPips }, pip(par), valores);
    const rs = ops.map((o) => o.r);
    porPar.set(par, rs);
    for (const o of ops) {
      sumaPips += o.r;
      nPips += 1;
    }
  }

  const todas = [...porPar.values()].flat();
  const media = todas.length ? todas.reduce((s, x) => s + x, 0) / todas.length : 0;

  const mejor = [...porPar.entries()].sort(
    (a, b) => b[1].reduce((s, x) => s + x, 0) - a[1].reduce((s, x) => s + x, 0),
  )[0]?.[0];
  const sm = [...porPar.entries()].filter(([q]) => q !== mejor).flatMap(([, x]) => x);
  const mediaSM = sm.length ? sm.reduce((s, x) => s + x, 0) / sm.length : 0;

  return {
    global: { n: todas.length, media, equilibrio: 0 },
    sinMejor: { n: sm.length, media: mediaSM, equilibrio: 0 },
    enVerde: [...porPar.values()].filter((l) => l.length > 20 && l.reduce((s, x) => s + x, 0) > 0).length,
    total: porPar.size,
  };
}

async function main(): Promise<void> {
  const tf = (txt("tf") ?? "1h") as Temporalidad;
  const spreadPips = num("spread", 0.7);
  const pares: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--pares") + 1] ?? "", "utf-8"),
  );

  const datos = new Map<string, Vela[]>();
  for (const p of pares) {
    try {
      const v = await velas(p, tf);
      if (v.length > 500) datos.set(p, v);
    } catch { /* se salta */ }
    await dormir(400);
  }
  console.log(
    `${datos.size} pares · ${tf} · spread ${spreadPips} pips (coste ECN realista ~0,7)\n`,
  );

  // ---- 1. VECINDARIO DE HORAS ----------------------------------------------------------
  console.log("1. VECINDARIO: ¿solo funciona 0-7 UTC o toda la franja asiatica?");
  console.log(
    `${"ventana UTC".padEnd(16)}${"ops".padStart(7)}${"R media".padStart(10)}` +
      `${"sin mejor".padStart(11)}${"en verde".padStart(11)}`,
  );
  console.log("-".repeat(55));

  const ventanas: Array<[number, number]> = [
    [22, 6], [23, 7], [0, 6], [0, 7], [0, 8], [1, 7], [1, 9], [2, 8],
    [7, 16], [13, 22],
  ];
  for (const [d, h] of ventanas) {
    const r = evaluar(datos, d, h, spreadPips, null);
    const etiqueta = `${d}-${h}${d === 7 || d === 13 ? " (control)" : ""}`;
    console.log(
      `${etiqueta.padEnd(16)}${String(r.global.n).padStart(7)}` +
        `${r.global.media.toFixed(4).padStart(10)}${r.sinMejor.media.toFixed(4).padStart(11)}` +
        `${(r.enVerde + "/" + r.total).padStart(11)}`,
    );
  }

  // ---- 2. FUERA DE MUESTRA -------------------------------------------------------------
  const todosT = [...datos.values()].flatMap((v) => [v[0]!.t, v[v.length - 1]!.t]);
  const min = Math.min(...todosT);
  const max = Math.max(...todosT);
  const medio = (min + max) / 2;
  const f = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

  console.log(`\n2. FUERA DE MUESTRA · corte ${f(medio)}`);
  console.log(
    `${"ventana UTC".padEnd(16)}${"1a mitad".padStart(11)}${"2a mitad".padStart(11)}` +
      `${"ops 1a".padStart(9)}${"ops 2a".padStart(9)}`,
  );
  console.log("-".repeat(56));
  for (const [d, h] of [[0, 7], [23, 7], [0, 8]] as Array<[number, number]>) {
    const a = evaluar(datos, d, h, spreadPips, { min, max: medio });
    const b = evaluar(datos, d, h, spreadPips, { min: medio, max });
    console.log(
      `${`${d}-${h}`.padEnd(16)}${a.global.media.toFixed(4).padStart(11)}` +
        `${b.global.media.toFixed(4).padStart(11)}` +
        `${String(a.global.n).padStart(9)}${String(b.global.n).padStart(9)}`,
    );
  }

  // ---- 3. SENSIBILIDAD AL COSTE --------------------------------------------------------
  console.log("\n3. ¿HASTA QUE COSTE AGUANTA? (ventana 0-7 UTC)");
  console.log(`${"spread pips".padEnd(14)}${"R media".padStart(10)}${"sin mejor".padStart(11)}`);
  console.log("-".repeat(35));
  for (const sp of [0, 0.5, 0.7, 1.0, 1.5, 2.0]) {
    const r = evaluar(datos, 0, 7, sp, null);
    console.log(
      `${String(sp).padEnd(14)}${r.global.media.toFixed(4).padStart(10)}` +
        `${r.sinMejor.media.toFixed(4).padStart(11)}`,
    );
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
