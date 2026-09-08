/**
 * Ver las operaciones dibujadas, con las velas que leyo el backtest.
 *
 *   npm run grafico -- --lista X.json --cache=V.json [--senal=vol2] [--peores=10]
 *                      [--mejores=10] [--azar=10] [--simbolo=BTCUSDT] [--salida=ops.html]
 *
 * El bucle de operaciones es el MISMO que el de `cartera:tendencia`, con los mismos parametros.
 * Si aqui se calculara de otra forma, el dibujo dejaria de ser una comprobacion del backtest y
 * pasaria a ser una segunda opinion, que no sirve de nada.
 *
 * Mirar las PEORES es lo que mas enseña: una perdida enorme suele ser un stop mal puesto o un
 * dato malo, no mala suerte.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Vela } from "../forex/datos";
import { atr } from "../forex/multiTf";
import {
  canal, volatilidad, simularRuptura,
  type SeñalRuptura, type TrazaOp,
} from "../forex/rupturas";
import { grafico, pagina, type OpDibujable } from "../forex/grafico";

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

const SEÑALES: Record<
  string,
  { f: (v: Vela[], a: (number | null)[]) => SeñalRuptura[]; stop: number; trail: number }
> = {
  canal20: { f: (v) => canal(v, 20), stop: 2, trail: 3 },
  canal50: { f: (v) => canal(v, 50), stop: 3, trail: 3 },
  vol2: { f: (v, a) => volatilidad(v, a, 2), stop: 2, trail: 2 },
};

interface Op extends OpDibujable {
  velas: Vela[];
}

async function main(): Promise<void> {
  const nombre = txt("senal") ?? "vol2";
  const cfg = SEÑALES[nombre];
  if (!cfg) {
    console.error(`Señal desconocida: ${nombre}. Hay ${Object.keys(SEÑALES).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const cache = txt("cache");
  const listaRuta = process.argv[process.argv.indexOf("--lista") + 1] ?? txt("lista") ?? "";
  if (!cache || !existsSync(cache) || !existsSync(listaRuta)) {
    console.error("Hacen falta --lista RUTA.json y --cache=RUTA.json");
    process.exitCode = 1;
    return;
  }
  const costeBps = num("costebps", 10);
  const soloSimbolo = txt("simbolo");
  const salida = txt("salida") ?? "operaciones.html";

  const lista: string[] = JSON.parse(readFileSync(listaRuta, "utf-8"));
  const g = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
  const datos = new Map<string, Vela[]>();
  for (const k of lista) {
    if (soloSimbolo && k !== soloSimbolo) continue;
    const v = g[k];
    if (v && v.length > 60) datos.set(k, v);
  }
  if (datos.size === 0) {
    console.error("Ningun instrumento con datos suficientes.");
    process.exitCode = 1;
    return;
  }

  // ---- Las operaciones, igual que en cartera:tendencia --------------------------------------
  const ops: Op[] = [];
  for (const [s, v] of datos) {
    const a = atr(v, 14);
    for (const sig of cfg.f(v, a)) {
      const av = a[sig.i];
      if (av == null || !(av > 0)) continue;
      const stop = av * cfg.stop;
      const precio = v[sig.i]!.c;
      const coste = (precio * costeBps) / 10_000;
      const traza = {} as TrazaOp;
      const r = simularRuptura(v, sig, stop, cfg.trail, coste / 2, 0, 0, true, true, traza);
      if (!r) continue;
      ops.push({
        simbolo: s, direccion: r.direccion, r: r.r, motivo: r.motivo, traza, velas: v,
      });
    }
  }
  if (ops.length === 0) {
    console.error("La señal no produjo ninguna operacion sobre estos datos.");
    process.exitCode = 1;
    return;
  }

  // ---- Cuales se enseñan --------------------------------------------------------------------
  const orden = [...ops].sort((x, y) => x.r - y.r);
  const nPeores = num("peores", soloSimbolo ? 0 : 6);
  const nMejores = num("mejores", soloSimbolo ? 0 : 6);
  const nAzar = num("azar", soloSimbolo ? 0 : 6);

  const elegidas: Array<{ titulo: string; op: Op }> = [];
  const vistas = new Set<Op>();
  const meter = (titulo: string, lista: Op[]) => {
    for (const o of lista) {
      if (vistas.has(o)) continue;
      vistas.add(o);
      elegidas.push({ titulo, op: o });
    }
  };
  meter("peor", orden.slice(0, nPeores));
  meter("mejor", orden.slice(-nMejores).reverse());
  if (nAzar > 0) {
    const rnd = azar(20260907);
    const resto = ops.filter((o) => !vistas.has(o));
    const muestra: Op[] = [];
    for (let k = 0; k < Math.min(nAzar, resto.length); k += 1) {
      muestra.push(resto.splice(Math.floor(rnd() * resto.length), 1)[0]!);
    }
    meter("al azar", muestra);
  }
  if (soloSimbolo && elegidas.length === 0) meter("todas", ops);

  // ---- La pagina ---------------------------------------------------------------------------
  const rs = ops.map((o) => o.r);
  const gan = rs.filter((x) => x > 0);
  const sp = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  const nota =
    `${ops.length} operaciones en ${datos.size} instrumento(s) · señal ${nombre} ` +
    `(stop ${cfg.stop} ATR, trailing ${cfg.trail}x) · coste ${costeBps} pb · ` +
    `acierto ${((gan.length / rs.length) * 100).toFixed(0)}% · ` +
    `PF ${(sp > 0 ? gan.reduce((s, x) => s + x, 0) / sp : 0).toFixed(2)}. ` +
    `Se enseñan ${elegidas.length}. Las velas son las que leyo el simulador, y el stop dibujado ` +
    `es el que el simulador tenia vigente en cada vela, no uno recalculado aqui.`;

  const svgs = elegidas.map(
    ({ titulo, op }) =>
      grafico(op.velas, { ...op, simbolo: `${op.simbolo}  [${titulo}]` }, num("margen", 12)),
  );
  writeFileSync(salida, pagina(`Operaciones · ${nombre}`, nota, svgs));

  console.log(`${ops.length} operaciones · se dibujan ${elegidas.length}`);
  for (const { titulo, op } of elegidas) {
    console.log(
      `  ${titulo.padEnd(8)}${op.simbolo.padEnd(12)}${op.direccion.padEnd(7)}` +
        `${(op.r >= 0 ? "+" : "") + op.r.toFixed(2)}R`.padStart(9) +
        `  ${op.motivo}`,
    );
  }
  console.log(`\nEscrito en ${salida}. Abrelo en el navegador.`);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
