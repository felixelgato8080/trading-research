/**
 * Descarga generica de velas a una cache, para cualquier lista y temporalidad.
 *
 *   npm run descargar -- --lista X.json --tf=1h --salida=cache.json [--min=1000]
 *
 * Existe porque el descargador de cripto llevaba la lista dentro y no servia para futuros ni
 * ETFs. Tener uno generico evita duplicar el bucle de descarga cada vez que hace falta un
 * universo nuevo, que es como se acaban colando diferencias entre pruebas.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { velas, type Vela, type Temporalidad } from "../forex/datos";
import { velasBinance } from "../forex/binance";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}

async function main(): Promise<void> {
  const tf = (txt("tf") ?? "1d") as Temporalidad;
  const salida = txt("salida");
  const minimo = Number(txt("min") ?? 1000);
  // Los simbolos de Binance (BTCUSDT) no existen en Yahoo y al reves: la fuente hay que
  // decirla, no adivinarla por el nombre.
  const binance = process.argv.includes("--binance");
  const maxVelas = Number(txt("max") ?? 3000);
  if (!salida) {
    console.error("Falta --salida=cache.json");
    process.exitCode = 1;
    return;
  }
  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );

  const store: Record<string, Vela[]> = {};
  const ok: string[] = [];
  for (const s of lista) {
    try {
      const v = binance
        ? await velasBinance(s, tf as "1d" | "1h" | "5m" | "15m", maxVelas)
        : await velas(s, tf);
      const conVol = v.filter((x) => x.v != null && x.v > 0).length;
      if (v.length >= minimo) {
        store[s] = v;
        ok.push(s);
        console.log(
          `${s.padEnd(12)}${String(v.length).padStart(7)} velas · ` +
            `${((conVol / v.length) * 100).toFixed(0)}% con volumen`,
        );
      } else {
        console.log(`${s.padEnd(12)}${String(v.length).padStart(7)} (corta, fuera)`);
      }
    } catch {
      console.log(`${s.padEnd(12)}    error`);
    }
    await dormir(400);
  }

  writeFileSync(salida, JSON.stringify(store));
  const listaSalida = txt("salida-lista");
  if (listaSalida) writeFileSync(listaSalida, JSON.stringify(ok));
  console.log(`\n${ok.length} de ${lista.length} guardados en ${salida}`);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
