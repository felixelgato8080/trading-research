/**
 * Universo de cripto descargado del EXCHANGE, no de un agregador.
 *
 *   npm run binance:universo -- salida_lista.json salida_velas.json [1d|1h] [maxVelas]
 *
 * Existe porque se midio que los rangos diarios de Yahoo son mas ESTRECHOS que los reales en el
 * 99% de los dias, y con estrategias de stop eso hace que el stop salte de menos y el backtest
 * salga optimista. Medido: la misma estrategia da 12,8% anual con Yahoo y 6,9% con Binance.
 */
import { writeFileSync } from "node:fs";
import type { Vela } from "../forex/datos";
import { velasBinance } from "../forex/binance";

const SIMBOLOS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT",
  "DOTUSDT", "LINKUSDT", "LTCUSDT", "BCHUSDT", "ATOMUSDT", "UNIUSDT", "XLMUSDT", "ETCUSDT",
  "FILUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "NEARUSDT", "ICPUSDT", "HBARUSDT", "VETUSDT",
  "ALGOUSDT", "AAVEUSDT", "INJUSDT", "SUIUSDT", "TRXUSDT", "SHIBUSDT",
];

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const intervalo = (process.argv[4] ?? "1d") as "1d" | "1h";
  const maxVelas = Number(process.argv[5] ?? 3000);
  const minimo = intervalo === "1d" ? 700 : 5000;

  const ok: string[] = [];
  const store: Record<string, Vela[]> = {};
  for (const s of SIMBOLOS) {
    try {
      const v = await velasBinance(s, intervalo, maxVelas);
      if (v.length > minimo) {
        ok.push(s);
        store[s] = v;
        console.log(
          `${s.padEnd(12)}${String(v.length).padStart(6)} velas desde ` +
            `${new Date(v[0]!.t * 1000).toISOString().slice(0, 10)}`,
        );
      } else {
        console.log(`${s.padEnd(12)}${String(v.length).padStart(6)} (corta, fuera)`);
      }
    } catch {
      console.log(`${s.padEnd(12)}   error`);
    }
    await dormir(300);
  }
  writeFileSync(process.argv[2] ?? "binance_ok.json", JSON.stringify(ok));
  writeFileSync(process.argv[3] ?? "binance_velas.json", JSON.stringify(store));
  console.log(`\n${ok.length} de ${SIMBOLOS.length} con historia suficiente`);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
