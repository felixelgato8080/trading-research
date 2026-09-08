/**
 * Construye el universo de cripto liquido con historia suficiente.
 *
 *   npm run cripto:universo -- salida_lista.json salida_velas.json
 *
 * Se exigen 700 velas diarias (unos dos años) para que una moneda entre. Sin ese minimo, las
 * recien listadas entrarian solo en el tramo en que subieron, que es el sesgo de supervivencia
 * en su version mas descarada.
 */
import { writeFileSync } from "node:fs";
import { velas, type Vela, type Temporalidad } from "../forex/datos";

const CANDIDATAS = [
  "BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD", "ADA-USD", "DOGE-USD", "AVAX-USD",
  "DOT-USD", "LINK-USD", "MATIC-USD", "LTC-USD", "BCH-USD", "ATOM-USD", "UNI7083-USD",
  "XLM-USD", "ETC-USD", "FIL-USD", "APT21794-USD", "ARB11841-USD", "OP-USD", "NEAR-USD",
  "ICP-USD", "HBAR-USD", "VET-USD", "ALGO-USD", "AAVE-USD", "INJ-USD", "SUI20947-USD",
  "TRX-USD", "TON11419-USD", "SHIB-USD",
];

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const ok: string[] = [];
  const store: Record<string, Vela[]> = {};
  // La temporalidad se pasa como 4o argumento. En 1h Yahoo da 730 dias, asi que el minimo de
  // velas tiene que ser otro: exigir 700 en diario son dos años, en 1h son 29 dias.
  const tf = (process.argv[4] ?? "1d") as Temporalidad;
  const minimo = tf === "1d" ? 700 : 5000;

  for (const s of CANDIDATAS) {
    try {
      const v = await velas(s, tf);
      if (v.length > minimo) {
        ok.push(s);
        store[s] = v;
        console.log(
          `${s.padEnd(16)}${String(v.length).padStart(6)} velas desde ` +
            `${new Date(v[0]!.t * 1000).toISOString().slice(0, 10)}`,
        );
      } else {
        console.log(`${s.padEnd(16)}${String(v.length).padStart(6)} (corta, fuera)`);
      }
    } catch {
      console.log(`${s.padEnd(16)}   error`);
    }
    await dormir(350);
  }

  writeFileSync(process.argv[2] ?? "cripto_ok.json", JSON.stringify(ok));
  writeFileSync(process.argv[3] ?? "cripto_velas.json", JSON.stringify(store));
  console.log(`\n${ok.length} criptos con historia suficiente`);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
