/**
 * LOS PIPS: lo mismo, pero en movimiento de precio en vez de en R.
 *
 *   npm run pips -- --lista X.json --cache=V.json [--costebps=10]
 *
 * POR QUE HACE FALTA APARTE
 * -------------------------
 * Todo el proyecto reporta en R (multiplos del riesgo) y en PF. Eso es lo correcto para comparar
 * estrategias entre si, pero esconde una cosa: R se normaliza por el stop, asi que dos
 * estrategias con la misma R pueden mover cantidades de precio completamente distintas.
 *
 * Felix lleva desde el principio pidiendo lo otro: cuantos pips se ganan contra cuantos se
 * pierden. En cripto el equivalente del pip es el % del precio, porque un "pip" no significa
 * nada cuando BTC vale 100.000 y DOGE 0,2.
 *
 * Aqui se suma el movimiento real capturado, sin normalizar por nada.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Vela } from "../forex/datos";
import { atr } from "../forex/multiTf";
import { volatilidad, simularRuptura } from "../forex/rupturas";

function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
function num(n: string, d: number): number {
  const m = txt(n);
  if (m === undefined) return d;
  const v = Number(m);
  return Number.isFinite(v) ? v : d;
}

async function main(): Promise<void> {
  const costeBps = num("costebps", 10);
  const cache = txt("cache")!;
  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );
  if (!existsSync(cache)) { console.error("Falta --cache"); process.exitCode = 1; return; }
  const g = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
  const datos = new Map<string, Vela[]>();
  for (const k of lista) { const v = g[k]; if (v && v.length > 300) datos.set(k, v); }

  console.log(
    `EN MOVIMIENTO DE PRECIO, no en R · ${datos.size} instrumentos · coste ${costeBps} pb\n`,
  );
  console.log(
    `${"variante".padEnd(22)}${"ops".padStart(7)}${"gana%".padStart(10)}${"pierde%".padStart(10)}` +
      `${"PF precio".padStart(11)}${"PF en R".padStart(9)}${"media gana".padStart(12)}${"media pierde".padStart(13)}`,
  );
  console.log("-".repeat(94));

  for (const [k, stopMult] of [[1.5, 2], [2, 2], [2.5, 2], [3, 2]] as Array<[number, number]>) {
    let ganaPct = 0, pierdePct = 0, nGana = 0, nPierde = 0;
    const rs: number[] = [];
    for (const [, v] of datos) {
      const a = atr(v, 14);
      for (const sig of volatilidad(v, a, k)) {
        const av = a[sig.i];
        if (av == null || !(av > 0)) continue;
        const stop = av * stopMult;
        const precio = v[sig.i]!.c;
        const r = simularRuptura(v, sig, stop, 2, ((precio * costeBps) / 10_000) / 2, 0);
        if (!r || !(precio > 0)) continue;
        rs.push(r.r);
        // El movimiento de precio capturado: R x stop, en % del precio de entrada.
        const pct = (r.r * stop) / precio * 100;
        if (pct > 0) { ganaPct += pct; nGana += 1; }
        else { pierdePct += -pct; nPierde += 1; }
      }
    }
    if (!rs.length) continue;
    const gR = rs.filter((x) => x > 0);
    const sgR = gR.reduce((s, x) => s + x, 0);
    const spR = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
    console.log(
      `${`vol ${k} ATR · stop ${stopMult}`.padEnd(22)}${String(rs.length).padStart(7)}` +
        `${ganaPct.toFixed(0).padStart(9)}%${pierdePct.toFixed(0).padStart(9)}%` +
        `${(pierdePct > 0 ? ganaPct / pierdePct : 0).toFixed(2).padStart(11)}` +
        `${(spR > 0 ? sgR / spR : 0).toFixed(2).padStart(9)}` +
        `${(nGana ? ganaPct / nGana : 0).toFixed(1).padStart(11)}%` +
        `${(nPierde ? pierdePct / nPierde : 0).toFixed(1).padStart(12)}%`,
    );
  }
  console.log(
    "\nSi 'PF precio' y 'PF en R' se parecen, medir en R no escondia nada.\n" +
    "Si difieren, es que las operaciones grandes y pequeñas no pesan igual en las dos medidas.",
  );
}

main().catch((e) => { console.error("Error:", e instanceof Error ? e.message : e); process.exitCode = 1; });
