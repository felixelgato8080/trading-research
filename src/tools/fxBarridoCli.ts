/**
 * Barrido amplio del RSI en M5: periodos, umbrales, salidas y sesiones.
 *
 *   npm run fx:barrido -- [--spread=0] [--stop=40]
 *
 * El RSI(14) 70/30 clasico da 53% de acierto y +0,050R sin costes. La pregunta de este barrido
 * es si alguna variante sube ese borde por encima del coste real (~0,9 pips de equilibrio).
 *
 * SE MIDE SIN COSTES A PROPOSITO en la corrida principal: primero hay que saber si existe
 * borde y de que tamaño; aplicarle el coste despues es aritmetica. Mezclar las dos cosas
 * esconde si una variante es mala o solo cara.
 *
 * Cada variante se juzga tambien QUITANDOLE SU MEJOR PAR, igual que en memecoins: una
 * configuracion que solo gana con un par no es una estrategia, es un acierto con ese par.
 */
import { velas, pip as pipCrudo, type Vela } from "../forex/datos";

/** Esta herramienta es solo de divisas: un par sin pip aqui es un error de uso, no un caso. */
function pipForex(par: string): number {
  const p = pipCrudo(par);
  if (p == null) throw new Error(`${par} no es un par de divisas y esta herramienta solo mide forex`);
  return p;
}
import { rsi, señales, filtrarPorSesion, type ReglasRsi } from "../forex/rsi";
import { simular, resumir, type ReglasSalidaFx } from "../forex/backtest";

const PARES = ["USDJPY=X", "EURUSD=X", "GBPUSD=X", "EURJPY=X", "AUDUSD=X"];
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(n: string, d: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (!m) return d;
  const v = Number(m.split("=")[1]);
  return Number.isFinite(v) ? v : d;
}

interface Variante {
  nombre: string;
  rsi: ReglasRsi;
  salida: ReglasSalidaFx;
  sesion?: [number, number];
}

async function main(): Promise<void> {
  const spreadPips = arg("spread", 0);
  const stopPips = arg("stop", 40);
  const tf = (process.argv.find((a) => a.startsWith("--tf="))?.split("=")[1] ?? "5m") as any;

  console.log(`${tf} · spread ${spreadPips} pips · stop ${stopPips} pips\n`);

  const datos = new Map<string, Vela[]>();
  for (const p of PARES) {
    const v = await velas(p, tf);
    if (v.length > 200) datos.set(p, v);
    await dormir(600);
  }
  console.log(`${datos.size} pares · ${[...datos.values()][0]?.length ?? 0} velas por par\n`);

  const base: ReglasRsi = { periodo: 14, sobreventa: 30, sobrecompra: 70, esperarCruce: true };
  const salidaBase: ReglasSalidaFx = { objetivoR: 1, stopPips, maxVelas: 0 };

  const variantes: Variante[] = [
    { nombre: "REFERENCIA: RSI14 70/30 1:1", rsi: base, salida: salidaBase },

    // --- periodo ---
    { nombre: "RSI 2 (Connors) 70/30", rsi: { ...base, periodo: 2 }, salida: salidaBase },
    { nombre: "RSI 7 70/30", rsi: { ...base, periodo: 7 }, salida: salidaBase },
    { nombre: "RSI 9 70/30", rsi: { ...base, periodo: 9 }, salida: salidaBase },
    { nombre: "RSI 21 70/30", rsi: { ...base, periodo: 21 }, salida: salidaBase },

    // --- umbrales ---
    { nombre: "RSI14 80/20", rsi: { ...base, sobreventa: 20, sobrecompra: 80 }, salida: salidaBase },
    { nombre: "RSI14 90/10", rsi: { ...base, sobreventa: 10, sobrecompra: 90 }, salida: salidaBase },
    { nombre: "RSI2 90/10", rsi: { ...base, periodo: 2, sobreventa: 10, sobrecompra: 90 }, salida: salidaBase },
    { nombre: "RSI2 95/5", rsi: { ...base, periodo: 2, sobreventa: 5, sobrecompra: 95 }, salida: salidaBase },

    // --- salidas ---
    { nombre: "salir al volver RSI 50", rsi: base, salida: { ...salidaBase, salirEnRsi: 50 } },
    { nombre: "RSI2 + salir en RSI 50", rsi: { ...base, periodo: 2 }, salida: { ...salidaBase, salirEnRsi: 50 } },
    { nombre: "objetivo 2:1", rsi: base, salida: { ...salidaBase, objetivoR: 2 } },
    { nombre: "objetivo 0.5:1", rsi: base, salida: { ...salidaBase, objetivoR: 0.5 } },
    { nombre: "corte a 12 velas (1h)", rsi: base, salida: { ...salidaBase, maxVelas: 12 } },

    // --- sesiones (UTC) ---
    { nombre: "solo Londres (7-16 UTC)", rsi: base, salida: salidaBase, sesion: [7, 16] },
    { nombre: "solo NY (13-22 UTC)", rsi: base, salida: salidaBase, sesion: [13, 22] },
    { nombre: "solo solape LDN-NY (13-16)", rsi: base, salida: salidaBase, sesion: [13, 16] },
    { nombre: "solo Asia (0-7 UTC)", rsi: base, salida: salidaBase, sesion: [0, 7] },
  ];

  console.log(
    `${"variante".padEnd(30)}${"ops".padStart(7)}${"acierto".padStart(9)}` +
      `${"R media".padStart(10)}${"sin su mejor par".padStart(18)}${"velas".padStart(8)}`,
  );
  console.log("-".repeat(82));

  const filas: Array<{ nombre: string; media: number; sinMejor: number; ops: number }> = [];

  for (const v of variantes) {
    const porPar = new Map<string, number[]>();
    let velasMed = 0;

    for (const [par, velasPar] of datos) {
      const cierres = velasPar.map((x) => x.c);
      const valoresRsi = rsi(cierres, v.rsi.periodo);
      let ss = señales(cierres, v.rsi);
      if (v.sesion) ss = filtrarPorSesion(ss, velasPar.map((x) => x.t), v.sesion[0], v.sesion[1]);
      const ops = simular(velasPar, ss, v.salida, { spreadPips }, pipForex(par), valoresRsi);
      porPar.set(par, ops.map((o) => o.r));
      if (ops.length) velasMed = resumir(ops).velasMedianas;
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
    const sinMejorArr = [...porPar.entries()].filter(([p]) => p !== mejor).flatMap(([, x]) => x);
    const sinMejor = sinMejorArr.length
      ? sinMejorArr.reduce((s, x) => s + x, 0) / sinMejorArr.length
      : 0;

    filas.push({ nombre: v.nombre, media, sinMejor, ops: todas.length });
    console.log(
      `${v.nombre.padEnd(30)}${String(todas.length).padStart(7)}` +
        `${(acierto * 100).toFixed(0).padStart(8)}%` +
        `${media.toFixed(3).padStart(10)}${sinMejor.toFixed(3).padStart(18)}` +
        `${velasMed.toFixed(0).padStart(8)}`,
    );
  }

  console.log("-".repeat(82));
  // Manda la columna de "sin su mejor par": es la que distingue estrategia de casualidad.
  const mejores = [...filas].sort((a, b) => b.sinMejor - a.sinMejor).slice(0, 3);
  console.log("Mejores por R media SIN su mejor par:");
  for (const m of mejores) {
    // Coste de equilibrio: cuantos pips de spread total aguanta antes de dejar de ganar.
    const pipsEquilibrio = m.sinMejor * stopPips;
    console.log(
      `  ${m.nombre.padEnd(30)} ${m.sinMejor.toFixed(3)}R · aguanta hasta ` +
        `${pipsEquilibrio.toFixed(2)} pips de coste total (${m.ops} ops)`,
    );
  }
  console.log(
    "\nRecordatorio: el coste real de una cuenta ECN es spread crudo MAS comision,\n" +
      "tipicamente ~0,7 pips equivalentes. Una variante que aguante menos de eso no sirve.",
  );
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
