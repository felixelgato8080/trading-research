/**
 * De R a dinero, y la prueba de agrupacion.
 *
 *   npm run cartera -- --lista etf_ok.json --cache=v.json [--rsi=4] [--umbral=15] [--coste=0.05]
 *                      [--capital=1000] [--riesgo=0.01]
 *
 * Responde tres cosas que el barrido en R no puede responder:
 *
 *   1. ¿Las señales son independientes o caen todas el mismo dia? Si caen juntas, el numero de
 *      operaciones esta inflado y el acierto real se mide POR DIA, no por operacion.
 *   2. Con capital finito y un tope de posiciones, ¿que queda de la ventaja?
 *   3. En euros: cuanto sube, cuanto es la peor caida, y cuanto se pierde en el peor dia.
 *
 * Ninguna de las tres puede salir de un promedio en R.
 */
import { readFileSync, existsSync } from "node:fs";
import { velas, type Vela } from "../forex/datos";
import { atr } from "../forex/multiTf";
import { retrocesoEnTendencia, simularReversion } from "../forex/reversion";
import { simularCartera, porDia, type Operacion } from "../forex/cartera";

function arg(n: string, d: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (!m) return d;
  const v = Number(m.split("=")[1]);
  return Number.isFinite(v) ? v : d;
}
function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stats(rs: number[]): { n: number; wr: number; pf: number; exp: number } {
  const g = rs.filter((x) => x > 0);
  const sg = g.reduce((s, x) => s + x, 0);
  const sp = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  return {
    n: rs.length,
    wr: rs.length ? g.length / rs.length : 0,
    pf: sp > 0 ? sg / sp : 0,
    exp: rs.length ? rs.reduce((s, x) => s + x, 0) / rs.length : 0,
  };
}

async function main(): Promise<void> {
  const periodoRsi = arg("rsi", 4);
  const umbral = arg("umbral", 15);
  const costeR = arg("coste", 0.05);
  const atrStop = arg("stop", 3);
  const maxVelas = arg("maxvelas", 10);
  const capital = arg("capital", 1000);
  const riesgoPct = arg("riesgo", 0.01);
  const cache = txt("cache");

  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );

  console.log(
    `RSI(${periodoRsi}) < ${umbral} sobre media 200 · stop ${atrStop} ATR · tope ${maxVelas} velas\n` +
      `coste ${(costeR * 100).toFixed(1)}% del riesgo · capital ${capital} · riesgo ${(riesgoPct * 100).toFixed(1)}% por operacion\n`,
  );

  const datos = new Map<string, Vela[]>();
  if (cache && existsSync(cache)) {
    const guardado = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
    for (const [k, v] of Object.entries(guardado)) if (v.length > 250) datos.set(k, v);
  } else {
    for (const s of lista) {
      try {
        const v = await velas(s, "1d");
        if (v.length > 250) datos.set(s, v);
      } catch { /* se salta */ }
      await dormir(400);
    }
  }
  console.log(`${datos.size} instrumentos\n`);

  const ops: Operacion[] = [];
  for (const [s, v] of datos) {
    const a = atr(v, 14);
    for (const sig of retrocesoEnTendencia(v, periodoRsi, umbral, 200, true)) {
      const av = a[sig.i];
      if (av == null || !(av > 0)) continue;
      const stop = av * atrStop;
      const r = simularReversion(v, sig, stop, (costeR * stop) / 2, maxVelas, null, 0);
      if (!r) continue;
      const iE = sig.i + 1;
      const iS = Math.min(iE + r.velas, v.length - 1);
      ops.push({ instrumento: s, tEntrada: v[iE]!.t, tSalida: v[iS]!.t, r: r.r });
    }
  }
  ops.sort((a, b) => a.tEntrada - b.tEntrada);
  if (ops.length === 0) {
    console.log("Sin operaciones.");
    return;
  }

  const anios =
    (ops[ops.length - 1]!.tEntrada - ops[0]!.tEntrada) / (365.25 * 86400);

  // ---- 1. AGRUPACION -------------------------------------------------------------------
  const dias = porDia(ops);
  const porOp = stats(ops.map((o) => o.r));
  const porDiaS = stats(dias.map((d) => d.r));
  const maxEnUnDia = Math.max(...dias.map((d) => d.n));

  console.log("1. ¿SON INDEPENDIENTES LAS SEÑALES?");
  console.log(`   ${ops.length} operaciones repartidas en ${dias.length} dias distintos`);
  console.log(
    `   media ${(ops.length / dias.length).toFixed(1)} señales por dia con señal · maximo ${maxEnUnDia} el mismo dia`,
  );
  console.log(
    `   por operacion: acierto ${(porOp.wr * 100).toFixed(0)}% · PF ${porOp.pf.toFixed(2)} · ${porOp.exp.toFixed(3)}R`,
  );
  console.log(
    `   POR DIA:       acierto ${(porDiaS.wr * 100).toFixed(0)}% · PF ${porDiaS.pf.toFixed(2)} · ${porDiaS.exp.toFixed(3)}R`,
  );
  console.log(
    `   La segunda linea es la muestra honesta: ${dias.length} observaciones en ${anios.toFixed(1)} años, no ${ops.length}.\n`,
  );

  // ---- 2. LA CARTERA CON TOPE ----------------------------------------------------------
  console.log("2. CARTERA REAL (riesgo compuesto sobre el capital del momento)");
  console.log(
    `${"tope".padStart(6)}${"acepta".padStart(9)}${"rechaza".padStart(9)}${"maxSim".padStart(8)}` +
      `${"final".padStart(12)}${"x".padStart(8)}${"anual".padStart(8)}${"peor caida".padStart(12)}${"peor dia".padStart(10)}`,
  );
  console.log("-".repeat(82));
  for (const tope of [1, 2, 3, 5, 8, 12, 0]) {
    const r = simularCartera(ops, { capital, riesgoPct, maxPosiciones: tope, compuesto: true });
    const mult = r.capitalFinal / capital;
    const anual = mult > 0 ? (Math.pow(mult, 1 / anios) - 1) * 100 : -100;
    console.log(
      `${(tope === 0 ? "sin" : String(tope)).padStart(6)}${String(r.aceptadas).padStart(9)}` +
        `${String(r.rechazadas).padStart(9)}${String(r.maxSimultaneas).padStart(8)}` +
        `${r.capitalFinal.toFixed(0).padStart(12)}${mult.toFixed(1).padStart(7)}x` +
        `${anual.toFixed(1).padStart(7)}%${(r.maxCaida * 100).toFixed(0).padStart(11)}%` +
        `${(r.peorDia * 100).toFixed(0).padStart(9)}%`,
    );
  }

  // ---- 3. CUANTO RIESGO AGUANTA --------------------------------------------------------
  console.log("\n3. CUANTO RIESGO POR OPERACION (tope de 5 posiciones)");
  console.log(
    `${"riesgo".padStart(8)}${"final".padStart(12)}${"anual".padStart(8)}${"peor caida".padStart(12)}${"peor dia".padStart(10)}`,
  );
  console.log("-".repeat(50));
  for (const rp of [0.005, 0.01, 0.02, 0.05, 0.1]) {
    const r = simularCartera(ops, { capital, riesgoPct: rp, maxPosiciones: 5, compuesto: true });
    const mult = r.capitalFinal / capital;
    const anual = mult > 0 ? (Math.pow(mult, 1 / anios) - 1) * 100 : -100;
    console.log(
      `${(rp * 100).toFixed(1).padStart(7)}%${r.capitalFinal.toFixed(0).padStart(12)}` +
        `${anual.toFixed(1).padStart(7)}%${(r.maxCaida * 100).toFixed(0).padStart(11)}%` +
        `${(r.peorDia * 100).toFixed(0).padStart(9)}%`,
    );
  }

  // ---- 4. AÑO A AÑO --------------------------------------------------------------------
  console.log("\n4. AÑO A AÑO (en R, sin componer, para ver si hay años perdedores)");
  const porAnio = new Map<string, number[]>();
  for (const o of ops) {
    const y = new Date(o.tEntrada * 1000).toISOString().slice(0, 4);
    const l = porAnio.get(y);
    if (l) l.push(o.r);
    else porAnio.set(y, [o.r]);
  }
  const anosOrd = [...porAnio.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let perdedores = 0;
  for (const [y, rs] of anosOrd) {
    const s = stats(rs);
    const total = rs.reduce((x, v) => x + v, 0);
    if (total <= 0) perdedores += 1;
    console.log(
      `   ${y}  ${String(rs.length).padStart(4)} ops · ${(s.wr * 100).toFixed(0).padStart(3)}% · ` +
        `PF ${s.pf.toFixed(2).padStart(5)} · ${total >= 0 ? "+" : ""}${total.toFixed(1)}R`,
    );
  }
  console.log(`\n   ${perdedores} de ${anosOrd.length} años en perdidas.`);

  console.log(
    `\nFrecuencia: ${(ops.length / anios).toFixed(0)} operaciones al año, ` +
      `${(dias.length / anios).toFixed(0)} dias con señal al año. Duracion media unos 3 dias.`,
  );
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
