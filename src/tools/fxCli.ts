/**
 * Barrido de la estrategia RSI en forex.
 *
 *   npm run fx                       # 1h, todos los pares, variantes de salida
 *   npm run fx -- --tf=15m --spread=1.5
 *
 * Contesta la pregunta que importa: ¿tiene esperanza positiva POR OPERACION, hoy?
 * El resultado va en R (multiplos del riesgo) y no en dinero, porque el dinero depende del
 * apalancamiento —que es una decision aparte— y no dice nada sobre si la estrategia sirve.
 */
import { velas, pip as pipCrudo, type Temporalidad, type Vela } from "../forex/datos";

/** Esta herramienta es solo de divisas: un par sin pip aqui es un error de uso, no un caso. */
function pipForex(par: string): number {
  const p = pipCrudo(par);
  if (p == null) throw new Error(`${par} no es un par de divisas y esta herramienta solo mide forex`);
  return p;
}
import { señales, REGLAS_RSI, type ReglasRsi } from "../forex/rsi";
import { simular, resumir, type ReglasSalidaFx } from "../forex/backtest";

const PARES = [
  "USDJPY=X",
  "EURJPY=X",
  "GBPJPY=X",
  "AUDJPY=X",
  "EURUSD=X",
  "GBPUSD=X",
  "AUDUSD=X",
];

/** Spread tipico de retail, en pips. Se puede subir para ver cuanto aguanta la ventaja. */
const SPREAD_POR_DEFECTO = 1.5;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lee un argumento numerico.
 *
 * OJO CON EL CERO. La primera version usaba `Number(x) || porDefecto`, y como 0 es falso en
 * JavaScript, `--spread=0` se convertia silenciosamente en el valor por defecto: las corridas
 * con y sin spread salian identicas y estuve a punto de concluir que el spread no importa.
 */
function arg(nombre: string, porDefecto: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  if (!m) return porDefecto;
  const v = Number(m.split("=")[1]);
  return Number.isFinite(v) ? v : porDefecto;
}

async function main(): Promise<void> {
  const tf = (process.argv.find((a) => a.startsWith("--tf="))?.split("=")[1] ??
    "1h") as Temporalidad;
  const spreadPips = arg("spread", SPREAD_POR_DEFECTO);
  const stopPips = arg("stop", tf === "1d" ? 60 : 20);

  console.log(`Temporalidad ${tf} · spread ${spreadPips} pips · stop ${stopPips} pips\n`);

  // Se bajan los datos una vez y se reutilizan para todas las variantes.
  const datos = new Map<string, Vela[]>();
  for (const p of PARES) {
    try {
      const v = await velas(p, tf);
      if (v.length > 100) datos.set(p, v);
      const desde = v.length ? new Date(v[0]!.t * 1000).toISOString().slice(0, 10) : "?";
      console.log(`  ${p.padEnd(10)} ${String(v.length).padStart(6)} velas desde ${desde}`);
    } catch {
      console.log(`  ${p.padEnd(10)} sin datos`);
    }
    await dormir(700);
  }
  console.log();

  // Variantes elegidas de antemano. La primera es la clasica que describio el usuario.
  const variantes: Array<[string, ReglasRsi, ReglasSalidaFx]> = [
    ["70/30 al cruzar · 1:1", { ...REGLAS_RSI, esperarCruce: true }, { objetivoR: 1, stopPips, maxVelas: 0 }],
    ["70/30 al cruzar · 2:1", { ...REGLAS_RSI, esperarCruce: true }, { objetivoR: 2, stopPips, maxVelas: 0 }],
    ["70/30 mientras esta · 1:1", { ...REGLAS_RSI, esperarCruce: false }, { objetivoR: 1, stopPips, maxVelas: 0 }],
    ["70/30 al cruzar · 0.5:1", { ...REGLAS_RSI, esperarCruce: true }, { objetivoR: 0.5, stopPips, maxVelas: 0 }],
    ["80/20 al cruzar · 1:1", { ...REGLAS_RSI, esperarCruce: true, sobreventa: 20, sobrecompra: 80 }, { objetivoR: 1, stopPips, maxVelas: 0 }],
    ["70/30 solo largos · 1:1", { ...REGLAS_RSI, esperarCruce: true, soloLargos: true }, { objetivoR: 1, stopPips, maxVelas: 0 }],
    ["70/30 solo cortos · 1:1", { ...REGLAS_RSI, esperarCruce: true, soloCortos: true }, { objetivoR: 1, stopPips, maxVelas: 0 }],
  ];

  console.log(
    `${"variante".padEnd(28)}${"ops".padStart(7)}${"acierto".padStart(9)}` +
      `${"R media".padStart(10)}${"R total".padStart(10)}${"sin su mejor par".padStart(18)}`,
  );
  console.log("-".repeat(82));

  for (const [nombre, reglasRsi, reglasSalida] of variantes) {
    const porPar = new Map<string, number[]>();
    for (const [par, v] of datos) {
      const ss = señales(v.map((x) => x.c), reglasRsi);
      const ops = simular(v, ss, reglasSalida, { spreadPips }, pipForex(par));
      porPar.set(par, ops.map((o) => o.r));
    }

    const todas = [...porPar.values()].flat();
    if (todas.length < 30) {
      console.log(`${nombre.padEnd(28)}${String(todas.length).padStart(7)}   (muestra corta)`);
      continue;
    }
    const r = resumir(
      todas.map((x) => ({ iEntrada: 0, iSalida: 0, direccion: "LARGO" as const, r: x, motivo: "FIN" as const, velas: 0 })),
    );

    // La misma prueba que en memecoins: quitarle su mejor instrumento. Una estrategia que solo
    // gana gracias a un par no es una estrategia, es un acierto con ese par.
    const mejor = [...porPar.entries()].sort(
      (a, b) => b[1].reduce((s, x) => s + x, 0) - a[1].reduce((s, x) => s + x, 0),
    )[0]?.[0];
    const sinMejor = [...porPar.entries()].filter(([p]) => p !== mejor).flatMap(([, v]) => v);
    const mediaSin = sinMejor.length ? sinMejor.reduce((s, x) => s + x, 0) / sinMejor.length : 0;

    console.log(
      `${nombre.padEnd(28)}${String(r.operaciones).padStart(7)}` +
        `${(r.tasaAcierto * 100).toFixed(0).padStart(8)}%` +
        `${r.mediaR.toFixed(3).padStart(10)}${r.totalR.toFixed(1).padStart(10)}` +
        `${mediaSin.toFixed(3).padStart(18)}`,
    );
  }

  console.log("-".repeat(82));
  console.log(
    "R media = ganancia esperada por operacion en multiplos del riesgo. Positiva = hay ventaja.\n" +
      "El dinero depende del apalancamiento, que es una decision aparte y no dice si la\n" +
      "estrategia sirve: el mismo multiplicador que convierte 1% en 120% convierte -1% en -120%.",
  );
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
