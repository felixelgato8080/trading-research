/**
 * ¿Cambia el resultado si los datos vienen del exchange en vez de Yahoo?
 *
 *   npm run fuente -- --cache=cripto_velas.json [--maxvelas=2000]
 *
 * Compara vela a vela y luego corre la MISMA estrategia sobre las dos fuentes. Si Yahoo diera
 * rangos mas estrechos que el exchange, los stops saltarian de menos y todo el backtest seria
 * optimista sin que nada mas lo delatase.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Vela } from "../forex/datos";
import { velasBinance, comparar } from "../forex/binance";
import { atr } from "../forex/multiTf";
import { volatilidad, simularRuptura } from "../forex/rupturas";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}

const EQUIVALENTES: Record<string, string> = {
  "BTC-USD": "BTCUSDT", "ETH-USD": "ETHUSDT", "SOL-USD": "SOLUSDT", "BNB-USD": "BNBUSDT",
  "XRP-USD": "XRPUSDT", "ADA-USD": "ADAUSDT", "DOGE-USD": "DOGEUSDT", "AVAX-USD": "AVAXUSDT",
  "LINK-USD": "LINKUSDT", "LTC-USD": "LTCUSDT", "ATOM-USD": "ATOMUSDT", "XLM-USD": "XLMUSDT",
  "ETC-USD": "ETCUSDT", "FIL-USD": "FILUSDT", "NEAR-USD": "NEARUSDT", "ALGO-USD": "ALGOUSDT",
  "AAVE-USD": "AAVEUSDT", "TRX-USD": "TRXUSDT", "DOT-USD": "DOTUSDT", "BCH-USD": "BCHUSDT",
};

function rendimiento(datos: Map<string, Vela[]>, coste: number): string {
  const rs: number[] = [];
  const porInstr = new Map<string, number[]>();
  for (const [s, v] of datos) {
    const a = atr(v, 14);
    const propias: number[] = [];
    for (const sig of volatilidad(v, a, 2)) {
      const av = a[sig.i];
      if (av == null || !(av > 0)) continue;
      const stop = av * 2;
      const r = simularRuptura(v, sig, stop, 2, (coste * stop) / 2, 0);
      if (r) { rs.push(r.r); propias.push(r.r); }
    }
    porInstr.set(s, propias);
  }
  if (!rs.length) return "sin operaciones";
  const g = rs.filter((x) => x > 0);
  const sg = g.reduce((s, x) => s + x, 0);
  const sp = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  const enVerde = [...porInstr.values()].filter((l) => l.length > 5 && l.reduce((s, x) => s + x, 0) > 0).length;
  return (
    `${String(rs.length).padStart(6)} ops · WR ${((g.length / rs.length) * 100).toFixed(0)}% · ` +
    `PF ${(sp > 0 ? sg / sp : 0).toFixed(2)} · ${(rs.reduce((s, x) => s + x, 0) / rs.length).toFixed(3)}R · ` +
    `${enVerde}/${porInstr.size} en verde`
  );
}

async function main(): Promise<void> {
  const cache = txt("cache");
  const maxVelas = Number(txt("maxvelas") ?? 2000);
  const guardar = txt("guardar");
  if (!cache || !existsSync(cache)) {
    console.error("Falta --cache con las velas de Yahoo");
    process.exitCode = 1;
    return;
  }
  const yahoo = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;

  const deBinance: Record<string, Vela[]> = {};
  console.log("COMPARACION VELA A VELA (diferencia relativa media por campo)\n");
  console.log(
    `${"activo".padEnd(11)}${"comunes".padStart(9)}${"apert".padStart(9)}${"max".padStart(9)}` +
      `${"min".padStart(9)}${"cierre".padStart(9)}${"rango Y+".padStart(10)}${"rango Y-".padStart(10)}`,
  );
  console.log("-".repeat(76));

  for (const [ySim, bSim] of Object.entries(EQUIVALENTES)) {
    const vy = yahoo[ySim];
    if (!vy) continue;
    try {
      const vb = await velasBinance(bSim, "1d", maxVelas);
      if (vb.length === 0) { console.log(`${ySim.padEnd(11)}  sin datos de Binance`); continue; }
      deBinance[ySim] = vb;
      const c = comparar(vy, vb);
      console.log(
        `${ySim.padEnd(11)}${String(c.comunes).padStart(9)}` +
          `${(c.medias.o * 100).toFixed(3).padStart(8)}%${(c.medias.h * 100).toFixed(3).padStart(8)}%` +
          `${(c.medias.l * 100).toFixed(3).padStart(8)}%${(c.medias.c * 100).toFixed(3).padStart(8)}%` +
          `${String(c.rangoMasAncho).padStart(10)}${String(c.rangoMasEstrecho).padStart(10)}`,
      );
    } catch (e) {
      console.log(`${ySim.padEnd(11)}  error: ${e instanceof Error ? e.message.slice(0, 40) : ""}`);
    }
    await dormir(300);
  }

  const comunes = Object.keys(deBinance);
  if (comunes.length === 0) {
    console.log("\nNo se pudo traer nada de Binance. Puede estar bloqueado desde esta red.");
    return;
  }
  if (guardar) writeFileSync(guardar, JSON.stringify(deBinance));

  // Misma ventana temporal en las dos fuentes, o la comparacion no significa nada.
  const desde = Math.max(
    ...comunes.map((s) => Math.max(yahoo[s]![0]!.t, deBinance[s]![0]!.t)),
  );
  const recorta = (v: Vela[]): Vela[] => v.filter((x) => x.t >= desde);

  const mapY = new Map(comunes.map((s) => [s, recorta(yahoo[s]!)]));
  const mapB = new Map(comunes.map((s) => [s, recorta(deBinance[s]!)]));

  console.log(`\nLA MISMA ESTRATEGIA SOBRE LAS DOS FUENTES (${comunes.length} monedas, mismo periodo)`);
  console.log(`  Yahoo:   ${rendimiento(mapY, 0.05)}`);
  console.log(`  Binance: ${rendimiento(mapB, 0.05)}`);
  console.log("\nSi las dos lineas se parecen, la fuente no era el problema.");
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
