/**
 * Experimentos 27-30 del spec: ¿aporta algo cada componente?
 *
 *   npm run fx:spec -- [--spread=1.5] [--tf=5m] [--minpuntos=6]
 *
 * El experimento central es el 29: la MISMA estrategia con y sin RSI. Si quitarlo mejora, el
 * RSI sobra. Para que la comparacion sea justa, apagar un componente no penaliza la puntuacion:
 * si "sin RSI" perdiera el punto del RSI, saldria peor por definicion.
 *
 * Se reporta cuantas combinaciones se han probado (spec §33). Con muchas variantes alguna sale
 * bien por azar, y ocultar el numero de intentos es la forma habitual de vender ruido.
 */
import { velas, pip, type Vela } from "../forex/datos";
import { detectar, PARAMETROS, type Componentes } from "../forex/setup";

const PARES = ["EURUSD=X", "USDJPY=X", "GBPJPY=X", "GBPUSD=X"];
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(n: string, d: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (!m) return d;
  const v = Number(m.split("=")[1]);
  return Number.isFinite(v) ? v : d;
}

interface Op {
  r: number;
  par: string;
  hora: number;
  direccion: "LARGO" | "CORTO";
}

/** Stop en multiplos de ATR, objetivo en R. Cierre forzado para no pagar swap. */
function simular(
  v: Vela[],
  i0: number,
  largo: boolean,
  stop: number,
  objetivoR: number,
  spread: number,
  maxVelas: number,
): number {
  const entrada = v[i0]!.o + (largo ? spread : -spread);
  const nStop = largo ? entrada - stop : entrada + stop;
  const nObj = largo ? entrada + stop * objetivoR : entrada - stop * objetivoR;

  for (let j = i0; j < v.length && j - i0 <= maxVelas; j += 1) {
    const c = v[j]!;
    // Si en la misma vela se tocan los dos, gana el STOP: no sabemos el orden intravela.
    if (largo ? c.l <= nStop : c.h >= nStop) return -1 - (spread * 2) / stop;
    if (largo ? c.h >= nObj : c.l <= nObj) return objetivoR - (spread * 2) / stop;
  }
  const fin = v[Math.min(v.length - 1, i0 + maxVelas)]!.c;
  const neta = fin - (largo ? spread : -spread);
  return (largo ? neta - entrada : entrada - neta) / stop;
}

function metricas(ops: Op[]): {
  n: number; wr: number; pf: number; exp: number; maxDD: number; rachaPerd: number;
} {
  if (!ops.length) return { n: 0, wr: 0, pf: 0, exp: 0, maxDD: 0, rachaPerd: 0 };
  const rs = ops.map((o) => o.r);
  const g = rs.filter((x) => x > 0);
  const p = rs.filter((x) => x <= 0);
  const sg = g.reduce((s, x) => s + x, 0);
  const sp = -p.reduce((s, x) => s + x, 0);

  // Drawdown sobre la curva de R acumulada, y racha maxima de perdidas.
  let pico = 0;
  let acum = 0;
  let maxDD = 0;
  let racha = 0;
  let maxRacha = 0;
  for (const r of rs) {
    acum += r;
    pico = Math.max(pico, acum);
    maxDD = Math.max(maxDD, pico - acum);
    racha = r <= 0 ? racha + 1 : 0;
    maxRacha = Math.max(maxRacha, racha);
  }
  return {
    n: ops.length,
    wr: g.length / ops.length,
    pf: sp > 0 ? sg / sp : 0,
    exp: rs.reduce((s, x) => s + x, 0) / ops.length,
    maxDD,
    rachaPerd: maxRacha,
  };
}

async function main(): Promise<void> {
  const spreadPips = arg("spread", 1.5);
  const tf = (process.argv.find((a) => a.startsWith("--tf="))?.split("=")[1] ?? "5m") as any;
  const minPuntos = arg("minpuntos", 0);
  const objetivoR = arg("tp", 2);
  const atrStop = arg("atr", 1.5);
  const maxVelas = arg("maxvelas", 96); // 8 horas en M5: cierra en el dia, sin swap

  console.log(
    `${tf} · spread ${spreadPips} pips · stop ${atrStop} ATR · TP ${objetivoR}R · ` +
      `cierre a ${maxVelas} velas · minimo ${minPuntos} puntos\n`,
  );

  const datos = new Map<string, { m5: Vela[]; h1: Vela[] }>();
  for (const p of PARES) {
    const m5 = await velas(p, tf);
    await dormir(600);
    const h1 = await velas(p, "1h");
    await dormir(600);
    if (m5.length > 500) datos.set(p, { m5, h1 });
  }
  console.log(`${datos.size} pares\n`);

  // Elegidas de antemano, no barridas. El numero se reporta (spec §33).
  const variantes: Array<[string, Componentes]> = [
    ["27 COMPLETA (H1+zona+RSI+estr)", { sesgoH1: true, zona: true, rsi: true, barrido: false, estructura: true }],
    ["29 SIN RSI", { sesgoH1: true, zona: true, rsi: false, barrido: false, estructura: true }],
    ["   sin zona", { sesgoH1: true, zona: false, rsi: true, barrido: false, estructura: true }],
    ["   sin estructura", { sesgoH1: true, zona: true, rsi: true, barrido: false, estructura: false }],
    ["   sin sesgo H1", { sesgoH1: false, zona: true, rsi: true, barrido: false, estructura: true }],
    ["30 + barrido liquidez", { sesgoH1: true, zona: true, rsi: true, barrido: true, estructura: true }],
    ["30 barrido SIN RSI", { sesgoH1: true, zona: true, rsi: false, barrido: true, estructura: true }],
    ["   solo RSI (referencia)", { sesgoH1: false, zona: false, rsi: true, barrido: false, estructura: false }],
    // A donde apunta el ablation: quitar lo que estorba y dejar solo lo que ayuda.
    ["   solo estructura", { sesgoH1: false, zona: false, rsi: false, barrido: false, estructura: true }],
    ["   zona + estructura", { sesgoH1: false, zona: true, rsi: false, barrido: false, estructura: true }],
  ];

  console.log(
    `${"variante".padEnd(32)}${"trades".padStart(8)}${"WR".padStart(7)}${"PF".padStart(7)}` +
      `${"exp R".padStart(9)}${"maxDD".padStart(8)}${"racha".padStart(7)}${"sin mejor par".padStart(15)}`,
  );
  console.log("-".repeat(93));

  for (const [nombre, comp] of variantes) {
    const porPar = new Map<string, Op[]>();
    for (const [par, d] of datos) {
      const pipTam = (pip(par) ?? 0.0001);
      const ops: Op[] = [];
      for (const s of detectar(d.m5, d.h1, comp, PARAMETROS)) {
        if (s.puntos < minPuntos) continue;
        const i0 = s.i + 1;
        if (i0 >= d.m5.length) continue;
        const r = simular(
          d.m5, i0, s.direccion === "LARGO", s.atr * atrStop, objetivoR, spreadPips * pipTam!, maxVelas,
        );
        ops.push({ r, par, hora: s.hora, direccion: s.direccion });
      }
      porPar.set(par, ops);
    }

    const todas = [...porPar.values()].flat();
    if (todas.length < 30) {
      console.log(`${nombre.padEnd(32)}${String(todas.length).padStart(8)}   (muestra corta)`);
      continue;
    }
    const m = metricas(todas);
    const mejor = [...porPar.entries()].sort(
      (a, b) => b[1].reduce((s, o) => s + o.r, 0) - a[1].reduce((s, o) => s + o.r, 0),
    )[0]?.[0];
    const sm = [...porPar.entries()].filter(([q]) => q !== mejor).flatMap(([, o]) => o);
    const expSin = sm.length ? sm.reduce((s, o) => s + o.r, 0) / sm.length : 0;

    console.log(
      `${nombre.padEnd(32)}${String(m.n).padStart(8)}${(m.wr * 100).toFixed(0).padStart(6)}%` +
        `${m.pf.toFixed(2).padStart(7)}${m.exp.toFixed(3).padStart(9)}` +
        `${m.maxDD.toFixed(1).padStart(8)}${String(m.rachaPerd).padStart(7)}` +
        `${expSin.toFixed(3).padStart(15)}`,
    );
  }

  console.log("-".repeat(93));
  console.log(
    `Combinaciones probadas: ${variantes.length}. Parametros fijos en sus valores del spec\n` +
      `(RSI 14, 70/30, EMA 20/50) — este barrido NO los optimiza, compara COMPONENTES.\n` +
      `maxDD y racha van en R acumulados. 'sin mejor par' quita el par que mas aporta.`,
  );
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
