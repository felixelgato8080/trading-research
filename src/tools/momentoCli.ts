/**
 * Barrido de momento transversal.
 *
 *   npm run momento -- --lista etf_ok.json --cache=v.json [--coste=0.001] [--sin=BTC-USD,ETH-USD]
 *
 * TRES CONTROLES, no uno:
 *   1. Tener TODO el universo a partes iguales. Si el ranking no lo supera, el ranking sobra.
 *   2. Quitar la cripto. Con BTC dentro, cualquier ranking acaba siendo "tener Bitcoin" y lo
 *      que se mide es una sola apuesta disfrazada de sistema.
 *   3. Las dos mitades del calendario por separado.
 *
 * Se dice cuantas combinaciones se han probado.
 */
import { readFileSync, existsSync } from "node:fs";
import { velas, type Vela } from "../forex/datos";
import { indexar, calendario, simular, control, type Ajustes, type Resultado } from "../forex/momento";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
function arg(n: string, d: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (!m) return d;
  const v = Number(m.split("=")[1]);
  return Number.isFinite(v) ? v : d;
}
function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}

function anual(r: Resultado, anios: number): number {
  return r.capitalFinal > 0 ? (Math.pow(r.capitalFinal, 1 / anios) - 1) * 100 : -100;
}

function linea(nombre: string, r: Resultado, anios: number): string {
  const a = anual(r, anios);
  return (
    `${nombre.padEnd(30)}${a.toFixed(1).padStart(8)}%${(r.maxCaida * 100).toFixed(0).padStart(8)}%` +
    `${(a / (r.maxCaida * 100 || 1)).toFixed(2).padStart(8)}` +
    `${(r.aciertoPeriodos * 100).toFixed(0).padStart(8)}%${(r.rotacionMedia * 100).toFixed(0).padStart(9)}%` +
    `${String(r.periodos.length).padStart(8)}`
  );
}

async function main(): Promise<void> {
  const coste = arg("coste", 0.001);
  const cache = txt("cache");
  const sin = (txt("sin") ?? "").split(",").filter(Boolean);
  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );

  const datos = new Map<string, Vela[]>();
  if (cache && existsSync(cache)) {
    const g = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
    for (const k of lista) {
      const v = g[k];
      if (v && v.length > 300 && !sin.includes(k)) datos.set(k, v);
    }
  } else {
    for (const s of lista) {
      if (sin.includes(s)) continue;
      try {
        const v = await velas(s, "1d");
        if (v.length > 300) datos.set(s, v);
      } catch { /* se salta */ }
      await dormir(400);
    }
  }

  const idx = indexar(datos);
  const cal = calendario(idx);
  const anios = (cal[cal.length - 1]! - cal[0]!) / (365.25 * 86400);
  console.log(
    `${datos.size} instrumentos · ${anios.toFixed(1)} años · coste ${(coste * 100).toFixed(2)}% por cambio` +
      `${sin.length ? ` · SIN ${sin.join(", ")}` : ""}\n`,
  );

  const cab =
    `${"variante".padEnd(30)}${"anual".padStart(9)}${"caida".padStart(8)}${"ratio".padStart(8)}` +
    `${"aciertoP".padStart(9)}${"rotacion".padStart(9)}${"periodos".padStart(8)}`;

  // ---- CONTROL -------------------------------------------------------------------------
  console.log(cab);
  console.log("-".repeat(72));
  const ctrl = control(idx, cal, 20);
  console.log(linea("CONTROL todo a partes iguales", ctrl, anios));
  const refAnual = anual(ctrl, anios);
  console.log("");

  // ---- REJILLA -------------------------------------------------------------------------
  const combos: Array<{ n: string; a: Ajustes }> = [];
  for (const lookback of [60, 120, 250]) {
    for (const cartera of [3, 5, 8]) {
      for (const absoluto of [false, true]) {
        combos.push({
          n: `mira ${lookback}d · top ${cartera}${absoluto ? " · abs" : ""}`,
          a: { lookback, hueco: 20, cartera, rebalanceo: 20, absoluto, coste },
        });
      }
    }
  }

  console.log(cab);
  console.log("-".repeat(72));
  const filas: Array<{ n: string; a: Ajustes; r: Resultado }> = [];
  for (const c of combos) {
    const r = simular(idx, cal, c.a);
    filas.push({ ...c, r });
    console.log(linea(c.n, r, anios));
  }

  // ---- FUERA DE MUESTRA sobre las mejores ----------------------------------------------
  const medio = cal[Math.floor(cal.length / 2)]!;
  const calA = cal.filter((t) => t <= medio);
  const calB = cal.filter((t) => t > medio);
  const aniosA = (calA[calA.length - 1]! - calA[0]!) / (365.25 * 86400);
  const aniosB = (calB[calB.length - 1]! - calB[0]!) / (365.25 * 86400);
  const f = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

  console.log(`\nFUERA DE MUESTRA · corte ${f(medio)}`);
  console.log(
    `${"variante".padEnd(30)}${"1a mitad".padStart(10)}${"2a mitad".padStart(10)}` +
      `${"caida 1a".padStart(10)}${"caida 2a".padStart(10)}`,
  );
  console.log("-".repeat(70));

  const ctrlA = control(idx, calA, 20);
  const ctrlB = control(idx, calB, 20);
  console.log(
    `${"CONTROL todo".padEnd(30)}${anual(ctrlA, aniosA).toFixed(1).padStart(9)}%` +
      `${anual(ctrlB, aniosB).toFixed(1).padStart(9)}%` +
      `${(ctrlA.maxCaida * 100).toFixed(0).padStart(9)}%${(ctrlB.maxCaida * 100).toFixed(0).padStart(9)}%`,
  );

  const mejores = [...filas].sort((x, y) => y.r.capitalFinal - x.r.capitalFinal).slice(0, 6);
  for (const m of mejores) {
    const a = simular(idx, calA, m.a);
    const b = simular(idx, calB, m.a);
    console.log(
      `${m.n.padEnd(30)}${anual(a, aniosA).toFixed(1).padStart(9)}%` +
        `${anual(b, aniosB).toFixed(1).padStart(9)}%` +
        `${(a.maxCaida * 100).toFixed(0).padStart(9)}%${(b.maxCaida * 100).toFixed(0).padStart(9)}%`,
    );
  }

  // ---- VEREDICTO -----------------------------------------------------------------------
  console.log(`\nControl: ${refAnual.toFixed(1)}% anual con ${(ctrl.maxCaida * 100).toFixed(0)}% de caida.`);
  const superan = filas.filter((x) => anual(x.r, anios) > refAnual && x.r.maxCaida < ctrl.maxCaida);
  console.log(
    superan.length === 0
      ? "Ninguna variante gana MAS con MENOS caida que tenerlo todo."
      : `${superan.length} de ${filas.length} ganan mas con menos caida: ${superan.map((x) => x.n).join(" · ")}`,
  );
  console.log(`\nCombinaciones probadas: ${combos.length} + 1 control.`);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
